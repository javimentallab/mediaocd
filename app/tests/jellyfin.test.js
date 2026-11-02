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
let episodesOfShow;

before(async () => {
  app = await startApp();
  onRequest(JF, (url, init) => {
    const { pathname, searchParams } = new URL(url);
    if (pathname === '/System/Info') return { ServerName: 'Test server', Version: '10.10' };
    if (pathname === `/Users/${USER}/Items` && searchParams.get('Filters') === 'IsPlayed') return { Items: played };
    if (pathname === `/Users/${USER}/Items` && searchParams.get('IncludeItemTypes') === 'Episode') return { Items: episodesOfShow };
    if (pathname === `/Users/${USER}/Items`) return { Items: library };
    if (pathname.startsWith(`/Users/${USER}/PlayedItems/`) && init.method === 'POST') return { Played: true };
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
  episodesOfShow = [];
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

// What reached Jellyfin as a played mark, after giving a fire-and-forget push time to arrive.
async function playedMarks(atLeast = 0) {
  const marks = () => calls.filter((c) => c.method === 'POST' && c.url.includes('/PlayedItems/')).map((c) => c.url.split('/').pop());
  for (let i = 0; i < 25 && marks().length < atLeast; i += 1) {
    await new Promise((resolve) => { setTimeout(resolve, 20); });
  }
  await new Promise((resolve) => { setTimeout(resolve, 60); });
  return marks();
}
const markByExternalId = (body) => app.api('PUT', '/api/seen/by-external-id', { body });

test('with the reverse sync on, an item marked by external id is marked in Jellyfin too, once', async () => {
  const id = await app.item({ title: 'Marked here', tmdbId: 51 });
  library = [{ Id: 'jf-movie', Type: 'Movie', Name: 'Marked here', ProviderIds: { Tmdb: '51' } }];
  const before = (await playedMarks()).length;

  const first = await markByExternalId({ mediaType: 'movie', id: { tmdbId: 51 } });
  assert.strictEqual(first.status, 200, first.text);
  assert.deepStrictEqual((await playedMarks(before + 1)).slice(before), ['jf-movie']);
  assert.strictEqual((await app.knex('seen').where('mediaItemId', id)).length, 1);

  // Jellyfin could report that mark back here: it must end, not bounce between the two.
  const echo = await markByExternalId({ mediaType: 'movie', id: { tmdbId: 51 } });
  assert.strictEqual(echo.status, 200, echo.text);
  assert.deepStrictEqual((await playedMarks()).slice(before), ['jf-movie'], 'no second push');
  assert.strictEqual((await app.knex('seen').where('mediaItemId', id)).length, 1, 'no second row');
});

test('a mark by external id can say watched, and anything else counts as played', async () => {
  const id = await app.item({ title: 'Kinds', mediaType: 'video_game', igdbId: 52 });
  await markByExternalId({ mediaType: 'video_game', id: { igdbId: 52 }, kind: 'watched' });
  await markByExternalId({ mediaType: 'video_game', id: { igdbId: 52 }, kind: 'nonsense' });
  const kinds = await app.knex('seen').where('mediaItemId', id).select('kind').orderBy('kind');
  assert.deepStrictEqual(kinds.map((row) => row.kind), ['played', 'watched']);
});

test('an episode goes to Jellyfin as that episode, or not at all', async () => {
  await app.show({ title: 'A pushed show', tmdbId: 53, episodes: [[1, 1, daysFromNow(-9)], [1, 2, daysFromNow(-8)], [1, 3, daysFromNow(-7)]] });
  library = [{ Id: 'jf-show', Type: 'Series', Name: 'A pushed show', ProviderIds: { Tmdb: '53' } }];
  episodesOfShow = [
    { Id: 'jf-e1', ParentIndexNumber: 1, IndexNumber: 1 },
    { Id: 'jf-e2', ParentIndexNumber: 1, IndexNumber: 2 },
  ];
  const before = (await playedMarks()).length;
  const second = await markByExternalId({ mediaType: 'tv', id: { tmdbId: 53 }, seasonNumber: 1, episodeNumber: 2 });
  assert.strictEqual(second.status, 200, second.text);
  assert.deepStrictEqual((await playedMarks(before + 1)).slice(before), ['jf-e2']);

  const third = await markByExternalId({ mediaType: 'tv', id: { tmdbId: 53 }, seasonNumber: 1, episodeNumber: 3 });
  assert.strictEqual(third.status, 200, third.text);
  assert.deepStrictEqual((await playedMarks()).slice(before), ['jf-e2'], 'Jellyfin does not have it');
});

test('theatre never reaches Jellyfin, even if its number matches a movie there', async () => {
  // Theatre keeps its Wikidata number in tmdbId, and that can be the TMDB id of any movie.
  await app.item({ title: 'A play', mediaType: 'theater', source: 'wikidata', tmdbId: 54 });
  library = [{ Id: 'jf-unrelated', Type: 'Movie', Name: 'An unrelated movie', ProviderIds: { Tmdb: '54' } }];
  const before = (await playedMarks()).length;
  const res = await markByExternalId({ mediaType: 'theater', id: { tmdbId: 54 } });
  assert.strictEqual(res.status, 200, res.text);
  assert.deepStrictEqual((await playedMarks()).slice(before), []);
});

test('with the reverse sync off, nothing reaches Jellyfin', async () => {
  await app.api('PUT', '/api/jellyfin/config', { body: { reverseSync: false } });
  await app.item({ title: 'Stays here', tmdbId: 55 });
  library = [{ Id: 'jf-stays', Type: 'Movie', Name: 'Stays here', ProviderIds: { Tmdb: '55' } }];
  const before = (await playedMarks()).length;
  const res = await markByExternalId({ mediaType: 'movie', id: { tmdbId: 55 } });
  await app.api('PUT', '/api/jellyfin/config', { body: { reverseSync: true } });
  assert.strictEqual(res.status, 200, res.text);
  assert.deepStrictEqual((await playedMarks()).slice(before), []);
});

const HOUR = 60 * 60 * 1000;
const syncMovie = async (tmdbId, userData) => {
  played = [{ Type: 'Movie', ProviderIds: { Tmdb: String(tmdbId) }, UserData: userData }];
  const res = await app.api('POST', '/api/jellyfin/sync');
  assert.strictEqual(res.status, 200, res.text);
  return res.json;
};
const viewings = (id) => app.knex('seen').where('mediaItemId', id).orderBy('date');

test('a mark pushed to Jellyfin does not come back as a second viewing', async () => {
  const id = await app.item({ title: 'There and back', tmdbId: 56 });
  library = [{ Id: 'jf-back', Type: 'Movie', Name: 'There and back', ProviderIds: { Tmdb: '56' } }];
  await markByExternalId({ mediaType: 'movie', id: { tmdbId: 56 } });
  const [{ date }] = await viewings(id);

  // Jellyfin dates it itself, a little later, or earlier if its clock is behind this one.
  for (const offset of [2000, -5 * 60 * 1000]) {
    const sync = await syncMovie(56, { LastPlayedDate: new Date(date + offset).toISOString() });
    assert.deepStrictEqual([sync.lastImported, sync.lastSkipped], [0, 1], `${offset} ms away`);
  }
  assert.strictEqual((await viewings(id)).length, 1);
});

test('a rewatch in Jellyfin hours later is a new viewing', async () => {
  const id = await app.item({ title: 'Seen again', tmdbId: 57 });
  const first = Date.now() - 24 * HOUR;
  await app.knex('seen').insert({ userId: app.admin.id, mediaItemId: id, date: first, kind: 'played' });
  const sync = await syncMovie(57, { LastPlayedDate: new Date(first + 3 * HOUR).toISOString() });
  assert.strictEqual(sync.lastImported, 1);
  assert.deepStrictEqual((await viewings(id)).map((row) => row.date), [first, first + 3 * HOUR]);
});

test('something played with no date in Jellyfin counts once, not at every Sync', async () => {
  const id = await app.item({ title: 'No date', tmdbId: 58 });
  assert.strictEqual((await syncMovie(58, {})).lastImported, 1, 'not seen yet: it counts');

  // Days later, far from the date that the first Sync had to make up.
  await app.knex('seen').where('mediaItemId', id).update({ date: Date.now() - 72 * HOUR });
  const again = await syncMovie(58, {});
  assert.deepStrictEqual([again.lastImported, again.lastSkipped], [0, 1]);
  assert.strictEqual((await viewings(id)).length, 1);
});

test('two episodes played within the same hour are two viewings', async () => {
  const show = await app.show({ title: 'A binge', tvdbId: 59, episodes: [[1, 1, daysFromNow(-9)], [1, 2, daysFromNow(-8)]] });
  onRequest(`/Users/${USER}/Items/series-binge`, { ProviderIds: { Tvdb: '59' } });
  const at = Date.now() - 24 * HOUR;
  played = [1, 2].map((episode) => ({
    Type: 'Episode',
    SeriesId: 'series-binge',
    ParentIndexNumber: 1,
    IndexNumber: episode,
    UserData: { LastPlayedDate: new Date(at + episode * 60000).toISOString() },
  }));
  const res = await app.api('POST', '/api/jellyfin/sync');
  assert.strictEqual(res.json.lastImported, 2, res.text);
  assert.strictEqual((await viewings(show.id)).length, 2);
});

test('only an administrator can reach the Jellyfin settings and syncs', async () => {
  const user = await app.createUser('not-an-admin');
  for (const [method, url] of [['GET', '/api/jellyfin/config'], ['POST', '/api/jellyfin/sync'], ['POST', '/api/jellyfin/sync-downloaded']]) {
    const res = await app.request(method, url, { token: user.token });
    assert.strictEqual(res.status, 403, url);
  }
});
