'use strict';

// "Progress in real units": hours and minutes, pages, audiobook position, chapters, and the
// episode runtimes that come from TMDB.

const { after, before, test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { daysFromNow, onRequest, startApp, STORAGE } = require('./helpers/app');

let app;
before(async () => { app = await startApp(); });
after(async () => { await app.stop(); });

const row = (id) => app.knex('mediaItem').where('id', id).first();

test('a position is a fraction between 0 and 1, and it is kept on the item', async () => {
  const id = await app.item({ mediaType: 'audiobook', title: 'An audiobook' });
  for (const [sent, stored] of [[0.25, 0.25], [1.5, 1], [-1, 0]]) {
    const res = await app.api('PUT', '/api/audio-progress', { query: { mediaItemId: id, progress: sent } });
    assert.strictEqual(res.status, 200, res.text);
    assert.strictEqual(res.json.audioProgress, stored);
    assert.strictEqual((await row(id)).audioProgress, stored);
  }
  const details = await app.api('GET', `/api/details/${id}`);
  assert.strictEqual(details.json.audioProgress, 0);
});

test('the total minutes, pages and chapters are whole numbers, at least 1', async () => {
  const id = await app.item({ mediaType: 'book', title: 'A book' });
  const res = await app.api('PUT', '/api/audio-progress', {
    query: { mediaItemId: id, runtime: 90.4, numberOfPages: 300.6, numberOfChapters: 0 },
  });
  assert.strictEqual(res.status, 200, res.text);
  const saved = await row(id);
  assert.deepStrictEqual(
    [saved.runtime, saved.numberOfPages, saved.numberOfChapters],
    [90, 301, 1],
  );
  const listed = await app.api('GET', `/api/details/${id}`);
  assert.deepStrictEqual([listed.json.numberOfPages, listed.json.numberOfChapters], [301, 1]);
});

test('an unknown item gets a 404', async () => {
  const res = await app.api('PUT', '/api/audio-progress', { query: { mediaItemId: 999999, progress: 0.5 } });
  assert.strictEqual(res.status, 404);
});

test('an episode keeps its own position and runtime', async () => {
  const show = await app.show({ title: 'A show', episodes: [[1, 1, daysFromNow(-3)]] });
  const episodeId = show.episodes.S1E1;
  const res = await app.api('PUT', '/api/episode-progress', { query: { episodeId, progress: 2, runtime: 44.7 } });
  assert.strictEqual(res.status, 200, res.text);
  assert.deepStrictEqual(res.json, { ok: true, progress: 1, runtime: 45 });
  const saved = await app.knex('episode').where('id', episodeId).first();
  assert.deepStrictEqual([saved.progress, saved.runtime], [1, 45]);

  const missing = await app.api('PUT', '/api/episode-progress', { query: { episodeId: 999999, progress: 0.1 } });
  assert.strictEqual(missing.status, 404);
});

test('the TMDB key saved from the interface stays private and is not shown back', async () => {
  const key = 'abcdef0123456789abcdef0123456789';
  const bad = await app.api('PUT', '/api/tmdb/key', { body: { apiKey: 'not a key' } });
  assert.strictEqual(bad.status, 400);

  const saved = await app.api('PUT', '/api/tmdb/key', { body: { apiKey: key } });
  assert.strictEqual(saved.status, 200, saved.text);
  const file = path.join(STORAGE, 'tmdb-key.json');
  assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
  assert.strictEqual(JSON.parse(fs.readFileSync(file, 'utf8')).apiKey, key);

  const shown = await app.api('GET', '/api/tmdb/key');
  assert.strictEqual(shown.text.includes(key), false);
  fs.rmSync(file);
});

test('missing episode runtimes are fetched from TMDB, with the key saved from the interface', async () => {
  const show = await app.show({
    title: 'Runtimes',
    tmdbId: 4242,
    episodes: [[1, 1, daysFromNow(-9)], [1, 2, daysFromNow(-8)]],
  });

  const noKey = await app.api('POST', '/api/episodes/fetch-runtimes', { query: { mediaItemId: show.id } });
  assert.strictEqual(noKey.status, 503);

  fs.writeFileSync(path.join(STORAGE, 'tmdb-key.json'), JSON.stringify({ apiKey: 'a1b2c3d4e5f6a1b2c3d4' }));
  const asked = [];
  onRequest('api.themoviedb.org/3/tv/4242/season/1', (url) => {
    asked.push(url);
    return { episodes: [{ episode_number: 1, runtime: 47 }, { episode_number: 2, runtime: null }] };
  });

  const res = await app.api('POST', '/api/episodes/fetch-runtimes', {
    query: { mediaItemId: show.id, episodeId: show.episodes.S1E1 },
  });
  assert.strictEqual(res.status, 200, res.text);
  assert.deepStrictEqual(res.json, { ok: true, updated: 1, totalSeasons: 1, episodeRuntime: 47 });
  assert.ok(asked[0].includes('api_key=a1b2c3d4e5f6a1b2c3d4'));
  const episodes = await app.knex('episode').where('tvShowId', show.id).orderBy('episodeNumber');
  assert.deepStrictEqual(episodes.map((e) => e.runtime), [47, null]);
});

test('only TV shows have episode runtimes to fetch', async () => {
  const id = await app.item({ title: 'A movie', tmdbId: 1 });
  const res = await app.api('POST', '/api/episodes/fetch-runtimes', { query: { mediaItemId: id } });
  assert.strictEqual(res.status, 400);
});
