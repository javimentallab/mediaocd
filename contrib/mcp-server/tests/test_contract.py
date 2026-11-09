"""Hold the server to the API it targets, as defined by the MediaOCD code in this repo.

The fake is only as right as whoever wrote it. These tests run every tool, then check
each request the fake received against the route table of the real application.
They are skipped if contrib/mcp-server is used outside the repository.
"""

import re
import typing

import pytest
import server as mcp_server
from conftest import SERVER_DIR, call_tool

ROUTES_FILE = SERVER_DIR.parent.parent / "app" / "build" / "generated" / "routes" / "routes.js"

# Read by the controllers from req.query, although the generated schema leaves them out.
UNDECLARED_BUT_READ = {("PUT", "/api/seen"): {"kind"}, ("DELETE", "/api/seen/"): {"kind"}}

pytestmark = pytest.mark.skipif(not ROUTES_FILE.exists(), reason="not inside the MediaOCD repository")


def parse_routes() -> dict[tuple[str, str], str]:
    """(METHOD, path) -> source of that route, up to the next route."""
    source = ROUTES_FILE.read_text(encoding="utf-8")
    matches = list(re.finditer(r"router\.(get|put|delete|post|patch)\('(/api/[^']*)'", source))
    routes = {}
    for match, following in zip(matches, matches[1:] + [None]):
        end = following.start() if following else len(source)
        routes[(match.group(1).upper(), match.group(2))] = source[match.start() : end]
    return routes


def find_route(routes: dict[tuple[str, str], str], method: str, path: str) -> str | None:
    if (method, path) in routes:
        return routes[(method, path)]
    for (route_method, route_path), block in routes.items():
        if route_method != method or ":" not in route_path:
            continue
        pattern = re.sub(r":\w+", r"[^/]+", route_path)
        if re.fullmatch(pattern, path):
            return block
    return None


def exercise_every_tool(server) -> None:
    call_tool(server, "search", term="x", media_type="tv")
    call_tool(server, "library", media_type="movie", order_by="title", limit=1)
    call_tool(server, "details", media_item_id=1)
    call_tool(server, "in_progress")
    call_tool(server, "watchlist")
    call_tool(server, "status")
    call_tool(server, "mark_seen", media_item_id=2, season_id=5, episode_id=6, when="custom_date", date="2024-05-31")
    call_tool(server, "unmark_seen", media_item_id=2, season_id=5, episode_id=6)
    call_tool(server, "watchlist_add", media_item_id=1)
    call_tool(server, "watchlist_remove", media_item_id=1)
    call_tool(server, "rate", media_item_id=1, rating=3, review="ok")


def test_every_request_matches_a_real_route(open_server, fake):
    routes = parse_routes()
    exercise_every_tool(open_server)
    assert len(fake.requests) >= 14
    for request in fake.requests:
        block = find_route(routes, request.method, request.path)
        assert block is not None, f"no such route: {request.method} {request.path}"
        allowed = UNDECLARED_BUT_READ.get((request.method, request.path), set())
        for name in set(request.query) - allowed:
            assert re.search(rf"\b{name}:", block), f"{request.method} {request.path} has no parameter {name}"
        for name in request.body or {}:
            assert re.search(rf"\b{name}:", block), f"{request.method} {request.path} has no body field {name}"


def test_body_and_query_go_where_the_route_expects_them(open_server, fake):
    routes = parse_routes()
    exercise_every_tool(open_server)
    for request in fake.requests:
        block = find_route(routes, request.method, request.path)
        if request.body:
            assert "requestBodySchema" in block, f"{request.path} does not take a body"
        if request.query:
            assert "requestQuerySchema" in block, f"{request.path} does not take a query string"


def enum_values(block: str, definition: str) -> set[str]:
    match = re.search(rf"{definition}: \{{\s*enum: \[([^\]]*)\]", block)
    assert match, f"{definition} not found"
    return set(re.findall(r"'([^']+)'", match.group(1)))


def test_enums_match_the_application():
    routes = parse_routes()
    items = routes[("GET", "/api/items")]
    seen = routes[("PUT", "/api/seen")]
    assert set(typing.get_args(mcp_server.MediaType)) == enum_values(items, "MediaType")
    assert set(typing.get_args(mcp_server.OrderBy)) == enum_values(items, "MediaItemOrderBy")
    assert set(typing.get_args(mcp_server.SeenWhen)) == enum_values(seen, "LastSeenAt")
