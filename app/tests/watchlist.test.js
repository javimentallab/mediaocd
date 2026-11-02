'use strict';

// "Watchlist ordered by date added; finished shows leave it automatically."

const { after, before, test } = require('node:test');
const assert = require('node:assert');
const { daysFromNow, onRequest, startApp } = require('./helpers/app');

let app;
before(async () => { app = await startApp(); });
after(async () => { await app.stop(); });

const add = async (mediaItemId) => {
  const res = await app.api('PUT', '/api/watchlist', { query: { mediaItemId } });
  assert.strictEqual(res.status, 200, res.text);
};
// The same request as the watchlist page of the web client.
const watchlist = async (query = {}) => {
  const res = await app.api('GET', '/api/items', {
    query: { onlyOnWatchlist: true, orderBy: 'listedAt', sortOrder: 'desc', ...query },
  });
  assert.strictEqual(res.status, 200, res.text);
  return res.json;
};
const onWatchlist = async (id) => (await watchlist()).some((item) => item.id === id);
const seenEpisode = (show, name) => app.api('PUT', '/api/seen', {
  query: { mediaItemId: show.id, episodeId: show.episodes[name], lastSeenAt: 'now' },
});

test('the latest added comes first, whatever the title or the order of creation', async () => {
  const titles = ['Zebra, added first', 'Apple, added second', 'Mango, added last'];
  const ids = [];
  for (const title of titles) {
    ids.push(await app.item({ title, mediaType: 'book' }));
  }
  // The other way round from the creation of the items, a second apart.
  const start = Date.now();
  for (const [offset, id] of [[0, ids[2]], [1000, ids[0]], [2000, ids[1]]]) {
    await add(id);
    await app.knex('listItem').where('mediaItemId', id).update({ addedAt: start + offset });
  }
  const listed = await watchlist({ mediaType: 'book' });
  assert.deepStrictEqual(listed.map((item) => item.id), [ids[1], ids[0], ids[2]]);
  assert.strictEqual(listed[0].onWatchlist, true);

  const oldestFirst = await watchlist({ mediaType: 'book', sortOrder: 'asc' });
  assert.deepStrictEqual(oldestFirst.map((item) => item.id), [ids[2], ids[0], ids[1]]);
});

test('a finished show leaves when its last aired episode is seen', async () => {
  const show = await app.show({
    title: 'Ended show',
    episodes: [[1, 1, daysFromNow(-20)], [1, 2, daysFromNow(-10)]],
  });
  await add(show.id);
  await seenEpisode(show, 'S1E1');
  assert.strictEqual(await onWatchlist(show.id), true, 'one episode left');
  await seenEpisode(show, 'S1E2');
  assert.strictEqual(await onWatchlist(show.id), false);
});

test('a show still on the air stays, even with everything seen', async () => {
  const show = await app.show({
    title: 'Returning show',
    status: 'Returning Series',
    episodes: [[1, 1, daysFromNow(-20)]],
  });
  await add(show.id);
  await seenEpisode(show, 'S1E1');
  assert.strictEqual(await onWatchlist(show.id), true);
});

test('a show without a status leaves only when no aired episode is left', async () => {
  const show = await app.show({
    title: 'Unaired left',
    status: null,
    episodes: [[1, 1, daysFromNow(-20)], [1, 2, daysFromNow(20)]],
  });
  await add(show.id);
  await seenEpisode(show, 'S1E1');
  assert.strictEqual(await onWatchlist(show.id), false, 'the next one has not aired');
});

test('a show leaves when a metadata refresh reports that it has ended', async () => {
  const show = await app.show({
    title: 'Ended while on the list',
    source: 'tmdb',
    tmdbId: 7001,
    status: 'Returning Series',
    episodes: [[1, 1, daysFromNow(-20)]],
  });
  await add(show.id);
  await seenEpisode(show, 'S1E1');
  assert.strictEqual(await onWatchlist(show.id), true, 'still on the air');

  const removers = [
    onRequest('api.themoviedb.org/3/tv/7001', {
      id: 7001,
      name: 'Ended while on the list',
      status: 'Ended',
      first_air_date: daysFromNow(-20),
      seasons: [{ season_number: 1, name: 'Season 1', episode_count: 1 }],
    }),
    onRequest('api.themoviedb.org/3/tv/7001/season/1', {
      episodes: [{ episode_number: 1, season_number: 1, name: 'Episode 1', air_date: daysFromNow(-20) }],
    }),
  ];
  const refreshed = await app.api('GET', `/api/details/update-metadata/${show.id}`);
  removers.forEach((remove) => remove());
  assert.strictEqual(refreshed.status, 200, refreshed.text);
  assert.strictEqual((await app.knex('mediaItem').where('id', show.id).first()).status, 'Ended');
  assert.strictEqual(await onWatchlist(show.id), false);
});

test('the watchlist of a user is theirs alone', async () => {
  const other = await app.createUser('someone-else');
  const id = await app.item({ title: 'Only mine', mediaType: 'book' });
  await add(id);
  const res = await app.request('GET', '/api/items', {
    token: other.token,
    query: { onlyOnWatchlist: true, orderBy: 'listedAt', sortOrder: 'desc' },
  });
  assert.deepStrictEqual(res.json, []);
});

test('an item can be taken off the watchlist', async () => {
  const id = await app.item({ title: 'Changed my mind', mediaType: 'book' });
  await add(id);
  const res = await app.api('DELETE', '/api/watchlist', { query: { mediaItemId: id } });
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(await onWatchlist(id), false);
});
