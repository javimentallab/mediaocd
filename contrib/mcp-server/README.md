# MediaOCD MCP server

**English** | [Español](README.es.md)

A [Model Context Protocol](https://modelcontextprotocol.io) server that lets an AI assistant search your [MediaOCD](../../README.md) library, mark items as seen, manage the watchlist and rate what you have seen. It talks to the MediaOCD HTTP API with an application token, so it needs no access to the database and runs anywhere that can reach your instance.

> [!WARNING]
> This server can change your data. **Do not expose it to the internet without `MCP_AUTH_TOKEN`**, and put it behind HTTPS if it leaves a network you trust. See [Security](#security).

## Tools

| Tool | What it does | Changes data |
|---|---|---|
| `search` | Search the external catalogues for one media type | No (1) |
| `library` | List the items in your library | No |
| `details` | Full record of an item | No |
| `in_progress` | Items pinned as actively in progress | No |
| `watchlist` | List your watchlist | No |
| `status` | Check the connection and the token; count movies and shows | No |
| `mark_seen` | Add to the seen history: an item, a season or an episode | **Yes** |
| `unmark_seen` | Delete from the seen history | **Yes, and it cannot be undone** |
| `watchlist_add` | Add to the watchlist | **Yes** |
| `watchlist_remove` | Remove from the watchlist | **Yes** |
| `rate` | Set the rating (1 to 5 stars), the review, or both | **Yes** |

(1) MediaOCD caches search results in its catalogue, but they do not join your library.

Tools carry the standard MCP read-only and destructive hints, which clients can use to ask for confirmation.

## Install

First create a token in MediaOCD under *Settings > General > Application tokens*. It acts as your user, so every action is done on your behalf.

### With Docker

From the root of this repository, add the service to your `docker-compose.yml`, next to `mediaocd`, and put both tokens in the `.env` file next to it:

```yaml
services:
  mediaocd-mcp:
    build: ./contrib/mcp-server
    container_name: mediaocd-mcp
    restart: unless-stopped
    ports:
      - "127.0.0.1:8016:8016"    # only this machine; see Security before changing it
    environment:
      MEDIAOCD_URL: http://mediaocd:7481
      MEDIAOCD_TOKEN: ${MEDIAOCD_TOKEN:?create one in MediaOCD}
      MCP_AUTH_TOKEN: ${MCP_AUTH_TOKEN:?generate one with openssl rand -hex 32}
    read_only: true
    tmpfs:
      - /tmp
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
```

```sh
docker compose build mediaocd-mcp
docker compose up -d mediaocd-mcp
```

The image runs as an unprivileged user and refuses to start without `MCP_AUTH_TOKEN`.

### Without Docker

Python 3.12 is the tested version.

```sh
cd contrib/mcp-server
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt

export MEDIAOCD_URL=http://localhost:7481
export MEDIAOCD_TOKEN=...
.venv/bin/python server.py
```

It listens on `http://127.0.0.1:8016/mcp`. On Windows use `.venv\Scripts\`, and `set` or `$env:` for the variables.

To run it without opening any port, set `MCP_TRANSPORT=stdio` and let the client start it; see below.

## Client configuration

**Claude Code:**

```sh
claude mcp add --transport http mediaocd http://localhost:8016/mcp \
  --header "Authorization: Bearer YOUR_MCP_AUTH_TOKEN"
```

**Clients with a JSON configuration, over HTTP.** The exact keys vary by client:

```json
{
  "mcpServers": {
    "mediaocd": {
      "type": "http",
      "url": "http://localhost:8016/mcp",
      "headers": { "Authorization": "Bearer YOUR_MCP_AUTH_TOKEN" }
    }
  }
}
```

**Clients that start the server themselves, over stdio:**

```json
{
  "mcpServers": {
    "mediaocd": {
      "command": "/path/to/contrib/mcp-server/.venv/bin/python",
      "args": ["/path/to/contrib/mcp-server/server.py"],
      "env": {
        "MCP_TRANSPORT": "stdio",
        "MEDIAOCD_URL": "http://localhost:7481",
        "MEDIAOCD_TOKEN": "YOUR_MEDIAOCD_TOKEN"
      }
    }
  }
}
```

## Configuration

Everything goes in environment variables; [`.env.example`](.env.example) has them all.

| Variable | Default | Purpose |
|---|---|---|
| `MEDIAOCD_TOKEN` | *(required)* | MediaOCD application token |
| `MEDIAOCD_URL` | `http://localhost:7481` | Address of your instance |
| `MEDIAOCD_TIMEOUT` | `25` | Seconds to wait for an answer |
| `MCP_AUTH_TOKEN` | *(empty)* | Token clients must send; at least 24 characters |
| `MCP_ALLOW_UNAUTHENTICATED` | *(empty)* | `true` to listen on a non-loopback address without a token |
| `MCP_TRANSPORT` | `streamable-http` | `streamable-http` or `stdio` |
| `MCP_HOST` | `127.0.0.1` (`0.0.0.0` in Docker) | Address to listen on |
| `MCP_PORT` | `8016` | Port to listen on |
| `MCP_ALLOWED_HOSTS` | *(loopback)* | Extra `Host` values accepted, separated by commas |
| `MCP_ALLOWED_ORIGINS` | *(loopback)* | Extra `Origin` values accepted, separated by commas |
| `MCP_LOG_LEVEL` | `INFO` | Log level |

Connecting by any name other than `localhost`, even from another container, means adding it to `MCP_ALLOWED_HOSTS` with its port (`mcp.example.org:8016`) or with `:*`. Otherwise the server answers `421 Invalid Host header`.

## Security

- **Loopback by default.** Without configuration the server only listens on `127.0.0.1`. Any local process can still use it, so set `MCP_AUTH_TOKEN` on a machine you share.
- **No public port without a token.** On any other address the server refuses to start without `MCP_AUTH_TOKEN`. `MCP_ALLOW_UNAUTHENTICATED=true` overrides this for a network you fully trust; anyone who can reach the port can then read and change your library.
- **The token travels in clear over plain HTTP**, like the MediaOCD token between this server and your instance if `MEDIAOCD_URL` is `http://`. Outside a trusted network, use a reverse proxy with HTTPS.
- **Requests are checked.** Tokens are compared in constant time, `Host` and `Origin` go through an allow-list against DNS rebinding, no CORS headers are sent, and request bodies are limited to 4 MiB.
- **Parameters are validated** against strict types and allow-lists before anything is sent to MediaOCD.
- **The MediaOCD token only goes to `MEDIAOCD_URL`:** redirects are not followed and proxies from the environment are ignored.
- **Errors and logs stay clean.** Errors returned to clients carry neither the MediaOCD address nor its response bodies, and logs carry neither tokens nor query strings.

Text from external catalogues reaches the assistant as tool output. A malicious title or description could try to influence it, so have your client ask for confirmation before the tools that change data.

## Limitations

- It covers the tools above, not the whole API. Lists other than the watchlist, YouTube, progress and administration are not available.
- A token has the permissions of its user, administrator included. There are no read-only tokens; the MCP hints are advice to the client, not enforcement.
- `search` works on one media type at a time, because the API requires one.
- `library` and `status` fetch the matching items in full from MediaOCD and `limit` only trims the answer, so a very large library makes them slower.
- A rating or a review can be changed from here, and a review emptied, but a rating can only be removed from the web interface.
- `unmark_seen` without `episode_id` or `season_id` deletes the entries of the whole item.
- It has been tested against a simulated MediaOCD and checked against the route table of this repository, not against every version of the application.

## Tests

The tests start the real server and talk to it over HTTP, against a fake MediaOCD on the loopback address. They touch no real instance and need no Docker.

```sh
cd contrib/mcp-server
.venv/bin/pip install -r requirements-dev.txt
.venv/bin/python -m pytest tests
```

## License

MIT, like the rest of the repository: see [`LICENSE`](../../LICENSE). Third-party components are listed in [`NOTICE`](NOTICE).
