"use strict";

// Settings > About > "Check for updates": asks GitHub for the latest release of MediaOCD and
// compares it with the running version. Only when an administrator presses the button, never
// in the background. Nothing is downloaded or installed: an app inside a container cannot
// replace itself safely, so the answer carries the commands that update it.

Object.defineProperty(exports, "__esModule", {
  value: true
});
exports.updateCheckHandler = exports.parseVersion = exports.compareVersions = exports.checkForUpdate = exports.UpdateCheckError = exports.LATEST_RELEASE_URL = void 0;
var _config = require("./config");
var _dbconfig = require("./dbconfig");
var _logger = require("./logger");
const REPOSITORY = 'javimentallab/mediaocd';
const LATEST_RELEASE_URL = exports.LATEST_RELEASE_URL = `https://api.github.com/repos/${REPOSITORY}/releases/latest`;
const RELEASES_PAGE = `https://github.com/${REPOSITORY}/releases/`;
const TIMEOUT_MS = 8000;
const MAX_NOTES = 20000;

// X.Y.Z with an optional -prerelease, and an optional "v" in front, as in the tags.
const VERSION = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
const parseVersion = text => {
  const m = VERSION.exec(String(text || '').trim());
  if (!m) return null;
  return {
    numbers: [Number(m[1]), Number(m[2]), Number(m[3])],
    pre: m[4] ? m[4].split('.') : []
  };
};

/** Semantic Versioning order: -1, 0 or 1. A pre-release goes before its release. */
exports.parseVersion = parseVersion;
const compareVersions = (a, b) => {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) throw new Error(`not a version: ${!x ? a : b}`);
  for (let i = 0; i < 3; i++) {
    if (x.numbers[i] !== y.numbers[i]) return x.numbers[i] < y.numbers[i] ? -1 : 1;
  }
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    if (x.pre[i] === undefined) return -1;
    if (y.pre[i] === undefined) return 1;
    if (x.pre[i] === y.pre[i]) continue;
    const xn = /^\d+$/.test(x.pre[i]);
    const yn = /^\d+$/.test(y.pre[i]);
    if (xn && yn) return Number(x.pre[i]) < Number(y.pre[i]) ? -1 : 1;
    if (xn !== yn) return xn ? -1 : 1;
    return x.pre[i] < y.pre[i] ? -1 : 1;
  }
  return 0;
};
exports.compareVersions = compareVersions;
class UpdateCheckError extends Error {
  constructor(code, detail) {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code;
  }
}

/**
 * The commands of the README, for the tag of the release. The tag has been checked against
 * VERSION, so it holds only digits, letters, dots and hyphens and is safe to paste in a shell.
 */
exports.UpdateCheckError = UpdateCheckError;
const updateCommands = tag => ['git fetch --tags origin', `git checkout ${tag}`, 'docker compose build mediaocd', 'docker compose up -d mediaocd'];
const checkForUpdate = async ({
  current = _config.Config.version,
  fetchImpl = globalThis.fetch,
  timeoutMs = TIMEOUT_MS
} = {}) => {
  let response;
  try {
    response = await fetchImpl(LATEST_RELEASE_URL, {
      headers: {
        'User-Agent': `MediaOCD-updater/${current}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28'
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs)
    });
  } catch (error) {
    const timedOut = error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    throw new UpdateCheckError(timedOut ? 'timeout' : 'unreachable', error && error.message);
  }
  if (response.status === 404) throw new UpdateCheckError('no-release');
  if (response.status === 429 || response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0') {
    throw new UpdateCheckError('rate-limited');
  }
  if (!response.ok) throw new UpdateCheckError('bad-response', `HTTP ${response.status}`);
  let release;
  try {
    release = await response.json();
  } catch (error) {
    throw new UpdateCheckError('bad-response', 'not JSON');
  }
  const tag = release && typeof release.tag_name === 'string' ? release.tag_name.trim() : '';
  if (!parseVersion(tag)) throw new UpdateCheckError('bad-response', `tag ${JSON.stringify(tag).slice(0, 60)}`);
  const latest = tag.replace(/^v/, '');
  const order = compareVersions(current, latest);
  const url = typeof release.html_url === 'string' && release.html_url.startsWith(RELEASES_PAGE) ? release.html_url : `${RELEASES_PAGE}tag/${tag}`;
  const notes = typeof release.body === 'string' ? release.body.trim() : '';
  return {
    current,
    latest,
    status: order < 0 ? 'update' : order === 0 ? 'latest' : 'newer',
    name: typeof release.name === 'string' && release.name.trim() ? release.name.trim().slice(0, 200) : `MediaOCD ${latest}`,
    url,
    publishedAt: typeof release.published_at === 'string' ? release.published_at : null,
    notes: notes.length > MAX_NOTES ? `${notes.slice(0, MAX_NOTES)}…` : notes,
    commands: order < 0 ? updateCommands(tag) : []
  };
};
exports.checkForUpdate = checkForUpdate;
const updateCheckHandler = async (req, res) => {
  const userId = Number(req.user);
  if (!userId) {
    res.status(401).json({ error: 'login required' });
    return;
  }
  const user = await _dbconfig.Database.knex('user').where('id', userId).first();
  if (!user || !user.admin) {
    res.status(403).json({ error: 'admin only' });
    return;
  }
  res.set('Cache-Control', 'no-store');
  try {
    res.json(await checkForUpdate());
  } catch (error) {
    const code = error instanceof UpdateCheckError ? error.code : 'unreachable';
    _logger.logger.warn(`Update check failed: ${error && error.message}`);
    res.status(502).json({ error: code, current: _config.Config.version });
  }
};
exports.updateCheckHandler = updateCheckHandler;
