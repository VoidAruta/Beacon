import asyncio
import hashlib
import hmac
import json
import logging
from pathlib import Path
import time
import unittest
from unittest.mock import patch

from hub.__main__ import _WebhookRedactFilter
from hub.api import HTTPException
from hub.api.routes_internal import internal_kv_put
from hub.api.routes_ui import (
    api_create_project,
    api_dead_mans_switch_ping,
    api_delete_project,
    api_put_project_kv,
    api_trigger_webhook,
    api_update_project,
)
from hub.ask_broker import _process_tg_updates, answer_ask, create_ask, poll_ask
import hub.ask_broker as ask_broker
from hub.db import execute_sql, get_setting, query_one, set_setting
from hub.disk_guard import rotate_and_prune_logs
from hub.process_mgr import ACTIVE_RUNS
import hub.scheduler as sched
from tests.helpers import DummyRequest, make_project, temp_hub_env


def _admin_req(**kwargs):
    req = DummyRequest(**kwargs)
    req.state.session = {"role": "admin", "user": "admin", "sid": "adm-sid"}
    return req


class TestSchedulerAndTelegram(unittest.TestCase):
    def setUp(self) -> None:
        sched._SERVICE_BACKOFF.clear()
        sched._JOB_RETRIES.clear()
        sched._JOB_SCHEDULES.clear()
        sched._SERVICE_CRON_RESTARTS.clear()
        sched._HEARTBEAT_ALERTED.clear()
        ask_broker._ASK_EVENTS.clear()
        ask_broker._TG_OFFSET = 0
        ask_broker._TG_BOOTSTRAPPED = False
        ACTIVE_RUNS.clear()

    def tearDown(self) -> None:
        ACTIVE_RUNS.clear()
        sched._SERVICE_BACKOFF.clear()
        sched._JOB_SCHEDULES.clear()
        sched._HEARTBEAT_ALERTED.clear()

    def test_p2_05_telegram_offset_acl_reply_and_stale_message(self) -> None:
        with temp_hub_env():
            proj = make_project("tg-ask-proj", proj_type="job", cmd="sleep 5")
            pid = int(proj["id"])
            now = int(time.time())
            run_id = execute_sql(
                """INSERT INTO runs (project_id, status, trigger, started_at, run_token, log_path)
                   VALUES (?, 'running', 'manual', ?, 'tok-tg-1', 'x.log')""",
                (pid, now),
            )

            async def _run():
                with patch("hub.ask_broker.send_telegram_message", return_value=777):
                    ask_id = await create_ask(run_id, pid, "tg-ask-proj", "Код?", timeout=60)

                cfg = {"tg_chat_id": "1001", "tg_allowed_user_ids": "555"}
                # 1. Сообщение не от разрешённого user_id -> игнорируется
                await _process_tg_updates(
                    [
                        {
                            "update_id": 10,
                            "message": {
                                "chat": {"id": 1001},
                                "from": {"id": 999},
                                "date": now + 5,
                                "text": "wrong-user",
                                "reply_to_message": {"message_id": 777},
                            },
                        }
                    ],
                    cfg,
                )
                self.assertEqual(query_one("SELECT status FROM pending_asks WHERE id = ?", (ask_id,))["status"], "pending")
                self.assertEqual(get_setting("tg_offset"), "11")

                # 2. Не-Reply (обычное сообщение в чате, даже от 555) -> НЕ принимается
                await _process_tg_updates(
                    [
                        {
                            "update_id": 11,
                            "message": {
                                "chat": {"id": 1001},
                                "from": {"id": 555},
                                "date": now + 6,
                                "text": "non-reply",
                            },
                        }
                    ],
                    cfg,
                )
                self.assertEqual(query_one("SELECT status FROM pending_asks WHERE id = ?", (ask_id,))["status"], "pending")

                # 3. Устаревший Reply (message.date < ask.created_at) -> игнорируется
                await _process_tg_updates(
                    [
                        {
                            "update_id": 12,
                            "message": {
                                "chat": {"id": 1001},
                                "from": {"id": 555},
                                "date": now - 120,
                                "text": "stale-reply",
                                "reply_to_message": {"message_id": 777},
                            },
                        }
                    ],
                    cfg,
                )
                self.assertEqual(query_one("SELECT status FROM pending_asks WHERE id = ?", (ask_id,))["status"], "pending")

                # 4. Валидный Reply от 555 -> принимается
                with patch("hub.ask_broker.send_telegram_message", return_value=778):
                    await _process_tg_updates(
                        [
                            {
                                "update_id": 13,
                                "message": {
                                    "chat": {"id": 1001},
                                    "from": {"id": 555},
                                    "date": now + 10,
                                    "text": "123456",
                                    "reply_to_message": {"message_id": 777},
                                },
                            }
                        ],
                        cfg,
                    )
                row = query_one("SELECT status, answer FROM pending_asks WHERE id = ?", (ask_id,))
                self.assertEqual(row["status"], "answered")
                self.assertEqual(row["answer"], "123456")
                self.assertEqual(get_setting("tg_offset"), "14")

            asyncio.run(_run())

    def test_p2_06_schedule_validation_daily_chain_and_missed_runs(self) -> None:
        with temp_hub_env():
            async def _run():
                # Некорректный interval (< 5) и некорректный daily -> 400
                with self.assertRaises(HTTPException) as ctx1:
                    await api_create_project(
                        _admin_req(
                            body={
                                "name": "bad-interval",
                                "type": "job",
                                "runtime": "bash",
                                "schedule_type": "interval",
                                "schedule_expr": "2",
                            }
                        )
                    )
                self.assertEqual(ctx1.exception.status_code, 400)

                with self.assertRaises(HTTPException) as ctx2:
                    await api_create_project(
                        _admin_req(
                            body={
                                "name": "bad-daily",
                                "type": "job",
                                "runtime": "bash",
                                "schedule_type": "daily",
                                "schedule_expr": "25:99",
                            }
                        )
                    )
                self.assertEqual(ctx2.exception.status_code, 400)

                # Создание проекта с расписанием daily и проверка циклов on_success_project_id
                p1 = await api_create_project(
                    _admin_req(
                        body={
                            "name": "chain-a",
                            "type": "job",
                            "runtime": "bash",
                            "schedule_type": "daily",
                            "schedule_expr": "04:15",
                        }
                    )
                )
                p2 = await api_create_project(
                    _admin_req(
                        body={
                            "name": "chain-b",
                            "type": "job",
                            "runtime": "bash",
                            "on_success_project_id": p1["id"],
                        }
                    )
                )
                self.assertEqual(p1["schedule_type"], "daily")

                # Попытка замкнуть A -> B -> A должна дать 400
                with self.assertRaises(HTTPException) as ctx3:
                    await api_update_project(
                        _admin_req(body={"on_success_project_id": p2["id"]}),
                        p1["id"],
                    )
                self.assertEqual(ctx3.exception.status_code, 400)

                # Проверка лимита глубины цепочки (MAX_CHAIN_DEPTH=5)
                with patch("hub.scheduler.start_project_run") as mock_start, patch(
                    "hub.scheduler.send_notification"
                ) as mock_notif:
                    await sched.on_run_finished(
                        {
                            "id": p2["id"],
                            "name": "chain-b",
                            "type": "job",
                            "_chain_depth": sched.MAX_CHAIN_DEPTH,
                        },
                        exit_code=0,
                        final_status="success",
                        log_tail="",
                    )
                    mock_start.assert_not_called()
                    mock_notif.assert_called_once()

                # Проверка run_missed='once' vs 'none' и сохранения next_run_at в БД
                missed_job = int(
                    make_project(
                        "missed-job",
                        proj_type="job",
                        cmd="true",
                        schedule_type="interval",
                        schedule_expr="60",
                    )["id"]
                )
                now = time.time()
                execute_sql("UPDATE projects SET next_run_at = ? WHERE id = ?", (int(now) - 120, missed_job))

                set_setting("run_missed", "none")
                sched._JOB_SCHEDULES.clear()
                with patch("hub.scheduler.start_project_run") as mock_start_none:
                    await sched.scheduler_tick(now=now)
                    mock_start_none.assert_not_called()
                row_after_none = query_one("SELECT next_run_at FROM projects WHERE id = ?", (missed_job,))
                self.assertGreater(row_after_none["next_run_at"], int(now))

                # Теперь run_missed='once' должен запустить просроченную задачу 1 раз
                execute_sql("UPDATE projects SET next_run_at = ? WHERE id = ?", (int(now) - 120, missed_job))
                set_setting("run_missed", "once")
                sched._JOB_SCHEDULES.clear()
                with patch("hub.scheduler.start_project_run") as mock_start_once:
                    await sched.scheduler_tick(now=now)
                    mock_start_once.assert_called_once_with(missed_job, trigger="schedule")

            asyncio.run(_run())

    def test_p2_06_healthcheck_backoff_heartbeat_zero_and_autostart_ram(self) -> None:
        with temp_hub_env():
            async def _run():
                # 1. Healthcheck 3-fail использует restart_with_backoff и останавливается по max_restarts
                svc = int(
                    make_project(
                        "hc-svc",
                        proj_type="service",
                        cmd="sleep 60",
                        max_restarts=2,
                        restart_delay_sec=1,
                        min_uptime_sec=30,
                    )["id"]
                )
                execute_sql("UPDATE projects SET desired_state = 'running' WHERE id = ?", (svc,))
                with patch("hub.scheduler.send_notification"):
                    await sched.on_healthcheck_failed({"id": svc, "name": "hc-svc"}, "fail1", "")
                    row1 = query_one("SELECT crash_loop_count, desired_state FROM projects WHERE id = ?", (svc,))
                    self.assertEqual(row1["crash_loop_count"], 1)
                    self.assertEqual(row1["desired_state"], "running")

                    await sched.on_healthcheck_failed({"id": svc, "name": "hc-svc"}, "fail2", "")
                    row2 = query_one("SELECT desired_state, health_status FROM projects WHERE id = ?", (svc,))
                    self.assertEqual(row2["desired_state"], "stopped")
                    self.assertEqual(row2["health_status"], "crash_loop")

                # 2. Dead Man's Switch с last_ping_at == 0 срабатывает и при ping отправляет recovery
                hb_proj = int(make_project("hb-zero-proj", proj_type="job", cmd="true")["id"])
                past = int(time.time()) - 500
                execute_sql(
                    "UPDATE projects SET heartbeat_interval_sec = 30, heartbeat_grace_sec = 10, last_ping_at = 0, created_at = ?, updated_at = ? WHERE id = ?",
                    (past, past, hb_proj),
                )
                with patch("hub.scheduler.send_notification") as mock_hb_alert:
                    await sched.scheduler_tick(now=time.time())
                    self.assertGreaterEqual(mock_hb_alert.call_count, 1)
                self.assertEqual(query_one("SELECT health_status FROM projects WHERE id = ?", (hb_proj,))["health_status"], "unhealthy")

                ping_tok = query_one("SELECT ping_token FROM projects WHERE id = ?", (hb_proj,))["ping_token"]
                with patch("hub.api.routes_ui.send_notification") as mock_recov:
                    res = await api_dead_mans_switch_ping(DummyRequest(path=f"/api/ping/{ping_tok}"), ping_tok)
                    self.assertEqual(res["health_status"], "healthy")
                    mock_recov.assert_called_once()

                # 3. Autostart пропускает сервис при нехватке RAM и соблюдает stagger
                auto_svc = int(make_project("heavy-svc", proj_type="service", cmd="sleep 60", autostart=1, ram_limit_mb=999999)["id"])
                execute_sql("UPDATE projects SET autostart = 1, ram_limit_mb = 999999 WHERE id = ?", (auto_svc,))
                set_setting("autostart_stagger_sec", "0")
                fake_vm = type("VM", (), {"available": 10 * 1024 * 1024})()
                with patch("hub.scheduler.psutil.virtual_memory", return_value=fake_vm), patch(
                    "hub.scheduler.start_project_run"
                ) as mock_auto_start, patch("hub.scheduler.send_notification") as mock_auto_warn:
                    await sched.autostart_services_on_boot()
                    mock_auto_start.assert_not_called()
                    mock_auto_warn.assert_called_once()

            asyncio.run(_run())

    def test_p2_08_retention_answer_wipe_and_kv_limits(self) -> None:
        with temp_hub_env():
            pid = int(make_project("kv-ret-proj", proj_type="job", cmd="true")["id"])
            now = int(time.time())
            run_id = execute_sql(
                """INSERT INTO runs (project_id, status, trigger, started_at, run_token, log_path)
                   VALUES (?, 'running', 'manual', ?, 'tok-ret-1', 'r.log')""",
                (pid, now),
            )

            async def _run():
                with patch("hub.ask_broker.send_telegram_message", return_value=None):
                    ask_id = await create_ask(run_id, pid, "kv-ret-proj", "2FA?", timeout=60)
                answer_ask(ask_id, "secret-code-99", source="web")
                polled = await poll_ask(ask_id, wait_sec=0.1)
                self.assertEqual(polled["status"], "answered")
                self.assertEqual(polled["answer"], "secret-code-99")
                # После доставки ответ в БД должен быть очищен
                after_row = query_one("SELECT answer FROM pending_asks WHERE id = ?", (ask_id,))
                self.assertIsNone(after_row["answer"])

                # Проверка лимитов KV (256 КБ и 1000 ключей)
                too_big = "x" * (257 * 1024)
                with self.assertRaises(HTTPException) as ctx_big:
                    await internal_kv_put(
                        DummyRequest(headers={"x-beacon-token": "tok-ret-1"}, body={"value": too_big}),
                        "big_key",
                    )
                self.assertEqual(ctx_big.exception.status_code, 413)

                with self.assertRaises(HTTPException) as ctx_ui_big:
                    await api_put_project_kv(_admin_req(body={"value": too_big}), pid, "big_key")
                self.assertEqual(ctx_ui_big.exception.status_code, 413)

                # Вставляем 1000 ключей, 1001-й отклоняется 400
                for i in range(1000):
                    execute_sql(
                        "INSERT INTO project_kv (project_id, key, value_json, updated_at) VALUES (?, ?, '1', ?)",
                        (pid, f"k_{i}", now),
                    )
                with self.assertRaises(HTTPException) as ctx_max:
                    await internal_kv_put(
                        DummyRequest(headers={"x-beacon-token": "tok-ret-1"}, body={"value": 1}),
                        "k_overflow",
                    )
                self.assertEqual(ctx_max.exception.status_code, 400)

            asyncio.run(_run())

            # Проверка ретенции rotate_and_prune_logs()
            old_100d = now - 100 * 86400
            old_40d = now - 40 * 86400
            old_10d = now - 10 * 86400
            execute_sql("INSERT INTO audit_log (timestamp, ip, action, details) VALUES (?, '1.1.1.1', 'OLD', 'd')", (old_100d,))
            execute_sql("INSERT INTO audit_log (timestamp, ip, action, details) VALUES (?, '1.1.1.1', 'NEW', 'd')", (now,))
            execute_sql(
                "INSERT INTO ai_audit_log (timestamp, token_id, token_name, ip, tool_or_endpoint, args_summary, status, result_summary) VALUES (?, 1, 't', '1.1.1.1', 'tool', '{}', 'ok', 'ok')",
                (old_40d,),
            )
            execute_sql(
                "INSERT INTO ai_approvals (id, token_id, token_name, action, status, created_at) VALUES ('apr-old', 1, 't', 'write_file', 'approved', ?)",
                (old_40d,),
            )
            execute_sql(
                "INSERT INTO pending_asks (id, run_id, project_id, prompt, status, created_at, expires_at) VALUES ('ask-old', ?, ?, 'p', 'timeout', ?, ?)",
                (run_id, pid, old_10d, old_10d + 60),
            )
            execute_sql("INSERT INTO revoked_sessions (sid, exp) VALUES ('expired-sid', ?)", (now - 10,))

            stats = rotate_and_prune_logs()
            self.assertGreaterEqual(stats["pruned_audit"], 1)
            self.assertGreaterEqual(stats["pruned_ai_audit"], 1)
            self.assertGreaterEqual(stats["pruned_approvals"], 1)
            self.assertGreaterEqual(stats["pruned_asks"], 1)
            self.assertGreaterEqual(stats["pruned_sessions"], 1)
            self.assertIsNotNone(query_one("SELECT id FROM audit_log WHERE action = 'NEW'"))
            self.assertIsNone(query_one("SELECT id FROM audit_log WHERE action = 'OLD'"))

    def test_p2_17_webhook_409_hmac_log_redact_and_delete_cleanup(self) -> None:
        with temp_hub_env():
            async def _run():
                p_main = await api_create_project(
                    _admin_req(
                        body={
                            "name": "del-target",
                            "type": "job",
                            "runtime": "bash",
                            "cmd": "sleep 10",
                            "webhook_hmac_secret": "my-hmac-key",
                        }
                    )
                )
                p_ref = await api_create_project(
                    _admin_req(
                        body={
                            "name": "chain-caller",
                            "type": "job",
                            "runtime": "bash",
                            "on_success_project_id": p_main["id"],
                        }
                    )
                )

                wh_tok = p_main["webhook_token"]
                raw_payload = b'{"event":"push"}'

                # Без HMAC-подписи -> 401
                with self.assertRaises(HTTPException) as ctx_sig:
                    await api_trigger_webhook(DummyRequest(raw_body=raw_payload, path=f"/api/webhook/{wh_tok}"), wh_tok)
                self.assertEqual(ctx_sig.exception.status_code, 401)

                # С валидной подписью, но проект уже запущен -> 409
                valid_sig = "sha256=" + hmac.new(b"my-hmac-key", raw_payload, hashlib.sha256).hexdigest()
                ACTIVE_RUNS[9991] = {"run_id": 9991, "project_id": p_main["id"], "pid": 12345}
                resp_409 = await api_trigger_webhook(
                    DummyRequest(
                        headers={"x-beacon-signature": valid_sig},
                        raw_body=raw_payload,
                        path=f"/api/webhook/{wh_tok}",
                    ),
                    wh_tok,
                )
                self.assertEqual(resp_409.status_code, 409)
                ACTIVE_RUNS.clear()

                # Фильтр лога маскирует токен вебхука и пинга
                filt = _WebhookRedactFilter()
                rec = logging.LogRecord(
                    "uvicorn.access",
                    logging.INFO,
                    "",
                    0,
                    '127.0.0.1 - "POST /api/webhook/%s HTTP/1.1" 200',
                    (wh_tok,),
                    None,
                )
                filt.filter(rec)
                self.assertNotIn(wh_tok, rec.getMessage())
                self.assertIn("/api/webhook/***", rec.getMessage())

                # Удаление проекта очищает on_success_project_id, логи и workdir при delete_files=true
                from hub.config import LOGS_DIR

                (LOGS_DIR / "del-target").mkdir(parents=True, exist_ok=True)
                (LOGS_DIR / "del-target" / "1.log").write_text("hi", encoding="utf-8")
                del_res = await api_delete_project(
                    _admin_req(query_params={"delete_files": "true"}),
                    p_main["id"],
                )
                self.assertTrue(del_res["ok"])
                self.assertTrue(del_res["deleted_files"])
                self.assertFalse((LOGS_DIR / "del-target").exists())
                self.assertFalse(Path(p_main["workdir"]).exists())
                ref_row = query_one("SELECT on_success_project_id FROM projects WHERE id = ?", (p_ref["id"],))
                self.assertEqual(int(ref_row["on_success_project_id"] or 0), 0)

            asyncio.run(_run())


if __name__ == "__main__":
    unittest.main()
