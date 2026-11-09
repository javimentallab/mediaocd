"""A stand-in for the MediaOCD API, speaking real HTTP on the loopback interface.

It imitates the behaviour the MCP server depends on, including the awkward parts,
and records every request so that the tests can assert on what was actually sent.
"""

import json
import re
import threading
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any
from urllib.parse import parse_qsl, urlsplit

TOKEN = "fake-mediaocd-token-for-tests-only"

USER = {"id": 7, "name": "demo", "admin": True}
# The watchlist is deliberately not list 1: its id differs from one user to another.
LISTS = [
    {"id": 3, "name": "Favourites", "isWatchlist": False},
    {"id": 42, "name": "Watchlist", "isWatchlist": True},
]
ITEMS = {
    1: {
        "id": 1,
        "title": "First Movie",
        "mediaType": "movie",
        "releaseDate": "1999-03-31",
        "seen": True,
        "onWatchlist": False,
    },
    2: {
        "id": 2,
        "title": "Second Show",
        "mediaType": "tv",
        "releaseDate": "2011-04-17",
        "seen": False,
        "onWatchlist": True,
        "unseenEpisodesCount": 3,
    },
}
# Row ids (900, 901) on purpose differ from the ids of the items they point to.
LIST_ROWS = [
    {"id": 900, "listedAt": "2026-01-02T10:00:00.000Z", "type": "tv", "mediaItem": ITEMS[2]},
    {"id": 901, "listedAt": "2026-01-01T10:00:00.000Z", "type": "movie", "mediaItem": ITEMS[1]},
]
IN_PROGRESS = {"included": [1, 999], "excluded": [2], "items": [1, 999]}


@dataclass
class Recorded:
    method: str
    path: str
    query: dict[str, str]
    raw_query: str
    body: Any
    headers: dict[str, str]


class FakeMediaOCD:
    def __init__(self) -> None:
        self.requests: list[Recorded] = []
        # (method, path) -> (status, headers, body) replacing the normal answer.
        self.overrides: dict[tuple[str, str], tuple[int, dict[str, str], bytes]] = {}
        self._lock = threading.Lock()
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args: Any) -> None:
                pass

            def _serve(self) -> None:
                fake._handle(self)

            do_GET = do_PUT = do_DELETE = do_POST = _serve

        self._httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self._httpd.daemon_threads = True
        threading.Thread(target=self._httpd.serve_forever, daemon=True).start()

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self._httpd.server_address[1]}"

    def stop(self) -> None:
        self._httpd.shutdown()
        self._httpd.server_close()

    def reset(self) -> None:
        with self._lock:
            self.requests.clear()
            self.overrides.clear()

    def calls(self, method: str | None = None, path: str | None = None) -> list[Recorded]:
        with self._lock:
            return [
                r
                for r in self.requests
                if (method is None or r.method == method) and (path is None or r.path == path)
            ]

    def _handle(self, handler: BaseHTTPRequestHandler) -> None:
        parts = urlsplit(handler.path)
        length = int(handler.headers.get("Content-Length") or 0)
        raw_body = handler.rfile.read(length) if length else b""
        recorded = Recorded(
            method=handler.command,
            path=parts.path,
            query=dict(parse_qsl(parts.query)),
            raw_query=parts.query,
            body=json.loads(raw_body) if raw_body else None,
            headers={k.lower(): v for k, v in handler.headers.items()},
        )
        with self._lock:
            self.requests.append(recorded)
            override = self.overrides.get((recorded.method, recorded.path))
        status, headers, body = override or self._answer(recorded)
        handler.send_response(status)
        for name, value in headers.items():
            handler.send_header(name, value)
        handler.send_header("Content-Length", str(len(body)))
        handler.end_headers()
        handler.wfile.write(body)

    def _answer(self, req: Recorded) -> tuple[int, dict[str, str], bytes]:
        authorized = req.headers.get("authorization") == f"Bearer {TOKEN}"
        route = (req.method, req.path)

        if route == ("GET", "/api/user"):
            return _json(USER if authorized else None)  # 200 even with a bad token
        if not authorized:
            return 401, {}, b""

        details = re.fullmatch(r"/api/details/(\d+)", req.path)
        if req.method == "GET" and details:
            item = ITEMS.get(int(details.group(1)))
            return _json(item) if item else (404, {}, b"")

        if route == ("GET", "/api/search"):
            if not req.query.get("q") or not req.query.get("mediaType"):
                return 400, {}, b""
            return _json([i for i in ITEMS.values() if i["mediaType"] == req.query["mediaType"]])
        if route == ("GET", "/api/items"):
            wanted = req.query.get("mediaType")
            return _json([i for i in ITEMS.values() if wanted in (None, i["mediaType"])])
        if route == ("GET", "/api/actively-in-progress"):
            return _json(IN_PROGRESS)
        if route == ("GET", "/api/lists"):
            if "userId" not in req.query:  # the real server fails on the undefined binding
                return 500, {}, b"Undefined binding(s) detected"
            return _json(LISTS if req.query["userId"] == str(USER["id"]) else [])
        if route == ("GET", "/api/list/items"):
            return _json(LIST_ROWS if req.query.get("listId") == "42" else [])

        if route == ("PUT", "/api/seen"):
            return _empty_if_known(req.query.get("mediaItemId"))
        if route == ("DELETE", "/api/seen/"):
            return _empty_if_known(req.query.get("mediaItemId"))
        if route in (("PUT", "/api/watchlist"), ("DELETE", "/api/watchlist")):
            return _empty_if_known(req.query.get("mediaItemId"))
        if route == ("PUT", "/api/rating"):
            return (200, {}, b"") if req.body and "mediaItemId" in req.body else (400, {}, b"")
        return 404, {}, b""


def _json(data: Any) -> tuple[int, dict[str, str], bytes]:
    return 200, {"Content-Type": "application/json"}, json.dumps(data).encode()


def _empty_if_known(media_item_id: str | None) -> tuple[int, dict[str, str], bytes]:
    known = media_item_id is not None and media_item_id.isdigit() and int(media_item_id) in ITEMS
    return (200, {}, b"") if known else (400, {}, b"")
