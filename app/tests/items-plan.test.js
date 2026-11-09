'use strict';

// The item lists (Home, In progress, Pending, the catalogues...) stay fast. SQLite builds no
// automatic index once one SELECT joins more than 8 tables, and the list query then scans
// every grouped subquery whole for each item: 1 to 4 seconds per section with a real
// library. Its per-item counts are correlated subqueries instead, so the joins stay at 8.

const { after, before, test } = require('node:test');
const assert = require('node:assert');
const { daysFromNow, startApp } = require('./helpers/app');

let app;
before(async () => { app = await startApp(); });
after(async () => { await app.stop(); });

// The requests of the Home, In progress and Pending sections, and of a catalogue page.
const sections = [
  { orderBy: 'lastAiring', sortOrder: 'desc', page: 1, onlySeenItems: false, excludeAbandoned: true },
  { orderBy: 'lastSeen', sortOrder: 'desc', page: 1, onlySeenItems: true, onlyWithoutUserRating: true },
  { orderBy: 'title', sortOrder: 'asc', page: 1, mediaType: 'tv', onlyWithProgress: true, excludeAbandoned: true },
  { orderBy: 'title', sortOrder: 'asc', page: 1, mediaType: 'movie', onlyWithProgress: true, excludeAbandoned: true },
  { orderBy: 'listedAt', sortOrder: 'desc', page: 1, mediaType: 'tv', onlyOnWatchlist: true },
  { orderBy: 'lastSeen', sortOrder: 'desc', page: 1, mediaType: 'movie' },
];

test('no item list joins more than 8 tables in one SELECT', async () => {
  const show = await app.show({ title: 'Plan show', episodes: [[1, 1, daysFromNow(-10)], [1, 2, daysFromNow(10)]] });
  await app.api('PUT', '/api/seen', { query: { mediaItemId: show.id, episodeId: show.episodes.S1E1, lastSeenAt: 'now' } });

  for (const query of sections) {
    const seenSql = [];
    const listen = (q) => seenSql.push(q);
    app.knex.on('query', listen);
    const res = await app.api('GET', '/api/items/paginated', { query });
    app.knex.removeListener('query', listen);
    assert.strictEqual(res.status, 200, res.text);

    const main = seenSql.filter((q) => /firstUnwatchedEpisode/.test(q.sql)).pop();
    assert.ok(main, 'the list query ran: ' + JSON.stringify(query));
    const plan = await app.knex.raw('EXPLAIN QUERY PLAN ' + main.sql, main.bindings);
    const loops = plan.filter((row) => row.parent === 0 && /^(SCAN|SEARCH) /.test(row.detail));
    assert.ok(loops.length <= 8, `${JSON.stringify(query)} joins ${loops.length} tables:\n${loops.map((r) => r.detail).join('\n')}`);
  }
});
