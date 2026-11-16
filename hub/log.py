"""
Централизованное логирование панели Beacon / Hub (PR-1 / P2-07).
Пишет структурированные записи в stdout, чтобы их видел systemd/journald или Docker.
"""

import logging
import sys
from typing import Optional

_CONFIGURED = False


def get_logger(name: str = "beacon") -> logging.Logger:
    global _CONFIGURED
    logger = logging.getLogger(name)
    if not _CONFIGURED:
        root_beacon = logging.getLogger("beacon")
        if not root_beacon.handlers:
            handler = logging.StreamHandler(sys.stdout)
            formatter = logging.Formatter(
                fmt="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
                datefmt="%Y-%m-%d %H:%M:%S",
            )
            handler.setFormatter(formatter)
            root_beacon.addHandler(handler)
        root_beacon.setLevel(logging.INFO)
        root_beacon.propagate = False
        _CONFIGURED = True
    if name != "beacon" and not name.startswith("beacon."):
        return logging.getLogger(f"beacon.{name}")
    return logger


def log_exception(msg: str, logger: Optional[logging.Logger] = None) -> None:
    (logger or get_logger("beacon")).exception(msg)
