"""
Единый реестр имён переменных окружения, cookie и HTTP-заголовков Beacon (P3-02).
Новые установки используют только BEACON_* / beacon_session / X-Beacon-*.
Устаревшие префиксы ARUTA_* и HUB_* поддерживаются с однократным предупреждением о депрекации.
"""

import os
from typing import Iterable

from hub.log import get_logger

logger = get_logger("names")

ENV_PREFIX = "BEACON_"
LEGACY_ENV_PREFIXES = ("ARUTA_", "HUB_")

SESSION_COOKIE_NAME = "beacon_session"
LEGACY_SESSION_COOKIE_NAMES = ("aruta_session", "hub_session")
ALL_SESSION_COOKIE_NAMES = (SESSION_COOKIE_NAME,) + LEGACY_SESSION_COOKIE_NAMES

SESSION_HEADER_NAME = "X-Beacon-Session"
LEGACY_SESSION_HEADER_NAMES = ("X-Aruta-Session", "X-Hub-Session")

SDK_TOKEN_HEADER = "X-Beacon-Token"
LEGACY_SDK_TOKEN_HEADERS = ("X-Aruta-Token", "X-Hub-Token")

SIGNATURE_HEADER = "X-Beacon-Signature"
LEGACY_SIGNATURE_HEADERS = ("X-Hub-Signature-256",)

_DEPRECATION_WARNED: set[str] = set()


def _warn_deprecated_env(old_key: str, new_key: str) -> None:
    cache_key = f"{old_key}->{new_key}"
    if cache_key in _DEPRECATION_WARNED:
        return
    _DEPRECATION_WARNED.add(cache_key)
    logger.warning(
        "Переменная окружения %s устарела (deprecated); используйте %s",
        old_key,
        new_key,
    )


def _strip_known_prefix(key: str) -> str:
    for pref in (ENV_PREFIX,) + LEGACY_ENV_PREFIXES:
        if key.startswith(pref):
            return key[len(pref) :]
    return key


def get_env_var(
    primary: str,
    legacy: str = "",
    default: str = "",
    extra_keys: Iterable[str] = (),
) -> str:
    """
    Читает переменную окружения BEACON_* с прозрачным откатом на ARUTA_* / HUB_*
    и однократным предупреждением о депрекации при использовании старого имени.
    """
    suffix = _strip_known_prefix(primary)
    canonical_key = f"{ENV_PREFIX}{suffix}" if primary.startswith((ENV_PREFIX,) + LEGACY_ENV_PREFIXES) else primary

    candidates: list[str] = [canonical_key]
    for pref in LEGACY_ENV_PREFIXES:
        cand = f"{pref}{suffix}"
        if cand not in candidates:
            candidates.append(cand)
    if legacy and legacy not in candidates:
        candidates.append(legacy)
    for k in extra_keys:
        if k and k not in candidates:
            candidates.append(k)

    for key in candidates:
        val = os.environ.get(key)
        if val is not None and str(val).strip() != "":
            if key != canonical_key:
                _warn_deprecated_env(key, canonical_key)
            return str(val).strip()
    return default
