'use strict';

// "Full backup / restore including auto-restore on missing data.db": the real
// docker/entrypoint.sh, with the commands that need a real container replaced by stubs.

const { before, beforeEach, test } = require('node:test');
const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DATABASE_PATH, prepareStorage, STORAGE } = require('./helpers/app');

const ENTRYPOINT = path.join(__dirname, '..', '..', 'docker', 'entrypoint.sh');
const BACKUPS = path.join(STORAGE, 'backups');

let stubs;
let started;

before(() => {
  stubs = fs.mkdtempSync(path.join(os.tmpdir(), 'mediaocd-entrypoint-'));
  started = path.join(stubs, 'started');
  const stub = (name, body) => fs.writeFileSync(path.join(stubs, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  stub('id', 'echo 1000');
  for (const name of ['chown', 'groupmod', 'usermod']) stub(name, 'exit 0');
  stub('su', `echo "$@" > "${started}"`);
});
beforeEach(() => {
  prepareStorage();
  fs.rmSync(started, { force: true });
});

function runEntrypoint() {
  const result = spawnSync('sh', [ENTRYPOINT], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${stubs}:${process.env.PATH}`, PUID: '1000', PGID: '1000' },
  });
  assert.strictEqual(result.status, 0, result.stderr);
  return result.stdout;
}
function writeBackup(name, content, ageInSeconds) {
  fs.mkdirSync(BACKUPS, { recursive: true });
  const file = path.join(BACKUPS, name);
  fs.writeFileSync(file, content);
  const when = Date.now() / 1000 - ageInSeconds;
  fs.utimesSync(file, when, when);
}

test('with no database, the newest backup is restored before the app starts', () => {
  writeBackup('data-20260101-0300-d.db', 'an old backup', 2000);
  writeBackup('data-20260103-0300-d.db', 'the newest backup', 10);
  writeBackup('data-20260102-0300-d.db', 'a middle backup', 1000);
  fs.writeFileSync(`${DATABASE_PATH}-wal`, 'a stale journal');

  const output = runEntrypoint();

  assert.strictEqual(fs.readFileSync(DATABASE_PATH, 'utf8'), 'the newest backup');
  assert.strictEqual(fs.existsSync(`${DATABASE_PATH}-wal`), false, 'a stale journal would corrupt it');
  assert.match(output, /auto-restore/);
  assert.match(fs.readFileSync(started, 'utf8'), /node \/app\/build\/index\.js/, 'then the app starts');
});

test('an existing database is never touched', () => {
  fs.writeFileSync(DATABASE_PATH, 'the real database');
  writeBackup('data-20260103-0300-d.db', 'a backup', 10);
  const output = runEntrypoint();
  assert.strictEqual(fs.readFileSync(DATABASE_PATH, 'utf8'), 'the real database');
  assert.strictEqual(/auto-restore/.test(output), false);
});

test('with no database and no backups, the app starts on an empty one', () => {
  fs.mkdirSync(BACKUPS);
  const output = runEntrypoint();
  assert.strictEqual(fs.existsSync(DATABASE_PATH), false);
  assert.match(output, /auto-restore/);
  assert.ok(fs.existsSync(started), 'the app starts');
});
