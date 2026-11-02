'use strict';

// Starts the app on the /storage that is already there, as a restart would, and says what it
// finds. A file of its own because each start needs a new process.

const fs = require('node:fs');
const { startApp, STORAGE } = require('./app');

(async () => {
  const app = await startApp({ keepStorage: true, users: false });
  const titles = (await app.knex('mediaItem').select('title')).map((row) => row.title);
  const configuration = (await app.request('GET', '/api/configuration')).status;
  const files = fs.readdirSync(STORAGE).sort();
  console.log(`BOOT ${JSON.stringify({ titles, configuration, files })}`);
  await app.stop();
  process.exit(0);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
