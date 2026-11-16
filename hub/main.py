"""
Псевдоним модуля hub.__main__ (обеспечивает стабильные импорты `from hub.main import ...`
и запуск `python3 -m hub.main`).
"""

from hub.__main__ import (  # noqa: F401
    _BG_TASKS,
    _SECURITY_HEADERS,
    _attach_security_headers,
    _check_rbac_permission,
    app,
    main,
    on_startup,
    security_and_auth_middleware,
)

if __name__ == "__main__":
    main()
