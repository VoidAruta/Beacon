"""
Beacon (ранее Hub Control Panel) — Легковесная автономная панель управления процессами и Containerless PaaS.
Поддерживает как вызов `python3 -m beacon`, так и импорт встроенного SDK (`import beacon`) из дочерних проектов.
"""

from sdk.python.beacon import ask, cookies_expired, notify, secret, state

__version__ = "2.2.0"
__all__ = ["notify", "secret", "cookies_expired", "ask", "state", "__version__"]
