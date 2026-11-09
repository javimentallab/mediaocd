"""Fixtures: a fake MediaOCD and real server.py processes talking to it over HTTP."""

import json
import os
import socket
import subprocess
import sys
import time
from collections.abc import Iterator
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import anyio
import httpx2
import pytest
from mcp.client import Client
from mcp.client.streamable_http import streamable_http_client

HERE = Path(__file__).resolve().parent
SERVER_DIR = HERE.parent
sys.path[:0] = [str(HERE), str(SERVER_DIR)]

from fake_mediaocd import TOKEN, FakeMediaOCD  # noqa: E402

AUTH_TOKEN = "fake-client-auth-token-for-tests-only"


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def clean_env(**overrides: str) -> dict[str, str]:
    """Only what the interpreter needs, so a developer's own settings cannot leak in."""
    env = {key: os.environ[key] for key in ("PATH", "SYSTEMROOT", "TEMP", "TMP") if key in os.environ}
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    env.update(overrides)
    return env


@dataclass
class RunningServer:
    process: subprocess.Popen
    port: int
    stderr_path: Path
    headers: dict[str, str] = field(default_factory=dict)

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.port}/mcp"

    def logs(self) -> str:
        return self.stderr_path.read_text(encoding="utf-8", errors="replace")

    def stop(self) -> None:
        self.process.terminate()
        try:
            self.process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait(timeout=5)


def start_server(tmp_dir: Path, headers: dict[str, str] | None = None, **env_vars: str) -> RunningServer:
    port = free_port()
    stderr_path = tmp_dir / f"server-{port}.log"
    env = clean_env(MCP_HOST="127.0.0.1", MCP_PORT=str(port), **env_vars)
    with stderr_path.open("w", encoding="utf-8") as stderr:
        process = subprocess.Popen(
            [sys.executable, str(SERVER_DIR / "server.py")],
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=stderr,
            stderr=stderr,
        )
    server = RunningServer(process, port, stderr_path, headers or {})
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"server.py exited with {process.returncode}:\n{server.logs()}")
        try:
            socket.create_connection(("127.0.0.1", port), timeout=0.2).close()
            return server
        except OSError:
            time.sleep(0.05)
    server.stop()
    raise RuntimeError(f"server.py did not start:\n{server.logs()}")


@dataclass
class ToolResult:
    text: str
    is_error: bool

    @property
    def json(self) -> Any:
        return json.loads(self.text)


@asynccontextmanager
async def connect(server: RunningServer):
    async with httpx2.AsyncClient(headers=server.headers) as http_client:
        async with Client(streamable_http_client(server.url, http_client=http_client)) as client:
            yield client


def call_tool(server: RunningServer, name: str, **arguments: Any) -> ToolResult:
    async def run() -> ToolResult:
        async with connect(server) as client:
            result = await client.call_tool(name, arguments)
        text = "\n".join(block.text for block in result.content if hasattr(block, "text"))
        return ToolResult(text, bool(result.is_error))

    return anyio.run(run)


def list_tools(server: RunningServer) -> list[Any]:
    async def run() -> list[Any]:
        async with connect(server) as client:
            return (await client.list_tools()).tools

    return anyio.run(run)


@pytest.fixture(scope="session")
def session_dir(tmp_path_factory: pytest.TempPathFactory) -> Path:
    return tmp_path_factory.mktemp("mcp-server")


@pytest.fixture(scope="session")
def fake_session() -> Iterator[FakeMediaOCD]:
    fake = FakeMediaOCD()
    yield fake
    fake.stop()


@pytest.fixture
def fake(fake_session: FakeMediaOCD) -> FakeMediaOCD:
    fake_session.reset()
    return fake_session


@pytest.fixture(scope="session")
def open_server(fake_session: FakeMediaOCD, session_dir: Path) -> Iterator[RunningServer]:
    """Listening on loopback with no client authentication."""
    server = start_server(session_dir, MEDIAOCD_URL=fake_session.url, MEDIAOCD_TOKEN=TOKEN)
    yield server
    server.stop()


@pytest.fixture(scope="session")
def auth_server(fake_session: FakeMediaOCD, session_dir: Path) -> Iterator[RunningServer]:
    """Requiring MCP_AUTH_TOKEN, with one extra host and origin allowed."""
    server = start_server(
        session_dir,
        headers={"Authorization": f"Bearer {AUTH_TOKEN}"},
        MEDIAOCD_URL=fake_session.url,
        MEDIAOCD_TOKEN=TOKEN,
        MCP_AUTH_TOKEN=AUTH_TOKEN,
        MCP_ALLOWED_HOSTS="mcp.example.org",
        MCP_ALLOWED_ORIGINS="https://client.example.org",
    )
    yield server
    server.stop()
