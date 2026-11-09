'use strict';

// "YouTube as a first-class media type": channels, watched videos, the recent feed, and a
// cache that survives YouTube's RSS outages. YouTube itself is simulated.

const { after, before, test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { calls, onRequest, startApp, STORAGE } = require('./helpers/app');

const CHANNEL = 'UCaaaaaaaaaaaaaaaaaaaaaa';
const RSS = 'youtube.com/feeds/videos.xml';

let app;
before(async () => { app = await startApp(); });
after(async () => { await app.stop(); });

const entry = (videoId, title, published) => `<entry><yt:videoId>${videoId}</yt:videoId>
  <title>${title}</title><published>${published}</published>
  <media:thumbnail url="https://i.ytimg.com/vi/${videoId}/1.jpg"/></entry>`;
const feed = (entries) => `<feed><title>A channel</title>${entries.join('')}</feed>`;

test('a channel is added by its id, once', async () => {
  const removeRss = onRequest(RSS, feed([]));
  const added = await app.api('POST', '/api/youtube/channels', { body: { input: `https://www.youtube.com/channel/${CHANNEL}` } });
  assert.strictEqual(added.status, 200, added.text);
  assert.strictEqual(added.json.channel.id, CHANNEL);
  assert.strictEqual(added.json.channel.name, 'A channel');

  const again = await app.api('POST', '/api/youtube/channels', { body: { input: CHANNEL } });
  assert.strictEqual(again.json.alreadyAdded, true);
  assert.deepStrictEqual((await app.api('GET', '/api/youtube/channels')).json.map((c) => c.id), [CHANNEL]);
  removeRss();
});

test('a channel is found from its @handle', async () => {
  const other = 'UCbbbbbbbbbbbbbbbbbbbbbb';
  const removePage = onRequest('youtube.com/@somebody', `<html><link rel="canonical" href="https://www.youtube.com/channel/${other}">
    <title>Somebody - YouTube</title></html>`);
  const added = await app.api('POST', '/api/youtube/channels', { body: { input: '@somebody' } });
  assert.deepStrictEqual([added.json.channel.id, added.json.channel.name], [other, 'Somebody']);
  removePage();
  await app.api('DELETE', `/api/youtube/channels/${other}`);
  assert.deepStrictEqual((await app.api('GET', '/api/youtube/channels')).json.map((c) => c.id), [CHANNEL]);
});

test('only addresses of YouTube are fetched, so nothing on your network can be reached', async () => {
  for (const input of ['http://jellyfin:8096/', 'https://evil.example.com/channel', 'http://www.youtube.com/@x']) {
    const before = calls.length;
    const res = await app.api('POST', '/api/youtube/channels', { body: { input } });
    assert.strictEqual(res.status, 400, input);
    assert.strictEqual(calls.length, before, `${input} was not even tried`);
  }
  const unknown = onRequest('youtube.com/@nobody', { status: 404, body: 'not found' });
  const res = await app.api('POST', '/api/youtube/channels', { body: { input: '@nobody' } });
  assert.strictEqual(res.status, 404);
  unknown();
});

test('the feed has the four newest videos of each channel, newest first', async () => {
  const remove = onRequest(RSS, feed([
    entry('video000001', 'Oldest', '2026-01-01T00:00:00+00:00'),
    entry('video000002', 'Third', '2026-01-03T00:00:00+00:00'),
    entry('video000003', 'Newest &amp; best', '2026-01-05T00:00:00+00:00'),
    entry('video000004', 'Second', '2026-01-04T00:00:00+00:00'),
    entry('video000005', 'Fourth', '2026-01-02T00:00:00+00:00'),
  ]));
  const res = await app.api('GET', '/api/youtube/feed', { query: { fresh: 1 } });
  assert.strictEqual(res.status, 200, res.text);
  assert.deepStrictEqual(res.json.videos.map((v) => v.title), ['Newest & best', 'Second', 'Third', 'Fourth']);
  assert.strictEqual(res.json.videos[0].url, 'https://www.youtube.com/watch?v=video000003');
  remove();
});

test('during an RSS outage the feed keeps the last videos, also after a restart', async () => {
  const before = (await app.api('GET', '/api/youtube/feed')).json.videos.map((v) => v.videoId);
  assert.strictEqual(before.length, 4, 'there is a feed to keep');

  const remove = onRequest(RSS, { status: 404, body: 'outage' });
  const during = await app.api('GET', '/api/youtube/feed', { query: { fresh: 1 } });
  assert.deepStrictEqual(during.json.videos.map((v) => v.videoId), before);

  // A restart empties the memory: what is left is the cache on disk.
  assert.ok(fs.existsSync(path.join(STORAGE, 'youtube-feed-cache.json')));
  delete global._ytChannelCache;
  const restarted = await app.api('GET', '/api/youtube/feed', { query: { fresh: 1 } });
  assert.deepStrictEqual(restarted.json.videos.map((v) => v.videoId), before);
  remove();
});

test('an empty answer from YouTube does not wipe the feed', async () => {
  const before = (await app.api('GET', '/api/youtube/feed')).json.videos.length;
  const remove = onRequest(RSS, '<html>an error page with status 200</html>');
  const res = await app.api('GET', '/api/youtube/feed', { query: { fresh: 1 } });
  assert.strictEqual(res.json.videos.length, before);
  remove();
});

test('a watched video counts its duration, and can be unmarked', async () => {
  const remove = onRequest('youtube.com/youtubei/v1/player', { videoDetails: { lengthSeconds: '125' } });
  const marked = await app.api('POST', '/api/youtube/watched', { body: { videoId: 'video000003', title: 'A video' } });
  assert.strictEqual(marked.status, 200, marked.text);
  assert.strictEqual(marked.json.durationSeconds, 125);

  const again = await app.api('POST', '/api/youtube/watched', { body: { videoId: 'video000003' } });
  assert.strictEqual(again.json.alreadyMarked, true);

  const stats = (await app.api('GET', '/api/youtube/watched-stats')).json;
  assert.deepStrictEqual([stats.count, stats.totalSeconds, stats.videoIds], [1, 125, ['video000003']]);

  assert.strictEqual((await app.api('DELETE', '/api/youtube/watched/video000003')).status, 200);
  assert.strictEqual((await app.api('DELETE', '/api/youtube/watched/video000003')).status, 404);
  assert.strictEqual((await app.api('GET', '/api/youtube/watched-stats')).json.count, 0);
  remove();
});

test('a video without a known duration is saved anyway, and filled in later', async () => {
  const noInfo = [
    onRequest('youtube.com/youtubei/v1/player', { playabilityStatus: { status: 'LOGIN_REQUIRED' } }),
    onRequest('youtube.com/watch', '<html>a bot check, no duration here</html>'),
  ];
  const marked = await app.api('POST', '/api/youtube/watched', { body: { videoId: 'video000004' } });
  assert.strictEqual(marked.status, 200, marked.text);
  assert.deepStrictEqual([marked.json.durationSeconds, marked.json.durationPending], [0, true]);
  noInfo.forEach((remove) => remove());

  const later = onRequest('youtube.com/youtubei/v1/player', { videoDetails: { lengthSeconds: '60' } });
  await app.api('GET', '/api/youtube/watched-stats');
  let total = 0;
  for (let i = 0; i < 50 && total !== 60; i += 1) {
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    total = (await app.api('GET', '/api/youtube/watched-stats')).json.totalSeconds;
  }
  assert.strictEqual(total, 60);
  later();
});

test('a video id has to look like one', async () => {
  const res = await app.api('POST', '/api/youtube/watched', { body: { videoId: 'not an id' } });
  assert.strictEqual(res.status, 400);
});
