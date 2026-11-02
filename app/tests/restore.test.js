'use strict';

// "Full backup / restore": a database uploaded with POST /api/backup/restore replaces the
// current one at the next start. This can replace somebody's data, so it is tested twice: the
// function on its own, in a temporary folder, and the whole thing with real restarts of the app.

const { after, before, beforeEach, test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DATABASE_PATH, startApp, STORAGE } = require('./helpers/app');

const BOOT = path.join(__dirname, 'helpers', 'boot.js');

let app;
let backup;
let Sqlite;
let applyUploadedBackup;
let dir;
let databasePath;
let uploadedPath;
let logs;

before(async () => {
  app = await startApp();
  /* eslint-disable global-require */
  Sqlite = require('better-sqlite3');
  ({ applyUploadedBackup } = require('../build/restoreUploadedBackup'));
  /* eslint-enable global-require */
  await app.item({ title: 'In the backup', tmdbId: 1 });
  await app.knex.raw('PRAGMA wal_checkpoint(TRUNCATE)');
  // A real one, as the app gives it: it says WAL mode in its header, like any backup.
  backup = (await app.api('GET', '/api/backup')).buffer;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mediaocd-restore-'));
});
after(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  for (const entry of fs.readdirSync(dir)) fs.rmSync(path.join(dir, entry), { force: true });
  databasePath = path.join(dir, 'data.db');
  uploadedPath = path.join(dir, 'data.db.uploaded');
  logs = { info: [], error: [] };
});

const apply = () => applyUploadedBackup({
  databasePath,
  uploadedPath,
  now: new Date('2026-11-02T04:15:00Z'),
  log: { info: (m) => logs.info.push(m), error: (m) => logs.error.push(m) },
});
const titlesIn = (file) => {
  const db = new Sqlite(file, { readonly: true });
  const titles = db.prepare('select title from mediaItem order by title').all().map((row) => row.title);
  db.close();
  return titles;
};
const edited = (change) => {
  const db = new Sqlite(uploadedPath);
  change(db);
  db.pragma('journal_mode = DELETE');
  db.close();
};
const inDir = () => fs.readdirSync(dir).sort();

/** A current database with its last rows only in the -wal, as after a crash. */
function currentDatabaseWithWal() {
  const source = path.join(dir, 'source.db');
  fs.writeFileSync(source, backup);
  const db = new Sqlite(source);
  db.pragma('journal_mode = WAL');
  db.pragma('wal_autocheckpoint = 0');
  db.prepare("insert into mediaItem (title, mediaType, source) values ('Last written', 'movie', 'user')").run();
  for (const suffix of ['', '-wal', '-shm']) fs.copyFileSync(source + suffix, databasePath + suffix);
  db.close();
  fs.rmSync(source, { force: true });
  assert.ok(fs.statSync(`${databasePath}-wal`).size > 0, 'the last rows are only in the -wal');
}

test('nothing uploaded, nothing happens', () => {
  fs.writeFileSync(databasePath, backup);
  assert.deepStrictEqual(apply(), { status: 'none' });
  assert.deepStrictEqual(inDir(), ['data.db']);
});

test('a valid backup replaces the database, and the previous one keeps all that was written', () => {
  currentDatabaseWithWal();
  fs.writeFileSync(uploadedPath, backup);

  const result = apply();

  const kept = 'data.db.before-restore-20261102T041500';
  assert.deepStrictEqual(result, { status: 'applied', kept: path.join(dir, kept) });
  assert.deepStrictEqual(inDir(), ['data.db', kept, `${kept}-shm`, `${kept}-wal`].sort());
  assert.ok(fs.readFileSync(databasePath).equals(backup), 'the database is the upload');
  assert.deepStrictEqual(logs.error, []);
  assert.match(logs.info[0], /previous one is kept/);

  // The kept name, opened as it is, has the last rows. Without its -wal it would not.
  const withoutWal = path.join(dir, 'main-only.db');
  fs.copyFileSync(path.join(dir, kept), withoutWal);
  assert.ok(!titlesIn(withoutWal).includes('Last written'), 'the test means something');
  fs.rmSync(withoutWal);
  assert.ok(titlesIn(path.join(dir, kept)).includes('Last written'));
});

test('a second start does not apply it again', () => {
  fs.writeFileSync(databasePath, 'the previous one');
  fs.writeFileSync(uploadedPath, backup);
  assert.strictEqual(apply().status, 'applied');
  const files = inDir();
  assert.deepStrictEqual(apply(), { status: 'none' });
  assert.deepStrictEqual(inDir(), files);
});

test('with no current database it is applied too, and nothing is kept', () => {
  fs.writeFileSync(uploadedPath, backup);
  assert.deepStrictEqual(apply(), { status: 'applied', kept: null });
  assert.deepStrictEqual(inDir(), ['data.db']);
});

for (const [name, corrupt, reason] of [
  ['garbage after a good header', () => fs.writeFileSync(uploadedPath, Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(9000, 0xab)])), /cannot be read|integrity/],
  ['a truncated upload', () => fs.writeFileSync(uploadedPath, backup.subarray(0, Math.floor(backup.length / 2))), /cannot be read|integrity/],
  ['pages overwritten in the middle', () => {
    const damaged = Buffer.from(backup);
    damaged.fill(0xaa, Math.floor(backup.length / 3), Math.floor((backup.length * 2) / 3));
    fs.writeFileSync(uploadedPath, damaged);
  }, /cannot be read|integrity/],
  // Only the integrity check can see this one: every table still reads fine, and the check
  // answers with a list of problems instead of an error.
  ['an index out of step with its table', () => {
    fs.writeFileSync(uploadedPath, backup);
    const open = () => {
      const db = new Sqlite(uploadedPath);
      db.unsafeMode(true);
      db.pragma('writable_schema = ON');
      return db;
    };
    let db = open();
    const index = db.prepare("select type, name, tbl_name, rootpage, sql from sqlite_master where type = 'index' and tbl_name = 'mediaItem' and sql is not null").get();
    db.prepare('delete from sqlite_master where name = ?').run(index.name);
    db.close();
    db = open();
    db.prepare("insert into mediaItem (title, mediaType, source) values ('Not in the index', 'movie', 'user')").run();
    db.close();
    db = open();
    db.prepare('insert into sqlite_master (type, name, tbl_name, rootpage, sql) values (?, ?, ?, ?, ?)')
      .run(index.type, index.name, index.tbl_name, index.rootpage, index.sql);
    db.pragma('journal_mode = DELETE');
    db.close();
  }, /failed the integrity check \(.*index/],
  ['a damaged table that nothing else reads', () => {
    fs.writeFileSync(uploadedPath, backup);
    const db = new Sqlite(uploadedPath, { readonly: true });
    const { rootpage } = db.prepare("select rootpage from sqlite_master where name = 'mediaItem'").get();
    const pageSize = db.pragma('page_size', { simple: true });
    db.close();
    const damaged = fs.readFileSync(uploadedPath);
    damaged.fill(0xaa, (rootpage - 1) * pageSize, rootpage * pageSize);
    fs.writeFileSync(uploadedPath, damaged);
  }, /cannot be read|integrity/],
  ['an empty file', () => fs.writeFileSync(uploadedPath, ''), /not a MediaOCD database/],
  ['a good SQLite that is not ours', () => {
    const db = new Sqlite(uploadedPath);
    db.exec('create table notes (id integer primary key)');
    db.close();
  }, /not a MediaOCD database \(no table knex_migrations/],
  ['a database of a newer version', () => {
    fs.writeFileSync(uploadedPath, backup);
    edited((db) => db.prepare("insert into knex_migrations (name, batch, migration_time) values ('99999999999999_from_the_future.js', 9, 0)").run());
  }, /newer version/],
]) {
  test(`${name} is set aside, and the current database stays`, () => {
    currentDatabaseWithWal();
    corrupt();
    const before = fs.readFileSync(databasePath);
    const beforeWal = fs.readFileSync(`${databasePath}-wal`);

    const result = apply();

    assert.strictEqual(result.status, 'rejected');
    assert.match(result.problem, reason);
    assert.ok(fs.readFileSync(databasePath).equals(before), 'the database did not change');
    assert.ok(fs.readFileSync(`${databasePath}-wal`).equals(beforeWal), 'nor its -wal');
    const rejected = 'data.db.uploaded.rejected-20261102T041500';
    assert.deepStrictEqual(inDir(), ['data.db', 'data.db-shm', 'data.db-wal', rejected].sort(), 'no stray files');
    assert.match(logs.error[0], /was not applied/);
    assert.ok(logs.error[0].includes(rejected), 'the log says where it is');
    assert.deepStrictEqual(apply(), { status: 'none' }, 'and the next start does not try again');
  });
}

test('if the last step fails, everything goes back where it was', (t) => {
  currentDatabaseWithWal();
  fs.writeFileSync(uploadedPath, backup);
  const before = fs.readFileSync(databasePath);
  const realRename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (from === uploadedPath) throw new Error('disk trouble');
    return realRename(from, to);
  });
  const result = apply();
  t.mock.restoreAll();
  assert.strictEqual(result.status, 'failed');
  assert.deepStrictEqual(inDir(), ['data.db', 'data.db-shm', 'data.db-wal', 'data.db.uploaded'].sort());
  assert.ok(fs.readFileSync(databasePath).equals(before));
  assert.match(logs.error[0], /could not be applied/);
});

// --- The whole thing, with real restarts ---

function restart() {
  const result = spawnSync(process.execPath, [BOOT], {
    encoding: 'utf8',
    env: { ...process.env, TEST_LOGS: '1' },
    timeout: 60000,
  });
  assert.strictEqual(result.status, 0, result.stderr || result.stdout);
  const line = result.stdout.split('\n').find((l) => l.startsWith('BOOT '));
  return { ...JSON.parse(line.slice(5)), log: result.stdout };
}

test('upload, restart: the backup is applied, and only the first time', async () => {
  await app.item({ title: 'After the backup', tmdbId: 2 });
  const octet = { 'Content-Type': 'application/octet-stream' };
  const uploaded = await app.api('POST', '/api/backup/restore', { raw: backup, headers: octet });
  assert.strictEqual(uploaded.status, 200, uploaded.text);
  await app.stop();

  const first = restart();
  assert.strictEqual(first.configuration, 200, 'the app works on it');
  assert.ok(first.titles.includes('In the backup'));
  assert.ok(!first.titles.includes('After the backup'), 'what came after the backup is gone from the database');
  assert.match(first.log, /the uploaded backup is now the database/);
  assert.ok(!first.files.includes('data.db.uploaded'), 'the upload is gone');
  const kept = first.files.filter((name) => /^data\.db\.before-restore-\d{8}T\d{6}$/.test(name));
  assert.strictEqual(kept.length, 1);
  assert.ok(titlesIn(path.join(STORAGE, kept[0])).includes('After the backup'), 'and kept in the previous one');

  const second = restart();
  assert.deepStrictEqual(second.titles, first.titles);
  assert.deepStrictEqual(second.files.filter((name) => name.includes('before-restore-') && !/-(wal|shm)$/.test(name)), kept, 'no second copy');
  assert.strictEqual(/uploaded backup/.test(second.log), false, 'nothing to say');
});

test('upload, restart: a corrupt backup leaves the database alone, and the log says so', () => {
  // It passes the check of the route, which only reads the header.
  const corrupt = Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(9000, 0xab)]);
  fs.writeFileSync(path.join(STORAGE, 'data.db.uploaded'), corrupt);
  const before = (new Sqlite(DATABASE_PATH, { readonly: true })).prepare('select count(*) as c from mediaItem').get().c;

  const result = restart();

  assert.strictEqual(result.configuration, 200, 'the app starts');
  assert.strictEqual(result.titles.length, before);
  assert.ok(result.titles.includes('In the backup'));
  assert.match(result.log, /the uploaded backup was not applied/);
  assert.ok(result.files.some((name) => name.startsWith('data.db.uploaded.rejected-')));
  assert.ok(!result.files.includes('data.db.uploaded'));
});
