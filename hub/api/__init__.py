"""
Адаптер веб-фреймворка для Aruta (Hub):
Использует штатный FastAPI + Starlette при их наличии в окружении (.venv),
либо предоставляет 100% совместимый легковесный асинхронный HTTP/SSE сервер на стандартной библиотеке Python 3
с жёсткими лимитами тела запроса (50 МБ -> 413), числа multipart-частей и числа одновременных соединений.
"""

import asyncio
import inspect
import json
import mimetypes
import os
import re
import secrets
import traceback
import urllib.parse
from pathlib import Path
from typing import Any, AsyncIterator, Callable, Optional

MAX_REQUEST_BODY_BYTES = 50 * 1024 * 1024  # 50 МБ
MAX_MULTIPART_PARTS = 64
MAX_CONCURRENT_CONNECTIONS = 128

try:
    from fastapi import APIRouter, FastAPI, HTTPException, Request, Response  # type: ignore
    from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, StreamingResponse  # type: ignore

    HAS_NATIVE_FASTAPI = True
except ImportError:
    HAS_NATIVE_FASTAPI = False

    class HTTPException(Exception):
        def __init__(self, status_code: int, detail: Any = "Error"):
            super().__init__(str(detail))
            self.status_code = int(status_code)
            self.detail = detail

    class _ClientAddr:
        def __init__(self, host: str, port: int = 0):
            self.host = host
            self.port = port

    class Request:
        def __init__(
            self,
            method: str,
            path: str,
            query_string: str,
            headers: dict[str, str],
            body: bytes,
            client_host: str = "127.0.0.1",
            path_params: Optional[dict[str, str]] = None,
            scheme: str = "http",
        ):
            self.method = method.upper()
            self.path = path
            self.url = type("URL", (), {"path": path, "query": query_string, "scheme": scheme})()
            self.headers = {k.lower(): v for k, v in headers.items()}
            self._raw_headers = headers
            self._body = body
            self.client = _ClientAddr(client_host)
            self.path_params = path_params or {}
            self.query_params: dict[str, str] = {}
            if query_string:
                for k, v in urllib.parse.parse_qs(query_string, keep_blank_values=True).items():
                    if v:
                        self.query_params[k] = v[-1]
            self.cookies: dict[str, str] = {}
            cookie_hdr = self.headers.get("cookie", "")
            if cookie_hdr:
                for part in cookie_hdr.split(";"):
                    if "=" in part:
                        ck, cv = part.strip().split("=", 1)
                        self.cookies[ck.strip()] = cv.strip()
            self.state = type("State", (), {})()

        async def body(self) -> bytes:
            return self._body

        async def json(self) -> Any:
            if not self._body:
                return {}
            return json.loads(self._body.decode("utf-8", errors="replace"))

        async def form(self) -> dict[str, Any]:
            ctype = self.headers.get("content-type", "")
            if "multipart/form-data" in ctype and "boundary=" in ctype:
                boundary = ctype.split("boundary=", 1)[1].split(";")[0].strip().strip('"')
                return _parse_multipart(self._body, boundary)
            if "application/x-www-form-urlencoded" in ctype:
                parsed = urllib.parse.parse_qs(self._body.decode("utf-8", errors="replace"))
                return {k: v[-1] for k, v in parsed.items() if v}
            return {}

    class _UploadFile:
        def __init__(self, filename: str, content: bytes, content_type: str = "application/octet-stream"):
            self.filename = filename
            self._content = content
            self.content_type = content_type

        async def read(self) -> bytes:
            return self._content

    def _parse_multipart(body: bytes, boundary: str) -> dict[str, Any]:
        result: dict[str, Any] = {}
        delim = f"--{boundary}".encode("utf-8")
        parts = body.split(delim)
        if len(parts) > MAX_MULTIPART_PARTS + 2:
            raise HTTPException(
                status_code=413,
                detail=f"Превышен лимит частей multipart/form-data (макс. {MAX_MULTIPART_PARTS})",
            )
        for part in parts[1:]:
            if part.startswith(b"--") or not part.strip():
                continue
            if part.startswith(b"\r\n"):
                part = part[2:]
            if part.endswith(b"\r\n"):
                part = part[:-2]
            sep = part.find(b"\r\n\r\n")
            if sep == -1:
                continue
            hdr_bytes = part[:sep].decode("utf-8", errors="replace")
            content = part[sep + 4 :]
            disp = ""
            ctype = "application/octet-stream"
            for line in hdr_bytes.split("\r\n"):
                if line.lower().startswith("content-disposition:"):
                    disp = line
                elif line.lower().startswith("content-type:"):
                    ctype = line.split(":", 1)[1].strip()
            name_m = re.search(r'name="([^"]+)"', disp)
            if not name_m:
                continue
            field_name = name_m.group(1)
            fn_m = re.search(r'filename="([^"]*)"', disp)
            if fn_m:
                result[field_name] = _UploadFile(fn_m.group(1), content, ctype)
            else:
                result[field_name] = content.decode("utf-8", errors="replace")
        return result

    class Response:
        def __init__(
            self,
            content: Any = b"",
            status_code: int = 200,
            headers: Optional[dict[str, str]] = None,
            media_type: str = "text/plain; charset=utf-8",
        ):
            self.status_code = int(status_code)
            self.headers: dict[str, str] = dict(headers or {})
            self.media_type = media_type
            self._cookies: list[str] = []
            if isinstance(content, bytes):
                self.body = content
            elif isinstance(content, str):
                self.body = content.encode("utf-8")
            else:
                self.body = json.dumps(content, ensure_ascii=False).encode("utf-8")
                self.media_type = "application/json; charset=utf-8"

        def set_cookie(
            self,
            key: str,
            value: str = "",
            max_age: Optional[int] = None,
            path: str = "/",
            httponly: bool = False,
            samesite: str = "Strict",
            secure: bool = False,
        ) -> None:
            parts = [f"{key}={value}", f"Path={path}"]
            if max_age is not None:
                parts.append(f"Max-Age={int(max_age)}")
            if httponly:
                parts.append("HttpOnly")
            if secure:
                parts.append("Secure")
            if samesite:
                parts.append(f"SameSite={samesite}")
            self._cookies.append("; ".join(parts))

        def delete_cookie(self, key: str, path: str = "/") -> None:
            self.set_cookie(key, "", max_age=0, path=path)

    class JSONResponse(Response):
        def __init__(
            self,
            content: Any,
            status_code: int = 200,
            headers: Optional[dict[str, str]] = None,
        ):
            body = json.dumps(content, ensure_ascii=False).encode("utf-8")
            super().__init__(
                content=body,
                status_code=status_code,
                headers=headers,
                media_type="application/json; charset=utf-8",
            )

    class HTMLResponse(Response):
        def __init__(self, content: str, status_code: int = 200, headers: Optional[dict[str, str]] = None):
            super().__init__(
                content=content.encode("utf-8"),
                status_code=status_code,
                headers=headers,
                media_type="text/html; charset=utf-8",
            )

    class FileResponse(Response):
        def __init__(self, path: str | Path, status_code: int = 200, media_type: Optional[str] = None):
            p = Path(path)
            if not p.exists() or not p.is_file():
                raise HTTPException(status_code=404, detail="File not found")
            guessed, _ = mimetypes.guess_type(str(p))
            mtype = media_type or guessed or "application/octet-stream"
            if mtype.startswith("text/") or mtype in ("application/javascript", "application/json"):
                mtype = f"{mtype}; charset=utf-8"
            super().__init__(content=p.read_bytes(), status_code=status_code, media_type=mtype)

    class StreamingResponse:
        def __init__(
            self,
            content: AsyncIterator[str | bytes],
            status_code: int = 200,
            headers: Optional[dict[str, str]] = None,
            media_type: str = "text/event-stream",
        ):
            self.content = content
            self.status_code = int(status_code)
            self.headers = dict(headers or {})
            self.media_type = media_type
            self._cookies: list[str] = []

    class APIRouter:
        def __init__(self, prefix: str = ""):
            self.prefix = prefix.rstrip("/")
            self.routes: list[tuple[str, re.Pattern[str], list[str], Callable[..., Any]]] = []

        def _add_route(self, method: str, path: str, func: Callable[..., Any]) -> Callable[..., Any]:
            full_path = f"{self.prefix}/{path.lstrip('/')}" if path != "/" else (self.prefix or "/")
            if full_path != "/" and full_path.endswith("/"):
                full_path = full_path.rstrip("/")
            param_names: list[str] = []

            def _repl(match: re.Match[str]) -> str:
                pname = match.group(1)
                param_names.append(pname)
                return r"([^/]+)"

            regex_str = "^" + re.sub(r"\{([a-zA-Z0-9_]+)\}", _repl, full_path) + "/?$"
            self.routes.append((method.upper(), re.compile(regex_str), param_names, func))
            return func

        def get(self, path: str) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
            return lambda f: self._add_route("GET", path, f)

        def post(self, path: str) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
            return lambda f: self._add_route("POST", path, f)

        def put(self, path: str) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
            return lambda f: self._add_route("PUT", path, f)

        def patch(self, path: str) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
            return lambda f: self._add_route("PATCH", path, f)

        def delete(self, path: str) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
            return lambda f: self._add_route("DELETE", path, f)

    class FastAPI(APIRouter):
        def __init__(self, title: str = "Aruta", version: str = "2.2.0", **kwargs: Any):
            super().__init__(prefix="")
            self.title = title
            self.version = version
            self.middlewares: list[Callable[..., Any]] = []
            self.startup_handlers: list[Callable[[], Any]] = []

        def include_router(self, router: APIRouter) -> None:
            self.routes.extend(router.routes)

        def middleware(self, mw_type: str) -> Callable[[Callable[..., Any]], Callable[..., Any]]:
            def _reg(func: Callable[..., Any]) -> Callable[..., Any]:
                self.middlewares.append(func)
                return func

            return _reg

        def on_event(self, event_type: str) -> Callable[[Callable[[], Any]], Callable[[], Any]]:
            def _reg(func: Callable[[], Any]) -> Callable[[], Any]:
                if event_type == "startup":
                    self.startup_handlers.append(func)
                return func

            return _reg


async def run_fallback_http_server(app: Any, host: str = "0.0.0.0", port: int = 8050) -> None:
    """Асинхронный HTTP/1.1 + SSE сервер для работы без внешнего пакета uvicorn."""
    from hub.auth import resolve_client_ip

    conn_sem = asyncio.Semaphore(MAX_CONCURRENT_CONNECTIONS)

    for handler in getattr(app, "startup_handlers", []):
        res = handler()
        if inspect.isawaitable(res):
            await res

    async def _dispatch_route(req: Request) -> Any:
        for method, pattern, param_names, func in app.routes:
            if method != req.method:
                continue
            m = pattern.match(req.path)
            if m:
                for idx, pname in enumerate(param_names):
                    req.path_params[pname] = urllib.parse.unquote(m.group(idx + 1))
                sig = inspect.signature(func)
                kwargs: dict[str, Any] = {}
                for arg_name, param in sig.parameters.items():
                    if arg_name in ("request", "req") or param.annotation is Request:
                        kwargs[arg_name] = req
                    elif arg_name in req.path_params:
                        val: Any = req.path_params[arg_name]
                        if param.annotation is int:
                            val = int(val)
                        kwargs[arg_name] = val
                    elif arg_name in req.query_params:
                        val = req.query_params[arg_name]
                        if param.annotation is int:
                            val = int(val)
                        kwargs[arg_name] = val
                try:
                    out = func(**kwargs)
                    if inspect.isawaitable(out):
                        out = await out
                    if isinstance(out, (Response, StreamingResponse)):
                        return out
                    return JSONResponse(out)
                except HTTPException as he:
                    return JSONResponse({"detail": he.detail, "error": he.detail}, status_code=he.status_code)
                except Exception:
                    err_id = secrets.token_hex(4)
                    print(f"[Aruta Error {err_id}] Необработанное исключение при вызове {req.path}:", flush=True)
                    traceback.print_exc()
                    return JSONResponse(
                        {"detail": f"Внутренняя ошибка сервера (код: {err_id})", "error_id": err_id},
                        status_code=500,
                    )
        return JSONResponse({"detail": f"Not Found: {req.path}"}, status_code=404)

    async def _handle_request_with_middlewares(req: Request) -> Any:
        mws = list(getattr(app, "middlewares", []))

        async def call_chain(idx: int, r: Request) -> Any:
            if idx < len(mws):
                return await mws[idx](r, lambda next_req: call_chain(idx + 1, next_req))
            return await _dispatch_route(r)

        try:
            return await call_chain(0, req)
        except HTTPException as he:
            return JSONResponse({"detail": he.detail, "error": he.detail}, status_code=he.status_code)
        except Exception:
            err_id = secrets.token_hex(4)
            traceback.print_exc()
            return JSONResponse(
                {"detail": f"Внутренняя ошибка сервера (код: {err_id})", "error_id": err_id},
                status_code=500,
            )

    async def _handle_client(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        if conn_sem.locked():
            try:
                writer.write(b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n")
                await writer.drain()
            except Exception:
                pass
            finally:
                writer.close()
            return

        async with conn_sem:
            try:
                header_data = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), timeout=15.0)
            except Exception:
                writer.close()
                return

            header_text = header_data.decode("utf-8", errors="replace")
            lines = header_text.split("\r\n")
            if not lines or not lines[0]:
                writer.close()
                return

            req_line_parts = lines[0].split(" ")
            if len(req_line_parts) < 2:
                writer.close()
                return
            method = req_line_parts[0]
            raw_target = req_line_parts[1]
            if "?" in raw_target:
                path, query_string = raw_target.split("?", 1)
            else:
                path, query_string = raw_target, ""

            headers: dict[str, str] = {}
            for line in lines[1:]:
                if ":" in line:
                    k, v = line.split(":", 1)
                    headers[k.strip()] = v.strip()

            try:
                content_length = int(headers.get("Content-Length", headers.get("content-length", "0")) or 0)
            except ValueError:
                content_length = 0

            # Лимит тела запроса (50 МБ -> 413) ДО чтения тела, проверки подсетей и входа
            if content_length > MAX_REQUEST_BODY_BYTES:
                err_body = json.dumps(
                    {
                        "detail": f"Превышен максимальный размер тела запроса ({MAX_REQUEST_BODY_BYTES // (1024 * 1024)} МБ)",
                        "max_bytes": MAX_REQUEST_BODY_BYTES,
                    },
                    ensure_ascii=False,
                ).encode("utf-8")
                hdrs = (
                    "HTTP/1.1 413 Payload Too Large\r\n"
                    "Content-Type: application/json; charset=utf-8\r\n"
                    f"Content-Length: {len(err_body)}\r\n"
                    "X-Frame-Options: DENY\r\n"
                    "X-Content-Type-Options: nosniff\r\n"
                    "Referrer-Policy: no-referrer\r\n"
                    "Connection: close\r\n\r\n"
                ).encode("utf-8")
                try:
                    writer.write(hdrs + err_body)
                    await writer.drain()
                except Exception:
                    pass
                finally:
                    writer.close()
                return

            body = b""
            if content_length > 0:
                try:
                    body = await asyncio.wait_for(reader.readexactly(content_length), timeout=30.0)
                except Exception:
                    body = await reader.read(content_length)

            peer = writer.get_extra_info("peername")
            direct_host = peer[0] if isinstance(peer, tuple) and peer else "127.0.0.1"
            fwd_for = headers.get("X-Forwarded-For", headers.get("x-forwarded-for", ""))
            client_host = resolve_client_ip(direct_host, fwd_for)

            req = Request(
                method=method,
                path=path,
                query_string=query_string,
                headers=headers,
                body=body,
                client_host=client_host,
            )

            resp = await _handle_request_with_middlewares(req)

            status_phrases = {
                200: "OK",
                201: "Created",
                202: "Accepted",
                204: "No Content",
                400: "Bad Request",
                401: "Unauthorized",
                403: "Forbidden",
                404: "Not Found",
                413: "Payload Too Large",
                429: "Too Many Requests",
                500: "Internal Server Error",
                503: "Service Unavailable",
            }

            if isinstance(resp, StreamingResponse):
                phrase = status_phrases.get(resp.status_code, "OK")
                hdr_lines = [
                    f"HTTP/1.1 {resp.status_code} {phrase}",
                    f"Content-Type: {resp.media_type}",
                    "Cache-Control: no-cache",
                    "Connection: keep-alive",
                    "X-Accel-Buffering: no",
                ]
                for hk, hv in resp.headers.items():
                    hdr_lines.append(f"{hk}: {hv}")
                for ck in resp._cookies:
                    hdr_lines.append(f"Set-Cookie: {ck}")
                writer.write(("\r\n".join(hdr_lines) + "\r\n\r\n").encode("utf-8"))
                await writer.drain()
                try:
                    async for chunk in resp.content:
                        data_bytes = chunk.encode("utf-8") if isinstance(chunk, str) else chunk
                        writer.write(data_bytes)
                        await writer.drain()
                except Exception:
                    pass
                finally:
                    try:
                        writer.close()
                    except Exception:
                        pass
                return

            phrase = status_phrases.get(resp.status_code, "OK")
            body_bytes = resp.body
            hdr_lines = [
                f"HTTP/1.1 {resp.status_code} {phrase}",
                f"Content-Type: {resp.media_type}",
                f"Content-Length: {len(body_bytes)}",
                "Connection: close",
            ]
            for hk, hv in resp.headers.items():
                hdr_lines.append(f"{hk}: {hv}")
            for ck in resp._cookies:
                hdr_lines.append(f"Set-Cookie: {ck}")

            try:
                writer.write(("\r\n".join(hdr_lines) + "\r\n\r\n").encode("utf-8") + body_bytes)
                await writer.drain()
            except Exception:
                pass
            finally:
                try:
                    writer.close()
                except Exception:
                    pass

    server = await asyncio.start_server(_handle_client, host=host, port=port)
    print(f"[Aruta] Сервер запущен на http://{host}:{port} (PID={os.getpid()})", flush=True)
    async with server:
        await server.serve_forever()
