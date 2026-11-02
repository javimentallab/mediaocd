# Contributing

Thanks for your interest. mediaocd has a single maintainer, so replies can take a while.

## Bugs and ideas

Open an [issue](https://github.com/javimentallab/mediaocd/issues). Say what you expected, what happened, and which version and system you use. English or Spanish are both fine.

Security problems go through [SECURITY.md](SECURITY.md), not through issues.

## Changing the code

For anything big, open an issue first so we can agree on the approach.

The server is in `app/build` and the web client in `app/public`, which is a built bundle. After editing anything in `app/public`, run `node tools/rehash-web.js`.

```sh
docker build -t mediaocd .
```

The tests of the app run the real server on a throwaway database, with every external service simulated. They need a folder `/storage`, so run them in a container; they refuse to start if `/storage` holds anything that isn't theirs:

```sh
docker run --rm --user "$(id -u):$(id -g)" -e HOME=/tmp -v "$PWD":/w -w /w/app node:22-alpine npm ci --omit=dev --legacy-peer-deps --no-audit --no-fund
docker run --rm --network none --user "$(id -u):$(id -g)" --tmpfs "/storage:uid=$(id -u),gid=$(id -g)" -v "$PWD":/w -w /w node:22-alpine sh -c 'node --test --test-concurrency=1 --test-force-exit app/tests/*.test.js'
```

There is one file per feature of the README, and `helpers/app.js` starts the app and fakes the network. `TEST_LOGS=1` shows the logs of the app. A test marked `todo` describes a known bug: remove the mark when you fix it.

The optional MCP server has its own tests:

```sh
cd contrib/mcp-server
pip install -r requirements-dev.txt
python -m pytest tests
```

- **Tests:** anything important that you add comes with a test.
- **Dependencies:** a new one needs a permissive licence (MIT, BSD, Apache…). Check it before adding it.
- **Private data:** no personal paths, hostnames, IP addresses or tokens in the code, the history or the screenshots.
- **Interface text:** new text goes in every language, and has to fit on screen in all of them. Texts are in `app/build/i18n/locales/<language>` for the server, and in the bundle for the web client.
- **Licence:** your contribution is released under the project's [MIT licence](LICENSE).
