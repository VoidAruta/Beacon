"""
Beacon (ранее Hub Control Panel) — Легковесная автономная панель управления процессами и Containerless PaaS.
Поддерживает как вызов `python3 -m beacon`, так и импорт встроенного SDK (`import beacon`) из дочерних проектов.
"""

from sdk.python.beacon import BeaconApiError, ask, cookies_expired, notify, ping, secret, state

__version__ = "2.4.0"
__all__ = ["BeaconApiError", "notify", "secret", "cookies_expired", "ask", "ping", "state", "__version__"]
