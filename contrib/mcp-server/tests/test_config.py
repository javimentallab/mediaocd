"""What the server accepts at startup, and that a bad configuration fails closed."""

import subprocess
import sys

import pytest
import server as mcp_server
from conftest import SERVER_DIR, clean_env
from server import ConfigError, load_config

BASE = {"MEDIAOCD_TOKEN": "a-mediaocd-token"}
LONG_TOKEN = "x" * 32


def test_defaults_are_safe():
    cfg = load_config(BASE)
    assert cfg.host == "127.0.0.1"
    assert cfg.transport == "streamable-http"
    assert cfg.auth_token == ""
    assert cfg.base_url == "http://localhost:7481"
    assert set(cfg.allowed_hosts) == {"127.0.0.1:*", "localhost:*", "[::1]:*"}


def test_token_is_required():
    with pytest.raises(ConfigError, match="MEDIAOCD_TOKEN"):
        load_config({})


@pytest.mark.parametrize("token", ["with space", "line\nbreak", "ñandú"])
def test_token_must_fit_in_a_header(token):
    with pytest.raises(ConfigError, match="MEDIAOCD_TOKEN"):
        load_config({"MEDIAOCD_TOKEN": token})


@pytest.mark.parametrize("host", ["0.0.0.0", "::", "192.0.2.10", "mcp.example.org"])
def test_non_loopback_without_auth_is_refused(host):
    with pytest.raises(ConfigError, match="MCP_AUTH_TOKEN"):
        load_config({**BASE, "MCP_HOST": host})


@pytest.mark.parametrize(
    "host,expected",
    [
        ("127.0.0.1", "127.0.0.1"),
        ("127.0.0.53", "127.0.0.53"),
        ("localhost", "localhost"),
        ("::1", "::1"),
        ("[::1]", "::1"),
    ],
)
def test_loopback_without_auth_is_allowed(host, expected):
    assert load_config({**BASE, "MCP_HOST": host}).host == expected


def test_non_loopback_with_auth_is_allowed():
    cfg = load_config({**BASE, "MCP_HOST": "0.0.0.0", "MCP_AUTH_TOKEN": LONG_TOKEN})
    assert cfg.auth_token == LONG_TOKEN


@pytest.mark.parametrize("value", ["", "no", "false", "0"])
def test_override_only_counts_when_explicit(value):
    with pytest.raises(ConfigError):
        load_config({**BASE, "MCP_HOST": "0.0.0.0", "MCP_ALLOW_UNAUTHENTICATED": value})


def test_explicit_override_is_honoured():
    cfg = load_config({**BASE, "MCP_HOST": "0.0.0.0", "MCP_ALLOW_UNAUTHENTICATED": "true"})
    assert cfg.auth_token == ""


def test_stdio_does_not_need_auth():
    assert load_config({**BASE, "MCP_TRANSPORT": "stdio", "MCP_HOST": "0.0.0.0"}).transport == "stdio"


def test_weak_auth_token_is_refused():
    with pytest.raises(ConfigError, match="at least"):
        load_config({**BASE, "MCP_AUTH_TOKEN": "short"})


def test_auth_token_must_differ_from_the_mediaocd_token():
    with pytest.raises(ConfigError, match="different"):
        load_config({"MEDIAOCD_TOKEN": LONG_TOKEN, "MCP_AUTH_TOKEN": LONG_TOKEN})


@pytest.mark.parametrize(
    "url",
    [
        "ftp://example.org",
        "file:///etc/passwd",
        "example.org:7481",
        "http://",
        "http://user:hunter2@example.org",
        "http://example.org?x=1",
        "http://example.org#fragment",
        "http://example.org:notaport",
    ],
)
def test_bad_urls_are_refused_without_being_repeated(url):
    with pytest.raises(ConfigError) as caught:
        load_config({**BASE, "MEDIAOCD_URL": url})
    assert "example.org" not in str(caught.value)
    assert "hunter2" not in str(caught.value)


@pytest.mark.parametrize(
    "url,expected",
    [
        ("http://mediaocd:7481/", "http://mediaocd:7481"),
        ("https://media.example.org/app/", "https://media.example.org/app"),
    ],
)
def test_good_urls(url, expected):
    assert load_config({**BASE, "MEDIAOCD_URL": url}).base_url == expected


@pytest.mark.parametrize(
    "name,value",
    [
        ("MCP_PORT", "0"),
        ("MCP_PORT", "70000"),
        ("MCP_PORT", "abc"),
        ("MEDIAOCD_TIMEOUT", "0"),
        ("MEDIAOCD_TIMEOUT", "nan"),
        ("MEDIAOCD_TIMEOUT", "abc"),
        ("MCP_TRANSPORT", "sse"),
        ("MCP_LOG_LEVEL", "LOUD"),
    ],
)
def test_bad_values_are_refused(name, value):
    with pytest.raises(ConfigError, match=name):
        load_config({**BASE, name: value})


def test_specific_bind_address_is_added_to_the_allowed_hosts():
    cfg = load_config({**BASE, "MCP_HOST": "192.0.2.10", "MCP_AUTH_TOKEN": LONG_TOKEN})
    assert "192.0.2.10:*" in cfg.allowed_hosts


def test_secrets_stay_out_of_the_config_repr():
    cfg = load_config({"MEDIAOCD_TOKEN": "secret-one", "MCP_AUTH_TOKEN": "secret-two" * 3})
    assert "secret-one" not in repr(cfg)
    assert "secret-two" not in repr(cfg)


def test_process_refuses_to_start_without_a_token():
    done = subprocess.run(
        [sys.executable, str(SERVER_DIR / "server.py")],
        env=clean_env(),
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert done.returncode == 2
    assert "MEDIAOCD_TOKEN" in done.stderr


def test_process_refuses_a_public_bind_without_auth_and_keeps_the_token_quiet():
    token = "must-not-appear-in-any-output"
    done = subprocess.run(
        [sys.executable, str(SERVER_DIR / "server.py")],
        env=clean_env(MEDIAOCD_TOKEN=token, MCP_HOST="0.0.0.0"),
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert done.returncode == 2
    assert "MCP_AUTH_TOKEN" in done.stderr
    assert token not in done.stderr + done.stdout


def test_module_import_needs_no_configuration():
    assert mcp_server.mcp.name == "mediaocd"
