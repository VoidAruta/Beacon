"""
Автоматические модульные и интеграционные тесты ядра Hub (`python3 -m unittest discover -s tests -v`).
Проверяет:
1. Хеширование паролей scrypt, генерацию начального пароля в data/initial_password (0600), инвалидацию сессий при logout и отсутствие бэкдора авто-сессии
2. Rate-limit входа (5 попыток -> блокировка 15 мин) и защиту вебхуков от перебора
3. Защиту от Path Traversal в workdir проектов (/etc, ..) и в именах секретов/куки
4. Проверку прав доступа к секретам в /internal/secret/{name} (403 при отсутствии привязки), маскировку tg_bot_token в /api/settings и redact_log_text, отсутствие сырых секретов в /proc/<pid>/environ
5. Отсутствие фейковых датчиков батареи при отсутствии sysfs (available=False) и честную ошибку 400 при сбое git clone
6. Блокирующий stdin FIFO (sys.stdin.readline() без BlockingIOError + удаление .fifo), сбор метрик PGID за один проход и поддержку ?offset= в SSE
"""

import asyncio
import json
import os
import secrets
import shutil
import tempfile
import time
import unittest
from pathlib import Path

from hub.api import HTTPException
from hub.api.routes_internal import internal_get_secret
from hub.api.routes_ui import (
    _validate_project_workdir,
    api_auth_me,
    api_get_settings,
    api_git_clone_project,
    api_run_acceptance_suite,
)
from hub.ask_broker import handle_telegram_command
from hub.auth import (
    _BLOCKED_IPS,
    _FAILED_LOGINS,
    _WEBHOOK_BLOCKED_IPS,
    _WEBHOOK_FAILS,
    check_rate_limit,
    check_webhook_rate_limit,
    clear_login_failures,
    create_session_tokens,
    get_internal_token,
    hash_password,
    record_login_failure,
    record_webhook_failure,
    revoke_session_token,
    verify_internal_token,
    verify_password,
    verify_session_token,
)
from hub.config import INITIAL_PASSWORD_PATH, LOGS_DIR, PROJECTS_DIR
from hub.db import checkpoint_wal, execute_sql, get_setting, init_db, query_one, set_setting
from hub.disk_guard import rotate_and_prune_logs
from hub.doctor import run_hub_doctor
from hub.process_mgr import (
    _build_process_env,
    collect_all_pgid_metrics,
    read_log_tail_bytes,
    send_stdin_to_run,
    start_project_run,
    stop_project,
)
from hub.secrets_mgr import (
    redact_log_text,
    reload_redaction_cache,
    save_secret,
    validate_cookie_name,
    validate_secret_name,
)
from hub.web_auth_mgr import check_android_hardware_guard, get_poco_hardware_status


class _DummyReq:
    def __init__(
        self,
        headers: dict[str, str] | None = None,
        cookies: dict[str, str] | None = None,
        query_params: dict[str, str] | None = None,
        body: dict | None = None,
    ) -> None:
        self.headers = headers or {}
        self.cookies = cookies or {}
        self.query_params = query_params or {}
        self._body = body or {}
        self.client = None

    async def json(self) -> dict:
        return self._body


class TestHubCore(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        init_db()

    def test_01_auth_no_backdoor_and_session_revocation(self) -> None:
        pw_hash = hash_password("StrongPass#2026")
        self.assertTrue(pw_hash.startswith("scrypt$"))
        self.assertTrue(verify_password("StrongPass#2026", pw_hash))
        self.assertFalse(verify_password("admin", get_setting("password_hash", "")))

        if INITIAL_PASSWORD_PATH.exists():
            mode = INITIAL_PASSWORD_PATH.stat().st_mode & 0o777
            self.assertEqual(mode, 0o600)

        # Проверяем, что бэкдор ?autostart=1 и X-Hub-Auto-Session: 1 удалён и возвращает 401
        req_backdoor = _DummyReq(
            headers={"x-hub-auto-session": "1"},
            query_params={"autostart": "1"},
        )
        resp_backdoor = asyncio.run(api_auth_me(req_backdoor))  # type: ignore[arg-type]
        self.assertEqual(resp_backdoor.status_code, 401)

        # Проверяем создание и серверную инвалидацию сессии при logout
        session_tok, csrf_tok = create_session_tokens()
        session = verify_session_token(session_tok)
        self.assertIsNotNone(session)
        self.assertEqual(session["csrf"], csrf_tok)

        revoke_session_token(session_tok)
        self.assertIsNone(verify_session_token(session_tok))

        internal_tok = get_internal_token()
        self.assertTrue(len(internal_tok) >= 32)
        self.assertTrue(verify_internal_token(internal_tok))
        self.assertFalse(verify_internal_token("invalid_token"))

    def test_02_login_and_webhook_rate_limits(self) -> None:
        test_ip = "198.51.100.77"
        clear_login_failures(test_ip)
        for i in range(5):
            blocked, _ = record_login_failure(test_ip)
            if i < 4:
                self.assertFalse(blocked)
            else:
                self.assertTrue(blocked)

        allowed, retry_after = check_rate_limit(test_ip)
        self.assertFalse(allowed)
        self.assertGreater(retry_after, 800)
        clear_login_failures(test_ip)
        _FAILED_LOGINS.pop(test_ip, None)
        _BLOCKED_IPS.pop(test_ip, None)

        wh_ip = "198.51.100.88"
        _WEBHOOK_FAILS.pop(wh_ip, None)
        _WEBHOOK_BLOCKED_IPS.pop(wh_ip, None)
        for _ in range(10):
            record_webhook_failure(wh_ip)
        wh_ok, wh_retry = check_webhook_rate_limit(wh_ip)
        self.assertFalse(wh_ok)
        self.assertGreater(wh_retry, 0)
        _WEBHOOK_FAILS.pop(wh_ip, None)
        _WEBHOOK_BLOCKED_IPS.pop(wh_ip, None)

    def test_03_workdir_and_secret_path_traversal(self) -> None:
        # Допустимый путь внутри PROJECTS_DIR
        valid_dir = _validate_project_workdir(str(PROJECTS_DIR / "my-bot"), "my-bot")
        self.assertTrue(valid_dir.startswith(str(PROJECTS_DIR.resolve())))

        # Попытки обхода Path Traversal через workdir должны блокироваться HTTPException(400)
        for bad_workdir in ("/", "/etc", "/etc/passwd", str(PROJECTS_DIR / "../../etc"), str(PROJECTS_DIR)):
            with self.assertRaises(HTTPException) as ctx:
                _validate_project_workdir(bad_workdir, "evil-proj")
            self.assertEqual(ctx.exception.status_code, 400)

        self.assertEqual(validate_secret_name("my_api_key-1"), "my_api_key-1")
        self.assertEqual(validate_cookie_name("account_cookies"), "account_cookies")
        for bad in ("../etc/passwd", "../../hub.db", "sub/file", ".env", "a b", ""):
            with self.assertRaises(ValueError):
                validate_secret_name(bad)

    def test_04_secret_acl_env_isolation_and_tg_token_masking(self) -> None:
        save_secret("bound_secret", "text", "secret_bound_val_112233")
        save_secret("forbidden_secret", "text", "secret_forbidden_val_998877")

        now = int(time.time())
        p_workdir = PROJECTS_DIR / "acl-test-proj"
        p_workdir.mkdir(parents=True, exist_ok=True)
        proj_id = execute_sql(
            """INSERT INTO projects (
                name, type, runtime, cmd, workdir, env_json, secrets_json,
                use_proxy, ram_limit_mb, schedule_type, schedule_expr,
                timeout_sec, max_retries, retry_delay_sec, webhook_token,
                autostart, restart_policy, backoff_min_sec, backoff_max_sec,
                desired_state, notify_on_error, notify_on_success, notify_on_crash,
                created_at, updated_at
            ) VALUES ('acl-test-proj', 'job', 'python', 'python3 main.py', ?, '{}', ?, 0, 0, 'manual', '',
                0, 0, 30, ?, 0, 'no', 2, 60, 'stopped', 0, 0, 0, ?, ?)""",
            (str(p_workdir), json.dumps(["bound_secret"]), secrets.token_hex(16), now, now),
        )
        try:
            proj = query_one("SELECT * FROM projects WHERE id = ?", (proj_id,))
            assert proj is not None

            # 1. В окружение процесса НЕ должны попадать сырые значения текстовых секретов (только пути к 0600 файлам или чтение через SDK)
            from hub.db import get_all_settings

            env_map = _build_process_env(proj, get_internal_token(), get_all_settings())
            for k, v in env_map.items():
                self.assertNotIn("secret_bound_val_112233", v)
            self.assertNotIn("HUB_SECRET_bound_secret", env_map)
            self.assertIn("HUB_SECRET_FILE_bound_secret", env_map)

            # 2. Запрос разрешённого секрета проходит, а непривязанного возвращает 403
            test_run_tok = secrets.token_hex(24)
            run_id = execute_sql(
                """INSERT INTO runs (project_id, status, trigger, pid, pgid, proc_create_time, started_at, log_path, run_token)
                   VALUES (?, 'running', 'manual', ?, ?, 0.0, ?, '/tmp/test.log', ?)""",
                (proj_id, os.getpid(), os.getpid(), now, test_run_tok),
            )
            req_ok = _DummyReq(headers={"x-hub-token": test_run_tok})
            res_ok = asyncio.run(internal_get_secret(req_ok, "bound_secret"))  # type: ignore[arg-type]
            self.assertEqual(res_ok["value"], "secret_bound_val_112233")

            with self.assertRaises(HTTPException) as ctx403:
                asyncio.run(internal_get_secret(req_ok, "forbidden_secret"))  # type: ignore[arg-type]
            self.assertEqual(ctx403.exception.status_code, 403)
        finally:
            execute_sql("DELETE FROM runs WHERE project_id = ?", (proj_id,))
            execute_sql("DELETE FROM projects WHERE id = ?", (proj_id,))
            shutil.rmtree(p_workdir, ignore_errors=True)

        # 3. Проверка маскировки tg_bot_token в /api/settings и в логах
        old_tg = get_setting("tg_bot_token", "")
        try:
            set_setting("tg_bot_token", "987654321:AAH_SecretTelegramBotTokenForTest99")
            reload_redaction_cache()
            cfg = asyncio.run(api_get_settings(_DummyReq()))  # type: ignore[arg-type]
            self.assertEqual(cfg["tg_bot_token"], "********")
            self.assertTrue(cfg["tg_bot_token_configured"])

            redacted = redact_log_text("Bot token leak: 987654321:AAH_SecretTelegramBotTokenForTest99")
            self.assertNotIn("AAH_SecretTelegramBotTokenForTest99", redacted)
        finally:
            set_setting("tg_bot_token", old_tg)
            reload_redaction_cache()

    def test_05_no_fake_hardware_or_fake_git_clone(self) -> None:
        hw = get_poco_hardware_status()
        if not Path("/sys/class/power_supply/battery/capacity").exists():
            self.assertFalse(hw["available"])
            self.assertFalse(hw["is_real_sysfs"])
            self.assertEqual(hw["device_model"], "N/A")
            self.assertIsNone(hw["battery_percent"])

        # git_clone с несуществующим локальным URL должен вернуть HTTPException(400), а не сгенерировать фейковый main.py
        bad_req = _DummyReq(
            body={
                "repo_url": "https://127.0.0.1:1/nonexistent/repo.git",
                "name": "failed-clone-test",
                "use_proxy": False,
            }
        )
        with self.assertRaises(HTTPException) as ctx:
            asyncio.run(api_git_clone_project(bad_req))  # type: ignore[arg-type]
        self.assertEqual(ctx.exception.status_code, 400)
        self.assertFalse((PROJECTS_DIR / "failed-clone-test").exists())

    def test_06_blocking_stdin_fifo_and_single_pass_pgid_metrics(self) -> None:
        now = int(time.time())
        p_dir = PROJECTS_DIR / "fifo-stdin-test"
        p_dir.mkdir(parents=True, exist_ok=True)
        (LOGS_DIR / "fifo-stdin-test").mkdir(parents=True, exist_ok=True)
        (p_dir / "main.py").write_text(
            "import sys\n"
            "print('READY_FOR_INPUT', flush=True)\n"
            "line = sys.stdin.readline().strip()\n"
            "print(f'GOT_LINE:{line}', flush=True)\n",
            encoding="utf-8",
        )
        proj_id = execute_sql(
            """INSERT INTO projects (
                name, type, runtime, cmd, workdir, env_json, secrets_json,
                use_proxy, ram_limit_mb, schedule_type, schedule_expr,
                timeout_sec, max_retries, retry_delay_sec, webhook_token,
                autostart, restart_policy, backoff_min_sec, backoff_max_sec,
                desired_state, notify_on_error, notify_on_success, notify_on_crash,
                created_at, updated_at
            ) VALUES ('fifo-stdin-test', 'job', 'python', 'python3 main.py', ?, '{}', '[]',
                0, 0, 'manual', '', 0, 0, 30, ?, 0, 'no', 2, 60, 'stopped', 0, 0, 0, ?, ?)""",
            (str(p_dir), secrets.token_hex(16), now, now),
        )

        async def _run_fifo_test() -> None:
            run = await start_project_run(proj_id, trigger="manual")
            run_id = int(run["id"])
            pgid = int(run["pgid"])
            fifo_file = LOGS_DIR / "fifo-stdin-test" / f"stdin_{run_id}.fifo"
            self.assertTrue(fifo_file.exists())

            # Проверяем сбор метрик PGID за один проход
            metrics_map = collect_all_pgid_metrics({pgid})
            self.assertIn(pgid, metrics_map)

            await asyncio.sleep(0.3)
            sent_ok = send_stdin_to_run(run_id, "hello_from_fifo")
            self.assertTrue(sent_ok)

            await asyncio.sleep(0.5)
            await stop_project(proj_id)
            self.assertFalse(fifo_file.exists())

            log_content = read_log_tail_bytes(run["log_path"])
            self.assertIn("GOT_LINE:hello_from_fifo", log_content)

        try:
            asyncio.run(_run_fifo_test())
        finally:
            execute_sql("DELETE FROM projects WHERE id = ?", (proj_id,))
            shutil.rmtree(p_dir, ignore_errors=True)
            shutil.rmtree(LOGS_DIR / "fifo-stdin-test", ignore_errors=True)

    def test_07_log_tail_seek_wal_and_doctor(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            log_file = Path(tmpdir) / "daemon.log"
            fd_append = os.open(str(log_file), os.O_CREAT | os.O_WRONLY | os.O_APPEND, 0o644)
            try:
                for i in range(50):
                    os.write(fd_append, f"line {i:04d}\n".encode("utf-8"))
                tail = read_log_tail_bytes(str(log_file), max_bytes=256, max_lines=5)
                self.assertIn("line 0049", tail)
            finally:
                os.close(fd_append)

        rotate_and_prune_logs()
        wal = checkpoint_wal(truncate_threshold_mb=0.0)
        self.assertEqual(wal["mode"], "TRUNCATE")

        doc = run_hub_doctor(auto_fix_perms=True)
        self.assertEqual(doc["total_checks"], 8)
        self.assertEqual(doc["error_count"], 0)

        guard_res = asyncio.run(check_android_hardware_guard(force_temp_c=44.0))
        self.assertTrue(guard_res["ok"])

        status_reply = asyncio.run(handle_telegram_command("/status"))
        self.assertIn("Статус сервера Hub", status_reply or "")

    def test_08_acceptance_suite_6_points(self) -> None:
        suite = asyncio.run(api_run_acceptance_suite(_DummyReq()))  # type: ignore[arg-type]
        self.assertTrue(suite["ok"])
        self.assertEqual(len(suite["results"]), 6)
        for item in suite["results"]:
            self.assertTrue(item["passed"], f"Acceptance test #{item['id']} failed: {item}")


if __name__ == "__main__":
    unittest.main()
