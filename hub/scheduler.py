"""
Планировщик задач (cron, interval, ретраи, цепочки on_success_project_id),
супервизор сервисов (autostart, Safe Mode, защита от crash-loop с экспоненциальным backoff, cron_restart)
и сторож Dead Man's Switch (входящие пинги от скриптов и исходящий heartbeat самой панели).
"""

import asyncio
import time
import urllib.request
from typing import Any

from hub.compat import croniter
from hub.db import execute_sql, get_setting, query_all, query_one
from hub.disk_guard import check_disk_and_maintain
from hub.notifier import send_notification
from hub.process_mgr import ACTIVE_RUNS, set_on_finish_callback, start_project_run, stop_project
from hub.web_auth_mgr import check_android_hardware_guard

# Состояние сервисов для экспоненциального backoff и crash-loop:
# project_id -> {"consecutive_failures": int, "next_restart_at": float}
_SERVICE_BACKOFF: dict[int, dict[str, float]] = {}

# Состояние ретраев для jobs:
# project_id -> {"retry_count": int, "next_retry_at": float}
_JOB_RETRIES: dict[int, dict[str, float]] = {}

# Состояние расписаний для jobs:
# project_id -> {"expr": str, "type": str, "next_run_at": float}
_JOB_SCHEDULES: dict[int, dict[str, Any]] = {}

# Состояние плановых cron-рестартов для сервисов:
# project_id -> {"expr": str, "next_restart_at": float}
_SERVICE_CRON_RESTARTS: dict[int, dict[str, Any]] = {}

# Отслеживание уже отправленных алертов Dead Man's Switch (project_id -> last_alerted_ping_ts)
_HEARTBEAT_ALERTED: dict[int, int] = {}


def is_project_running(project_id: int) -> bool:
    for info in ACTIVE_RUNS.values():
        if info["project_id"] == project_id:
            return True
    row = query_one(
        "SELECT id FROM runs WHERE project_id = ? AND status IN ('running', 'waiting_input') LIMIT 1",
        (project_id,),
    )
    return row is not None


def _compute_next_schedule_ts(sched_type: str, sched_expr: str, base_ts: float) -> float:
    expr = (sched_expr or "").strip()
    if sched_type == "interval":
        interval_sec = max(5, int(expr or "60"))
        return base_ts + interval_sec
    elif sched_type == "cron":
        it = croniter(expr, base_ts)
        return float(it.get_next(float))
    return 0.0


async def on_run_finished(project: dict[str, Any], exit_code: int, final_status: str, log_tail: str) -> None:
    """
    Обработчик завершения процесса из process_mgr:
    - Для 'service' и 'web': проверяет min_uptime_sec и max_restarts (защита от crash-loop),
      вычисляет экспоненциальный backoff и планирует перезапуск.
    - Для 'job': управляет повторными попытками (max_retries, retry_delay_sec) и шлёт уведомления.
    - Для всех проектов: при успешном завершении (exit_code == 0) запускает следующий проект
      по цепочке (on_success_project_id), если он настроен.
    """
    proj_id = int(project["id"])
    proj_name = project["name"]
    proj_type = project["type"]

    last_run = query_one(
        "SELECT id, started_at, finished_at FROM runs WHERE project_id = ? ORDER BY id DESC LIMIT 1",
        (proj_id,),
    )
    uptime_sec = 0
    last_run_id = int(last_run["id"]) if last_run else 0
    if last_run and last_run.get("started_at") and last_run.get("finished_at"):
        uptime_sec = max(0, int(last_run["finished_at"]) - int(last_run["started_at"]))

    fresh_proj = query_one("SELECT * FROM projects WHERE id = ?", (proj_id,)) or project

    # Цепочка проектов: если проект успешно завершился и задан on_success_project_id — запускаем следующий проект
    next_proj_id = fresh_proj.get("on_success_project_id")
    if exit_code == 0 and final_status == "success" and next_proj_id:
        try:
            target_id = int(next_proj_id)
            if target_id != proj_id and not is_project_running(target_id):
                await start_project_run(target_id, trigger="chain")
        except Exception:
            pass

    if proj_type in ("service", "web"):
        if fresh_proj.get("desired_state") != "running":
            _SERVICE_BACKOFF.pop(proj_id, None)
            return

        min_uptime = max(1, int(fresh_proj.get("min_uptime_sec") or 10))
        max_restarts = max(0, int(fresh_proj.get("max_restarts") or 10))
        restart_delay = max(1, int(fresh_proj.get("restart_delay_sec") or fresh_proj.get("backoff_min_sec") or 2))

        state = _SERVICE_BACKOFF.setdefault(proj_id, {"consecutive_failures": 0, "next_restart_at": 0.0})
        if uptime_sec >= min_uptime:
            state["consecutive_failures"] = 0
            execute_sql("UPDATE projects SET crash_loop_count = 0 WHERE id = ?", (proj_id,))
        else:
            state["consecutive_failures"] = int(state["consecutive_failures"]) + 1
            execute_sql(
                "UPDATE projects SET crash_loop_count = ? WHERE id = ?",
                (int(state["consecutive_failures"]), proj_id),
            )

        policy = fresh_proj.get("restart_policy", "on-failure")
        should_restart = policy == "always" or (policy == "on-failure" and exit_code != 0)

        # Проверка порога Crash-Loop
        failures = int(state["consecutive_failures"])
        if should_restart and max_restarts > 0 and failures >= max_restarts:
            _SERVICE_BACKOFF.pop(proj_id, None)
            now_ts = int(time.time())
            execute_sql(
                "UPDATE projects SET desired_state = 'stopped', health_status = 'crash_loop', updated_at = ? WHERE id = ?",
                (now_ts, proj_id),
            )
            if last_run_id:
                execute_sql(
                    "UPDATE runs SET status = 'crash_loop', error_summary = ? WHERE id = ?",
                    (f"Crash-loop: {failures} быстрых падений подряд (< {min_uptime}с)", last_run_id),
                )
            await send_notification(
                f"Сервис «{proj_name}» остановлен защитой от Crash-Loop после {failures} падений подряд (время жизни < {min_uptime} сек).",
                level="crash",
                project_name=proj_name,
                log_tail=log_tail,
            )
            return

        if exit_code != 0 and int(fresh_proj.get("notify_on_crash", 1)) == 1:
            await send_notification(
                f"Сервис «{proj_name}» аварийно завершился с кодом {exit_code}.",
                level="crash",
                project_name=proj_name,
                log_tail=log_tail,
            )

        if should_restart:
            b_max = max(restart_delay, int(fresh_proj.get("backoff_max_sec") or 300))
            exp_power = max(0, failures - 1)
            delay = min(b_max, restart_delay * (2**exp_power))
            state["next_restart_at"] = time.time() + delay

    else:
        # Логика для type == 'job'
        if exit_code == 0 and final_status == "success":
            _JOB_RETRIES.pop(proj_id, None)
            if int(fresh_proj.get("notify_on_success", 0)) == 1:
                await send_notification(
                    f"Задача «{proj_name}» успешно выполнена за {uptime_sec} сек.",
                    level="info",
                    project_name=proj_name,
                )
        else:
            max_retries = max(0, int(fresh_proj.get("max_retries") or 0))
            retry_delay = max(1, int(fresh_proj.get("retry_delay_sec") or 30))
            r_state = _JOB_RETRIES.setdefault(proj_id, {"retry_count": 0, "next_retry_at": 0.0})

            if int(r_state["retry_count"]) < max_retries:
                r_state["retry_count"] = int(r_state["retry_count"]) + 1
                r_state["next_retry_at"] = time.time() + retry_delay
                if int(fresh_proj.get("notify_on_error", 1)) == 1:
                    await send_notification(
                        f"Задача «{proj_name}» завершилась с ошибкой (код {exit_code}). "
                        f"Повторная попытка {int(r_state['retry_count'])}/{max_retries} через {retry_delay} сек.",
                        level="warn",
                        project_name=proj_name,
                        log_tail=log_tail,
                    )
            else:
                _JOB_RETRIES.pop(proj_id, None)
                if int(fresh_proj.get("notify_on_error", 1)) == 1:
                    await send_notification(
                        f"Задача «{proj_name}» завершилась с ошибкой (код {exit_code}).",
                        level="error",
                        project_name=proj_name,
                        log_tail=log_tail,
                    )


async def autostart_services_on_boot() -> None:
    """
    При старте панели запускает все сервисы и веб-бэкенды с autostart == 1 (или desired_state == 'running'),
    если не включён безопасный режим (Safe Mode: --safe-mode / ARUTA_SAFE_MODE=1 / safe_mode='1').
    """
    set_on_finish_callback(on_run_finished)
    if get_setting("safe_mode", "0") == "1":
        print(
            "[Safe Mode] Панель запущена в безопасном режиме (safe_mode=1): автозапуск сервисов пропущен.",
            flush=True,
        )
        return

    services = query_all(
        "SELECT * FROM projects WHERE type IN ('service', 'web') AND (autostart = 1 OR desired_state = 'running')"
    )
    now = int(time.time())
    for svc in services:
        proj_id = svc["id"]
        execute_sql("UPDATE projects SET desired_state = 'running', updated_at = ? WHERE id = ?", (now, proj_id))
        if not is_project_running(proj_id):
            try:
                await start_project_run(proj_id, trigger="autostart")
            except Exception:
                pass


def get_upcoming_runs(limit: int = 5) -> list[dict[str, Any]]:
    """Вычисляет ближайшие запланированные запуски задач для дашборда."""
    jobs = query_all(
        "SELECT id, name, schedule_type, schedule_expr FROM projects WHERE type = 'job' AND schedule_type IN ('cron', 'interval')"
    )
    upcoming: list[dict[str, Any]] = []
    now = time.time()

    for j in jobs:
        jid = j["id"]
        stype = j["schedule_type"]
        sexpr = (j["schedule_expr"] or "").strip()
        if not sexpr:
            continue
        try:
            cached = _JOB_SCHEDULES.get(jid)
            if cached and cached.get("type") == stype and cached.get("expr") == sexpr and cached.get("next_run_at", 0) > now:
                next_ts = float(cached["next_run_at"])
            else:
                next_ts = _compute_next_schedule_ts(stype, sexpr, now)
            upcoming.append(
                {
                    "project_id": jid,
                    "project_name": j["name"],
                    "schedule_type": stype,
                    "schedule_expr": sexpr,
                    "next_run_at": int(next_ts),
                    "in_seconds": max(0, int(next_ts - now)),
                }
            )
        except Exception:
            continue

    upcoming.sort(key=lambda x: x["next_run_at"])
    return upcoming[:limit]


def _ping_outbound_heartbeat_sync(url: str) -> None:
    if not url or not url.startswith(("http://", "https://")):
        return
    try:
        req = urllib.request.Request(url, method="GET", headers={"User-Agent": "Aruta-Heartbeat/2.2"})
        with urllib.request.urlopen(req, timeout=5.0):
            pass
    except Exception:
        pass


async def scheduler_loop() -> None:
    """
    Фоновый async-цикл планировщика (каждую 1 секунду):
    1. Проверяет отложенные перезапуски сервисов (backoff).
    2. Проверяет плановый cron_restart работающих сервисов.
    3. Проверяет отложенные ретраи упавших задач (retry_delay_sec).
    4. Проверяет задачи по расписанию cron / interval (при выключенном Safe Mode).
    5. Проверяет Dead Man's Switch (heartbeat_interval_sec + heartbeat_grace_sec) и исходящий пинг панели.
    6. Раз в 60 секунд запускает disk_guard.check_disk_and_maintain().
    """
    set_on_finish_callback(on_run_finished)
    last_disk_check = 0.0
    last_hw_guard_check = 0.0
    last_outbound_ping = 0.0

    while True:
        try:
            now = time.time()
            safe_mode = get_setting("safe_mode", "0") == "1"

            # 1. Backoff-перезапуск сервисов и web-бэкендов
            if not safe_mode:
                for proj_id, b_state in list(_SERVICE_BACKOFF.items()):
                    next_at = b_state.get("next_restart_at", 0.0)
                    if next_at > 0 and now >= next_at:
                        b_state["next_restart_at"] = 0.0
                        proj = query_one("SELECT * FROM projects WHERE id = ?", (proj_id,))
                        if proj and proj["type"] in ("service", "web") and proj["desired_state"] == "running":
                            if not is_project_running(proj_id):
                                try:
                                    await start_project_run(proj_id, trigger="restart")
                                except Exception:
                                    b_state["next_restart_at"] = now + 10.0

            # 2. Плановый cron_restart для работающих сервисов
            if not safe_mode:
                cron_svcs = query_all(
                    "SELECT id, name, cron_restart FROM projects WHERE type IN ('service', 'web') AND desired_state = 'running' AND cron_restart != ''"
                )
                for svc in cron_svcs:
                    sid = int(svc["id"])
                    cexpr = str(svc.get("cron_restart") or "").strip()
                    if not cexpr:
                        continue
                    c_entry = _SERVICE_CRON_RESTARTS.get(sid)
                    if not c_entry or c_entry.get("expr") != cexpr:
                        try:
                            nxt = _compute_next_schedule_ts("cron", cexpr, now)
                            _SERVICE_CRON_RESTARTS[sid] = {"expr": cexpr, "next_restart_at": nxt}
                        except Exception:
                            continue
                        c_entry = _SERVICE_CRON_RESTARTS[sid]
                    if now >= float(c_entry["next_restart_at"]):
                        try:
                            c_entry["next_restart_at"] = _compute_next_schedule_ts("cron", cexpr, now)
                        except Exception:
                            c_entry["next_restart_at"] = now + 3600.0
                        try:
                            await stop_project(sid)
                            await asyncio.sleep(0.2)
                            await start_project_run(sid, trigger="cron_restart")
                        except Exception:
                            pass

            # 3. Повторные запуски (retries) для jobs
            if not safe_mode:
                for proj_id, r_state in list(_JOB_RETRIES.items()):
                    next_at = r_state.get("next_retry_at", 0.0)
                    if next_at > 0 and now >= next_at:
                        r_state["next_retry_at"] = 0.0
                        proj = query_one("SELECT * FROM projects WHERE id = ?", (proj_id,))
                        if proj and not is_project_running(proj_id):
                            try:
                                await start_project_run(proj_id, trigger="retry")
                            except Exception:
                                pass

            # 4. Плановые запуски cron и interval
            jobs = query_all(
                "SELECT * FROM projects WHERE type = 'job' AND schedule_type IN ('cron', 'interval')"
            )
            active_job_ids = {j["id"] for j in jobs}
            for old_id in list(_JOB_SCHEDULES.keys()):
                if old_id not in active_job_ids:
                    del _JOB_SCHEDULES[old_id]

            for job in jobs:
                jid = job["id"]
                stype = job["schedule_type"]
                sexpr = (job["schedule_expr"] or "").strip()
                if not sexpr:
                    continue

                sched = _JOB_SCHEDULES.get(jid)
                if not sched or sched.get("type") != stype or sched.get("expr") != sexpr:
                    try:
                        next_ts = _compute_next_schedule_ts(stype, sexpr, now)
                        _JOB_SCHEDULES[jid] = {"type": stype, "expr": sexpr, "next_run_at": next_ts}
                    except Exception:
                        continue
                    sched = _JOB_SCHEDULES[jid]

                if now >= float(sched["next_run_at"]):
                    try:
                        sched["next_run_at"] = _compute_next_schedule_ts(stype, sexpr, now)
                    except Exception:
                        sched["next_run_at"] = now + 60.0

                    if not safe_mode and not is_project_running(jid):
                        try:
                            await start_project_run(jid, trigger="schedule")
                        except Exception:
                            pass

            # 5. Dead Man's Switch — проверка входящих heartbeat-пингов от скриптов
            hb_projects = query_all(
                "SELECT id, name, heartbeat_interval_sec, heartbeat_grace_sec, last_ping_at, health_status FROM projects WHERE heartbeat_interval_sec > 0 AND last_ping_at > 0"
            )
            now_int = int(now)
            for hp in hb_projects:
                pid = int(hp["id"])
                interval_s = int(hp["heartbeat_interval_sec"])
                grace_s = max(5, int(hp.get("heartbeat_grace_sec") or 60))
                last_p = int(hp["last_ping_at"])
                if (now_int - last_p) > (interval_s + grace_s):
                    if _HEARTBEAT_ALERTED.get(pid) != last_p:
                        _HEARTBEAT_ALERTED[pid] = last_p
                        execute_sql("UPDATE projects SET health_status = 'unhealthy' WHERE id = ?", (pid,))
                        await send_notification(
                            f"Dead Man's Switch: проект «{hp['name']}» не присылал пинг более {now_int - last_p} сек (ожидался каждые {interval_s}с).",
                            level="warn",
                            project_name=hp["name"],
                        )

            # 6. Исходящий пинг самой панели во внешний мониторинг (Healthchecks.io / Uptime Kuma)
            if now - last_outbound_ping >= 60.0:
                last_outbound_ping = now
                outbound_url = get_setting("outbound_heartbeat_url", "").strip()
                if outbound_url:
                    await asyncio.to_thread(_ping_outbound_heartbeat_sync, outbound_url)

            # 7. Периодический контроль диска, ротация логов и WAL checkpoint
            if now - last_disk_check >= 60.0:
                last_disk_check = now
                await check_disk_and_maintain()

            # 8. Аппаратный сторож батареи и перегрева Android (каждые 30 секунд)
            if now - last_hw_guard_check >= 30.0:
                last_hw_guard_check = now
                await check_android_hardware_guard()

        except Exception:
            pass

        await asyncio.sleep(1.0)
