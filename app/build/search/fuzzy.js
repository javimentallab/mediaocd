'use strict';

// Forgiving search over titles and authors (also narrators and developers): upper and lower
// case, accents, punctuation, roman numerals, words written together and typos, in the
// language of any of the titles of an item. Built on MiniSearch.
//
// - searchIds(): the library search. What matches as typed comes first, and typos are only
//   tried when nothing does, so a correct search does not fill up with lookalikes.
// - corrections(): spellings to try when a catalogue answers nothing. They come from the
//   words of the library and, failing that, from Wikipedia. SEARCH_SPELLCHECK=0 turns
//   Wikipedia off.
// - The titles in other languages come from TMDB, IGDB and Open Library, little by little,
//   and are kept in /storage/search-titles.json. TITLES_WARM=0 turns that off.

const fs = require('fs');
const axiosModule = require('axios');
const miniSearchModule = require('minisearch');

const axios = axiosModule.default || axiosModule;
const MiniSearch = miniSearchModule.default || miniSearchModule;

const TITLES_PATH = '/storage/search-titles.json';
const USER_AGENT = 'MediaOCD (https://github.com/javimentallab/mediaocd)';
const MAX_RESULTS = 500;
const MAX_TITLES = 80;
const DAY = 24 * 3600 * 1000;
const TITLES_TTL = 90 * DAY;
const WARM_EVERY = 1500;
const REBUILD_FOR_TITLES_EVERY = 5 * 60 * 1000;
const BACKOFF = 10 * 60 * 1000;

const ROMAN = {
  ii: '2', iii: '3', iv: '4', v: '5', vi: '6', vii: '7', viii: '8', ix: '9', x: '10', xi: '11', xii: '12', xiii: '13',
};
// "Fast and Furious" and "Fast & Furious" are the same title.
const NOISE = new Set(['and', 'y', 'e', 'et', 'und']);
const LETTERS = { ß: 'ss', ł: 'l', ø: 'o', đ: 'd', æ: 'ae', œ: 'oe' };
const BOOST = { title: 3, originalTitle: 2.5, compact: 2.5, altTitles: 1.5, people: 1.5 };
// Typos are looked for here first. The translations come after, with more care.
const OWN_TITLES = ['title', 'originalTitle', 'compact', 'people'];

const database = () => require('../dbconfig').Database.knex;
const configuration = () => require('../repository/globalSettings').GlobalConfiguration.configuration || {};

const normalize = (text) => String(text || '')
  .normalize('NFD').replace(/\p{M}+/gu, '').normalize('NFC')
  .toLowerCase()
  .replace(/[ßłøđæœ]/g, (c) => LETTERS[c])
  .replace(/['’`´]/g, '');
const tokenize = (text) => normalize(text).split(/[\s\p{P}\p{Z}]+/u).filter(Boolean);
const processTerm = (term) => (NOISE.has(term) ? null : ROMAN[term] || term);
const terms = (text) => tokenize(text).map(processTerm).filter(Boolean);
// All the words as one, keeping the noise: the "e" of "S.T.A.L.K.E.R." is not a conjunction.
const joined = (text) => tokenize(text).map((word) => ROMAN[word] || word).join('');

// How far a word can be from what was typed. A swap of two letters counts as two.
const tolerance = (term) => {
  const length = [...term].length;
  if (length < 3) return false;
  return length < 5 ? 1 : 2;
};

// A film with seventy translations has so many words that a short one is always nearly there.
const toleranceInTranslations = (term) => ([...term].length < 5 ? false : 2);

const distance = (a, b) => {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i += 1) {
    const next = [i];
    for (let j = 1; j <= b.length; j += 1) {
      next[j] = Math.min(next[j - 1] + 1, row[j] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    row = next;
  }
  return row[b.length];
};
// Only a real correction of what was typed, not whatever a search engine came up with.
const isCorrection = (typed, other) => {
  const a = terms(typed).join(' ');
  const b = terms(other).join(' ');
  if (!a || !b || a === b) return false;
  return distance(a, b) <= Math.max(2, Math.ceil(a.length * 0.25));
};

// --- Titles in other languages ---

let titles = null;
let titlesSaveTimer = null;
let titlesChangedAt = 0;
let titlesBlockedUntil = 0;

function loadTitles() {
  if (titles) return titles;
  try {
    titles = JSON.parse(fs.readFileSync(TITLES_PATH, 'utf8')) || {};
  } catch (_) {
    titles = {};
  }
  return titles;
}
function saveTitles() {
  if (titlesSaveTimer) return;
  titlesSaveTimer = setTimeout(() => {
    titlesSaveTimer = null;
    const tmp = `${TITLES_PATH}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify(titles));
      fs.renameSync(tmp, TITLES_PATH);
    } catch (e) {
      console.error('search titles: cache write failed:', e.message);
    }
  }, 5000);
  if (titlesSaveTimer.unref) titlesSaveTimer.unref();
}

// Providers without titles() have none to offer. titles() answers null while it cannot ask.
async function refreshTitles(item) {
  const cache = loadTitles();
  const now = Date.now();
  const { metadataProviders } = require('../metadata/metadataProviders');
  const provider = metadataProviders.has(item.mediaType) ? metadataProviders.get(item.mediaType) : null;
  if (!provider || typeof provider.titles !== 'function') {
    cache[item.id] = { exp: now + TITLES_TTL, t: [] };
    saveTitles();
    return;
  }
  const previous = cache[item.id] && cache[item.id].t;
  try {
    const raw = await provider.titles(item);
    if (raw === null) {
      cache[item.id] = { exp: now + DAY, t: previous || [] };
    } else {
      const known = new Set([normalize(item.title), normalize(item.originalTitle)]);
      const t = [];
      for (const title of raw) {
        const key = normalize(title);
        if (title && title.length <= 120 && !known.has(key)) {
          known.add(key);
          t.push(title);
        }
        if (t.length >= MAX_TITLES) break;
      }
      cache[item.id] = { exp: now + TITLES_TTL, t };
      if (t.length) titlesChangedAt = now;
    }
  } catch (e) {
    const status = e && e.response && e.response.status;
    if (status === 429) {
      titlesBlockedUntil = now + BACKOFF;
      return;
    }
    cache[item.id] = { exp: now + DAY, t: previous || [] };
  }
  saveTitles();
}

let warmList = [];
let warmListAt = 0;
async function warmTick() {
  if (Date.now() < titlesBlockedUntil) return;
  if (!warmList.length || Date.now() - warmListAt > 3600 * 1000) {
    warmList = await database()('mediaItem')
      .select('id', 'mediaType', 'title', 'originalTitle', 'tmdbId', 'igdbId', 'openlibraryId')
      .whereIn('mediaType', ['movie', 'tv', 'video_game', 'book'])
      .where((qb) => qb
        .whereExists(function seen() { this.from('seen').whereRaw('"seen"."mediaItemId" = "mediaItem"."id"'); })
        .orWhereExists(function listed() { this.from('listItem').whereRaw('"listItem"."mediaItemId" = "mediaItem"."id"'); })
        .orWhereExists(function dropped() { this.from('abandoned').whereRaw('"abandoned"."mediaItemId" = "mediaItem"."id"'); }))
      .orderBy('id', 'desc');
    warmListAt = Date.now();
  }
  // First what was never asked for, then what expired longest ago.
  const cache = loadTitles();
  const now = Date.now();
  let next = null;
  let nextExp = Infinity;
  for (const item of warmList) {
    const hit = cache[item.id];
    if (!hit) {
      next = item;
      break;
    }
    if (hit.exp <= now && hit.exp < nextExp) {
      next = item;
      nextExp = hit.exp;
    }
  }
  if (next) await refreshTitles(next);
}
if (process.env.TITLES_WARM !== '0' && !global.__mtTitlesWarm) {
  global.__mtTitlesWarm = true;
  const loop = () => {
    warmTick()
      .catch((e) => console.error('search titles:', e.message))
      .then(() => {
        const t = setTimeout(loop, WARM_EVERY);
        if (t.unref) t.unref();
      });
  };
  const start = setTimeout(loop, 120 * 1000);
  if (start.unref) start.unref();
}

// --- Index ---

let index = null;
let indexKey = null;
let indexBuiltAt = 0;
let building = null;

async function build(key) {
  const rows = await database()('mediaItem').select('id', 'mediaType', 'title', 'originalTitle', 'authors', 'narrators', 'developer');
  const cache = loadTitles();
  const fresh = new MiniSearch({
    fields: ['title', 'originalTitle', 'altTitles', 'compact', 'people'],
    storeFields: ['mediaType'],
    tokenize,
    processTerm,
  });
  await fresh.addAllAsync(rows.map((row) => ({
    id: row.id,
    mediaType: row.mediaType,
    title: row.title,
    originalTitle: row.originalTitle,
    altTitles: cache[row.id] && cache[row.id].t.length ? cache[row.id].t.join(' | ') : null,
    people: [row.authors, row.narrators, row.developer].filter(Boolean).join(', ') || null,
    // Each title as one word, so "spiderman" finds "Spider-Man" and the other way round.
    compact: [row.title, row.originalTitle].filter(Boolean).map(joined).join(' '),
  })), { chunkSize: 500 });
  index = fresh;
  indexKey = key;
  indexBuiltAt = Date.now();
}

async function getIndex() {
  const row = await database()('mediaItem').count({ n: '*' }).max({ m: 'id', u: 'lastTimeUpdated' }).first();
  const key = `${row.n}:${row.m}:${row.u}`;
  const titlesOld = titlesChangedAt > indexBuiltAt && Date.now() - indexBuiltAt > REBUILD_FOR_TITLES_EVERY;
  if (index && key === indexKey && !titlesOld) return index;
  if (!building) {
    building = build(key).finally(() => {
      building = null;
    });
  }
  // Meanwhile the one already built is good enough, unless the catalogue itself changed.
  if (index && key === indexKey) return index;
  await building;
  return index;
}

// Titles fetched just now count from the next search, not in a few minutes.
function invalidate() {
  indexKey = null;
}

// A word too many: what has most of them, never a title that only looks like one of them.
// With two words, the one that matches has to be a real word, not "de" or "the".
function mostWords(engine, q, words, options) {
  const wanted = new Set(words).size;
  const need = wanted <= 2 ? 1 : Math.ceil(wanted * 0.6);
  const enough = (size) => (r) => r.queryTerms.length >= need
    && (wanted > 2 || r.queryTerms.some((t) => [...t].length >= size));
  let found = engine.search(q, { ...options, fuzzy: false, combineWith: 'OR' }).filter(enough(4));
  if (!found.length) {
    found = engine.search(q, { ...options, fields: OWN_TITLES, fuzzy: tolerance, combineWith: 'OR' }).filter(enough(5));
  }
  if (!found.length) return found;
  const least = found[0].score * 0.4;
  return found.filter((r) => r.score >= least);
}

// strict: every word has to be there, as typed or with a typo.
async function searchIds(text, mediaType, { strict = false } = {}) {
  const q = String(text || '').slice(0, 200);
  const words = terms(q);
  if (!words.length) return [];
  const engine = await getIndex();
  const options = {
    prefix: true,
    boost: BOOST,
    filter: mediaType ? (r) => r.mediaType === mediaType : undefined,
  };
  const query = {
    combineWith: 'OR',
    queries: [
      { combineWith: 'AND', queries: [q] },
      { combineWith: 'AND', fields: ['compact'], queries: [joined(q)] },
    ],
  };
  let found = engine.search(query, { ...options, fuzzy: false });
  if (!found.length) found = engine.search(query, { ...options, fields: OWN_TITLES, fuzzy: tolerance });
  if (!found.length) found = engine.search(query, { ...options, fuzzy: toleranceInTranslations });
  if (!found.length && !strict && words.length > 1) found = mostWords(engine, q, words, options);
  return found.slice(0, MAX_RESULTS).map((r) => r.id);
}

// --- Corrections ---

let wikipediaBlockedUntil = 0;

async function wikipediaAnswers(q, language) {
  const url = `https://${language}.wikipedia.org/w/api.php`;
  const request = (params) => axios.get(url, {
    params: { format: 'json', ...params },
    headers: { 'User-Agent': USER_AGENT },
    timeout: 3000,
  });
  const answers = [];
  const suggestion = await request({ action: 'query', list: 'search', srsearch: q, srinfo: 'suggestion', srprop: '', srlimit: 1 });
  const said = suggestion.data && suggestion.data.query && suggestion.data.query.searchinfo && suggestion.data.query.searchinfo.suggestion;
  if (said) answers.push(said);
  const pages = await request({ action: 'opensearch', search: q, profile: 'fuzzy', limit: 3 });
  for (const page of (pages.data && pages.data[1]) || []) {
    // "El padrino (película)" is the page; the title is what comes before the bracket.
    const title = String(page);
    const bracket = title.lastIndexOf(' (');
    answers.push(bracket > 0 && title.endsWith(')') ? title.slice(0, bracket) : title);
  }
  return answers;
}

async function corrections(text, mediaType) {
  const q = String(text || '').slice(0, 200);
  if (!terms(q).length) return [];
  const out = [];
  const add = (candidate) => {
    if (isCorrection(q, candidate) && !out.includes(candidate)) out.push(candidate);
  };
  const gap = (candidate) => distance(terms(q).join(' '), terms(candidate).join(' '));
  const nearestFirst = () => [...out].sort((a, b) => gap(a) - gap(b)).slice(0, 3);
  const engine = await getIndex();
  engine.autoSuggest(q, {
    prefix: false,
    fuzzy: tolerance,
    filter: mediaType ? (r) => r.mediaType === mediaType : undefined,
  }).slice(0, 5).forEach((s) => add(s.suggestion));
  // One letter off is good enough. Further than that, the words of a library can be the wrong
  // ones ("piratas del cartel"), so the suggestion of Wikipedia gets a say.
  if (out.some((candidate) => gap(candidate) <= 1)) return nearestFirst();
  if (process.env.SEARCH_SPELLCHECK === '0' || Date.now() < wikipediaBlockedUntil) return nearestFirst();

  const own = String(configuration().tmdbLang || '').slice(0, 2).toLowerCase();
  const found = out.length;
  for (const language of [...new Set([/^[a-z]{2}$/.test(own) ? own : 'en', 'en'])]) {
    try {
      (await wikipediaAnswers(q, language)).forEach(add);
    } catch (e) {
      if (e && e.response && e.response.status === 429) wikipediaBlockedUntil = Date.now() + BACKOFF;
    }
    if (out.length > found || Date.now() < wikipediaBlockedUntil) break;
  }
  return nearestFirst();
}

module.exports = { searchIds, corrections, refreshTitles, invalidate };
