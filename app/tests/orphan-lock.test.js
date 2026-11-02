'use strict';

// An update puts a lock on the item in the database. If the app dies during it, nobody takes
// the lock off, and the item answers 500 "is locked": the next start has to clear it.

const { test } = require('node:test');
const assert = require('node:assert');
const { restartApp, startApp } = require('./helpers/app');

test('a lock left by a crash does not outlive the next start', async () => {
  const app = await startApp();
  const id = await app.item({
    mediaType: 'theater',
    source: 'wikidata',
    title: 'Locked by a crash',
    tmdbId: 910001,
    needsDetails: true,
    lockedAt: Date.now(),
  });
  const stuck = await app.api('GET', `/api/details/${id}`);
  assert.strictEqual(stuck.status, 500, 'this is what the lock does');
  assert.match(stuck.text, /is locked/);
  const { token } = app.admin;
  await app.stop();

  const restarted = restartApp({ BOOT_OPEN_ITEM: String(id), BOOT_TOKEN: token });

  assert.deepStrictEqual(restarted.opened, { status: 200, title: 'Fetched after the restart' });
  assert.strictEqual(restarted.locked, 0);
  assert.match(restarted.log, /Cleared 1 item locks/);
});

test('a start with nothing locked has nothing to say', () => {
  const restarted = restartApp();
  assert.strictEqual(restarted.locked, 0);
  assert.strictEqual(/item locks/.test(restarted.log), false);
});
