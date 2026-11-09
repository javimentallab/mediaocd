'use strict';

// The estimated length of a play, from the printed edition on Open Library.

const { after, before, test } = require('node:test');
const assert = require('node:assert');
const { onRequest, startApp } = require('./helpers/app');
const { bundleSource } = require('./helpers/bundle');

let app;
let theatre;
before(async () => {
  app = await startApp();
  // eslint-disable-next-line global-require
  theatre = require('../build/metadata/theatreRuntime');
});
after(async () => { await app.stop(); });

const runtime = async (id) => (await app.knex('mediaItem').where('id', id).first()).runtime;
const doc = (title, author, pages, editions = 1) => ({
  title, author_name: [author], number_of_pages_median: pages, edition_count: editions,
});

function fakeLookups(qid) {
  const removers = [
    onRequest(`Special:EntityData/Q${qid}.json`, {
      entities: {
        [`Q${qid}`]: {
          labels: { en: { value: 'The Merchant of Venice' }, es: { value: 'El mercader de Venecia' } },
          claims: { P50: [{ mainsnak: { datavalue: { value: { id: 'Q692' } } } }] },
        },
      },
    }),
    onRequest('Special:EntityData/Q692.json', {
      entities: { Q692: { labels: { en: { value: 'William Shakespeare' } } } },
    }),
    onRequest('openlibrary.org/search.json', {
      docs: [
        doc('The Merchant of Venice', 'William Shakespeare', 150, 900),
        doc('The Merchant of Venice', 'Somebody Else', 400, 5000),
      ],
    }),
  ];
  return () => removers.forEach((remove) => remove());
}

test('the most reprinted edition with that exact title and author decides', () => {
  const docs = [
    doc('Hamlet', 'William Shakespeare', 188, 2493),
    doc('Hamlet', 'William Shakespeare', 140, 37),
    doc('The Hamlet', 'William Faulkner', 373, 37),
  ];
  assert.strictEqual(theatre.pickPages(docs, 'Hamlet', 'William Shakespeare'), 188);
});

test('a book by another author, or too short to be a play, does not count', () => {
  assert.strictEqual(theatre.pickPages([doc('Burundanga', 'Abel Robino', 48)], 'Burundanga', 'Jordi Galceran'), null);
  assert.strictEqual(theatre.pickPages([doc('Mayumana', 'Mayumana', 19)], 'Mayumana', 'Mayumana'), null);
  assert.strictEqual(theatre.pickPages([], 'Hamlet', 'William Shakespeare'), null);
});

test('a page is a minute, up to four hours', () => {
  assert.strictEqual(theatre.minutesFromPages(135), 135);
  assert.strictEqual(theatre.minutesFromPages(576), 240);
});

test('a play with no length gets one, looked up with its title in English and its author', async () => {
  const id = await app.item({ mediaType: 'theater', source: 'wikidata', title: 'El mercader de Venecia', tmdbId: 206400 });
  const remove = fakeLookups(206400);
  await theatre.estimateMissing();
  remove();
  assert.strictEqual(await runtime(id), 150);
});

test('a length typed by hand is left alone, and a staging without an author is not looked up', async () => {
  const typed = await app.item({ mediaType: 'theater', source: 'wikidata', title: 'Typed', tmdbId: 900001, runtime: 95 });
  const staging = await app.item({ mediaType: 'theater', source: 'teatroes', title: 'Burundanga', tmdbId: 60070 });
  await theatre.estimateMissing();
  assert.strictEqual(await runtime(typed), 95);
  assert.strictEqual(await runtime(staging), null);
});

test('refreshing a play from a catalogue without a length keeps the one it had', async () => {
  const id = await app.item({
    mediaType: 'theater', source: 'wikidata', title: 'Bernarda', tmdbId: 777002, needsDetails: true, runtime: 120,
  });
  const remove = [
    onRequest('wikidata.org/wiki/Special:EntityData/Q777002.json', {
      entities: { Q777002: { labels: { es: { value: 'Bernarda' } }, claims: {} } },
    }),
  ];
  const res = await app.api('GET', `/api/details/${id}`);
  remove.forEach((r) => r());
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(await runtime(id), 120);
});

test('the page of a play shows the estimate, in every language', () => {
  const source = bundleSource();
  assert.ok(source.includes('a.mediaType==="theater"&&a.runtime>0&&'));
  assert.strictEqual(source.split('"Estimated duration":"').length - 1, 16);
});
