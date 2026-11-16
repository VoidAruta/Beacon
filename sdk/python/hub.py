"""
Совместимый алиас `import hub` -> `import beacon`.
Генерирует ненавязчивый DeprecationWarning и полностью проксирует все функции SDK.
"""

import warnings

from beacon import BeaconApiError, ask, cookies_expired, notify, ping, secret, state

warnings.warn(
    "Модуль 'hub' переименован в 'beacon'. Используйте 'import beacon' (обратная совместимость сохранена).",
    DeprecationWarning,
    stacklevel=2,
)

__all__ = ["BeaconApiError", "notify", "secret", "cookies_expired", "ask", "ping", "state"]
