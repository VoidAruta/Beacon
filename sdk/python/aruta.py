"""
Совместимый алиас `import aruta` -> `import beacon`.
"""

from beacon import BeaconApiError, ask, cookies_expired, notify, ping, secret, state

__all__ = ["BeaconApiError", "notify", "secret", "cookies_expired", "ask", "ping", "state"]
