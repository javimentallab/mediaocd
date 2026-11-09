"""Each tool end to end: MCP client -> server.py -> fake MediaOCD."""

import sys
from datetime import datetime, timedelta, timezone

import anyio
import pytest
from conftest import SERVER_DIR, call_tool, clean_env, free_port, list_tools, start_server
from fake_mediaocd import TOKEN
from mcp.client import Client
from mcp.client.stdio import StdioServerParameters

READ_TOOLS = {"search", "library", "details", "in_progress", "watchlist", "status"}
WRITE_TOOLS = {"mark_seen", "unmark_seen", "watchlist_add", "watchlist_remove", "rate"}


def writes(fake):
    return [r for r in fake.requests if r.method != "GET"]


def test_tool_list_and_annotations(open_server):
    tools = {tool.name: tool for tool in list_tools(open_server)}
    assert set(tools) == READ_TOOLS | WRITE_TOOLS
    for name in READ_TOOLS:
        assert tools[name].annotations.read_only_hint is True, name
    for name in WRITE_TOOLS:
        assert tools[name].annotations.read_only_hint is False, name
    for name in ("unmark_seen", "watchlist_remove", "rate"):
        assert tools[name].annotations.destructive_hint is True, name


def test_every_tool_has_a_description(open_server):
    assert all(tool.description for tool in list_tools(open_server))


def test_search(open_server, fake):
    result = call_tool(open_server, "search", term="first movie", media_type="movie")
    assert not result.is_error
    assert result.json["found"] == 1
    assert result.json["results"][0] == {
        "id": 1,
        "title": "First Movie",
        "mediaType": "movie",
        "year": "1999",
        "seen": True,
        "on_watchlist": False,
    }
    sent = fake.calls("GET", "/api/search")[0]
    assert sent.query == {"q": "first movie", "mediaType": "movie"}
    assert sent.headers["authorization"] == f"Bearer {TOKEN}"


def test_the_token_never_goes_in_the_url(open_server, fake):
    call_tool(open_server, "search", term="x")
    assert all(TOKEN not in r.raw_query for r in fake.requests)


@pytest.mark.parametrize(
    "arguments",
    [
        {"term": ""},
        {"term": "   "},
        {"term": "x" * 201},
        {"term": "x", "media_type": "podcast"},
        {"term": "x", "media_type": "movie&admin=1"},
    ],
)
def test_search_validation(open_server, fake, arguments):
    assert call_tool(open_server, "search", **arguments).is_error
    assert fake.requests == []


def test_search_escapes_the_term(open_server, fake):
    call_tool(open_server, "search", term="a&mediaType=tv#b")
    assert fake.calls("GET", "/api/search")[0].query == {"q": "a&mediaType=tv#b", "mediaType": "movie"}


def test_library(open_server, fake):
    result = call_tool(open_server, "library", media_type="tv", order_by="title", limit=5)
    assert result.json["total"] == 1
    assert result.json["items"][0]["unseen_episodes"] == 3
    assert fake.calls("GET", "/api/items")[0].query == {"mediaType": "tv", "orderBy": "title", "sortOrder": "desc"}


def test_library_without_a_type_lists_everything(open_server, fake):
    assert call_tool(open_server, "library").json["total"] == 2
    assert "mediaType" not in fake.calls("GET", "/api/items")[0].query


def test_library_applies_the_limit(open_server, fake):
    result = call_tool(open_server, "library", limit=1).json
    assert (result["total"], result["showing"], len(result["items"])) == (2, 1, 1)


@pytest.mark.parametrize(
    "arguments",
    [
        {"order_by": "password"},
        {"order_by": "title;drop"},
        {"limit": 0},
        {"limit": -1},
        {"limit": 201},
        {"limit": "ten"},
        {"media_type": "podcast"},
    ],
)
def test_library_validation(open_server, fake, arguments):
    assert call_tool(open_server, "library", **arguments).is_error
    assert fake.requests == []


@pytest.mark.parametrize("bad_id", [0, -1, 2**53, "1/../../etc", "1?x=1", "abc", 1.5, True, None, [1]])
@pytest.mark.parametrize(
    "tool", ["details", "mark_seen", "unmark_seen", "watchlist_add", "watchlist_remove", "rate"]
)
def test_ids_are_validated_in_every_tool(open_server, fake, tool, bad_id):
    extra = {"rating": 3} if tool == "rate" else {}
    assert call_tool(open_server, tool, media_item_id=bad_id, **extra).is_error
    assert fake.requests == []


def test_details(open_server, fake):
    assert call_tool(open_server, "details", media_item_id=2).json["title"] == "Second Show"


def test_details_of_a_missing_item_is_an_error(open_server, fake):
    result = call_tool(open_server, "details", media_item_id=999)
    assert result.is_error
    assert "HTTP 404" in result.text


def test_in_progress_survives_one_broken_item(open_server, fake):
    result = call_tool(open_server, "in_progress").json
    assert result["total"] == 2
    assert result["items"][0]["title"] == "First Movie"
    assert result["items"][1]["id"] == 999
    assert "HTTP 404" in result["items"][1]["error"]


def test_watchlist_finds_the_list_of_this_user(open_server, fake):
    result = call_tool(open_server, "watchlist").json
    assert result["list"] == "Watchlist"
    assert fake.calls("GET", "/api/lists")[0].query == {"userId": "7"}
    assert fake.calls("GET", "/api/list/items")[0].query == {"listId": "42"}


def test_watchlist_reports_the_item_id_not_the_row_id(open_server, fake):
    items = call_tool(open_server, "watchlist").json["items"]
    assert [item["id"] for item in items] == [2, 1]
    assert items[0]["listed_on"] == "2026-01-02"


def test_watchlist_without_one_is_an_error(open_server, fake):
    fake.overrides[("GET", "/api/lists")] = (200, {"Content-Type": "application/json"}, b"[]")
    result = call_tool(open_server, "watchlist")
    assert result.is_error
    assert "no watchlist" in result.text


def test_mark_seen_uses_the_query_string(open_server, fake):
    result = call_tool(open_server, "mark_seen", media_item_id=1)
    assert not result.is_error
    sent = fake.calls("PUT", "/api/seen")[0]
    assert sent.query == {"mediaItemId": "1", "lastSeenAt": "now", "kind": "played"}
    assert sent.body is None


def test_mark_seen_episode_and_kind(open_server, fake):
    call_tool(open_server, "mark_seen", media_item_id=2, season_id=5, episode_id=6, kind="watched", when="unknown")
    assert fake.calls("PUT", "/api/seen")[0].query == {
        "mediaItemId": "2",
        "seasonId": "5",
        "episodeId": "6",
        "lastSeenAt": "unknown",
        "kind": "watched",
    }


@pytest.mark.parametrize(
    "date,expected",
    [
        ("2024-05-31", 1717113600000),
        ("2024-05-31T12:00:00+02:00", 1717149600000),
    ],
)
def test_mark_seen_custom_date_is_sent_in_milliseconds(open_server, fake, date, expected):
    call_tool(open_server, "mark_seen", media_item_id=1, when="custom_date", date=date)
    sent = fake.calls("PUT", "/api/seen")[0].query
    assert sent["lastSeenAt"] == "custom_date"
    assert sent["date"] == str(expected)


@pytest.mark.parametrize(
    "arguments",
    [
        {"when": "custom_date"},
        {"when": "custom_date", "date": "yesterday"},
        {"when": "custom_date", "date": "1969-12-31"},
        {"when": "custom_date", "date": "2024-05-31" + "x" * 40},
        {"when": "custom_date", "date": (datetime.now(timezone.utc) + timedelta(days=2)).isoformat()},
        {"when": "now", "date": "2024-05-31"},
        {"when": "tomorrow"},
        {"kind": "stolen"},
        {"season_id": 0},
        {"episode_id": -5},
    ],
)
def test_mark_seen_validation(open_server, fake, arguments):
    assert call_tool(open_server, "mark_seen", media_item_id=1, **arguments).is_error
    assert fake.requests == []


def test_mark_seen_of_an_unknown_item_reports_the_failure(open_server, fake):
    result = call_tool(open_server, "mark_seen", media_item_id=999)
    assert result.is_error
    assert "HTTP 400" in result.text


def test_unmark_seen_undoes_what_mark_seen_wrote(open_server, fake):
    call_tool(open_server, "mark_seen", media_item_id=1)
    call_tool(open_server, "unmark_seen", media_item_id=1)
    written = fake.calls("PUT", "/api/seen")[0].query["kind"]
    deleted = fake.calls("DELETE", "/api/seen/")[0].query
    assert deleted == {"mediaItemId": "1", "kind": written}


def test_unmark_seen_can_be_narrowed(open_server, fake):
    call_tool(open_server, "unmark_seen", media_item_id=2, episode_id=6, kind="watched")
    assert fake.calls("DELETE", "/api/seen/")[0].query == {"mediaItemId": "2", "episodeId": "6", "kind": "watched"}


def test_watchlist_add_and_remove(open_server, fake):
    assert not call_tool(open_server, "watchlist_add", media_item_id=1).is_error
    assert not call_tool(open_server, "watchlist_remove", media_item_id=1).is_error
    assert fake.calls("PUT", "/api/watchlist")[0].query == {"mediaItemId": "1"}
    assert fake.calls("DELETE", "/api/watchlist")[0].query == {"mediaItemId": "1"}


def test_rate_only_sends_what_it_was_given(open_server, fake):
    call_tool(open_server, "rate", media_item_id=1, rating=4)
    call_tool(open_server, "rate", media_item_id=1, review="Good")
    call_tool(open_server, "rate", media_item_id=1, rating=5, review="Great")
    bodies = [r.body for r in fake.calls("PUT", "/api/rating")]
    assert bodies == [
        {"mediaItemId": 1, "rating": 4},
        {"mediaItemId": 1, "review": "Good"},
        {"mediaItemId": 1, "rating": 5, "review": "Great"},
    ]


def test_rate_can_empty_a_review(open_server, fake):
    call_tool(open_server, "rate", media_item_id=1, review="")
    assert fake.calls("PUT", "/api/rating")[0].body == {"mediaItemId": 1, "review": ""}


@pytest.mark.parametrize(
    "arguments",
    [
        {},
        {"rating": 0},
        {"rating": 6},
        {"rating": -1},
        {"rating": 3.5},
        {"rating": "NaN"},
        {"rating": float("inf")},
        {"rating": True},
        {"review": "x" * 10_001},
    ],
)
def test_rate_validation(open_server, fake, arguments):
    assert call_tool(open_server, "rate", media_item_id=1, **arguments).is_error
    assert writes(fake) == []


def test_status(open_server, fake):
    assert call_tool(open_server, "status").json == {"user": "demo", "movies": 1, "tv_shows": 1}


def test_status_notices_a_token_that_mediaocd_ignores(fake, session_dir):
    server = start_server(session_dir, MEDIAOCD_URL=fake.url, MEDIAOCD_TOKEN="not-the-right-token")
    try:
        result = call_tool(server, "status")
        rejected = call_tool(server, "library")
    finally:
        server.stop()
    assert result.is_error
    assert "MEDIAOCD_TOKEN" in result.text
    assert rejected.is_error
    assert "401" in rejected.text


def assert_nothing_leaked(text, *extra):
    for secret in (TOKEN, *extra):
        assert secret not in text


@pytest.mark.parametrize("status", [400, 403, 404, 500, 502])
def test_upstream_errors_do_not_leak(open_server, fake, status):
    body = f"stack trace at {fake.url} token={TOKEN} /srv/private/path".encode()
    fake.overrides[("GET", "/api/items")] = (status, {}, body)
    result = call_tool(open_server, "library")
    assert result.is_error
    assert f"HTTP {status}" in result.text
    assert_nothing_leaked(result.text, fake.url, "/srv/private/path", "stack trace", "127.0.0.1")


def test_unreachable_mediaocd_does_not_leak(session_dir):
    dead = f"http://127.0.0.1:{free_port()}"
    server = start_server(session_dir, MEDIAOCD_URL=dead, MEDIAOCD_TOKEN=TOKEN)
    try:
        result = call_tool(server, "library")
    finally:
        server.stop()
    assert result.is_error
    assert "Could not reach MediaOCD." in result.text
    assert_nothing_leaked(result.text, dead, "127.0.0.1")
    assert_nothing_leaked(server.logs(), dead)


def test_redirects_are_not_followed_so_the_token_stays_home(open_server, fake):
    target = f"{fake.url}/stolen"
    fake.overrides[("GET", "/api/items")] = (302, {"Location": target}, b"")
    result = call_tool(open_server, "library")
    assert result.is_error
    assert "Redirects are not followed" in result.text
    assert target not in result.text
    assert fake.calls("GET", "/stolen") == []


def test_non_json_answers_are_reported(open_server, fake):
    fake.overrides[("GET", "/api/items")] = (200, {"Content-Type": "text/html"}, b"<html>index</html>")
    result = call_tool(open_server, "library")
    assert result.is_error
    assert "unexpected answer" in result.text
    assert "<html>" not in result.text


def test_a_proxy_in_the_environment_is_ignored(fake, session_dir):
    server = start_server(
        session_dir,
        MEDIAOCD_URL=fake.url,
        MEDIAOCD_TOKEN=TOKEN,
        HTTP_PROXY=f"http://127.0.0.1:{free_port()}",
        ALL_PROXY=f"http://127.0.0.1:{free_port()}",
        NO_PROXY="",
    )
    try:
        assert not call_tool(server, "status").is_error
    finally:
        server.stop()


def test_stdio_transport(fake):
    params = StdioServerParameters(
        command=sys.executable,
        args=[str(SERVER_DIR / "server.py")],
        env=clean_env(MEDIAOCD_URL=fake.url, MEDIAOCD_TOKEN=TOKEN, MCP_TRANSPORT="stdio"),
    )

    async def run():
        async with Client(params) as client:
            names = {tool.name for tool in (await client.list_tools()).tools}
            result = await client.call_tool("status", {})
        return names, result

    names, result = anyio.run(run)
    assert names == READ_TOOLS | WRITE_TOOLS
    assert not result.is_error
