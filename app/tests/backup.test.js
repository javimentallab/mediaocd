'use strict';

// "Full backup / restore ... plus JSON and Letterboxd CSV exports." The auto-restore when
// data.db is missing is in auto-restore.test.js, and applying an upload in restore.test.js.

const { after, before, test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startApp, STORAGE } = require('./helpers/app');

let app;
before(async () => { app = await startApp(); });
after(async () => { await app.stop(); });

const UPLOADED = path.join(STORAGE, 'data.db.uploaded');

test('the database comes down whole, with the token of an administrator', async () => {
  const id = await app.item({ title: 'In the backup', tmdbId: 100 });
  await app.api('PUT', '/api/seen', { query: { mediaItemId: id, lastSeenAt: 'now' } });
  await app.knex.raw('PRAGMA wal_checkpoint(TRUNCATE)');

  const res = await app.api('GET', '/api/backup');
  assert.strictEqual(res.status, 200, res.text);
  assert.match(res.headers.get('content-disposition'), /mediaocd-backup-\d{4}-\d{2}-\d{2}\.db/);
  assert.strictEqual(res.buffer.subarray(0, 15).toString(), 'SQLite format 3');

  // A real copy, with the data in it: open it and read.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mediaocd-backup-'));
  const file = path.join(dir, 'copy.db');
  fs.writeFileSync(file, res.buffer);
  // eslint-disable-next-line global-require
  const Sqlite = require('better-sqlite3');
  const copy = new Sqlite(file, { readonly: true });
  assert.strictEqual(copy.prepare('select title from mediaItem where id = ?').get(id).title, 'In the backup');
  assert.strictEqual(copy.prepare('select count(*) as c from seen where mediaItemId = ?').get(id).c, 1);
  copy.close();
  fs.rmSync(dir, { recursive: true });
});

test('everything about backups is for administrators only', async () => {
  const user = await app.createUser('not-an-admin');
  const routes = [['GET', '/api/backup'], ['GET', '/api/backup/export-json'], ['GET', '/api/backup/letterboxd'],
    ['POST', '/api/backup/restore'], ['POST', '/api/backup/import']];
  for (const [method, url] of routes) {
    assert.strictEqual((await app.request(method, url, { token: user.token })).status, 403, `${method} ${url} as a user`);
    assert.strictEqual((await app.request(method, url)).status, 401, `${method} ${url} anonymous`);
  }
});

test('the JSON export brings back what was lost, matched by external id', async () => {
  const id = await app.item({ title: 'Round trip', tmdbId: 200, imdbId: 'tt0000200' });
  const userId = app.admin.id;
  await app.knex('seen').insert({ userId, mediaItemId: id, date: 1700000000000, kind: 'watched' });
  await app.knex('userRating').insert({ userId, mediaItemId: id, rating: 4, review: 'Good', date: 1700000000000 });
  await app.api('PUT', '/api/watchlist', { query: { mediaItemId: id } });

  const exported = await app.api('GET', '/api/backup/export-json');
  assert.strictEqual(exported.status, 200, exported.text);
  assert.match(exported.headers.get('content-disposition'), /mediaocd-export-.*\.json/);
  assert.ok(exported.json.mediaItems.some((item) => item.tmdbId === 200));

  await app.knex('seen').where('mediaItemId', id).delete();
  await app.knex('userRating').where('mediaItemId', id).delete();
  await app.knex('listItem').where('mediaItemId', id).delete();

  const imported = await app.api('POST', '/api/backup/import', {
    raw: exported.text,
    headers: { 'Content-Type': 'application/octet-stream' },
  });
  assert.strictEqual(imported.status, 200, imported.text);
  assert.strictEqual(imported.json.ok, true);

  const seen = await app.knex('seen').where('mediaItemId', id).first();
  assert.strictEqual(seen.date, 1700000000000);
  const rating = await app.knex('userRating').where('mediaItemId', id).first();
  assert.deepStrictEqual([rating.rating, rating.review], [4, 'Good']);
  assert.ok(await app.knex('listItem').where('mediaItemId', id).first(), 'back on the watchlist');

  // Importing the same file again adds nothing.
  await app.api('POST', '/api/backup/import', { raw: exported.text, headers: { 'Content-Type': 'application/octet-stream' } });
  assert.strictEqual((await app.knex('seen').where('mediaItemId', id)).length, 1);
  assert.strictEqual((await app.knex('userRating').where('mediaItemId', id)).length, 1);
});

test('an import keeps whether something was watched or played', async () => {
  const id = await app.item({ title: 'Watched, not played', mediaType: 'video_game', igdbId: 250 });
  await app.knex('seen').insert({ userId: app.admin.id, mediaItemId: id, date: 1700000000001, kind: 'watched' });
  const exported = await app.api('GET', '/api/backup/export-json');
  await app.knex('seen').where('mediaItemId', id).delete();
  await app.api('POST', '/api/backup/import', { raw: exported.text, headers: { 'Content-Type': 'application/octet-stream' } });
  assert.strictEqual((await app.knex('seen').where('mediaItemId', id).first()).kind, 'watched');
});

const octetStream = { 'Content-Type': 'application/octet-stream' };
const exportWith = (tmdbId, seen) => JSON.stringify({
  mediaItems: [{ id: 1, title: 'From an export', mediaType: 'movie', tmdbId }],
  seen: seen.map((s) => ({ mediaItemId: 1, ...s })),
});
const kindsOf = async (tmdbId) => {
  const item = await app.knex('mediaItem').where({ tmdbId }).first();
  const rows = await app.knex('seen').where('mediaItemId', item.id).orderBy('kind');
  return rows.map((row) => row.kind);
};

test('an old export, from before there were kinds, still imports, as played', async () => {
  const res = await app.api('POST', '/api/backup/import', { raw: exportWith(260, [{ date: 1600000000000 }]), headers: octetStream });
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(res.json.seenImported, 1);
  assert.deepStrictEqual(await kindsOf(260), ['played']);
});

test('an old export does not repeat a viewing that is already there as watched', async () => {
  const date = 1600000000001;
  await app.api('POST', '/api/backup/import', { raw: exportWith(261, [{ date, kind: 'watched' }]), headers: octetStream });
  const res = await app.api('POST', '/api/backup/import', { raw: exportWith(261, [{ date }]), headers: octetStream });
  assert.strictEqual(res.json.seenSkipped, 1);
  assert.deepStrictEqual(await kindsOf(261), ['watched']);
});

test('played and watched on the same date are two different things', async () => {
  const date = 1600000000002;
  const res = await app.api('POST', '/api/backup/import', {
    raw: exportWith(262, [{ date, kind: 'played' }, { date, kind: 'watched' }]),
    headers: octetStream,
  });
  assert.strictEqual(res.json.seenImported, 2);
  assert.deepStrictEqual(await kindsOf(262), ['played', 'watched']);
});

test('an unknown kind in an export counts as played', async () => {
  await app.api('POST', '/api/backup/import', { raw: exportWith(263, [{ date: 1600000000003, kind: 'nonsense' }]), headers: octetStream });
  assert.deepStrictEqual(await kindsOf(263), ['played']);
});

test('an import creates what is missing, unless told not to', async () => {
  const data = (tmdbId, extra = {}) => JSON.stringify({
    mediaItems: [{ id: 1, title: 'From elsewhere', mediaType: 'movie', tmdbId }],
    seen: [{ mediaItemId: 1, date: 1600000000000, kind: 'played' }],
    ...extra,
  });
  const headers = { 'Content-Type': 'application/octet-stream' };

  const created = await app.api('POST', '/api/backup/import', { raw: data(300), headers });
  assert.strictEqual(created.json.mediaItemsCreated, 1);
  const item = await app.knex('mediaItem').where({ tmdbId: 300 }).first();
  assert.ok(await app.knex('seen').where('mediaItemId', item.id).first(), 'the viewing is attached');

  const notCreated = await app.api('POST', '/api/backup/import', { raw: data(301, { createMissing: false }), headers });
  assert.strictEqual(notCreated.json.mediaItemsCreated, 0);
  assert.strictEqual(await app.knex('mediaItem').where({ tmdbId: 301 }).first(), undefined);
});

test('an import refuses what is not an export', async () => {
  const headers = { 'Content-Type': 'application/octet-stream' };
  assert.strictEqual((await app.api('POST', '/api/backup/import', { raw: 'not json', headers })).status, 400);
  assert.strictEqual((await app.api('POST', '/api/backup/import', { raw: '{"a":1}', headers })).status, 400);
});

test('the Letterboxd export is a CSV of movies with their ratings as stored', async () => {
  const userId = app.admin.id;
  const movie = await app.item({ title: 'Five, "stars"', tmdbId: 400, releaseDate: '2001-05-05' });
  const unrated = await app.item({ title: 'Unrated', tmdbId: 401, releaseDate: '2002-05-05' });
  const book = await app.item({ title: 'A book', mediaType: 'book', releaseDate: '2003-05-05' });
  await app.knex('seen').insert([
    { userId, mediaItemId: movie, date: Date.UTC(2024, 0, 1), kind: 'played' },
    { userId, mediaItemId: movie, date: Date.UTC(2024, 5, 1), kind: 'played' },
    { userId, mediaItemId: unrated, date: Date.UTC(2024, 1, 1), kind: 'played' },
    { userId, mediaItemId: book, date: Date.UTC(2024, 1, 1), kind: 'played' },
  ]);
  await app.knex('userRating').insert({ userId, mediaItemId: movie, rating: 5, date: 1 });

  const res = await app.api('GET', '/api/backup/letterboxd');
  assert.strictEqual(res.status, 200, res.text);
  assert.match(res.headers.get('content-type'), /text\/csv/);
  assert.match(res.headers.get('content-disposition'), /letterboxd-\d{4}-\d{2}-\d{2}\.csv/);
  const lines = res.text.split('\n');
  assert.strictEqual(lines[0], 'Date,Name,Year,Rating,Rewatch,WatchedDate');
  assert.ok(lines.includes('2024-01-01,"Five, ""stars""",2001,5,,2024-01-01'), res.text);
  assert.ok(lines.includes('2024-06-01,"Five, ""stars""",2001,5,true,2024-06-01'), 'a second viewing is a rewatch');
  assert.ok(lines.includes('2024-02-01,Unrated,2002,,,2024-02-01'), 'no rating, empty cell');
  assert.strictEqual(res.text.includes('A book'), false, 'movies only');
});

test('a restore only accepts SQLite files', async () => {
  const good = Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(100)]);
  const headers = { 'Content-Type': 'application/octet-stream' };

  const accepted = await app.api('POST', '/api/backup/restore', { raw: good, headers });
  assert.strictEqual(accepted.status, 200, accepted.text);
  assert.strictEqual(accepted.json.size, good.length);
  assert.ok(fs.readFileSync(UPLOADED).equals(good));

  const refused = await app.api('POST', '/api/backup/restore', { raw: Buffer.from('this is not a database'), headers });
  assert.strictEqual(refused.status, 400);
  assert.strictEqual(fs.existsSync(UPLOADED), false, 'nothing is left behind');
});
