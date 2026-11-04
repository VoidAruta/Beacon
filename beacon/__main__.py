"""
Точка входа Beacon: python3 -m beacon [doctor|systemd|migrate|ai-pause]
Полная совместимость с python3 -m hub.
"""

from hub.__main__ import main

if __name__ == "__main__":
    main()
