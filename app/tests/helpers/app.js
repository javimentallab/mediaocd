'use strict';

// Starts the real app (Express, migrations, generated routes, auth) on a throwaway SQLite
// database, on a loopback port. No external service is ever reached: fetch, axios, https
// and curl all go through the fake network below, and an unexpected request fails loudly.
//
// app/build reads and writes fixed paths under /storage, so the tests need that folder.
// They refuse to run if it holds anything that they did not put there: see prepareStorage.

const assert = require('node:assert');
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const { EventEmitter, once } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');

const STORAGE = '/storage';
const MARKER = '.mediaocd-test-sandbox';
const DATABASE_PATH = path.join(STORAGE, 'data.db');

const HOW_TO_RUN = 'Run the tests where /storage is a throwaway folder: see CONTRIBUTING.md.';

function prepareStorage() {
  let entries;
  try {
    entries = fs.readdirSync(STORAGE);
  } catch (error) {
    try {
      fs.mkdirSync(STORAGE);
    } catch (mkdirError) {
      throw new Error(`Cannot create ${STORAGE}: ${mkdirError.message}\n${HOW_TO_RUN}`);
    }
    entries = [];
  }
  if (entries.length > 0 && !entries.includes(MARKER)) {
    throw new Error(`Refusing to run: ${STORAGE} holds data that is not from these tests.\n${HOW_TO_RUN}`);
  }
  for (const entry of entries) {
    fs.rmSync(path.join(STORAGE, entry), { recursive: true, force: true });
  }
  try {
    fs.writeFileSync(path.join(STORAGE, MARKER), 'Throwaway folder of the MediaOCD tests.\n');
  } catch (error) {
    throw new Error(`Cannot write to ${STORAGE}: ${error.message}\n${HOW_TO_RUN}`);
  }
}

// --- Fake network ---

const routes = [];
const calls = [];
const unexpected = [];

const isLoopback = (host) => ['127.0.0.1', 'localhost', '::1'].includes(String(host).replace(/[[\]]/g, ''));
const isLoopbackUrl = (url) => {
  try {
    return isLoopback(new URL(url).hostname);
  } catch (error) {
    return false;
  }
};

/**
 * Answers the requests whose URL matches. The handler gets (url, { method, body }) and
 * returns { status, body, url } or just a body; the last route added wins.
 */
function onRequest(pattern, handler) {
  const route = { pattern, handler };
  routes.push(route);
  return () => routes.splice(routes.indexOf(route), 1);
}

async function answer(url, init = {}) {
  calls.push({ url, method: (init.method || 'GET').toUpperCase(), body: init.body });
  const route = [...routes].reverse().find((r) => (r.pattern instanceof RegExp ? r.pattern.test(url) : url.includes(r.pattern)));
  if (!route) {
    unexpected.push(url);
    throw new Error(`Unexpected network request in a test: ${url}`);
  }
  const result = await (typeof route.handler === 'function' ? route.handler(url, init) : route.handler);
  const isWrapped = result && typeof result === 'object' && (typeof result.status === 'number' || 'body' in result);
  const full = isWrapped ? result : { body: result };
  const body = full.body === undefined || full.body === null ? '' : full.body;
  return {
    status: full.status || 200,
    body: typeof body === 'string' ? body : JSON.stringify(body),
    url: full.url || url,
    headers: full.headers || {},
  };
}

function fakeFetch(realFetch) {
  return async (input, init = {}) => {
    const url = String(input && input.url ? input.url : input);
    if (isLoopbackUrl(url)) return realFetch(input, init);
    const r = await answer(url, init);
    return new Response(r.status === 204 ? null : r.body, { status: r.status, headers: r.headers });
  };
}

function fakeHttpsCall(protocolName, original, isGet) {
  return (...args) => {
    const first = args[0];
    const isOptions = first && typeof first === 'object' && !(first instanceof URL);
    const url = isOptions
      ? `${protocolName}://${first.hostname || first.host}${first.path || '/'}`
      : String(first);
    if (isLoopbackUrl(url)) return original(...args);
    const options = args.find((a, i) => (i > 0 || isOptions) && a && typeof a === 'object' && !(a instanceof URL)) || {};
    const callback = args.find((a) => typeof a === 'function');
    const req = new EventEmitter();
    const chunks = [];
    let started = false;
    const start = () => {
      if (started) return;
      started = true;
      answer(url, { method: options.method, body: chunks.join('') }).then((r) => {
        const res = new PassThrough();
        res.statusCode = r.status;
        res.headers = r.headers;
        if (callback) callback(res);
        req.emit('response', res);
        res.end(r.body);
      }, (error) => req.emit('error', error));
    };
    req.write = (chunk) => { chunks.push(String(chunk)); return true; };
    req.end = (chunk) => { if (chunk) chunks.push(String(chunk)); setImmediate(start); return req; };
    req.destroy = (error) => { if (error) req.emit('error', error); return req; };
    req.setTimeout = () => req;
    if (isGet) req.end();
    return req;
  };
}

function installFakeNetwork() {
  globalThis.fetch = fakeFetch(globalThis.fetch);

  https.get = fakeHttpsCall('https', https.get, true);
  https.request = fakeHttpsCall('https', https.request, false);
  http.get = fakeHttpsCall('http', http.get, true);
  http.request = fakeHttpsCall('http', http.request, false);

  const realExecFile = childProcess.execFile;
  childProcess.execFile = (command, args, options, callback) => {
    if (command !== 'curl') return realExecFile(command, args, options, callback);
    const url = args[args.length - 1];
    const format = args[args.indexOf('-w') + 1];
    answer(url).then((r) => {
      const footer = format
        .replace('%{http_code}', String(r.status))
        .replace('%header{retry-after}', r.headers['retry-after'] || '')
        .replace('%{url_effective}', r.url);
      callback(null, r.body + footer);
    }, (error) => callback(error));
    return new EventEmitter();
  };

  // Last line of defence: whatever slips past the fakes cannot leave the machine.
  const realConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function connect(...args) {
    const target = Array.isArray(args[0]) ? args[0][0] : args[0];
    if (target && typeof target === 'object' && target.host && !isLoopback(target.host)) {
      unexpected.push(target.host);
      throw new Error(`Unexpected network connection in a test: ${target.host}`);
    }
    return realConnect.apply(this, args);
  };

  // eslint-disable-next-line global-require
  const axios = require('axios');
  axios.defaults.adapter = async (config) => {
    const url = axios.getUri(config);
    const r = await answer(url, { method: config.method, body: config.data, headers: config.headers });
    const response = { data: r.body, status: r.status, statusText: String(r.status), headers: r.headers, config, request: {} };
    if (config.validateStatus && !config.validateStatus(r.status)) {
      throw new axios.AxiosError(`Request failed with status code ${r.status}`, 'ERR_BAD_RESPONSE', config, {}, response);
    }
    return response;
  };
}

// --- Dates, relative to today, because "already aired" depends on the day the tests run ---

const daysFromNow = (days) => new Date(Date.now() + days * 86400000).toISOString().slice(0, 10);

// --- The app ---

function migratedDatabasePath() {
  const dir = path.join(__dirname, '..', '..', 'build', 'migrations');
  const list = fs.readdirSync(dir).sort().map((f) => `${f}:${fs.statSync(path.join(dir, f)).size}`).join('|');
  const hash = crypto.createHash('sha256').update(list).digest('hex').slice(0, 16);
  return path.join(os.tmpdir(), `mediaocd-tests-migrated-${hash}.db`);
}

let current = null;

/**
 * keepStorage starts on the /storage that is already there, as a restart would, and only if
 * it is the one of these tests. users: false does not create the administrator.
 */
async function startApp({ keepStorage = false, users = true } = {}) {
  assert.strictEqual(current, null, 'one app per test file');
  if (keepStorage) {
    assert.ok(fs.existsSync(path.join(STORAGE, MARKER)), `${STORAGE} is not the folder of these tests`);
  } else {
    prepareStorage();
  }

  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mediaocd-tests-'));
  Object.assign(process.env, {
    HOME: home,
    NODE_ENV: 'production',
    DATABASE_PATH,
    ASSETS_PATH: path.join(home, 'assets'),
    LOGS_PATH: path.join(home, 'logs'),
    FILMAFFINITY_WARM: '0',
    METACRITIC_WARM: '0',
  });
  for (const name of ['JELLYFIN_URL', 'JELLYFIN_API_KEY', 'JELLYFIN_USER_ID', 'JELLYFIN_PUBLIC_URL',
    'JELLYFIN_REVERSE_SYNC', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REDIRECT_URI',
    'TMDB_API_KEY', 'IGDB_CLIENT_ID', 'IGDB_CLIENT_SECRET', 'DATABASE_CLIENT', 'DATABASE_URL', 'DEMO']) {
    delete process.env[name];
  }
  installFakeNetwork();

  // Migrations are most of the start-up: they run once, and the next files copy the result.
  const migrated = migratedDatabasePath();
  if (!keepStorage && fs.existsSync(migrated)) fs.copyFileSync(migrated, DATABASE_PATH);

  /* eslint-disable global-require */
  const { initialize, Server } = require('../../build/server');
  const { Database } = require('../../build/dbconfig');
  const { logger } = require('../../build/logger');
  /* eslint-enable global-require */

  // TEST_LOGS=1 shows the logs of the app, which are only noise when everything passes.
  const initLogger = logger.init.bind(logger);
  logger.init = () => {
    initLogger();
    if (!process.env.TEST_LOGS) {
      logger.debugLogger.transports.filter((t) => t.name === 'console').forEach((t) => { t.silent = true; });
    }
  };

  const { sessionKey } = await initialize({ serverLang: 'en', tmdbLang: 'en', audibleLang: 'us', demo: false });
  if (!keepStorage && !fs.existsSync(migrated)) {
    const partial = `${migrated}.${process.pid}`;
    await Database.knex.raw('VACUUM INTO ?', [partial]);
    fs.renameSync(partial, migrated);
  }
  const server = new Server({
    hostname: '127.0.0.1',
    port: 0,
    assetsPath: process.env.ASSETS_PATH,
    publicPath: path.join(__dirname, '..', '..', 'public'),
    sessionKey,
    production: false,
  });
  const listener = server.create().listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const baseUrl = `http://127.0.0.1:${listener.address().port}`;

  async function request(method, urlPath, { query, body, token, cookie, headers, raw } = {}) {
    const url = new URL(urlPath, baseUrl);
    for (const [key, value] of Object.entries(query || {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    const allHeaders = { ...headers };
    if (token) allHeaders.Authorization = `Bearer ${token}`;
    if (cookie) allHeaders.Cookie = cookie;
    let payload;
    if (raw !== undefined) {
      payload = raw;
    } else if (body !== undefined) {
      payload = JSON.stringify(body);
      allHeaders['Content-Type'] = 'application/json';
    }
    const response = await fetch(url, {
      method, headers: allHeaders, body: payload, redirect: 'manual', signal: AbortSignal.timeout(15000),
    });
    const buffer = Buffer.from(await response.arrayBuffer());
    const text = buffer.toString('utf8');
    let json;
    try {
      json = JSON.parse(text);
    } catch (error) {
      json = undefined;
    }
    return { status: response.status, headers: response.headers, text, json, buffer };
  }

  async function createUser(name) {
    const password = `password of ${name}`;
    const registered = await request('POST', '/api/user/register', {
      body: { username: name, password, confirmPassword: password },
    });
    assert.strictEqual(registered.status, 200, `register ${name}: ${registered.text}`);
    const cookie = (registered.headers.get('set-cookie') || '').split(';')[0];
    assert.ok(cookie, `register ${name} gives a session`);
    const created = await request('PUT', '/api/tokens', { query: { description: 'tests' }, cookie });
    assert.strictEqual(created.status, 200, `token of ${name}: ${created.text}`);
    const user = await Database.knex('user').where('name', name).first();
    return { id: user.id, name, token: created.json.token };
  }

  // The first user to register becomes the administrator.
  const admin = users ? await createUser('admin') : null;
  const api = (method, urlPath, options = {}) => request(method, urlPath, { token: admin && admin.token, ...options });

  async function item(fields = {}) {
    const [row] = await Database.knex('mediaItem').insert({
      mediaType: 'movie',
      source: 'user',
      title: 'An item',
      releaseDate: '2001-01-01',
      needsDetails: false,
      lastTimeUpdated: Date.now(),
      ...fields,
    }).returning('id');
    return row.id;
  }

  /**
   * A TV show. episodes: [[season, episode, releaseDate], ...]; returns its id and the id of
   * each episode, by "S1E1".
   */
  async function show({ episodes = [], ...fields }) {
    const id = await item({ mediaType: 'tv', status: 'Ended', ...fields });
    const seasons = new Map();
    const episodeIds = {};
    for (const [seasonNumber, episodeNumber, releaseDate] of episodes) {
      if (!seasons.has(seasonNumber)) {
        const [season] = await Database.knex('season').insert({
          tvShowId: id,
          seasonNumber,
          title: `Season ${seasonNumber}`,
          isSpecialSeason: false,
          numberOfEpisodes: episodes.filter((e) => e[0] === seasonNumber).length,
        }).returning('id');
        seasons.set(seasonNumber, season.id);
      }
      const [episode] = await Database.knex('episode').insert({
        tvShowId: id,
        seasonId: seasons.get(seasonNumber),
        seasonNumber,
        episodeNumber,
        seasonAndEpisodeNumber: seasonNumber * 1000 + episodeNumber,
        title: `Episode ${episodeNumber}`,
        releaseDate,
        isSpecialEpisode: false,
      }).returning('id');
      episodeIds[`S${seasonNumber}E${episodeNumber}`] = episode.id;
    }
    return { id, episodes: episodeIds, seasons };
  }

  async function stop() {
    await new Promise((resolve) => { listener.close(() => resolve()); listener.closeAllConnections(); });
    await Database.knex.destroy();
    fs.rmSync(home, { recursive: true, force: true });
    current = null;
    assert.deepStrictEqual(unexpected, [], 'requests that no test expected');
  }

  current = {
    api, request, createUser, admin, item, show, stop, knex: Database.knex, onRequest, calls, unexpected, storage: STORAGE,
  };
  return current;
}

module.exports = {
  startApp, prepareStorage, onRequest, calls, unexpected, daysFromNow, STORAGE, DATABASE_PATH,
};
