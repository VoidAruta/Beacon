"""
Совместимый слой зависимостей для запуска Hub как с установленными пакетами из requirements.txt
(psutil, croniter, httpx), так и напрямую на чистом системном Python 3.10+/3.12 через /proc.
"""

import asyncio
import datetime
import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import namedtuple
from typing import Any, Iterator, Optional

# ==============================================================================
# 1. PSUTIL (нативный пакет или прямое чтение ядра Linux /proc)
# ==============================================================================
try:
    import psutil as psutil  # type: ignore
except ImportError:
    pmem = namedtuple("pmem", ["rss", "vms"])
    svmem = namedtuple("svmem", ["total", "available", "percent", "used", "free"])
    sdiskusage = namedtuple("sdiskusage", ["total", "used", "free", "percent"])

    class NoSuchProcess(Exception):
        def __init__(self, pid: int, msg: str = "process no longer exists"):
            super().__init__(f"{msg} (pid={pid})")
            self.pid = pid

    class AccessDenied(Exception):
        pass

    class ZombieProcess(NoSuchProcess):
        pass

    _CLK_TCK = os.sysconf(os.sysconf_names.get("SC_CLK_TCK", "SC_CLK_TCK")) if hasattr(os, "sysconf") else 100
    _PAGE_SIZE = os.sysconf("SC_PAGE_SIZE") if hasattr(os, "sysconf") else 4096

    def _get_boot_time() -> float:
        try:
            with open("/proc/stat", "r", encoding="utf-8", errors="ignore") as f:
                for line in f:
                    if line.startswith("btime "):
                        return float(line.split()[1])
        except Exception:
            pass
        return 0.0

    _BOOT_TIME = _get_boot_time()
    _CPU_PREV: tuple[int, int] = (0, 0)
    _PROC_CPU_PREV: dict[int, tuple[float, float]] = {}

    class _FallbackProcess:
        def __init__(self, pid: Optional[int] = None):
            self.pid = os.getpid() if pid is None else int(pid)
            self._stat = self._read_stat()

        def _read_stat(self) -> list[str]:
            stat_path = f"/proc/{self.pid}/stat"
            if not os.path.exists(stat_path):
                raise NoSuchProcess(self.pid)
            try:
                with open(stat_path, "r", encoding="utf-8", errors="ignore") as f:
                    data = f.read().strip()
                rparen = data.rfind(")")
                comm_start = data.find("(")
                if comm_start == -1 or rparen == -1:
                    raise NoSuchProcess(self.pid)
                comm = data[comm_start + 1 : rparen]
                rest = data[rparen + 2 :].split()
                return [str(self.pid), comm] + rest
            except FileNotFoundError as e:
                raise NoSuchProcess(self.pid) from e
            except ProcessLookupError as e:
                raise NoSuchProcess(self.pid) from e

        def is_running(self) -> bool:
            try:
                st = self._read_stat()
                state = st[2]
                return state != "Z"
            except NoSuchProcess:
                return False

        def status(self) -> str:
            st = self._read_stat()
            code = st[2]
            mapping = {
                "R": "running",
                "S": "sleeping",
                "D": "disk-sleep",
                "T": "stopped",
                "Z": "zombie",
            }
            return mapping.get(code, "running")

        def create_time(self) -> float:
            st = self._read_stat()
            starttime_ticks = int(st[21])
            return round(_BOOT_TIME + (starttime_ticks / float(_CLK_TCK)), 3)

        def memory_info(self) -> pmem:
            st = self._read_stat()
            vms_bytes = int(st[22])
            rss_pages = int(st[23])
            return pmem(rss=rss_pages * _PAGE_SIZE, vms=vms_bytes)

        def cpu_percent(self, interval: Optional[float] = None) -> float:
            try:
                if interval and interval > 0:
                    st1 = self._read_stat()
                    t1 = time.monotonic()
                    ticks1 = (int(st1[13]) + int(st1[14])) / float(_CLK_TCK)
                    time.sleep(interval)
                    st2 = self._read_stat()
                    t2 = time.monotonic()
                    ticks2 = (int(st2[13]) + int(st2[14])) / float(_CLK_TCK)
                    dt = max(t2 - t1, 0.001)
                    return round(max(0.0, (ticks2 - ticks1) / dt * 100.0), 1)
                else:
                    st = self._read_stat()
                    now = time.monotonic()
                    ticks = (int(st[13]) + int(st[14])) / float(_CLK_TCK)
                    prev = _PROC_CPU_PREV.get(self.pid)
                    _PROC_CPU_PREV[self.pid] = (now, ticks)
                    if not prev:
                        return 0.0
                    dt = max(now - prev[0], 0.001)
                    return round(max(0.0, (ticks - prev[1]) / dt * 100.0), 1)
            except Exception:
                return 0.0

        def name(self) -> str:
            st = self._read_stat()
            return st[1]

        def ppid(self) -> int:
            st = self._read_stat()
            return int(st[3])

        def cmdline(self) -> list[str]:
            try:
                with open(f"/proc/{self.pid}/cmdline", "rb") as f:
                    raw = f.read()
                return [p.decode("utf-8", errors="ignore") for p in raw.split(b"\x00") if p]
            except Exception:
                return []

    class _FallbackPsutilModule:
        Process = _FallbackProcess
        NoSuchProcess = NoSuchProcess
        AccessDenied = AccessDenied
        ZombieProcess = ZombieProcess
        STATUS_ZOMBIE = "zombie"

        @staticmethod
        def pid_exists(pid: int) -> bool:
            return os.path.exists(f"/proc/{int(pid)}")

        @staticmethod
        def process_iter(attrs: Optional[list[str]] = None) -> Iterator[_FallbackProcess]:
            try:
                entries = os.listdir("/proc")
            except Exception:
                return
            for entry in entries:
                if entry.isdigit():
                    try:
                        yield _FallbackProcess(int(entry))
                    except NoSuchProcess:
                        continue

        @staticmethod
        def cpu_percent(interval: Optional[float] = None) -> float:
            global _CPU_PREV
            try:
                def read_cpu() -> tuple[int, int]:
                    with open("/proc/stat", "r", encoding="utf-8") as f:
                        first = f.readline()
                    parts = [int(x) for x in first.split()[1:]]
                    idle = parts[3] + (parts[4] if len(parts) > 4 else 0)
                    total = sum(parts)
                    return total, idle

                if interval and interval > 0:
                    t1, i1 = read_cpu()
                    time.sleep(interval)
                    t2, i2 = read_cpu()
                else:
                    t1, i1 = _CPU_PREV
                    t2, i2 = read_cpu()
                    _CPU_PREV = (t2, i2)
                    if t1 == 0:
                        return 2.5
                dt = max(t2 - t1, 1)
                di = max(i2 - i1, 0)
                return round(max(0.0, min(100.0, (dt - di) / float(dt) * 100.0)), 1)
            except Exception:
                return 0.0

        @staticmethod
        def virtual_memory() -> svmem:
            info: dict[str, int] = {}
            try:
                with open("/proc/meminfo", "r", encoding="utf-8") as f:
                    for line in f:
                        parts = line.split(":")
                        if len(parts) == 2:
                            key = parts[0].strip()
                            val_kb = int(parts[1].strip().split()[0])
                            info[key] = val_kb * 1024
            except Exception:
                pass
            total = info.get("MemTotal", 2 * 1024**3)
            avail = info.get(
                "MemAvailable",
                info.get("MemFree", 0) + info.get("Buffers", 0) + info.get("Cached", 0),
            )
            used = max(0, total - avail)
            free = info.get("MemFree", avail)
            percent = round((used / float(total)) * 100.0, 1) if total > 0 else 0.0
            return svmem(total=total, available=avail, percent=percent, used=used, free=free)

        @staticmethod
        def disk_usage(path: str) -> sdiskusage:
            st = os.statvfs(str(path))
            total = st.f_blocks * st.f_frsize
            free = st.f_bavail * st.f_frsize
            used = max(0, (st.f_blocks - st.f_bfree) * st.f_frsize)
            percent = round((used / float(total)) * 100.0, 1) if total > 0 else 0.0
            return sdiskusage(total=total, used=used, free=free, percent=percent)

    psutil = _FallbackPsutilModule()  # type: ignore


# ==============================================================================
# 2. CRONITER (нативный пакет или POSIX 5-field cron парсер)
# ==============================================================================
try:
    from croniter import croniter as croniter  # type: ignore
except ImportError:
    class croniter:  # type: ignore
        """Полная реализация 5-польного cron-вычислителя (минута час день месяц день_недели)."""

        def __init__(self, expr: str, start_time: Optional[float] = None):
            self.expr = expr.strip()
            self.cur = float(start_time if start_time is not None else time.time())
            parts = self.expr.split()
            if len(parts) != 5:
                raise ValueError(f"Некорректное cron-выражение (ожидается 5 полей): {expr}")
            self.minutes = self._parse_field(parts[0], 0, 59)
            self.hours = self._parse_field(parts[1], 0, 23)
            self.doms = self._parse_field(parts[2], 1, 31)
            self.months = self._parse_field(parts[3], 1, 12)
            self.dows = self._parse_field(parts[4], 0, 7, is_dow=True)

        @staticmethod
        def _parse_field(field: str, min_val: int, max_val: int, is_dow: bool = False) -> set[int]:
            result: set[int] = set()
            for part in field.split(","):
                part = part.strip()
                step = 1
                if "/" in part:
                    part, step_str = part.split("/", 1)
                    step = max(1, int(step_str))
                if part == "*":
                    start, end = min_val, max_val
                elif "-" in part:
                    s_str, e_str = part.split("-", 1)
                    start, end = int(s_str), int(e_str)
                else:
                    val = int(part)
                    if is_dow and val == 7:
                        val = 0
                    if val < min_val or val > max_val:
                        raise ValueError(f"Значение {val} вне диапазона [{min_val}, {max_val}]")
                    result.add(val)
                    continue
                for v in range(start, end + 1, step):
                    if is_dow and v == 7:
                        v = 0
                    if min_val <= v <= max_val:
                        result.add(v)
            if not result:
                raise ValueError(f"Пустое поле cron: {field}")
            return result

        @classmethod
        def is_valid(cls, expr: str) -> bool:
            try:
                cls(expr)
                return True
            except Exception:
                return False

        def get_next(self, ret_type: Any = float) -> Any:
            dt = datetime.datetime.fromtimestamp(self.cur)
            dt = dt.replace(second=0, microsecond=0) + datetime.timedelta(minutes=1)
            for _ in range(525600):  # До 1 года вперёд
                cron_dow = (dt.weekday() + 1) % 7  # 0 = Sunday, 1 = Monday ... 6 = Saturday
                if (
                    dt.month in self.months
                    and dt.day in self.doms
                    and cron_dow in self.dows
                    and dt.hour in self.hours
                    and dt.minute in self.minutes
                ):
                    self.cur = dt.timestamp()
                    return self.cur if ret_type is float else dt
                dt += datetime.timedelta(minutes=1)
            raise RuntimeError(f"Не удалось найти следующее время для cron: {self.expr}")


# ==============================================================================
# 3. HTTPX (нативный пакет или асинхронный клиент с поддержкой HTTP-прокси 127.0.0.1:10808)
# ==============================================================================
try:
    import httpx as httpx  # type: ignore
except ImportError:
    class _FallbackResponse:
        def __init__(self, status_code: int, text: str, headers: dict[str, str]):
            self.status_code = status_code
            self.text = text
            self.headers = headers

        def json(self) -> Any:
            return json.loads(self.text) if self.text else {}

    class _FallbackAsyncClient:
        def __init__(self, proxy: Optional[str] = None, timeout: float = 15.0, **kwargs: Any):
            self.proxy = proxy
            self.timeout = float(timeout)

        async def __aenter__(self) -> "_FallbackAsyncClient":
            return self

        async def __aexit__(self, exc_type: Any, exc: Any, tb: Any) -> None:
            pass

        def _sync_request(
            self,
            method: str,
            url: str,
            params: Optional[dict[str, Any]] = None,
            json_body: Optional[Any] = None,
            content: Optional[bytes] = None,
            headers: Optional[dict[str, str]] = None,
        ) -> _FallbackResponse:
            if params:
                qs = urllib.parse.urlencode(params)
                sep = "&" if "?" in url else "?"
                url = f"{url}{sep}{qs}"

            req_headers = dict(headers or {})
            data_bytes: Optional[bytes] = content
            if json_body is not None:
                data_bytes = json.dumps(json_body, ensure_ascii=False).encode("utf-8")
                req_headers.setdefault("Content-Type", "application/json; charset=utf-8")

            if self.proxy:
                handler = urllib.request.ProxyHandler({"http": self.proxy, "https": self.proxy})
            else:
                handler = urllib.request.ProxyHandler({})

            opener = urllib.request.build_opener(handler)
            req = urllib.request.Request(url, data=data_bytes, headers=req_headers, method=method.upper())
            try:
                with opener.open(req, timeout=self.timeout) as resp:
                    raw = resp.read().decode("utf-8", errors="replace")
                    return _FallbackResponse(resp.status, raw, dict(resp.headers))
            except urllib.error.HTTPError as e:
                raw = e.read().decode("utf-8", errors="replace")
                return _FallbackResponse(e.code, raw, dict(e.headers) if e.headers else {})

        async def get(
            self,
            url: str,
            params: Optional[dict[str, Any]] = None,
            headers: Optional[dict[str, str]] = None,
        ) -> _FallbackResponse:
            return await asyncio.to_thread(self._sync_request, "GET", url, params, None, None, headers)

        async def post(
            self,
            url: str,
            json: Optional[Any] = None,
            content: Optional[bytes] = None,
            headers: Optional[dict[str, str]] = None,
        ) -> _FallbackResponse:
            return await asyncio.to_thread(self._sync_request, "POST", url, None, json, content, headers)

    class _FallbackHttpxModule:
        AsyncClient = _FallbackAsyncClient
        Response = _FallbackResponse

    httpx = _FallbackHttpxModule()  # type: ignore
