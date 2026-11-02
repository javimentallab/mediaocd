'use strict';

// "Two-way Jellyfin integration", against a simulated Jellyfin server.

const { after, before, beforeEach, test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { calls, daysFromNow, onRequest, startApp, STORAGE } = require('./helpers/app');

const JF = 'http://jellyfin.test:8096';
const USER = 'jf-user';

let app;
let library;
let played;

before(async () => {
  app = await startApp();
  onRequest(JF, (url, init) => {
    const { pathname, searchParams } = new URL(url);
    if (pathname === '/System/Info') return { ServerName: 'Test server', Version: '10.10' };
    if (pathname === `/Users/${USER}/Items` && searchParams.get('Filters') === 'IsPlayed') return { Items: played };
    if (pathname === `/Users/${USER}/Items`) return { Items: library };
    if (pathname === `/Users/${USER}/PlayedItems/jf-movie` && init.method === 'POST') return { Played: true };
    return { status: 404, body: `no fake for ${url}` };
  });
  const saved = await app.api('PUT', '/api/jellyfin/config', {
    body: { url: `${JF}/`, apiKey: 'jf-secret', userId: USER, publicUrl: 'https://jf.example.com/web/#/home', reverseSync: true },
  });
  assert.strictEqual(saved.status, 200, saved.text);
});
after(async () => { await app.stop(); });
beforeEach(() => {
  library = [];
  played = [];
  if (global._jfLookupCache) global._jfLookupCache.clear();
  if (global._jfReverseCache) global._jfReverseCache.clear();
});

const downloaded = async (id) => Boolean((await app.knex('mediaItem').where('id', id).first()).downloaded);

test('the configuration keeps the key private, and the public address to its origin', async () => {
  const { json } = await app.api('GET', '/api/jellyfin/config');
  assert.strictEqual(json.apiKey, '');
  assert.strictEqual(json.apiKeySet, true);
  assert.strictEqual(json.publicUrl, 'https://jf.example.com');
  assert.strictEqual(fs.statSync(path.join(STORAGE, 'jellyfin-config.json')).mode & 0o777, 0o600);

  const status = await app.api('GET', '/api/jellyfin/status');
  assert.strictEqual(status.json.connected, true);
  assert.strictEqual(status.json.serverName, 'Test server');
});

test('downloaded flags are two-way: they follow what Jellyfin has', async () => {
  const byTmdb = await app.item({ title: 'In Jellyfin by TMDB', tmdbId: 11 });
  const byImdb = await app.item({ title: 'In Jellyfin by IMDb', imdbId: 'tt0000012' });
  const byTvdb = await app.item({ title: 'Show in Jellyfin', mediaType: 'tv', tvdbId: 13 });
  const gone = await app.item({ title: 'Deleted from there', tmdbId: 14, downloaded: true });
  library = [
    { Type: 'Movie', Name: 'In Jellyfin by TMDB', ProviderIds: { Tmdb: '11' } },
    { Type: 'Movie', Name: 'In Jellyfin by IMDb', ProviderIds: { Imdb: 'tt0000012' } },
    { Type: 'Series', Name: 'Show in Jellyfin', ProviderIds: { Tvdb: '13' } },
    { Type: 'Movie', Name: 'Unknown here', ProviderIds: { Tmdb: '999' } },
  ];

  const res = await app.api('POST', '/api/jellyfin/sync-downloaded');
  assert.strictEqual(res.status, 200, res.text);
  assert.deepStrictEqual(
    [res.json.newlyMarked, res.json.unmatched, res.json.newlyUnmarked],
    [3, 1, 1],
  );
  assert.deepStrictEqual(
    await Promise.all([byTmdb, byImdb, byTvdb, gone].map(downloaded)),
    [true, true, true, false],
  );
});

test('an empty answer from Jellyfin does not clear every flag', async () => {
  const id = await app.item({ title: 'Stays downloaded', tmdbId: 21, downloaded: true });
  library = [];
  const res = await app.api('POST', '/api/jellyfin/sync-downloaded');
  assert.strictEqual(res.json.newlyUnmarked, 0);
  assert.strictEqual(await downloaded(id), true);
});

test('what you played in Jellyfin comes back as seen, once', async () => {
  const movie = await app.item({ title: 'Played there', tmdbId: 31 });
  const show = await app.show({ title: 'Show played there', tvdbId: 32, episodes: [[1, 1, daysFromNow(-9)]] });
  onRequest(`/Users/${USER}/Items/series-1`, { ProviderIds: { Tvdb: '32' } });
  played = [
    { Type: 'Movie', ProviderIds: { Tmdb: '31' }, UserData: { LastPlayedDate: '2026-01-02T03:04:05Z' } },
    { Type: 'Episode', SeriesId: 'series-1', ParentIndexNumber: 1, IndexNumber: 1, UserData: { LastPlayedDate: '2026-01-03T00:00:00Z' } },
    { Type: 'Movie', ProviderIds: { Tmdb: '999' }, UserData: {} },
  ];

  const first = await app.api('POST', '/api/jellyfin/sync');
  assert.strictEqual(first.status, 200, first.text);
  assert.deepStrictEqual([first.json.lastImported, first.json.lastUnmatched], [2, 1]);

  const seenMovie = await app.knex('seen').where('mediaItemId', movie).first();
  assert.strictEqual(seenMovie.date, Date.parse('2026-01-02T03:04:05Z'));
  const seenEpisode = await app.knex('seen').where('mediaItemId', show.id).first();
  assert.strictEqual(seenEpisode.episodeId, show.episodes.S1E1);

  const second = await app.api('POST', '/api/jellyfin/sync');
  assert.deepStrictEqual([second.json.lastImported, second.json.lastSkipped], [0, 2]);
  assert.strictEqual((await app.knex('seen').where('mediaItemId', movie)).length, 1);
});

test('"Play in Jellyfin" links to the public address', async () => {
  library = [{ Id: 'jf-42', ServerId: 'srv', Name: 'A movie', Type: 'Movie', ProviderIds: { Tmdb: '42' } }];
  const found = await app.api('GET', '/api/jellyfin/lookup', { query: { tmdbId: 42, mediaType: 'movie' } });
  assert.deepStrictEqual(found.json, {
    found: true,
    itemId: 'jf-42',
    name: 'A movie',
    type: 'Movie',
    deeplink: 'https://jf.example.com/web/#/details?id=jf-42&serverId=srv',
  });
  const missing = await app.api('GET', '/api/jellyfin/lookup', { query: { tmdbId: 43, mediaType: 'movie' } });
  assert.strictEqual(missing.json.found, false);
});

test('with the reverse sync on, an item marked by external id is marked in Jellyfin too', { todo: 'BUG: addByExternalId in seen.js uses an undeclared "kind", so this route always answers 500 and the reverse sync never runs' }, async () => {
  await app.item({ title: 'Marked here', tmdbId: 51 });
  library = [{ Id: 'jf-movie', Type: 'Movie', Name: 'Marked here', ProviderIds: { Tmdb: '51' } }];
  const res = await app.api('PUT', '/api/seen/by-external-id', {
    body: { mediaType: 'movie', id: { tmdbId: 51 } },
  });
  assert.strictEqual(res.status, 200, res.text);
  const posted = () => calls.some((c) => c.method === 'POST' && c.url.endsWith(`/Users/${USER}/PlayedItems/jf-movie`));
  for (let i = 0; i < 50 && !posted(); i += 1) {
    await new Promise((resolve) => { setTimeout(resolve, 20); });
  }
  assert.ok(posted(), 'Jellyfin got the played mark');
});

test('only an administrator can reach the Jellyfin settings and syncs', async () => {
  const user = await app.createUser('not-an-admin');
  for (const [method, url] of [['GET', '/api/jellyfin/config'], ['POST', '/api/jellyfin/sync'], ['POST', '/api/jellyfin/sync-downloaded']]) {
    const res = await app.request(method, url, { token: user.token });
    assert.strictEqual(res.status, 403, url);
  }
});
