'use strict';

// "Per-medium consumption verbs ... The same item can have several."

const { after, before, test } = require('node:test');
const assert = require('node:assert');
const { startApp } = require('./helpers/app');
const { historyLabels } = require('./helpers/bundle');

let app;
before(async () => { app = await startApp(); });
after(async () => { await app.stop(); });

const seen = (mediaItemId, kind) => app.api('PUT', '/api/seen', { query: { mediaItemId, lastSeenAt: 'now', kind } });
const games = async (query) => {
  const res = await app.api('GET', '/api/items', { query: { mediaType: 'video_game', orderBy: 'title', sortOrder: 'asc', ...query } });
  assert.strictEqual(res.status, 200, res.text);
  return res.json.map((item) => item.title);
};

test('a game can be both played and watched, and each stays apart', async () => {
  const both = await app.item({ mediaType: 'video_game', title: 'Played and watched' });
  const justWatched = await app.item({ mediaType: 'video_game', title: 'Just watched' });
  const justPlayed = await app.item({ mediaType: 'video_game', title: 'Just played' });
  for (const [id, kind] of [[both, 'played'], [both, 'watched'], [justWatched, 'watched'], [justPlayed, 'played']]) {
    assert.strictEqual((await seen(id, kind)).status, 200);
  }

  const kinds = await app.knex('seen').where('mediaItemId', both).select('kind').orderBy('kind');
  assert.deepStrictEqual(kinds.map((row) => row.kind), ['played', 'watched']);

  assert.deepStrictEqual(await games({ onlyPlayed: true }), ['Just played', 'Played and watched']);
  assert.deepStrictEqual(await games({ onlyWatched: true }), ['Just watched', 'Played and watched']);
  assert.deepStrictEqual(await games({ onlyJustWatched: true }), ['Just watched']);
});

test('removing the watched mark keeps the played one', async () => {
  const id = await app.item({ mediaType: 'video_game', title: 'Both, for a while' });
  await seen(id, 'played');
  await seen(id, 'watched');
  assert.strictEqual((await app.api('GET', `/api/item-flags/${id}`)).json.seenWatched, true);

  const removed = await app.api('DELETE', `/api/seen/watched/${id}`);
  assert.deepStrictEqual(removed.json, { ok: true, removed: 1 });

  assert.strictEqual((await app.api('GET', `/api/item-flags/${id}`)).json.seenWatched, false);
  const kinds = await app.knex('seen').where('mediaItemId', id).select('kind');
  assert.deepStrictEqual(kinds.map((row) => row.kind), ['played']);
});

test('without a kind, what you mark counts as played', async () => {
  const id = await app.item({ mediaType: 'book', title: 'A book' });
  assert.strictEqual((await seen(id)).status, 200);
  const row = await app.knex('seen').where('mediaItemId', id).first();
  assert.strictEqual(row.kind, 'played');
});

test('the history button uses the verb of each medium', () => {
  assert.deepStrictEqual(historyLabels(), {
    audiobook: 'Add to listened history',
    book: 'Add to read history',
    video_game: 'Add to played history',
    movie: 'Add to seen history',
    theater: 'Add to seen history',
  });
});

test('lists tell a game only watched from one played', async () => {
  const watched = await app.item({ title: 'Only watched', mediaType: 'video_game' });
  const played = await app.item({ title: 'Played', mediaType: 'video_game' });
  await app.api('PUT', '/api/seen', { query: { mediaItemId: watched, lastSeenAt: 'now', kind: 'watched' } });
  await app.api('PUT', '/api/seen', { query: { mediaItemId: played, lastSeenAt: 'now', kind: 'played' } });
  const res = await app.api('GET', '/api/items', { query: { mediaType: 'video_game', onlySeenItems: true } });
  const flags = (id) => {
    const it = (res.json.data || res.json).find((x) => x.id === id);
    return [it.seenWatched, it.seenPlayed];
  };
  assert.deepStrictEqual(flags(watched), [true, false]);
  assert.deepStrictEqual(flags(played), [false, true]);
});
