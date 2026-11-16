"""Тесты процессов и супервизора Beacon (PR-1, P0-3, P1-5, P1-6)."""

import asyncio
import os
from pathlib import Path
import time
import unittest
from unittest.mock import patch

from hub.api import HTTPException
from hub.compat import psutil
from hub.db import execute_sql, query_all, query_one
from hub.process_mgr import (
    ACTIVE_RUNS,
    recover_running_processes,
    start_project_run,
    stop_project,
    watch_processes_loop,
)
from tests.helpers import DummyRequest, create_temp_hub, make_project


class TestProcessSupervisor(unittest.TestCase):
    def test_p0_3_exec_run_does_not_kill_running_service_or_wipe_tmp(self) -> None:
        with create_temp_hub():
            proj = make_project("svc-p03", proj_type="service", runtime="bash", cmd="sleep 120")
            proj_id = int(proj["id"])
            workdir = Path(proj["workdir"])
            tmp_keep = workdir / ".tmp" / "service_state.tmp"
            tmp_keep.parent.mkdir(parents=True, exist_ok=True)
            tmp_keep.write_text("alive", encoding="utf-8")

            async def _scenario() -> None:
                run_svc = await start_project_run(proj_id, trigger="manual")
                run_exec = await start_project_run(
                    proj_id,
                    trigger="manual",
                    custom_cmd="/bin/bash -c true",
                )
                task = asyncio.create_task(watch_processes_loop())
                try:
                    deadline = time.time() + 6.0
                    while time.time() < deadline:
                        exec_row = query_one("SELECT status, exit_code FROM runs WHERE id = ?", (run_exec["id"],))
                        if exec_row and exec_row["status"] != "running":
                            break
                        await asyncio.sleep(0.25)

                    exec_row = query_one("SELECT status, exit_code FROM runs WHERE id = ?", (run_exec["id"],))
                    self.assertIsNotNone(exec_row)
                    self.assertEqual(exec_row["status"], "success")  # type: ignore[index]

                    # Работающий сервис и его .tmp-файл обязаны остаться живы
                    svc_row = query_one("SELECT status FROM runs WHERE id = ?", (run_svc["id"],))
                    self.assertIsNotNone(svc_row)
                    self.assertEqual(svc_row["status"], "running")  # type: ignore[index]
                    self.assertIn(int(run_svc["id"]), ACTIVE_RUNS)
                    p = psutil.Process(int(run_svc["pid"]))
                    self.assertTrue(p.is_running() and p.status() != "zombie")
                    self.assertTrue(tmp_keep.exists(), "cleanup_project_tmp_dir удалил .tmp при активном сервисе")
                finally:
                    task.cancel()
                    try:
                        await task
                    except asyncio.CancelledError:
                        pass
                    await stop_project(proj_id)
                    self.assertFalse(tmp_keep.exists(), "stop_project должен очищать .tmp после остановки всех запусков")

            asyncio.run(_scenario())

    def test_p1_5_invalid_cmd_and_popen_failure_leave_no_running_row(self) -> None:
        with create_temp_hub():
            bad_proj = make_project(
                "bad-quote-proj",
                proj_type="service",
                runtime="python",
                cmd='python3 -c "unterminated',
                desired_state="stopped",
                health_status="stopped",
            )
            bad_id = int(bad_proj["id"])

            with self.assertRaises(ValueError):
                asyncio.run(start_project_run(bad_id, trigger="manual"))

            stuck = query_all("SELECT * FROM runs WHERE project_id = ? AND status = 'running'", (bad_id,))
            self.assertEqual(stuck, [])
            proj_after = query_one("SELECT desired_state, health_status FROM projects WHERE id = ?", (bad_id,))
            self.assertEqual(proj_after["desired_state"], "stopped")  # type: ignore[index]

            # Ошибка после INSERT (Popen падает) -> run переводится в failed с откатом desired_state
            ok_proj = make_project(
                "popen-fail-proj",
                proj_type="service",
                runtime="bash",
                cmd="sleep 10",
                desired_state="stopped",
                health_status="stopped",
            )
            ok_id = int(ok_proj["id"])
            with patch("hub.process_mgr.subprocess.Popen", side_effect=OSError("mock spawn failure")):
                with self.assertRaises(OSError):
                    asyncio.run(start_project_run(ok_id, trigger="manual"))

            stuck2 = query_all("SELECT * FROM runs WHERE project_id = ? AND status = 'running'", (ok_id,))
            self.assertEqual(stuck2, [])
            failed_row = query_one("SELECT status, exit_code, error_summary FROM runs WHERE project_id = ? ORDER BY id DESC LIMIT 1", (ok_id,))
            self.assertIsNotNone(failed_row)
            self.assertEqual(failed_row["status"], "failed")  # type: ignore[index]
            self.assertEqual(failed_row["exit_code"], -1)  # type: ignore[index]
            self.assertIn("mock spawn failure", failed_row["error_summary"])  # type: ignore[index]
            proj_after2 = query_one("SELECT desired_state FROM projects WHERE id = ?", (ok_id,))
            self.assertEqual(proj_after2["desired_state"], "stopped")  # type: ignore[index]

    def test_p1_6_recovered_process_preserves_exit_code_and_handles_missing_exit(self) -> None:
        with create_temp_hub():
            proj = make_project(
                "recover-exit-proj",
                proj_type="service",
                runtime="bash",
                cmd='bash -c "sleep 0.6; exit 3"',
            )
            proj_id = int(proj["id"])

            async def _scenario() -> None:
                run = await start_project_run(proj_id, trigger="manual")
                run_id = int(run["id"])

                # Симулируем рестарт панели (ECHILD: popen=None)
                info = ACTIVE_RUNS.pop(run_id, None)
                old_popen = info.get("popen") if info else None
                if info and isinstance(info.get("stdin_keepalive_fd"), int):
                    try:
                        os.close(info["stdin_keepalive_fd"])
                    except OSError:
                        pass
                rec = recover_running_processes()
                self.assertEqual(rec["recovered"], 1)
                self.assertIsNone(ACTIVE_RUNS[run_id]["popen"])

                task = asyncio.create_task(watch_processes_loop())
                try:
                    deadline = time.time() + 6.0
                    while time.time() < deadline:
                        r = query_one("SELECT status, exit_code FROM runs WHERE id = ?", (run_id,))
                        if r and r["status"] != "running":
                            break
                        await asyncio.sleep(0.25)

                    r = query_one("SELECT status, exit_code FROM runs WHERE id = ?", (run_id,))
                    self.assertIsNotNone(r)
                    self.assertEqual(r["status"], "failed")  # type: ignore[index]
                    self.assertEqual(r["exit_code"], 3)  # type: ignore[index]
                finally:
                    task.cancel()
                    try:
                        await task
                    except asyncio.CancelledError:
                        pass
                    await stop_project(proj_id)
                    if old_popen is not None:
                        try:
                            old_popen.wait(timeout=1.0)
                        except Exception:
                            pass

            asyncio.run(_scenario())

            # Если процесса нет и .exit отсутствует (например SIGKILL launcher), статус failed + unknown exit
            log_p = Path(proj["workdir"]) / "missing_exit.log"
            log_p.write_text("log", encoding="utf-8")
            dead_run_id = execute_sql(
                """INSERT INTO runs (project_id, status, trigger, pid, pgid, proc_create_time, started_at, run_token, log_path)
                   VALUES (?, 'running', 'manual', 999999, 999999, 1.0, ?, 'tok_dead_no_exit', ?)""",
                (proj_id, int(time.time()), str(log_p)),
            )
            rec2 = recover_running_processes()
            self.assertGreaterEqual(rec2["marked_dead"], 1)
            dead_row = query_one("SELECT status, exit_code, error_summary FROM runs WHERE id = ?", (dead_run_id,))
            self.assertEqual(dead_row["status"], "failed")  # type: ignore[index]
            self.assertEqual(dead_row["exit_code"], -1)  # type: ignore[index]
            self.assertIn("неизвестен", dead_row["error_summary"])  # type: ignore[index]

    def test_pr1_read_json_parse_int_and_system_health(self) -> None:
        from hub.api import parse_int_param, read_json
        from hub.api.routes_ui import api_system_health

        bad_json_req = DummyRequest(raw_body=b"{not json")
        with self.assertRaises(HTTPException) as ctx_json:
            asyncio.run(read_json(bad_json_req))  # type: ignore[arg-type]
        self.assertEqual(ctx_json.exception.status_code, 400)

        non_obj_req = DummyRequest(raw_body=b"[1, 2, 3]")
        with self.assertRaises(HTTPException) as ctx_arr:
            asyncio.run(read_json(non_obj_req))  # type: ignore[arg-type]
        self.assertEqual(ctx_arr.exception.status_code, 400)

        with self.assertRaises(HTTPException) as ctx_int:
            parse_int_param("abc", "lines")
        self.assertEqual(ctx_int.exception.status_code, 400)

        with create_temp_hub():
            health = asyncio.run(api_system_health(DummyRequest()))  # type: ignore[arg-type]
            self.assertTrue(health["ok"])
            self.assertIn("watch_loop", health)
            self.assertIn("scheduler_loop", health)

    def test_p1_7_50_projects_batch_and_calc_dir_size_skips_heavy_dirs(self) -> None:
        from hub.api.routes_ui import _calc_dir_size, api_list_projects

        with create_temp_hub() as tmpdir:
            heavy = tmpdir / "projects" / "p00" / "node_modules" / "pkg"
            heavy.mkdir(parents=True, exist_ok=True)
            (heavy / "big.bin").write_bytes(b"X" * 50000)
            (tmpdir / "projects" / "p00" / ".venv" / "lib").mkdir(parents=True, exist_ok=True)
            (tmpdir / "projects" / "p00" / ".venv" / "lib" / "v.bin").write_bytes(b"Y" * 50000)
            (tmpdir / "projects" / "p00" / "main.py").write_text("print(1)\n", encoding="utf-8")

            sz = _calc_dir_size(tmpdir / "projects" / "p00", force_refresh=True)
            self.assertLess(sz, 1000)

            for i in range(50):
                make_project(f"bench-proj-{i:02d}")

            t0 = time.perf_counter()
            items = asyncio.run(api_list_projects(DummyRequest()))  # type: ignore[arg-type]
            elapsed_ms = (time.perf_counter() - t0) * 1000.0
            self.assertEqual(len(items), 50)
            self.assertLess(elapsed_ms, 200.0)

    def test_p1_8_systemd_run_args_preexec_and_doctor(self) -> None:
        from hub.doctor import run_hub_doctor
        from hub.process_mgr import _make_preexec_fn, build_systemd_run_args

        fake_pw = type("PW", (), {"pw_uid": 1001, "pw_gid": 1001})()
        with patch("hub.process_mgr.pwd.getpwnam", return_value=fake_pw):
            args, ok = build_systemd_run_args("/usr/bin/systemd-run", 256, "beacon-runner")
        self.assertTrue(ok)
        self.assertIn("--property=MemoryMax=256M", args)
        self.assertIn("--uid=1001", args)
        self.assertIn("--gid=1001", args)
        self.assertFalse(any(a.startswith("-p=") for a in args))

        # При drop_privileges=False _make_preexec_fn не должен падать на несуществующем пользователе (сбрасывает systemd-run)
        preexec = _make_preexec_fn("__nonexistent_user_beacon_999__", drop_privileges=False)
        pid = os.fork()
        if pid == 0:
            try:
                preexec()
            except BaseException:
                os._exit(1)
            os._exit(0)
        else:
            _, status = os.waitpid(pid, 0)
            self.assertEqual(os.WEXITSTATUS(status) if os.WIFEXITED(status) else -1, 0)

        with create_temp_hub():
            doc = run_hub_doctor()
            ids = {c["id"] for c in doc["checks"]}
            self.assertIn("systemd_run_ram_limit", ids)

    def test_p1_10_deps_npm_ci_no_mask_and_exec_cyrillic_multiline(self) -> None:
        from hub.api.routes_ui import api_exec_project_command
        from hub.process_mgr import build_install_deps_command

        with create_temp_hub() as tmpdir:
            node_dir = tmpdir / "projects" / "node-app"
            node_dir.mkdir(parents=True, exist_ok=True)
            (node_dir / "package.json").write_text('{"name":"x"}', encoding="utf-8")
            (node_dir / "package-lock.json").write_text("{}", encoding="utf-8")
            argv_ci = build_install_deps_command(node_dir, "node")
            self.assertIsInstance(argv_ci, list)
            self.assertEqual(argv_ci[:2], ["/bin/bash", "-c"])
            self.assertIn("npm ci", argv_ci[2])
            self.assertNotIn("|| echo", argv_ci[2])

            (node_dir / "package-lock.json").unlink()
            argv_inst = build_install_deps_command(node_dir, "node")
            self.assertIn("npm install", argv_inst[2])
            self.assertNotIn("|| echo", argv_inst[2])

            proj = make_project("exec-cyrillic", runtime="bash", cmd="true")
            pid = int(proj["id"])
            multi_cmd = "echo 'привет мир'\necho 'строка два'"
            res = asyncio.run(
                api_exec_project_command(
                    DummyRequest(body={"command": multi_cmd}),  # type: ignore[arg-type]
                    pid,
                )
            )
            self.assertTrue(res["ok"])
            run_id = int(res["run"]["id"])
            log_path = Path(res["run"]["log_path"])

            async def _wait_exec() -> None:
                task = asyncio.create_task(watch_processes_loop())
                try:
                    deadline = time.time() + 5.0
                    while time.time() < deadline:
                        r = query_one("SELECT status FROM runs WHERE id = ?", (run_id,))
                        if r and r["status"] != "running":
                            break
                        await asyncio.sleep(0.15)
                finally:
                    task.cancel()
                    try:
                        await task
                    except asyncio.CancelledError:
                        pass

            asyncio.run(_wait_exec())
            log_txt = log_path.read_text(encoding="utf-8", errors="replace")
            self.assertIn("привет мир", log_txt)
            self.assertIn("строка два", log_txt)

    def test_p2_11_and_p2_18_healthcheck_ssrf_runtime_port_and_lchown_guards(self) -> None:
        from hub.config import get_runtime_port, is_runtime_safe_mode, set_runtime_port, set_runtime_safe_mode
        from hub.db import get_setting, set_setting
        from hub.process_mgr import _build_process_env, _prepare_workdir_ownership, check_endpoint_health

        with create_temp_hub() as tmpdir:
            # 1. SSRF защита в check_endpoint_health
            ok_ext, msg_ext = check_endpoint_health("http://169.254.169.254/latest/meta-data/")
            self.assertFalse(ok_ext)
            self.assertEqual(msg_ext, "blocked_external_healthcheck_host")

            ok_tcp_ext, msg_tcp_ext = check_endpoint_health("tcp://8.8.8.8:53")
            self.assertFalse(ok_tcp_ext)
            self.assertEqual(msg_tcp_ext, "blocked_external_healthcheck_host")

            # 2. RUNTIME_PORT влияет на BEACON_API_URL независимо от settings.port
            orig_port = get_runtime_port()
            try:
                set_runtime_port(9123)
                proj = make_project("rt-port-proj")
                env = _build_process_env(proj, "rtok", {"port": "8050"}, run_id=1)
                self.assertEqual(env["BEACON_API_URL"], "http://127.0.0.1:9123/internal")
            finally:
                set_runtime_port(orig_port)

            # 3. Runtime --safe-mode не меняет настройку safe_mode в БД
            set_setting("safe_mode", "0")
            orig_sm = is_runtime_safe_mode()
            try:
                set_runtime_safe_mode(True)
                self.assertTrue(is_runtime_safe_mode())
                self.assertEqual(get_setting("safe_mode", "0"), "0")
            finally:
                set_runtime_safe_mode(orig_sm)

            # 4. _prepare_workdir_ownership пропускает symlink и hardlink (st_nlink > 1)
            wdir = tmpdir / "projects" / "own-test"
            wdir.mkdir(parents=True, exist_ok=True)
            regular = wdir / "regular.txt"
            regular.write_text("reg", encoding="utf-8")
            outside = tmpdir / "outside.txt"
            outside.write_text("out", encoding="utf-8")
            hard = wdir / "hardlink.txt"
            os.link(outside, hard)
            sym = wdir / "symlink.txt"
            os.symlink(outside, sym)

            lchown_calls: list[str] = []
            with patch("hub.process_mgr.os.lchown", side_effect=lambda p, u, g: lchown_calls.append(str(p))):
                _prepare_workdir_ownership(wdir, uid=os.geteuid() + 1, gid=os.getegid() + 1)
            self.assertIn(str(regular), lchown_calls)
            self.assertNotIn(str(hard), lchown_calls)
            self.assertNotIn(str(sym), lchown_calls)

    def test_command_args_workers_port_and_healthcheck_now(self) -> None:
        from hub.api.routes_ui import api_healthcheck_project_now
        from hub.process_mgr import _build_command_args

        with create_temp_hub() as tmpdir:
            wdir = tmpdir / "projects" / "heavy-api"
            venv_bin = wdir / ".venv" / "bin"
            venv_bin.mkdir(parents=True, exist_ok=True)
            fake_uvicorn = venv_bin / "uvicorn"
            fake_uvicorn.write_text("#!/bin/sh\n", encoding="utf-8")
            fake_uvicorn.chmod(0o755)

            proj = make_project(
                "heavy-api",
                proj_type="web",
                runtime="python",
                cmd="uvicorn main:app --host 0.0.0.0 --port $PORT --workers 4",
            )
            execute_sql("UPDATE projects SET port = 18099 WHERE id = ?", (proj["id"],))
            proj_row = query_one("SELECT * FROM projects WHERE id = ?", (proj["id"],))
            assert proj_row is not None

            args = _build_command_args(proj_row)
            self.assertEqual(args[0], str(fake_uvicorn))
            self.assertIn("18099", args)
            self.assertIn("4", args)

            # Shell pipeline / compound command resolution
            proj_pipe = dict(proj_row)
            proj_pipe["cmd"] = "python3 migrate.py && uvicorn main:app --port ${PORT}"
            pipe_args = _build_command_args(proj_pipe)
            self.assertEqual(pipe_args[:2], ["/bin/bash", "-c"])
            self.assertIn("18099", pipe_args[2])

            # Manual healthcheck_now endpoint returns structured result
            hc_res = asyncio.run(api_healthcheck_project_now(DummyRequest(), int(proj["id"])))  # type: ignore[arg-type]
            self.assertIn("ok", hc_res)
            self.assertIn("latency_ms", hc_res)
            self.assertIn("18099", hc_res["target"])


if __name__ == "__main__":
    unittest.main()

