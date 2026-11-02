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

The tests of the app need nothing installed:

```sh
node --test app/tests/*.test.js
```

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
