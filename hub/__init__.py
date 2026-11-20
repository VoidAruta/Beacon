"""
Совместимый пакет `hub` (новое каноническое имя — `beacon`).
Поддерживает как серверные подмодули (`hub.db`, `hub.process_mgr`, `hub.api`),
так и клиентский SDK (`hub.notify`, `hub.secret`, `hub.ask`, `hub.cookies_expired`, `hub.state`).
"""

from sdk.python.beacon import BeaconApiError, ask, cookies_expired, notify, ping, secret, state

__version__ = "2.4.0"
__all__ = ["BeaconApiError", "notify", "secret", "cookies_expired", "ask", "ping", "state", "__version__"]
