"""
Планировщик задач (cron, interval, daily, ретраи, цепочки on_success_project_id),
супервизор сервисов (autostart с задержкой и RAM-проверкой, Safe Mode, защита от crash-loop с экспоненциальным backoff, cron_restart)
и сторож Dead Man's Switch (входящие пинги от скриптов и исходящий heartbeat самой панели).
"""

import asyncio
import datetime
import re
import time
import urllib.request
from typing import Any

from hub.compat import croniter, psutil
from hub.config import is_runtime_safe_mode
from hub.db import execute_sql, get_setting, log_audit, query_all, query_one
from hub.disk_guard import check_disk_and_maintain
from hub.log import get_logger
from hub.notifier import send_notification
from hub.process_mgr import (
    ACTIVE_RUNS,
    set_on_finish_callback,
    set_on_healthcheck_fail_callback,
    start_project_run,
    stop_project,
)
from hub.web_auth_mgr import check_android_hardware_guard

logger = get_logger("scheduler")

MAX_CHAIN_DEPTH = 5
_DAILY_RE = re.compile(r"^([01]\d|2[0-3]):([0-5]\d)$")

_SCHEDULER_LOOP_STATUS: dict[str, Any] = {
    "last_tick_at": 0.0,
    "ticks": 0,
    "error_count": 0,
    "last_error": "",
    "last_error_at": 0.0,
}

# Состояние сервисов для экспоненциального backoff и crash-loop:
# project_id -> {"consecutive_failures": int, "next_restart_at": float, "trigger": str}
_SERVICE_BACKOFF: dict[int, dict[str, Any]] = {}

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


def validate_schedule_config(schedule_type: str, schedule_expr: str) -> None:
    """Строгая валидация расписания (manual, interval >= 5, croniter, daily HH:MM) (P2-06)."""
    stype = (schedule_type or "manual").strip()
    sexpr = (schedule_expr or "").strip()
    if stype not in ("manual", "cron", "interval", "daily"):
        raise ValueError("schedule_type должен быть 'manual', 'cron', 'interval' или 'daily'")
    if stype == "interval":
        try:
            sec = int(sexpr)
        except ValueError as exc:
            raise ValueError("Для расписания 'interval' укажите целое число секунд (>= 5)") from exc
        if sec < 5:
            raise ValueError("Интервал расписания 'interval' должен быть не менее 5 секунд")
    elif stype == "cron":
        if not sexpr or not croniter.is_valid(sexpr):
            raise ValueError(f"Некорректное выражение cron: {sexpr or '<пусто>'}")
    elif stype == "daily":
        if not _DAILY_RE.match(sexpr):
            raise ValueError("Для расписания 'daily' укажите время в формате HH:MM (например 03:30)")


def validate_chain_no_cycle(project_id: int, on_success_project_id: int) -> None:
    """Проверяет отсутствие самоссылки и циклов A->B->A в цепочке on_success_project_id (DFS) (P2-06)."""
    target_id = int(on_success_project_id or 0)
    if target_id <= 0:
        return
    if project_id > 0 and target_id == project_id:
        raise ValueError("Нельзя указать текущий проект в цепочке on_success_project_id")

    target_row = query_one("SELECT id, on_success_project_id FROM projects WHERE id = ?", (target_id,))
    if not target_row:
        raise ValueError(f"Проект цепочки on_success_project_id={target_id} не найден")

    visited: set[int] = set()
    if project_id > 0:
        visited.add(project_id)
    curr: int = target_id
    steps = 0
    while curr > 0 and steps < 256:
        if curr in visited:
            raise ValueError("Обнаружен цикл в цепочке проектов on_success_project_id")
        visited.add(curr)
        row = query_one("SELECT on_success_project_id FROM projects WHERE id = ?", (curr,))
        if not row:
            break
        curr = int(row.get("on_success_project_id") or 0)
        steps += 1


def _compute_next_schedule_ts(sched_type: str, sched_expr: str, base_ts: float) -> float:
    expr = (sched_expr or "").strip()
    if sched_type == "interval":
        interval_sec = max(5, int(expr or "60"))
        return base_ts + interval_sec
    elif sched_type == "cron":
        it = croniter(expr, base_ts)
        return float(it.get_next(float))
    elif sched_type == "daily":
        m = _DAILY_RE.match(expr)
        if not m:
            raise ValueError(f"Некорректное время daily: {expr}")
        hh, mm = int(m.group(1)), int(m.group(2))
        base_dt = datetime.datetime.fromtimestamp(base_ts)
        cand = base_dt.replace(hour=hh, minute=mm, second=0, microsecond=0)
        if cand <= base_dt:
            cand = cand + datetime.timedelta(days=1)
        return float(cand.timestamp())
    return 0.0


def clear_heartbeat_alert(project_id: int) -> bool:
    """Сбрасывает флаг тревоги Dead Man's Switch при поступлении пинга и возвращает True, если тревога была активна."""
    return _HEARTBEAT_ALERTED.pop(int(project_id), None) is not None


async def restart_with_backoff(
    proj_id: int,
    exit_code: int,
    final_status: str,
    log_tail: str,
    trigger_label: str = "restart",
    reason_msg: str = "",
) -> None:
    """
    Единый путь перезапуска сервиса с защитой от crash-loop и экспоненциальным backoff (P2-06):
    используется при on-failure, сбое 3x healthcheck и неудачном cron_restart.
    """
    fresh_proj = query_one("SELECT * FROM projects WHERE id = ?", (proj_id,))
    if not fresh_proj:
        _SERVICE_BACKOFF.pop(proj_id, None)
        return
    if fresh_proj["type"] not in ("service", "web") or fresh_proj.get("desired_state") != "running":
        _SERVICE_BACKOFF.pop(proj_id, None)
        return

    proj_name = fresh_proj["name"]
    last_run = query_one(
        "SELECT id, started_at, finished_at FROM runs WHERE project_id = ? ORDER BY id DESC LIMIT 1",
        (proj_id,),
    )
    uptime_sec = 0
    last_run_id = int(last_run["id"]) if last_run else 0
    if last_run and last_run.get("started_at") and last_run.get("finished_at"):
        uptime_sec = max(0, int(last_run["finished_at"]) - int(last_run["started_at"]))

    min_uptime = max(1, int(fresh_proj.get("min_uptime_sec") or 10))
    max_restarts = max(0, int(fresh_proj.get("max_restarts") or 10))
    restart_delay = max(1, int(fresh_proj.get("restart_delay_sec") or fresh_proj.get("backoff_min_sec") or 2))

    state = _SERVICE_BACKOFF.setdefault(
        proj_id, {"consecutive_failures": 0, "next_restart_at": 0.0, "trigger": trigger_label}
    )
    is_abnormal = trigger_label in ("healthcheck", "cron_restart") or exit_code != 0
    if not is_abnormal and uptime_sec >= min_uptime:
        state["consecutive_failures"] = 0
        execute_sql("UPDATE projects SET crash_loop_count = 0 WHERE id = ?", (proj_id,))
    elif uptime_sec >= min_uptime and trigger_label == "restart" and exit_code == 0:
        state["consecutive_failures"] = 0
        execute_sql("UPDATE projects SET crash_loop_count = 0 WHERE id = ?", (proj_id,))
    elif uptime_sec < min_uptime or trigger_label in ("healthcheck", "cron_restart"):
        state["consecutive_failures"] = int(state["consecutive_failures"]) + 1
        execute_sql(
            "UPDATE projects SET crash_loop_count = ? WHERE id = ?",
            (int(state["consecutive_failures"]), proj_id),
        )

    policy = str(fresh_proj.get("restart_policy") or "on-failure")
    should_restart = (
        policy == "always"
        or (policy == "on-failure" and is_abnormal)
        or trigger_label in ("healthcheck", "cron_restart")
    )
    if policy == "no" and trigger_label == "restart":
        should_restart = False

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
            f"Сервис «{proj_name}» остановлен защитой от Crash-Loop после {failures} падений подряд.",
            level="crash",
            project_name=proj_name,
            log_tail=log_tail,
        )
        return

    if is_abnormal and int(fresh_proj.get("notify_on_crash", 1)) == 1:
        msg = reason_msg or f"Сервис «{proj_name}» аварийно завершился с кодом {exit_code}."
        await send_notification(
            msg,
            level="crash" if trigger_label == "restart" else "error",
            project_name=proj_name,
            log_tail=log_tail,
        )

    if should_restart:
        b_max = max(restart_delay, int(fresh_proj.get("backoff_max_sec") or 300))
        exp_power = max(0, failures - 1)
        delay = min(b_max, restart_delay * (2**exp_power))
        state["trigger"] = trigger_label
        state["next_restart_at"] = time.time() + delay


async def on_healthcheck_failed(project: dict[str, Any], hc_msg: str, log_tail: str) -> None:
    """Обработчик 3-кратного сбоя healthcheck: делегирует перезапуск единому backoff/crash-loop пути (P2-06)."""
    await restart_with_backoff(
        proj_id=int(project["id"]),
        exit_code=-1,
        final_status="failed",
        log_tail=log_tail,
        trigger_label="healthcheck",
        reason_msg=f"Сервис «{project['name']}» завис ({hc_msg}). Запланирован перезапуск с backoff.",
    )


async def on_run_finished(project: dict[str, Any], exit_code: int, final_status: str, log_tail: str) -> None:
    """
    Обработчик завершения процесса из process_mgr:
    - Для 'service' и 'web': вызывает единый restart_with_backoff().
    - Для 'job': управляет повторными попытками (max_retries, retry_delay_sec) и шлёт уведомления.
    - Для всех проектов: при успешном завершении (exit_code == 0) запускает следующий проект
      по цепочке (on_success_project_id) с ограничением глубины MAX_CHAIN_DEPTH=5.
    """
    proj_id = int(project["id"])
    proj_name = project["name"]
    proj_type = project["type"]

    last_run = query_one(
        "SELECT id, started_at, finished_at FROM runs WHERE project_id = ? ORDER BY id DESC LIMIT 1",
        (proj_id,),
    )
    uptime_sec = 0
    if last_run and last_run.get("started_at") and last_run.get("finished_at"):
        uptime_sec = max(0, int(last_run["finished_at"]) - int(last_run["started_at"]))

    fresh_proj = query_one("SELECT * FROM projects WHERE id = ?", (proj_id,)) or project

    # Цепочка проектов с защитой от бесконечной рекурсии (MAX_CHAIN_DEPTH = 5)
    next_proj_id = fresh_proj.get("on_success_project_id")
    chain_depth = int(project.get("_chain_depth") or 0)
    if exit_code == 0 and final_status == "success" and next_proj_id:
        target_id = int(next_proj_id)
        if chain_depth >= MAX_CHAIN_DEPTH:
            logger.warning(
                "Цепочка on_success остановлена для проекта %s -> %s: достигнута максимальная глубина (%s)",
                proj_id,
                target_id,
                MAX_CHAIN_DEPTH,
            )
            await send_notification(
                f"Цепочка запуска после «{proj_name}» остановлена: достигнут лимит глубины ({MAX_CHAIN_DEPTH}).",
                level="warn",
                project_name=proj_name,
            )
        elif target_id != proj_id and not is_project_running(target_id):
            try:
                await start_project_run(target_id, trigger="chain", chain_depth=chain_depth + 1)
            except Exception:
                logger.exception("Ошибка запуска цепочки on_success после проекта %s -> %s", proj_id, next_proj_id)

    if proj_type in ("service", "web"):
        await restart_with_backoff(proj_id, exit_code, final_status, log_tail, trigger_label="restart")
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
    При старте панели запускает сервисы и веб-бэкенды с autostart == 1 (или desired_state == 'running'),
    с задержкой autostart_stagger_sec между стартами и проверкой свободной RAM (P2-06).
    """
    set_on_finish_callback(on_run_finished)
    set_on_healthcheck_fail_callback(on_healthcheck_failed)
    if is_runtime_safe_mode() or get_setting("safe_mode", "0") == "1":
        print(
            "[Safe Mode] Панель запущена в безопасном режиме: автозапуск сервисов пропущен.",
            flush=True,
        )
        return

    services = query_all(
        "SELECT * FROM projects WHERE type IN ('service', 'web') AND (autostart = 1 OR desired_state = 'running') ORDER BY id ASC"
    )
    try:
        stagger_sec = max(0.0, float(get_setting("autostart_stagger_sec", "2") or 2))
    except ValueError:
        stagger_sec = 2.0
    try:
        min_free_ram_mb = max(0.0, float(get_setting("autostart_min_free_ram_mb", "64") or 64))
    except ValueError:
        min_free_ram_mb = 64.0

    started_count = 0
    for svc in services:
        proj_id = int(svc["id"])
        if is_project_running(proj_id):
            continue

        if started_count > 0 and stagger_sec > 0:
            await asyncio.sleep(stagger_sec)

        fresh = query_one("SELECT * FROM projects WHERE id = ?", (proj_id,))
        if not fresh:
            continue
        if fresh["type"] not in ("service", "web"):
            continue
        if int(fresh.get("autostart") or 0) != 1 and fresh.get("desired_state") != "running":
            continue
        if is_project_running(proj_id):
            continue

        avail_mb = psutil.virtual_memory().available / (1024.0 * 1024.0)
        req_mb = max(min_free_ram_mb, float(fresh.get("ram_limit_mb") or 0))
        if req_mb > 0 and avail_mb < req_mb:
            msg = (
                f"Автозапуск «{fresh.get('name')}» пропущен: свободно {round(avail_mb, 1)} МБ ОЗУ "
                f"(требуется >= {round(req_mb, 1)} МБ)."
            )
            logger.warning(msg)
            await send_notification(msg, level="warn", project_name=str(fresh.get("name") or ""))
            continue

        now = int(time.time())
        execute_sql("UPDATE projects SET desired_state = 'running', updated_at = ? WHERE id = ?", (now, proj_id))
        try:
            await start_project_run(proj_id, trigger="autostart")
            started_count += 1
        except Exception:
            logger.exception("Ошибка автозапуска проекта %s (id=%s)", fresh.get("name"), proj_id)


def get_upcoming_runs(limit: int = 5) -> list[dict[str, Any]]:
    """Вычисляет ближайшие запланированные запуски задач для дашборда."""
    jobs = query_all(
        "SELECT id, name, schedule_type, schedule_expr, next_run_at FROM projects WHERE type = 'job' AND schedule_type IN ('cron', 'interval', 'daily')"
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
            db_next = float(j.get("next_run_at") or 0)
            if cached and cached.get("type") == stype and cached.get("expr") == sexpr and cached.get("next_run_at", 0) > now:
                next_ts = float(cached["next_run_at"])
            elif db_next > now:
                next_ts = db_next
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


def _redact_heartbeat_url(raw_url: str) -> str:
    """Скрывает логин/пароль, секретные сегменты пути (UUID/push-токены) и query-параметры heartbeat URL перед логированием."""
    try:
        from urllib.parse import urlparse

        p = urlparse(str(raw_url or ""))
        if not p.scheme or not p.hostname:
            return "***REDACTED***"
        host_port = f"{p.hostname}:{p.port}" if p.port else p.hostname
        parts = [seg for seg in (p.path or "").split("/") if seg]
        if not parts:
            return f"{p.scheme}://{host_port}/"
        if len(parts) == 1:
            return f"{p.scheme}://{host_port}/***"
        return f"{p.scheme}://{host_port}/{'/'.join(parts[:-1])}/***"
    except Exception:
        return "***REDACTED***"


def _ping_outbound_heartbeat_sync(url: str) -> None:
    if not url or not url.startswith(("http://", "https://")):
        return
    from hub.notifier import _is_safe_outbound_webhook_url, _redact_outbound_secrets

    safe_label = _redact_heartbeat_url(url)
    safe, reason = _is_safe_outbound_webhook_url(url)
    if not safe:
        logger.warning("Исходящий heartbeat заблокирован политикой SSRF (%s): %s", safe_label, reason)
        return

    class _NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, req: Any, fp: Any, code: int, msg: str, headers: Any, newurl: str) -> Any:
            return None

    try:
        opener = urllib.request.build_opener(_NoRedirect())
        req = urllib.request.Request(url, method="GET", headers={"User-Agent": "Beacon-Heartbeat/2.4"})
        with opener.open(req, timeout=5.0):
            pass
    except Exception as exc:
        logger.warning("Ошибка отправки исходящего heartbeat на %s: %s", safe_label, _redact_outbound_secrets(str(exc)))


async def scheduler_tick(now: float | None = None) -> None:
    """Один детерминированный тик планировщика (используется и в цикле, и в тестах)."""
    if now is None:
        now = time.time()
    safe_mode = is_runtime_safe_mode() or get_setting("safe_mode", "0") == "1"
    run_missed = get_setting("run_missed", "none").strip().lower()

    # 1. Backoff-перезапуск сервисов и web-бэкендов
    if not safe_mode:
        for proj_id, b_state in list(_SERVICE_BACKOFF.items()):
            next_at = float(b_state.get("next_restart_at", 0.0) or 0.0)
            if next_at > 0 and now >= next_at:
                b_state["next_restart_at"] = 0.0
                trig = str(b_state.get("trigger") or "restart")
                proj = query_one("SELECT * FROM projects WHERE id = ?", (proj_id,))
                if proj and proj["type"] in ("service", "web") and proj["desired_state"] == "running":
                    if not is_project_running(proj_id):
                        try:
                            await start_project_run(proj_id, trigger=trig)
                        except Exception as exc:
                            logger.exception("Ошибка отложенного перезапуска сервиса id=%s", proj_id)
                            await restart_with_backoff(
                                proj_id,
                                exit_code=-1,
                                final_status="failed",
                                log_tail=str(exc),
                                trigger_label=trig,
                                reason_msg=f"Не удалось перезапустить «{proj.get('name')}»: {exc}",
                            )

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
                    # Сохраняем desired_state = 'running', так как это плановый рестарт
                    execute_sql("UPDATE projects SET desired_state = 'running', updated_at = ? WHERE id = ?", (int(now), sid))
                    await asyncio.sleep(0.2)
                    await start_project_run(sid, trigger="cron_restart")
                except Exception as exc:
                    logger.exception("Ошибка планового cron_restart сервиса id=%s (%s)", sid, svc.get("name"))
                    execute_sql("UPDATE projects SET desired_state = 'running', updated_at = ? WHERE id = ?", (int(now), sid))
                    await restart_with_backoff(
                        sid,
                        exit_code=-1,
                        final_status="failed",
                        log_tail=str(exc),
                        trigger_label="cron_restart",
                        reason_msg=f"Плановый рестарт (cron_restart) сервиса «{svc.get('name')}» не удался: {exc}",
                    )

    # 3. Повторные запуски (retries) для jobs
    if not safe_mode:
        for proj_id, r_state in list(_JOB_RETRIES.items()):
            next_at = float(r_state.get("next_retry_at", 0.0) or 0.0)
            if next_at > 0 and now >= next_at:
                r_state["next_retry_at"] = 0.0
                proj = query_one("SELECT * FROM projects WHERE id = ?", (proj_id,))
                if proj and not is_project_running(proj_id):
                    try:
                        await start_project_run(proj_id, trigger="retry")
                    except Exception:
                        logger.exception("Ошибка повторного запуска задачи id=%s", proj_id)

    # 4. Плановые запуски cron, interval и daily с сохранением next_run_at в БД (P2-06)
    jobs = query_all(
        "SELECT * FROM projects WHERE type = 'job' AND schedule_type IN ('cron', 'interval', 'daily')"
    )
    active_job_ids = {j["id"] for j in jobs}
    for old_id in list(_JOB_SCHEDULES.keys()):
        if old_id not in active_job_ids:
            del _JOB_SCHEDULES[old_id]

    for job in jobs:
        jid = int(job["id"])
        stype = job["schedule_type"]
        sexpr = (job["schedule_expr"] or "").strip()
        if not sexpr:
            continue

        sched = _JOB_SCHEDULES.get(jid)
        if not sched or sched.get("type") != stype or sched.get("expr") != sexpr:
            try:
                db_next = float(job.get("next_run_at") or 0)
                if db_next > 0:
                    if now >= db_next and (now - db_next) > 5.0:
                        if run_missed == "once":
                            next_ts = db_next
                        else:
                            next_ts = _compute_next_schedule_ts(stype, sexpr, now)
                            execute_sql("UPDATE projects SET next_run_at = ? WHERE id = ?", (int(next_ts), jid))
                    else:
                        next_ts = db_next
                else:
                    next_ts = _compute_next_schedule_ts(stype, sexpr, now)
                    execute_sql("UPDATE projects SET next_run_at = ? WHERE id = ?", (int(next_ts), jid))
                _JOB_SCHEDULES[jid] = {"type": stype, "expr": sexpr, "next_run_at": next_ts}
            except Exception as exc:
                logger.warning("Некорректное расписание для job id=%s (%s %s): %s", jid, stype, sexpr, exc)
                continue
            sched = _JOB_SCHEDULES[jid]

        if now >= float(sched["next_run_at"]):
            try:
                next_ts = _compute_next_schedule_ts(stype, sexpr, now)
            except Exception:
                next_ts = now + 60.0
            sched["next_run_at"] = next_ts
            execute_sql("UPDATE projects SET next_run_at = ? WHERE id = ?", (int(next_ts), jid))

            if not safe_mode:
                if is_project_running(jid):
                    msg = f"Пропущен плановый запуск задачи «{job.get('name')}» (id={jid}): предыдущий запуск ещё выполняется"
                    logger.info(msg)
                    log_audit("127.0.0.1", "SCHEDULE_SKIPPED", msg)
                else:
                    try:
                        await start_project_run(jid, trigger="schedule")
                        execute_sql("UPDATE projects SET last_run_at = ? WHERE id = ?", (int(now), jid))
                    except Exception:
                        logger.exception("Ошибка запуска по расписанию задачи id=%s (%s)", jid, job.get("name"))

    # 5. Dead Man's Switch — проверка входящих heartbeat-пингов (включая last_ping_at == 0)
    hb_projects = query_all(
        "SELECT id, name, heartbeat_interval_sec, heartbeat_grace_sec, last_ping_at, created_at, updated_at, health_status FROM projects WHERE heartbeat_interval_sec > 0"
    )
    active_hb_ids = {int(hp["id"]) for hp in hb_projects}
    for old_hb_id in list(_HEARTBEAT_ALERTED.keys()):
        if old_hb_id not in active_hb_ids:
            del _HEARTBEAT_ALERTED[old_hb_id]

    now_int = int(now)
    for hp in hb_projects:
        pid = int(hp["id"])
        interval_s = int(hp["heartbeat_interval_sec"])
        grace_s = max(5, int(hp.get("heartbeat_grace_sec") or 60))
        last_p = int(hp.get("last_ping_at") or 0)
        baseline = last_p if last_p > 0 else max(int(hp.get("created_at") or 0), int(hp.get("updated_at") or 0))
        if baseline > 0 and (now_int - baseline) > (interval_s + grace_s):
            if _HEARTBEAT_ALERTED.get(pid) != last_p:
                _HEARTBEAT_ALERTED[pid] = last_p
                execute_sql("UPDATE projects SET health_status = 'unhealthy' WHERE id = ?", (pid,))
                silence_desc = (
                    f"более {now_int - baseline} сек"
                    if last_p > 0
                    else f"ни разу с момента настройки ({now_int - baseline} сек)"
                )
                await send_notification(
                    f"Dead Man's Switch: проект «{hp['name']}» не присылал пинг {silence_desc} (ожидался каждые {interval_s}с).",
                    level="warn",
                    project_name=hp["name"],
                )

    # Очистка устаревших записей удалённых проектов из in-memory словарей (контроль бюджета ОЗУ < 80 МБ)
    if _SERVICE_BACKOFF or _JOB_RETRIES or _SERVICE_CRON_RESTARTS:
        existing_ids = {int(r["id"]) for r in query_all("SELECT id FROM projects")}
        for cache_dict in (_SERVICE_BACKOFF, _JOB_RETRIES, _SERVICE_CRON_RESTARTS):
            for stale_id in list(cache_dict.keys()):
                if stale_id not in existing_ids:
                    del cache_dict[stale_id]


async def scheduler_loop() -> None:
    """
    Фоновый async-цикл планировщика (каждую 1 секунду).
    """
    set_on_finish_callback(on_run_finished)
    set_on_healthcheck_fail_callback(on_healthcheck_failed)
    last_disk_check = 0.0
    last_hw_guard_check = 0.0
    last_outbound_ping = 0.0

    while True:
        try:
            now = time.time()
            await scheduler_tick(now=now)

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

        except Exception as exc:
            _SCHEDULER_LOOP_STATUS["error_count"] += 1
            _SCHEDULER_LOOP_STATUS["last_error"] = str(exc)
            _SCHEDULER_LOOP_STATUS["last_error_at"] = time.time()
            logger.exception("Ошибка в тике scheduler_loop")
        finally:
            _SCHEDULER_LOOP_STATUS["last_tick_at"] = time.time()
            _SCHEDULER_LOOP_STATUS["ticks"] += 1

        await asyncio.sleep(1.0)
