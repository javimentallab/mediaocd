'use strict';

// The first time an item is opened its details are fetched, with a lock on it. Whoever opens it
// meanwhile, from another client or tab, has to get the data too, not "MediaItem 8 is locked".

const { after, before, test } = require('node:test');
const assert = require('node:assert');
const { calls, onRequest, startApp } = require('./helpers/app');

let app;
before(async () => { app = await startApp(); });
after(async () => { await app.stop(); });

const entity = (qid, title) => ({
  entities: {
    [qid]: { labels: { es: { value: title } }, descriptions: {}, claims: {}, sitelinks: {} },
  },
});
const untilTrue = async (condition) => {
  for (let i = 0; i < 100 && !condition(); i += 1) {
    await new Promise((resolve) => { setTimeout(resolve, 10); });
  }
  assert.ok(condition(), 'it happened');
};
const aMoment = () => new Promise((resolve) => { setTimeout(resolve, 150); });

/** An item whose details are not fetched yet, and a provider that answers when told to. */
async function itemBeingFetched(number, answer) {
  const url = `Special:EntityData/Q${number}.json`;
  const id = await app.item({ mediaType: 'theater', source: 'wikidata', title: 'Not fetched yet', tmdbId: number, needsDetails: true });
  let release;
  const released = new Promise((resolve) => { release = resolve; });
  const remove = onRequest(url, async () => {
    await released;
    return answer;
  });
  const asked = () => calls.filter((c) => c.url.includes(url)).length;
  return { id, release, remove, asked };
}

test('two clients opening an item on its first load both get it, with a single fetch', async () => {
  const { id, release, remove, asked } = await itemBeingFetched(900001, entity('Q900001', 'Fetched title'));

  const first = app.api('GET', `/api/details/${id}`);
  await untilTrue(() => asked() === 1);
  let secondAnswered = false;
  const second = app.api('GET', `/api/details/${id}`).then((res) => { secondAnswered = true; return res; });
  await aMoment();
  assert.strictEqual(secondAnswered, false, 'the second one waits, it does not fail');

  release();
  const [a, b] = await Promise.all([first, second]);
  remove();
  assert.strictEqual(a.status, 200, a.text);
  assert.strictEqual(b.status, 200, b.text);
  assert.strictEqual(a.json.title, 'Fetched title');
  assert.strictEqual(b.json.title, 'Fetched title');
  assert.strictEqual(asked(), 1, 'one fetch for both');
  assert.strictEqual((await app.knex('mediaItem').where('id', id).first()).lockedAt, null, 'the lock is released');
});

test('the button that refreshes metadata does not fail during a first load either', async () => {
  const { id, release, remove, asked } = await itemBeingFetched(900002, entity('Q900002', 'Also fetched'));

  const opening = app.api('GET', `/api/details/${id}`);
  await untilTrue(() => asked() === 1);
  const refreshing = app.api('GET', `/api/details/update-metadata/${id}`);
  await aMoment();
  release();
  const [a, b] = await Promise.all([opening, refreshing]);
  remove();
  assert.strictEqual(a.status, 200, a.text);
  assert.strictEqual(b.status, 200, b.text);
});

test('if the fetch fails, the next attempt starts over instead of inheriting the failure', async () => {
  const { id, release, remove } = await itemBeingFetched(900003, { status: 502, body: 'bad gateway' });

  const first = app.api('GET', `/api/details/${id}`);
  await aMoment();
  release();
  assert.strictEqual((await first).status, 500);
  remove();
  assert.strictEqual((await app.knex('mediaItem').where('id', id).first()).lockedAt, null, 'the lock is released');

  const removeGood = onRequest('Special:EntityData/Q900003.json', entity('Q900003', 'Second attempt'));
  const retry = await app.api('GET', `/api/details/${id}`);
  removeGood();
  assert.strictEqual(retry.status, 200, retry.text);
  assert.strictEqual(retry.json.title, 'Second attempt');
});
