'use strict';

// The web client shows the errors of the server as they come, in every language, so they are
// in English like the rest of them.

const { after, before, test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { startApp } = require('./helpers/app');

let app;
before(async () => { app = await startApp(); });
after(async () => { await app.stop(); });

test('no message of the item controller is in Spanish', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'build', 'controllers', 'item.js'), 'utf8');
  const messages = [...source.matchAll(/(?:error: |message: |new Error\()(['`])(.*?)\1/g)].map((m) => m[2]);
  assert.ok(messages.length > 30, 'the search finds them');
  const spanish = /[áéíóúñ¿¡]|requerid|no encontrad|no marcad|distint|solo se|archivo|sin campo|reinicia|p[eé]ga|comprueba|no se pudo/i;
  assert.deepStrictEqual(messages.filter((text) => spanish.test(text)), []);
});

test('errors reach the client in English', async () => {
  const checks = [
    [await app.api('POST', '/api/dupes/merge', { body: {} }), 400, 'winnerId and loserId are required and must differ'],
    [await app.api('PUT', '/api/abandoned/999999'), 404, 'mediaItem not found'],
    [await app.api('POST', '/api/youtube/channels', { body: {} }), 400, 'input required'],
    [await app.api('POST', '/api/youtube/channels', { body: { input: 'https://example.com/x' } }), 400, 'Only youtube.com and youtu.be addresses are accepted'],
    [await app.api('POST', '/api/youtube/watched', { body: { videoId: 'x' } }), 400, 'videoId required (11 characters)'],
    [await app.api('DELETE', '/api/youtube/watched/aaaaaaaaaaa'), 404, 'not marked'],
    [await app.api('PUT', '/api/tmdb/key', { body: { apiKey: 'zz' } }), 400, 'Invalid TMDB API key format (at least 20 hex characters expected).'],
    [await app.api('POST', '/api/backup/import', { raw: 'not json', headers: { 'Content-Type': 'application/octet-stream' } }), 400, /^Invalid JSON: /],
    [await app.api('POST', '/api/backup/restore', { raw: Buffer.from('not a database'), headers: { 'Content-Type': 'application/octet-stream' } }), 400, 'The uploaded file is not a valid SQLite database'],
  ];
  for (const [res, status, message] of checks) {
    assert.strictEqual(res.status, status, res.text);
    if (message instanceof RegExp) assert.match(res.json.error, message);
    else assert.strictEqual(res.json.error, message);
  }
});
