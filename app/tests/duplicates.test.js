'use strict';

// "Duplicate detection and merge tooling that doesn't lose seen / ratings / lists."

const { after, before, test } = require('node:test');
const assert = require('node:assert');
const { daysFromNow, startApp } = require('./helpers/app');

let app;
before(async () => { app = await startApp(); });
after(async () => { await app.stop(); });

const dupes = async () => {
  const res = await app.api('GET', '/api/dupes');
  assert.strictEqual(res.status, 200, res.text);
  return res.json;
};
const merge = (winnerId, loserId) => app.api('POST', '/api/dupes/merge', { body: { winnerId, loserId } });

test('same title, year and type with different ids are duplicates, whatever the case', async () => {
  const a = await app.item({ title: 'The Same Film', tmdbId: 1, releaseDate: '1999-01-01' });
  const b = await app.item({ title: ' the same film ', tmdbId: 2, releaseDate: '1999-12-31' });
  await app.item({ title: 'The Same Film', tmdbId: 3, releaseDate: '2024-01-01' }); // a remake
  await app.item({ title: 'The Same Film', mediaType: 'book', openlibraryId: 'x', releaseDate: '1999-01-01' }); // the novel
  await app.api('PUT', '/api/seen', { query: { mediaItemId: b, lastSeenAt: 'now' } });

  const { count, dupes: groups } = await dupes();
  assert.strictEqual(count, 1);
  assert.deepStrictEqual(groups[0].items.map((item) => item.id), [b, a], 'the one in use comes first');
  assert.deepStrictEqual(groups[0].items.map((item) => item.usage), [1, 0]);
  await merge(b, a);
});

test('merging keeps seen, ratings, progress and lists, and removes the duplicate', async () => {
  const winner = await app.item({ title: 'Winner', tmdbId: 10 });
  const loser = await app.item({ title: 'Winner', tmdbId: 11 });
  const userId = app.admin.id;
  const list = await app.knex('list').where({ userId, isWatchlist: true }).first();
  await app.knex('seen').insert([
    { userId, mediaItemId: winner, date: 1000, kind: 'played' },
    { userId, mediaItemId: loser, date: 1000, kind: 'played' }, // the same viewing, twice
    { userId, mediaItemId: loser, date: 2000, kind: 'played' }, // only on the duplicate
  ]);
  await app.knex('userRating').insert({ userId, mediaItemId: loser, rating: 4, date: 1000 });
  await app.knex('progress').insert({ userId, mediaItemId: loser, progress: 0.5, date: 1000 });
  await app.knex('listItem').insert({ listId: list.id, mediaItemId: loser, addedAt: 1000 });

  const res = await merge(winner, loser);
  assert.strictEqual(res.status, 200, res.text);
  assert.deepStrictEqual(
    [res.json.seen, res.json.ratings, res.json.progress, res.json.listItems],
    [1, 1, 1, 1],
  );

  const seen = await app.knex('seen').where('mediaItemId', winner).orderBy('date');
  assert.deepStrictEqual(seen.map((row) => row.date), [1000, 2000], 'one viewing moved, the repeated one dropped');
  assert.strictEqual((await app.knex('userRating').where('mediaItemId', winner).first()).rating, 4);
  assert.strictEqual((await app.knex('progress').where('mediaItemId', winner).first()).progress, 0.5);
  assert.ok(await app.knex('listItem').where({ mediaItemId: winner, listId: list.id }).first());

  assert.strictEqual(await app.knex('mediaItem').where('id', loser).first(), undefined);
  assert.strictEqual((await dupes()).count, 0);
});

test('a rating of the winner is not overwritten by the one of the duplicate', async () => {
  const winner = await app.item({ title: 'Rated', tmdbId: 20 });
  const loser = await app.item({ title: 'Rated', tmdbId: 21 });
  const userId = app.admin.id;
  await app.knex('userRating').insert([
    { userId, mediaItemId: winner, rating: 5, date: 1 },
    { userId, mediaItemId: loser, rating: 1, date: 1 },
  ]);
  assert.strictEqual((await merge(winner, loser)).status, 200);
  const ratings = await app.knex('userRating').where('mediaItemId', winner);
  assert.deepStrictEqual(ratings.map((row) => row.rating), [5]);
});

test('merging a show takes away the episodes of the duplicate', async () => {
  const winner = await app.show({ title: 'A show', tmdbId: 30, episodes: [[1, 1, daysFromNow(-9)]] });
  const loser = await app.show({ title: 'A show', tmdbId: 31, episodes: [[1, 1, daysFromNow(-9)]] });
  assert.strictEqual((await merge(winner.id, loser.id)).status, 200);
  assert.strictEqual((await app.knex('episode').where('tvShowId', loser.id)).length, 0);
  assert.strictEqual((await app.knex('season').where('tvShowId', loser.id)).length, 0);
  assert.strictEqual((await app.knex('episode').where('tvShowId', winner.id)).length, 1);
});

test('nonsense merges are refused and change nothing', async () => {
  const movie = await app.item({ title: 'Movie', tmdbId: 40 });
  const book = await app.item({ title: 'Movie', mediaType: 'book', openlibraryId: 'y' });
  assert.strictEqual((await merge(movie, movie)).status, 400);
  assert.strictEqual((await merge(movie, book)).status, 400, 'different media');
  assert.strictEqual((await merge(movie, 999999)).status, 404);
  assert.ok(await app.knex('mediaItem').where('id', book).first());
});

test('only an administrator can see or merge duplicates', async () => {
  const user = await app.createUser('not-an-admin');
  assert.strictEqual((await app.request('GET', '/api/dupes', { token: user.token })).status, 403);
  const res = await app.request('POST', '/api/dupes/merge', { token: user.token, body: { winnerId: 1, loserId: 2 } });
  assert.strictEqual(res.status, 403);
});
