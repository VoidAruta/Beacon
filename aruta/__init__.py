"""
Совместимый алиас пакета `aruta` -> `beacon`.
"""

from sdk.python.beacon import ask, cookies_expired, notify, secret, state

__version__ = "2.2.0"
__all__ = ["notify", "secret", "cookies_expired", "ask", "state", "__version__"]
