'use strict';

// The rating dialog: stars are only a draft until Save, which sends them with the review.

const { after, before, test } = require('node:test');
const assert = require('node:assert');
const { startApp } = require('./helpers/app');
const { bundleSource } = require('./helpers/bundle');

let app;
before(async () => { app = await startApp(); });
after(async () => { await app.stop(); });

const rate = (body) => app.api('PUT', '/api/rating', { body });
const stored = (id) => app.knex('userRating').where('mediaItemId', id).first();

function dialog() {
  const source = bundleSource();
  const start = source.indexOf('var Bo=function(e){');
  const end = source.indexOf(',Yo=function(e){', start);
  assert.ok(start > 0 && end > start, 'the rating dialog is in the bundle');
  return source.slice(start, end);
}

test('a star only changes the draft: the only write is the one on Save', () => {
  const code = dialog();
  assert.strictEqual(code.split('an({').length - 1, 1);
  assert.ok(code.includes('onSubmit'));
  assert.ok(code.includes('k(t+1===h?null:t+1)'));
  assert.ok(code.includes('rating:h,review:'));
});

test('the rating and the review arrive together', async () => {
  const id = await app.item({ mediaType: 'movie', title: 'Rated with a review' });
  assert.strictEqual((await rate({ mediaItemId: id, rating: 4, review: 'Good' })).status, 200);
  const row = await stored(id);
  assert.deepStrictEqual([row.rating, row.review], [4, 'Good']);
});

test('clearing the stars keeps the review', async () => {
  const id = await app.item({ mediaType: 'movie', title: 'Rating removed' });
  await rate({ mediaItemId: id, rating: 3, review: 'Keep me' });
  assert.strictEqual((await rate({ mediaItemId: id, rating: null, review: 'Keep me' })).status, 200);
  const row = await stored(id);
  assert.deepStrictEqual([row.rating, row.review], [null, 'Keep me']);
});

test('without a review, only the stars are written', async () => {
  const id = await app.item({ mediaType: 'movie', title: 'Just stars' });
  assert.strictEqual((await rate({ mediaItemId: id, rating: 5 })).status, 200);
  const row = await stored(id);
  assert.strictEqual(row.rating, 5);
  assert.ok(!row.review);
});
