'use strict';

// The Books section of "Downloaded" lists books and audiobooks (mediaType=book takes both),
// and its count has to say the same number.

const { after, before, test } = require('node:test');
const assert = require('node:assert');
const { startApp } = require('./helpers/app');

let app;
before(async () => { app = await startApp(); });
after(async () => { await app.stop(); });

test('the Books section of Downloaded counts the audiobooks that it lists', async () => {
  await app.item({ mediaType: 'book', title: 'A downloaded book', downloaded: true });
  await app.item({ mediaType: 'audiobook', title: 'A downloaded audiobook', downloaded: true });
  await app.item({ mediaType: 'book', title: 'Not downloaded' });
  const { status, json } = await app.api('GET', '/api/items/paginated', {
    query: { mediaType: 'book', onlyDownloaded: true, page: 1, orderBy: 'title', sortOrder: 'asc' },
  });
  assert.strictEqual(status, 200, JSON.stringify(json));
  assert.strictEqual(json.total, 2);
});
