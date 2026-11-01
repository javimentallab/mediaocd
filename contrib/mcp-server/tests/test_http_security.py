"""Client authentication and header checks, over real HTTP against server.py."""

import httpx2
import pytest
from conftest import AUTH_TOKEN, call_tool, start_server
from fake_mediaocd import TOKEN

INITIALIZE = {
    "jsonrpc": "2.0",
    "id": 1,
    "method": "initialize",
    "params": {
        "protocolVersion": "2025-06-18",
        "capabilities": {},
        "clientInfo": {"name": "tests", "version": "1"},
    },
}
MCP_HEADERS = {"Content-Type": "application/json", "Accept": "application/json, text/event-stream"}


def post(server, headers=None, url=None):
    return httpx2.post(
        url or server.url,
        json=INITIALIZE,
        headers={**MCP_HEADERS, **(headers or {})},
        timeout=10,
    )


GOOD = {"Authorization": f"Bearer {AUTH_TOKEN}"}


def test_no_token_is_rejected(auth_server):
    response = post(auth_server)
    assert response.status_code == 401
    assert response.headers["www-authenticate"] == "Bearer"


@pytest.mark.parametrize(
    "header",
    [
        "Bearer wrong-token",
        f"Bearer {AUTH_TOKEN}x",
        f"Bearer {AUTH_TOKEN[:-1]}",
        f"Basic {AUTH_TOKEN}",
        AUTH_TOKEN,
        "Bearer",
        f"Bearer {TOKEN}",
    ],
)
def test_bad_credentials_are_rejected(auth_server, header):
    assert post(auth_server, {"Authorization": header}).status_code == 401


def test_good_token_is_accepted(auth_server):
    assert post(auth_server, GOOD).status_code == 200


def test_scheme_is_case_insensitive(auth_server):
    assert post(auth_server, {"Authorization": f"bearer {AUTH_TOKEN}"}).status_code == 200


def test_token_in_the_query_string_does_not_count(auth_server):
    url = f"{auth_server.url}?token={AUTH_TOKEN}&access_token={AUTH_TOKEN}"
    assert post(auth_server, url=url).status_code == 401


@pytest.mark.parametrize("method", ["GET", "DELETE", "PUT", "OPTIONS"])
def test_every_method_needs_the_token(auth_server, method):
    assert httpx2.request(method, auth_server.url, timeout=10).status_code == 401


def test_other_paths_need_the_token_too(auth_server):
    assert httpx2.get(f"http://127.0.0.1:{auth_server.port}/", timeout=10).status_code == 401


def test_tools_refuse_without_the_token_and_nothing_reaches_mediaocd(auth_server, fake):
    body = {**INITIALIZE, "method": "tools/call", "params": {"name": "mark_seen", "arguments": {"media_item_id": 1}}}
    response = httpx2.post(auth_server.url, json=body, headers=MCP_HEADERS, timeout=10)
    assert response.status_code == 401
    assert fake.requests == []


def test_tools_work_with_the_token(auth_server, fake):
    assert call_tool(auth_server, "status").json["user"] == "demo"


@pytest.mark.parametrize("host", ["evil.example", "127.0.0.1.evil.example", "localhost.evil.example:80"])
def test_unknown_host_header_is_rejected(auth_server, host):
    assert post(auth_server, {**GOOD, "Host": host}).status_code == 421


def test_loopback_server_rejects_unknown_host_without_auth(open_server):
    assert post(open_server, {"Host": "evil.example"}).status_code == 421


def test_allowed_host_is_accepted(auth_server):
    assert post(auth_server, {**GOOD, "Host": "mcp.example.org"}).status_code == 200


@pytest.mark.parametrize("origin", ["https://evil.example", "http://localhost.evil.example:8016", "null"])
def test_unknown_origin_is_rejected(auth_server, origin):
    assert post(auth_server, {**GOOD, "Origin": origin}).status_code == 403


@pytest.mark.parametrize("origin", ["http://localhost:3000", "https://client.example.org"])
def test_allowed_origin_is_accepted(auth_server, origin):
    assert post(auth_server, {**GOOD, "Origin": origin}).status_code == 200


def test_no_cors_headers_are_offered(auth_server):
    response = post(auth_server, {**GOOD, "Origin": "http://localhost:3000"})
    assert "access-control-allow-origin" not in response.headers


def test_oversized_bodies_are_rejected(auth_server):
    padding = {"padding": "x" * (5 * 1024 * 1024)}
    response = httpx2.post(auth_server.url, json={**INITIALIZE, **padding}, headers={**MCP_HEADERS, **GOOD}, timeout=30)
    assert response.status_code == 413


def test_server_header_is_not_sent(auth_server):
    assert "server" not in post(auth_server).headers


def test_rejections_are_logged_without_the_presented_token(auth_server):
    post(auth_server, {"Authorization": "Bearer guess-that-must-not-be-logged"})
    logs = auth_server.logs()
    assert "Rejected a request" in logs
    assert "guess-that-must-not-be-logged" not in logs


def test_no_token_ever_reaches_the_logs_even_on_debug(fake, session_dir):
    server = start_server(
        session_dir,
        headers=GOOD,
        MEDIAOCD_URL=fake.url,
        MEDIAOCD_TOKEN=TOKEN,
        MCP_AUTH_TOKEN=AUTH_TOKEN,
        MCP_LOG_LEVEL="DEBUG",
    )
    try:
        assert call_tool(server, "status").json["user"] == "demo"
        assert call_tool(server, "details", media_item_id=999_999).is_error
        post(server, {"Authorization": "Bearer nope"})
    finally:
        server.stop()
    logs = server.logs()
    assert logs, "the server should have logged something at DEBUG"
    assert TOKEN not in logs
    assert AUTH_TOKEN not in logs
    assert fake.url not in logs


def test_unauthenticated_public_bind_warns(fake, session_dir):
    server = start_server(
        session_dir,
        MEDIAOCD_URL=fake.url,
        MEDIAOCD_TOKEN=TOKEN,
        MCP_ALLOW_UNAUTHENTICATED="true",
    )
    try:
        assert "MCP_AUTH_TOKEN is not set" in server.logs()
    finally:
        server.stop()
