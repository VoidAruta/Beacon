"""
Совместимый алиас `import aruta` -> `import beacon`.
"""

from beacon import ask, cookies_expired, notify, secret, state

__all__ = ["notify", "secret", "cookies_expired", "ask", "state"]
