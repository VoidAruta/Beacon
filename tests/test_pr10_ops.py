"""
Тесты PR-10 (операции, CLI, бэкапы, безопасность настроек и управление пользователями):
1. `hub.names.get_env_var` и `migrate_legacy_installation`: канонические BEACON_* и миграция старых установок
2. `hub.backup_mgr`: архивирование и восстановление в изолированном BEACON_DIR, защита от traversal/симмлинков, 0600 на секреты, исключение session.secret / internal.token / .venv / node_modules
3. CLI subcommands `python3 -m beacon {migrate,systemd,backup,restore,reset-password}`
4. UI API routes: PUT/DELETE /api/users/{id}, audit_log.actor, строгая валидация PUT /api/settings + confirm_lockout, read-only GET /api/system/systemd_unit, streaming GET /api/system/backup
"""

import asyncio
import json
import logging
import os
import secrets
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

from hub.api import HTTPException
from hub.api.routes_ui import (
    api_create_user,
    api_delete_user,
    api_system_audit,
    api_system_backup_zip,
    api_system_systemd_unit,
    api_update_settings,
    api_update_user,
)
from hub.backup_mgr import _validate_zip_member
from hub.db import execute_sql, get_setting, init_db, query_one, set_setting
from hub.names import get_env_var, migrate_legacy_installation

REPO_ROOT = Path(__file__).resolve().parent.parent


class _DummyReq:
    def __init__(
        self,
        body: dict | None = None,
        client_host: str = "127.0.0.1",
        actor: str = "admin",
        role: str = "admin",
    ) -> None:
        self.headers: dict[str, str] = {}
        self.cookies: dict[str, str] = {}
        self.query_params: dict[str, str] = {}
        self._body = body or {}
        self.client = type("Client", (), {"host": client_host})()
        self.state = type("State", (), {"session": {"user": actor, "role": role, "csrf": "ok"}})()

    async def json(self) -> dict:
        return self._body


class TestPr10Ops(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        init_db()

    def test_01_env_var_and_legacy_migration(self) -> None:
        saved = dict(os.environ)
        try:
            os.environ.pop("BEACON_UNIT_ALIAS_TEST", None)
            self.assertEqual(get_env_var("BEACON_UNIT_ALIAS_TEST", "default-val"), "default-val")

            os.environ["BEACON_UNIT_ALIAS_TEST"] = "new-val"
            self.assertEqual(get_env_var("BEACON_UNIT_ALIAS_TEST"), "new-val")

            with tempfile.TemporaryDirectory() as tmpdir:
                bdir = Path(tmpdir)
                (bdir / "data").mkdir(parents=True)
                (bdir / "data" / "hub.pid").write_text("12345", encoding="utf-8")
                res = migrate_legacy_installation(bdir)
                self.assertTrue(res["ok"])
                self.assertEqual(res["migrated_files"], 1)
                self.assertTrue((bdir / "data" / "beacon.pid").exists())
        finally:
            os.environ.clear()
            os.environ.update(saved)

    def test_02_backup_zip_validation_rejects_traversal_and_symlinks(self) -> None:
        for bad_name in ("../etc/passwd", "/etc/shadow", "data/session.secret", "data/internal.token", "foo/bar.txt"):
            info = zipfile.ZipInfo(bad_name)
            with self.assertRaises(ValueError):
                _validate_zip_member(info)

        sym_info = zipfile.ZipInfo("projects/bot/link.py")
        sym_info.external_attr = 0o120777 << 16
        with self.assertRaises(ValueError):
            _validate_zip_member(sym_info)

        ok_info = zipfile.ZipInfo("data/secrets/api_token")
        self.assertEqual(_validate_zip_member(ok_info), "data/secrets/api_token")

    def test_03_isolated_backup_restore_and_cli_subcommands(self) -> None:
        with tempfile.TemporaryDirectory(prefix="beacon_pr10_ops_") as tmpdir:
            bdir = Path(tmpdir)
            env = dict(os.environ)
            env["BEACON_DIR"] = str(bdir)
            env["PYTHONPATH"] = str(REPO_ROOT) + (os.pathsep + env["PYTHONPATH"] if env.get("PYTHONPATH") else "")

            def _run_beacon(*args: str, check: bool = True) -> subprocess.CompletedProcess[str]:
                return subprocess.run(
                    [sys.executable, "-m", "beacon", *args],
                    cwd=str(REPO_ROOT),
                    env=env,
                    capture_output=True,
                    text=True,
                    timeout=30,
                    check=check,
                )

            # 1. migrate
            mig = _run_beacon("migrate")
            self.assertEqual(mig.returncode, 0, mig.stderr)
            self.assertTrue((bdir / "data" / "hub.db").exists())

            # 2. systemd writes ONLY to data/generated/beacon.service, never scripts/beacon.service
            unit_src_missing = not (REPO_ROOT / "scripts" / "beacon.service").exists()
            self.assertTrue(unit_src_missing)
            sd = _run_beacon("systemd", "--port", "8065")
            self.assertEqual(sd.returncode, 0, sd.stderr)
            gen_unit = bdir / "data" / "generated" / "beacon.service"
            self.assertTrue(gen_unit.exists())
            unit_txt = gen_unit.read_text(encoding="utf-8")
            self.assertIn('Environment="BEACON_PORT=8065"', unit_txt)
            self.assertIn("KillMode=process", unit_txt)
            self.assertFalse((REPO_ROOT / "scripts" / "beacon.service").exists())

            # 3. reset-password rejects short & 'admin', accepts strong password & bumps epoch
            bad_short = _run_beacon("reset-password", "--password", "short", check=False)
            self.assertNotEqual(bad_short.returncode, 0)
            bad_admin = _run_beacon("reset-password", "--password", "admin", check=False)
            self.assertNotEqual(bad_admin.returncode, 0)

            before_epoch_conn = sqlite3.connect(str(bdir / "data" / "hub.db"))
            before_row = before_epoch_conn.execute(
                "SELECT value FROM settings WHERE key='session_epoch'"
            ).fetchone()
            before_epoch_conn.close()
            before_epoch = int(before_row[0]) if before_row else 1

            ok_reset = _run_beacon("reset-password", "--password", "StrongPass#PR10")
            self.assertEqual(ok_reset.returncode, 0, ok_reset.stderr)

            after_conn = sqlite3.connect(str(bdir / "data" / "hub.db"))
            after_row = after_conn.execute("SELECT value FROM settings WHERE key='session_epoch'").fetchone()
            after_conn.close()
            self.assertGreater(int(after_row[0]), before_epoch)

            # 4. backup + restore round-trip preserving secrets(0600), projects, and excluding ephemeral/secret keys
            (bdir / "data" / "session.secret").write_text("TOP_SESSION_SECRET", encoding="utf-8")
            (bdir / "data" / "internal.token").write_text("TOP_INTERNAL_TOKEN", encoding="utf-8")
            sec_file = bdir / "data" / "secrets" / "my_api"
            sec_file.write_text("secret-value-123", encoding="utf-8")
            os.chmod(sec_file, 0o600)

            proj_dir = bdir / "projects" / "demo-bot"
            proj_dir.mkdir(parents=True, exist_ok=True)
            (proj_dir / "main.py").write_text("print('beacon-ok')\n", encoding="utf-8")
            venv_dir = proj_dir / ".venv" / "bin"
            venv_dir.mkdir(parents=True, exist_ok=True)
            (venv_dir / "python").write_text("skipme", encoding="utf-8")
            nm_dir = proj_dir / "node_modules" / "pkg"
            nm_dir.mkdir(parents=True, exist_ok=True)
            (nm_dir / "index.js").write_text("skipme", encoding="utf-8")

            bak_zip = bdir / "manual_backup.zip"
            bak = _run_beacon("backup", str(bak_zip))
            self.assertEqual(bak.returncode, 0, bak.stderr)
            self.assertTrue(bak_zip.exists())

            with zipfile.ZipFile(bak_zip, "r") as zf:
                names = set(zf.namelist())
                self.assertIn("data/hub.db", names)
                self.assertIn("data/secrets/my_api", names)
                self.assertIn("projects/demo-bot/main.py", names)
                self.assertNotIn("data/session.secret", names)
                self.assertNotIn("data/internal.token", names)
                self.assertFalse(any(".venv/" in n or "node_modules/" in n for n in names))

            # Wipe project & secret and restore with --yes
            sec_file.unlink()
            shutil.rmtree(proj_dir)
            (bdir / "data" / "hub.db").unlink()

            rst = _run_beacon("restore", str(bak_zip), "--yes")
            self.assertEqual(rst.returncode, 0, rst.stderr)
            self.assertTrue((bdir / "data" / "hub.db").exists())
            self.assertEqual(sec_file.read_text(encoding="utf-8"), "secret-value-123")
            self.assertEqual(os.stat(sec_file).st_mode & 0o777, 0o600)
            self.assertEqual((proj_dir / "main.py").read_text(encoding="utf-8"), "print('beacon-ok')\n")

    def test_04_users_crud_self_delete_guard_and_audit_actor(self) -> None:
        uname = f"op_test_{secrets.token_hex(3)}"
        created = asyncio.run(
            api_create_user(
                _DummyReq(body={"username": uname, "password": "Operator#2026", "role": "viewer"}, actor="alice")  # type: ignore[arg-type]
            )
        )
        uid = int(created["id"])
        try:
            # Update role & password
            upd = asyncio.run(
                api_update_user(
                    _DummyReq(body={"role": "operator", "password": "Operator#2027"}, actor="alice"),  # type: ignore[arg-type]
                    uid,
                )
            )
            self.assertEqual(upd["role"], "operator")

            # Unknown user -> 404
            with self.assertRaises(HTTPException) as ctx404:
                asyncio.run(api_update_user(_DummyReq(body={"role": "viewer"}), 999999))  # type: ignore[arg-type]
            self.assertEqual(ctx404.exception.status_code, 404)

            # Self-delete forbidden (400)
            with self.assertRaises(HTTPException) as ctx_self:
                asyncio.run(api_delete_user(_DummyReq(actor=uname), uid))  # type: ignore[arg-type]
            self.assertEqual(ctx_self.exception.status_code, 400)

            # Audit log recorded actor="alice"
            logs = asyncio.run(api_system_audit(_DummyReq()))  # type: ignore[arg-type]
            self.assertTrue(
                any(entry.get("actor") == "alice" and uname in str(entry.get("details", "")) for entry in logs)
            )
        finally:
            row = query_one("SELECT id FROM users WHERE id = ?", (uid,))
            if row:
                asyncio.run(api_delete_user(_DummyReq(actor="alice"), uid))  # type: ignore[arg-type]

    def test_05_settings_strict_validation_lockout_systemd_and_backup_stream(self) -> None:
        orig_port = get_setting("port", "8050")
        orig_subnets = get_setting("allowed_subnets", "127.0.0.1/32,192.168.0.0/16")
        try:
            # Invalid CIDR must fail without mutating port
            with self.assertRaises(HTTPException) as bad_cidr:
                asyncio.run(
                    api_update_settings(
                        _DummyReq(body={"port": "8055", "allowed_subnets": "127.0.0.1/32,not-a-cidr"})  # type: ignore[arg-type]
                    )
                )
            self.assertEqual(bad_cidr.exception.status_code, 400)
            self.assertEqual(get_setting("port", "8050"), orig_port)

            # Wildcard trusted_proxies rejected
            with self.assertRaises(HTTPException):
                asyncio.run(api_update_settings(_DummyReq(body={"trusted_proxies": "*"}) ))  # type: ignore[arg-type]

            # Unknown run_as_user rejected
            with self.assertRaises(HTTPException):
                asyncio.run(api_update_settings(_DummyReq(body={"run_as_user": "nonexistent_user_xyz"})))  # type: ignore[arg-type]

            # Lockout protection: non-loopback IP excluded from proposed allowed_subnets triggers lockout_warning
            with self.assertRaises(HTTPException) as ctx_lock:
                asyncio.run(
                    api_update_settings(
                        _DummyReq(
                            body={"allowed_subnets": "10.99.0.0/24"},
                            client_host="203.0.113.50",
                        )  # type: ignore[arg-type]
                    )
                )
            self.assertEqual(ctx_lock.exception.status_code, 400)
            self.assertIn("lockout_warning", str(ctx_lock.exception.detail))

            # confirm_lockout=true succeeds
            ok_cfg = asyncio.run(
                api_update_settings(
                    _DummyReq(
                        body={"allowed_subnets": "10.99.0.0/24", "confirm_lockout": True},
                        client_host="203.0.113.50",
                    )  # type: ignore[arg-type]
                )
            )
            self.assertEqual(ok_cfg["allowed_subnets"], "10.99.0.0/24")

            # Read-only systemd preview endpoint
            unit_resp = asyncio.run(api_system_systemd_unit(_DummyReq()))  # type: ignore[arg-type]
            self.assertTrue(unit_resp["ok"])
            self.assertFalse(unit_resp["saved"])
            self.assertIn("KillMode=process", unit_resp["content"])

            # Streaming backup zip endpoint
            async def _collect_stream() -> tuple[bytes, str]:
                resp = await api_system_backup_zip(_DummyReq())  # type: ignore[arg-type]
                chunks: list[bytes] = []
                async for part in resp.body_iterator:
                    chunks.append(part if isinstance(part, bytes) else bytes(part))
                cd = resp.headers.get("Content-Disposition", "")
                return b"".join(chunks), cd

            zip_bytes, content_disp = asyncio.run(_collect_stream())
            self.assertIn("beacon_backup_", content_disp)
            self.assertTrue(zip_bytes.startswith(b"PK"))
        finally:
            set_setting("port", orig_port)
            set_setting("allowed_subnets", orig_subnets)
            execute_sql("DELETE FROM audit_log WHERE details LIKE '%nonexistent_user_xyz%'")

    def test_templates_use_canonical_beacon_and_trusted_proxies_env(self) -> None:
        import hub.templates_mgr as tmpl_mgr

        orig_projects_dir = tmpl_mgr.PROJECTS_DIR
        orig_logs_dir = tmpl_mgr.LOGS_DIR
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp_root = Path(tmpdir)
            tmpl_mgr.PROJECTS_DIR = tmp_root / "projects"
            tmpl_mgr.LOGS_DIR = tmp_root / "logs"
            try:
                py_info = tmpl_mgr.create_project_from_template("tpl_py_check", "python", "python", "service")
                node_info = tmpl_mgr.create_project_from_template("tpl_node_check", "node", "node", "service")
                cookie_info = tmpl_mgr.create_project_from_template("tpl_cookie_check", "cookie_parser", "python", "job")

                py_code = (Path(py_info["workdir"]) / "main.py").read_text(encoding="utf-8")
                node_code = (Path(node_info["workdir"]) / "index.js").read_text(encoding="utf-8")
                cookie_code = (Path(cookie_info["workdir"]) / "main.py").read_text(encoding="utf-8")

                self.assertIn("import beacon", py_code)
                self.assertNotIn("import aruta", py_code)
                self.assertIn("require('beacon')", node_code)
                self.assertNotIn("require('aruta')", node_code)
                self.assertIn("beacon.cookies_expired", cookie_code)
                self.assertNotIn("import aruta", cookie_code)
            finally:
                tmpl_mgr.PROJECTS_DIR = orig_projects_dir
                tmpl_mgr.LOGS_DIR = orig_logs_dir

        # Verify BEACON_TRUSTED_PROXIES env propagation in isolated config import
        code = (
            "import os, json; "
            "from hub.config import DEFAULT_SETTINGS; "
            "print(json.dumps(DEFAULT_SETTINGS['trusted_proxies']))"
        )
        env = os.environ.copy()
        env["BEACON_TRUSTED_PROXIES"] = "127.0.0.1/32,10.0.0.0/8"
        res = subprocess.run(
            [sys.executable, "-c", code],
            cwd=str(Path(__file__).resolve().parent.parent),
            env=env,
            capture_output=True,
            text=True,
            timeout=15,
        )
        self.assertEqual(res.returncode, 0, res.stderr)
        self.assertEqual(json.loads(res.stdout.strip()), "127.0.0.1/32,10.0.0.0/8")


if __name__ == "__main__":
    unittest.main()
