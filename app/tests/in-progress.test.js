'use strict';

// "'In progress' page that keeps itself tidy": everything being watched, read, played or
// listened to; airing shows stay; the card shows the next episode; shows leave by themselves;
// abandoned items have their own list.

const { after, before, test } = require('node:test');
const assert = require('node:assert');
const { daysFromNow, startApp } = require('./helpers/app');

let app;
before(async () => { app = await startApp(); });
after(async () => { await app.stop(); });

// The same request as the In progress page of the web client.
async function inProgress(mediaType = 'tv') {
  const res = await app.api('GET', '/api/items', {
    query: { mediaType, onlyWithProgress: true, excludeAbandoned: true, orderBy: 'title', sortOrder: 'asc' },
  });
  assert.strictEqual(res.status, 200, res.text);
  return res.json;
}
const isIn = async (id, mediaType) => (await inProgress(mediaType)).some((item) => item.id === id);
const watchlist = (mediaItemId) => app.api('PUT', '/api/watchlist', { query: { mediaItemId } });
const seenEpisode = async (show, name) => {
  const res = await app.api('PUT', '/api/seen', { query: { mediaItemId: show.id, episodeId: show.episodes[name], lastSeenAt: 'now' } });
  assert.strictEqual(res.status, 200, res.text);
};

test('a finished show stays while episodes are left, and leaves after the last one', async () => {
  const show = await app.show({
    title: 'Finished show',
    episodes: [[1, 1, daysFromNow(-30)], [1, 2, daysFromNow(-20)]],
  });
  assert.strictEqual(await isIn(show.id), false, 'not started yet');

  await seenEpisode(show, 'S1E1');
  const card = (await inProgress()).find((item) => item.id === show.id);
  assert.ok(card, 'in progress once started');
  assert.strictEqual(card.firstUnwatchedEpisode.episodeNumber, 2);

  await seenEpisode(show, 'S1E2');
  assert.strictEqual(await isIn(show.id), false, 'leaves by itself');
});

test('an airing show stays while you are up to date', async () => {
  const show = await app.show({
    title: 'Airing show',
    status: 'Returning Series',
    episodes: [[1, 1, daysFromNow(-20)], [1, 2, daysFromNow(10)]],
  });
  await watchlist(show.id);
  await seenEpisode(show, 'S1E1');
  assert.strictEqual(await isIn(show.id), true);
});

test('an airing show stays too when it is not on the watchlist', async () => {
  const show = await app.show({
    title: 'Airing, off the list',
    status: 'Returning Series',
    episodes: [[1, 1, daysFromNow(-20)], [1, 2, daysFromNow(10)]],
  });
  await seenEpisode(show, 'S1E1');
  assert.strictEqual(await isIn(show.id), true);
});

test('an airing show leaves when its season ends', async () => {
  const show = await app.show({
    title: 'Season over',
    status: 'Returning Series',
    episodes: [[1, 1, daysFromNow(-20)], [2, 1, daysFromNow(60)]],
  });
  await watchlist(show.id);
  await seenEpisode(show, 'S1E1');
  assert.strictEqual(await isIn(show.id), false);
});

test('an episode watched ahead of its air date keeps the show, and the card shows the next one', async () => {
  const show = await app.show({
    title: 'Watched ahead',
    status: 'Returning Series',
    episodes: [[1, 1, daysFromNow(-20)], [1, 2, daysFromNow(5)], [1, 3, daysFromNow(12)]],
  });
  await seenEpisode(show, 'S1E1');
  await seenEpisode(show, 'S1E2');
  const card = (await inProgress()).find((item) => item.id === show.id);
  assert.ok(card, 'stays');
  assert.strictEqual(card.firstUnwatchedEpisode.episodeNumber, 3);
});

test('other media are in progress while unfinished, and leave when marked as seen', async () => {
  const id = await app.item({ title: 'A movie', mediaType: 'movie' });
  assert.strictEqual(await isIn(id, 'movie'), false);
  const progress = await app.api('PUT', '/api/progress', { query: { mediaItemId: id, progress: 0.5, date: Date.now() } });
  assert.strictEqual(progress.status, 200, progress.text);
  assert.strictEqual(await isIn(id, 'movie'), true);
  await app.api('PUT', '/api/seen', { query: { mediaItemId: id, lastSeenAt: 'now' } });
  assert.strictEqual(await isIn(id, 'movie'), false);
});

test('you can pin anything as in progress, and take it out again', async () => {
  const id = await app.item({ title: 'A pinned game', mediaType: 'video_game' });
  assert.strictEqual(await isIn(id, 'video_game'), false);

  await app.api('PUT', `/api/actively-in-progress/${id}`);
  assert.deepStrictEqual((await app.api('GET', '/api/actively-in-progress')).json.included, [id]);
  assert.strictEqual(await isIn(id, 'video_game'), true);

  await app.api('DELETE', `/api/actively-in-progress/${id}`);
  const list = (await app.api('GET', '/api/actively-in-progress')).json;
  assert.deepStrictEqual([list.included, list.excluded], [[], [id]]);
  assert.strictEqual(await isIn(id, 'video_game'), false);
});

test('a pinned show loses the pin when its season is over, not before', async () => {
  const over = await app.show({ title: 'Pin, season over', status: 'Returning Series', episodes: [[1, 1, daysFromNow(-20)]] });
  const going = await app.show({
    title: 'Pin, season going',
    status: 'Returning Series',
    episodes: [[1, 1, daysFromNow(-20)], [1, 2, daysFromNow(7)]],
  });
  await app.api('PUT', `/api/actively-in-progress/${over.id}`);
  await app.api('PUT', `/api/actively-in-progress/${going.id}`);
  await seenEpisode(over, 'S1E1');
  await seenEpisode(going, 'S1E1');
  const { included } = (await app.api('GET', '/api/actively-in-progress')).json;
  assert.strictEqual(included.includes(over.id), false);
  assert.strictEqual(included.includes(going.id), true);
});

test('abandoned items leave In progress and have their own list', async () => {
  const id = await app.item({ title: 'Abandoned movie', mediaType: 'movie' });
  await app.api('PUT', '/api/progress', { query: { mediaItemId: id, progress: 0.3, date: Date.now() } });
  assert.strictEqual(await isIn(id, 'movie'), true);

  await app.api('PUT', `/api/abandoned/${id}`);
  assert.strictEqual(await isIn(id, 'movie'), false);
  assert.ok((await app.api('GET', '/api/abandoned')).json.items.includes(id));
  const abandoned = await app.api('GET', '/api/items', { query: { onlyAbandoned: true, orderBy: 'title', sortOrder: 'asc' } });
  assert.deepStrictEqual(abandoned.json.map((item) => item.id), [id]);

  await app.api('DELETE', `/api/abandoned/${id}`);
  assert.strictEqual(await isIn(id, 'movie'), true);
});

test('what is in progress is also pending: a started show goes to the watchlist', async () => {
  const show = await app.show({ title: 'Started and pending', episodes: [[1, 1, daysFromNow(-30)], [1, 2, daysFromNow(-20)]] });
  await seenEpisode(show, 'S1E1');
  const card = (await inProgress()).find((item) => item.id === show.id);
  assert.strictEqual(card.inProgress, true);
  assert.strictEqual(card.onWatchlist, true);
});

test('finishing a show does not put it on the watchlist', async () => {
  const show = await app.show({ title: 'Finished, not pending', episodes: [[1, 1, daysFromNow(-30)]] });
  await seenEpisode(show, 'S1E1');
  assert.strictEqual((await app.api('GET', `/api/details/${show.id}`)).json.onWatchlist, false);
});

test('an abandoned show is in progress nowhere, and marking an episode does not make it pending', async () => {
  const show = await app.show({ title: 'Abandoned show', episodes: [[1, 1, daysFromNow(-30)], [1, 2, daysFromNow(-20)], [1, 3, daysFromNow(-10)]] });
  await app.api('PUT', `/api/abandoned/${show.id}`);
  await seenEpisode(show, 'S1E1');
  const details = (await app.api('GET', `/api/details/${show.id}`)).json;
  assert.strictEqual(details.inProgress, false);
  assert.strictEqual(details.onWatchlist, false);
  const all = await app.api('GET', '/api/items', { query: { mediaType: 'tv', orderBy: 'title', sortOrder: 'asc' } });
  const card = all.json.find((item) => item.id === show.id);
  assert.strictEqual(card.inProgress, false);
  assert.strictEqual(card.abandoned, true);
});

test('a show with nothing left keeps the progress of its last episode', async () => {
  const show = await app.show({ title: 'Finished with progress', episodes: [[1, 1, daysFromNow(-30)], [1, 2, daysFromNow(-20)]] });
  await seenEpisode(show, 'S1E1');
  await seenEpisode(show, 'S1E2');
  const saved = await app.api('PUT', '/api/episode-progress', { query: { episodeId: show.episodes.S1E2, progress: 0.47 } });
  assert.strictEqual(saved.status, 200, saved.text);
  const details = (await app.api('GET', `/api/details/${show.id}`)).json;
  assert.strictEqual(details.lastAiredEpisode.progress, 0.47);
  const all = await app.api('GET', '/api/items', { query: { mediaType: 'tv', orderBy: 'title', sortOrder: 'asc' } });
  assert.strictEqual(all.json.find((item) => item.id === show.id).lastAiredEpisode.progress, 0.47);
});
