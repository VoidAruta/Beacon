"""
Планировщик задач (cron, interval, ретраи) и супервизор сервисов (autostart, экспоненциальный backoff).
"""

import asyncio
import time
from typing import Any

from hub.compat import croniter
from hub.db import execute_sql, query_all, query_one
from hub.disk_guard import check_disk_and_maintain
from hub.notifier import send_notification
from hub.process_mgr import ACTIVE_RUNS, set_on_finish_callback, start_project_run
from hub.web_auth_mgr import check_android_hardware_guard

# Состояние сервисов для экспоненциального backoff:
# project_id -> {"consecutive_failures": int, "next_restart_at": float}
_SERVICE_BACKOFF: dict[int, dict[str, float]] = {}

# Состояние ретраев для jobs:
# project_id -> {"retry_count": int, "next_retry_at": float}
_JOB_RETRIES: dict[int, dict[str, float]] = {}

# Состояние расписаний для jobs:
# project_id -> {"expr": str, "type": str, "next_run_at": float}
_JOB_SCHEDULES: dict[int, dict[str, Any]] = {}


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
    - Для 'service': считает время стабильной работы (>60с сбрасывает consecutive_failures),
      вычисляет экспоненциальный backoff min(backoff_max, backoff_min * 2^failures) и планирует перезапуск.
    - Для 'job': управляет повторными попытками (max_retries, retry_delay_sec) и шлёт уведомления.
    """
    proj_id = int(project["id"])
    proj_name = project["name"]
    proj_type = project["type"]

    # Получаем последний завершённый запуск для расчёта длительности работы
    last_run = query_one(
        "SELECT started_at, finished_at FROM runs WHERE project_id = ? ORDER BY id DESC LIMIT 1",
        (proj_id,),
    )
    uptime_sec = 0
    if last_run and last_run.get("started_at") and last_run.get("finished_at"):
        uptime_sec = max(0, int(last_run["finished_at"]) - int(last_run["started_at"]))

    if proj_type == "service":
        # Перечитываем актуальный desired_state из БД
        fresh_proj = query_one("SELECT * FROM projects WHERE id = ?", (proj_id,)) or project
        if fresh_proj.get("desired_state") != "running":
            _SERVICE_BACKOFF.pop(proj_id, None)
            return

        state = _SERVICE_BACKOFF.setdefault(proj_id, {"consecutive_failures": 0, "next_restart_at": 0.0})
        if uptime_sec >= 60:
            state["consecutive_failures"] = 0

        policy = fresh_proj.get("restart_policy", "on-failure")
        should_restart = policy == "always" or (policy == "on-failure" and exit_code != 0)

        if exit_code != 0 and int(fresh_proj.get("notify_on_crash", 1)) == 1:
            await send_notification(
                f"Сервис «{proj_name}» аварийно завершился с кодом {exit_code}.",
                level="crash",
                project_name=proj_name,
                log_tail=log_tail,
            )

        if should_restart:
            b_min = max(1, int(fresh_proj.get("backoff_min_sec") or 2))
            b_max = max(b_min, int(fresh_proj.get("backoff_max_sec") or 300))
            failures = int(state["consecutive_failures"])
            delay = min(b_max, b_min * (2**failures))
            state["consecutive_failures"] = failures + 1
            state["next_restart_at"] = time.time() + delay

    else:
        # Логика для type == 'job'
        if exit_code == 0 and final_status == "success":
            _JOB_RETRIES.pop(proj_id, None)
            if int(project.get("notify_on_success", 0)) == 1:
                await send_notification(
                    f"Задача «{proj_name}» успешно выполнена за {uptime_sec} сек.",
                    level="info",
                    project_name=proj_name,
                )
        else:
            max_retries = max(0, int(project.get("max_retries") or 0))
            retry_delay = max(1, int(project.get("retry_delay_sec") or 30))
            r_state = _JOB_RETRIES.setdefault(proj_id, {"retry_count": 0, "next_retry_at": 0.0})

            if int(r_state["retry_count"]) < max_retries:
                r_state["retry_count"] = int(r_state["retry_count"]) + 1
                r_state["next_retry_at"] = time.time() + retry_delay
                if int(project.get("notify_on_error", 1)) == 1:
                    await send_notification(
                        f"Задача «{proj_name}» завершилась с ошибкой (код {exit_code}). "
                        f"Повторная попытка {int(r_state['retry_count'])}/{max_retries} через {retry_delay} сек.",
                        level="warn",
                        project_name=proj_name,
                        log_tail=log_tail,
                    )
            else:
                _JOB_RETRIES.pop(proj_id, None)
                if int(project.get("notify_on_error", 1)) == 1:
                    await send_notification(
                        f"Задача «{proj_name}» завершилась с ошибкой (код {exit_code}).",
                        level="error",
                        project_name=proj_name,
                        log_tail=log_tail,
                    )


async def autostart_services_on_boot() -> None:
    """
    При старте Hub запускает все сервисы с autostart == 1 (или desired_state == 'running'),
    если они ещё не были подхвачены живыми на этапе recover_running_processes().
    """
    set_on_finish_callback(on_run_finished)
    services = query_all(
        "SELECT * FROM projects WHERE type = 'service' AND (autostart = 1 OR desired_state = 'running')"
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


async def scheduler_loop() -> None:
    """
    Фоновый async-цикл планировщика (каждую 1 секунду):
    1. Проверяет отложенные перезапуски сервисов (backoff).
    2. Проверяет отложенные ретраи упавших задач (retry_delay_sec).
    3. Проверяет задачи по расписанию cron / interval (запрещая параллельный запуск одной задачи).
    4. Раз в 60 секунд запускает disk_guard.check_disk_and_maintain().
    """
    set_on_finish_callback(on_run_finished)
    last_disk_check = 0.0
    last_hw_guard_check = 0.0

    while True:
        try:
            now = time.time()

            # 1. Backoff-перезапуск сервисов
            for proj_id, b_state in list(_SERVICE_BACKOFF.items()):
                next_at = b_state.get("next_restart_at", 0.0)
                if next_at > 0 and now >= next_at:
                    b_state["next_restart_at"] = 0.0
                    proj = query_one("SELECT * FROM projects WHERE id = ?", (proj_id,))
                    if proj and proj["type"] == "service" and proj["desired_state"] == "running":
                        if not is_project_running(proj_id):
                            try:
                                await start_project_run(proj_id, trigger="restart")
                            except Exception:
                                b_state["next_restart_at"] = now + 10.0

            # 2. Повторные запуски (retries) для jobs
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

            # 3. Плановые запуски cron и interval
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

                    # Запрет параллельного запуска одной и той же задачи по расписанию
                    if not is_project_running(jid):
                        try:
                            await start_project_run(jid, trigger="schedule")
                        except Exception:
                            pass

            # 4. Периодический контроль диска, ротация логов и WAL checkpoint
            if now - last_disk_check >= 60.0:
                last_disk_check = now
                await check_disk_and_maintain()

            # 5. Аппаратный сторож батареи и перегрева Android (каждые 30 секунд)
            if now - last_hw_guard_check >= 30.0:
                last_hw_guard_check = now
                await check_android_hardware_guard()

        except Exception:
            pass

        await asyncio.sleep(1.0)
