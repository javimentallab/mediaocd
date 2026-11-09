'use strict';

// A book can be read or listened to. The choice made in the status dialog is kept on the item,
// and the green icon on the cover follows it.

const { after, before, test } = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');
const { startApp } = require('./helpers/app');
const { bundleSource } = require('./helpers/bundle');

let app;
before(async () => { app = await startApp(); });
after(async () => { await app.stop(); });

const save = (id, query) => app.api('PUT', '/api/audio-progress', { query: { mediaItemId: id, ...query } });
const stored = async (id) => (await app.knex('mediaItem').where('id', id).first()).bookMode;

test('the choice is saved and can be changed both ways', async () => {
  const id = await app.item({ mediaType: 'book', title: 'Read then listened' });
  assert.strictEqual(await stored(id), null);
  for (const mode of ['listen', 'read', 'listen']) {
    const res = await save(id, { progress: 0, bookMode: mode });
    assert.strictEqual(res.status, 200, res.text);
    assert.strictEqual(res.json.bookMode, mode);
    assert.strictEqual(await stored(id), mode);
  }
});

test('it reaches the three places a dialog can be opened from', async () => {
  const id = await app.item({ mediaType: 'book', title: 'Seen everywhere' });
  await save(id, { bookMode: 'listen' });
  await app.api('PUT', '/api/watchlist', { query: { mediaItemId: id } });

  const details = await app.api('GET', `/api/details/${id}`);
  assert.strictEqual(details.json.bookMode, 'listen');

  const items = await app.api('GET', '/api/items', { query: { mediaType: 'book', orderBy: 'title', sortOrder: 'asc' } });
  assert.strictEqual(items.status, 200, items.text);
  assert.strictEqual(items.json.find((x) => x.id === id).bookMode, 'listen');

  const { listId } = await app.knex('listItem').where('mediaItemId', id).first();
  const list = await app.api('GET', '/api/list/items', { query: { listId } });
  assert.strictEqual(list.status, 200, list.text);
  assert.strictEqual(list.json.find((x) => x.mediaItem.id === id).mediaItem.bookMode, 'listen');
});

test('saving other fields leaves the choice alone', async () => {
  const id = await app.item({ mediaType: 'book', title: 'Keeps its mode' });
  await save(id, { bookMode: 'listen' });
  await save(id, { numberOfPages: 300 });
  assert.strictEqual(await stored(id), 'listen');
});

test('only a book takes it, and only with a known value', async () => {
  const book = await app.item({ mediaType: 'book', title: 'Bad value' });
  assert.strictEqual((await save(book, { bookMode: 'watched' })).status, 200);
  assert.strictEqual(await stored(book), null);
  const movie = await app.item({ mediaType: 'movie', title: 'Not a book' });
  assert.strictEqual((await save(movie, { bookMode: 'listen' })).status, 200);
  assert.strictEqual(await stored(movie), null);
});

/** The function of the bundle that picks the icon, evaluated as shipped. */
function iconOf(item) {
  const source = bundleSource();
  const start = source.indexOf('_PS=function(t){');
  const end = source.indexOf(',_MI=function', start);
  assert.ok(start > 0 && end > start, 'the icon function is in the bundle');
  const code = `var Do=function(t){return t.mediaType==="book"},jo=function(t){return t.mediaType==="audiobook"};var ${source.slice(start, end)};_PS`;
  return vm.runInNewContext(code)(item).icon;
}

test('the icon follows the saved choice, whatever the progress says', () => {
  const book = { mediaType: 'book' };
  assert.strictEqual(iconOf({ ...book, bookMode: 'listen', audioProgress: 0 }), 'headphones');
  assert.strictEqual(iconOf({ ...book, bookMode: 'read', audioProgress: 0.5 }), 'menu_book');
  assert.strictEqual(iconOf({ ...book, bookMode: 'listen', seen: true, audioProgress: 0 }), 'headphones');
});

test('a book nobody chose for keeps looking at its listening progress', () => {
  assert.strictEqual(iconOf({ mediaType: 'book', audioProgress: 0.5 }), 'headphones');
  assert.strictEqual(iconOf({ mediaType: 'book', audioProgress: 0 }), 'menu_book');
});

test('the dialog opens on the saved choice and sends it on each way of saving', () => {
  const source = bundleSource();
  assert.ok(source.includes('r.useState(t.bookMode||(t.audioProgress>0?"listen":"read"))'));
  assert.strictEqual(source.split('"&bookMode="+_mode').length - 1, 4);
});
