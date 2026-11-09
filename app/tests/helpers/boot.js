'use strict';

// Starts the app on the /storage that is already there, as a restart would, and says what it
// finds. A file of its own because each start needs a new process.

const fs = require('node:fs');
const { onRequest, startApp, STORAGE } = require('./app');

(async () => {
  const app = await startApp({ keepStorage: true, users: false });
  const titles = (await app.knex('mediaItem').select('title')).map((row) => row.title);
  const configuration = (await app.request('GET', '/api/configuration')).status;
  const files = fs.readdirSync(STORAGE).sort();
  const { locked } = await app.knex('mediaItem').whereNotNull('lockedAt').count('* as locked').first();

  // BOOT_OPEN_ITEM opens that item as its first load, with a theatre provider that answers.
  let opened = null;
  if (process.env.BOOT_OPEN_ITEM) {
    onRequest('Special:EntityData/', (url) => {
      const [, qid] = url.match(/(Q\d+)\.json/);
      return {
        entities: { [qid]: { labels: { es: { value: 'Fetched after the restart' } }, descriptions: {}, claims: {}, sitelinks: {} } },
      };
    });
    const res = await app.request('GET', `/api/details/${process.env.BOOT_OPEN_ITEM}`, { token: process.env.BOOT_TOKEN });
    opened = { status: res.status, title: res.json ? res.json.title : res.text };
  }
  console.log(`BOOT ${JSON.stringify({ titles, configuration, files, locked, opened })}`);
  await app.stop();
  process.exit(0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
