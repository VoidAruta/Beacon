"""
Совместимый пакет `hub` (новое каноническое имя — `beacon`).
Поддерживает как серверные подмодули (`hub.db`, `hub.process_mgr`, `hub.api`),
так и клиентский SDK (`hub.notify`, `hub.secret`, `hub.ask`, `hub.cookies_expired`, `hub.state`).
"""

from sdk.python.beacon import ask, cookies_expired, notify, secret, state

__version__ = "2.2.0"
__all__ = ["notify", "secret", "cookies_expired", "ask", "state", "__version__"]
