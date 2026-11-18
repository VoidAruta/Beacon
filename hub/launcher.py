"""
Тонкая обёртка запуска дочерних процессов проектов (P1-6).

Назначение:
- Запускается как лидер группы процессов (os.setsid() выполняется в parent preexec_fn).
- Запускает целевую команду напрямую, наследуя stdin (FIFO) и stdout/stderr (лог-файл).
- Пересылает SIGTERM/SIGINT/SIGHUP/SIGUSR1/SIGUSR2 дочернему процессу и ждёт его завершения.
- Атомарно записывает реальный код возврата (int) в файл <run_id>.exit рядом с логом,
  чтобы после рестарта панели Beacon не терял реальный exit code и корректно применял
  политики перезапуска (on-failure / crash-loop / уведомления).

Использование:
    python3 -m hub.launcher <exit_file> -- <cmd...>
"""

import os
import signal
import subprocess
import sys
from pathlib import Path
from typing import Optional


def _write_exit_file(exit_file: Path, code: int) -> None:
    payload = f"{int(code)}\n".encode("ascii")
    tmp_path = exit_file.with_name(f"{exit_file.name}.tmp.{os.getpid()}")
    try:
        fd = os.open(str(tmp_path), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        try:
            os.write(fd, payload)
            os.fsync(fd)
        finally:
            os.close(fd)
        os.replace(str(tmp_path), str(exit_file))
        return
    except OSError:
        try:
            tmp_path.unlink(missing_ok=True)
        except OSError:
            pass

    # Fallback: предсозданный родительским процессом файл при недоступном на запись каталоге
    try:
        fd = os.open(str(exit_file), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        try:
            os.write(fd, payload)
            os.fsync(fd)
        finally:
            os.close(fd)
    except OSError as exc:
        try:
            sys.stderr.write(f"[beacon.launcher] Ошибка записи {exit_file}: {exc}\n")
            sys.stderr.flush()
        except OSError:
            pass


def main(argv: Optional[list[str]] = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if "--" not in args:
        sys.stderr.write("Usage: python3 -m hub.launcher <exit_file> -- <cmd...>\n")
        return 2

    sep_idx = args.index("--")
    if sep_idx != 1 or sep_idx + 1 >= len(args):
        sys.stderr.write("Usage: python3 -m hub.launcher <exit_file> -- <cmd...>\n")
        return 2

    exit_file = Path(args[0])
    cmd = args[sep_idx + 1 :]

    try:
        child = subprocess.Popen(cmd, close_fds=False)
    except OSError as exc:
        sys.stderr.write(f"[beacon.launcher] Не удалось запустить команду {cmd[0]!r}: {exc}\n")
        sys.stderr.flush()
        _write_exit_file(exit_file, 127)
        return 127

    def _forward_signal(signum: int, _frame: object) -> None:
        if child.poll() is None:
            try:
                pgid = os.getpgid(child.pid)
                if pgid != os.getpgrp():
                    os.killpg(pgid, signum)
                else:
                    child.send_signal(signum)
            except ProcessLookupError:
                pass
            except OSError:
                try:
                    child.send_signal(signum)
                except OSError:
                    pass

    for sig_name in ("SIGTERM", "SIGINT", "SIGHUP", "SIGUSR1", "SIGUSR2"):
        sig = getattr(signal, sig_name, None)
        if sig is not None:
            try:
                signal.signal(sig, _forward_signal)
            except (OSError, ValueError):
                pass

    while True:
        try:
            rc = child.wait()
            break
        except InterruptedError:
            continue

    rc_int = int(rc if rc is not None else -1)
    _write_exit_file(exit_file, rc_int)
    if rc_int < 0:
        return 128 + abs(rc_int)
    return rc_int


if __name__ == "__main__":
    raise SystemExit(main())
