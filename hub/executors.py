"""
Выделенные ограниченные пулы потоков (ThreadPoolExecutor) для тяжёлых синхронных операций Beacon:
- SCRYPT_EXECUTOR (max_workers=1): хеширование и проверка паролей (hashlib.scrypt, ~16 МБ буфер)
  с последующим возвратом памяти в ОС (libc.malloc_trim(0) на Linux) — не плодит glibc malloc-арены.
- IO_EXECUTOR (max_workers=2): создание .venv, кросс-поиск по логам с редакцией секретов,
  крупные чанки redact_log_text и фоновое обслуживание диска/WAL без блокировки asyncio event loop.
"""

import asyncio
import ctypes
import sys
from concurrent.futures import ThreadPoolExecutor
from typing import Any, Callable, TypeVar

T = TypeVar("T")

SCRYPT_EXECUTOR = ThreadPoolExecutor(max_workers=1, thread_name_prefix="beacon-scrypt")
IO_EXECUTOR = ThreadPoolExecutor(max_workers=2, thread_name_prefix="beacon-io")

_LIBC_MALLOC_TRIM: Any = None
_LIBC_TRIED = False


def trim_glibc_malloc() -> None:
    """На Linux (glibc) запрашивает возврат освобождённых страниц кучи обратно ОС."""
    global _LIBC_MALLOC_TRIM, _LIBC_TRIED
    if not sys.platform.startswith("linux"):
        return
    if not _LIBC_TRIED:
        _LIBC_TRIED = True
        try:
            libc = ctypes.CDLL("libc.so.6")
            fn = getattr(libc, "malloc_trim", None)
            if fn is not None:
                fn.argtypes = [ctypes.c_size_t]
                fn.restype = ctypes.c_int
                _LIBC_MALLOC_TRIM = fn
        except Exception:
            _LIBC_MALLOC_TRIM = None
    if _LIBC_MALLOC_TRIM is not None:
        try:
            _LIBC_MALLOC_TRIM(0)
        except Exception:
            pass


def _call_and_trim(func: Callable[..., T], args: tuple[Any, ...]) -> T:
    try:
        return func(*args)
    finally:
        trim_glibc_malloc()


async def run_in_scrypt_executor(func: Callable[..., T], *args: Any) -> T:
    """Выполняет scrypt-операцию (verify/hash/dummy) строго в одном потоке с возвратом памяти."""
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(SCRYPT_EXECUTOR, _call_and_trim, func, args)


async def run_in_io_executor(func: Callable[..., T], *args: Any) -> T:
    """Выполняет блокирующую дисковую/subprocess-операцию в ограниченном пуле IO_EXECUTOR (max_workers=2)."""
    loop = asyncio.get_running_loop()
    return await loop.run_in_executor(IO_EXECUTOR, func, *args)
