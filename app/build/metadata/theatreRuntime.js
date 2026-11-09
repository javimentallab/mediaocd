"use strict";

// Estimated length of a play. Catalogues rarely say how long one lasts, because it depends on
// the staging, but most plays are in print and a printed page takes about a minute on stage.
// Only plays with no length at all are filled in: a length typed by hand is never replaced.

Object.defineProperty(exports, "__esModule", { value: true });
const axios = require('axios');
const { Database } = require('../dbconfig');
const { logger } = require('../logger');

const USER_AGENT = 'MediaOCD/1.0 (https://github.com/javimentallab/mediaocd; play length estimate)';
const MINUTES_PER_PAGE = 1;
const MIN_PAGES = 40; // Shorter than this is a programme or a leaflet, not the text of a play.
const MAX_MINUTES = 240; // Annotated editions run long; few stagings go past four hours.

const normalize = (text) => String(text || '')
  .normalize('NFD')
  .replace(/[̀-ͯ]/g, '')
  .toLowerCase()
  .replace(/[^a-z0-9]+/g, ' ')
  .trim();

/** Pages of the most reprinted edition with exactly this title by this author, or null. */
function pickPages(docs, title, author) {
  const wanted = normalize(title);
  const surname = normalize(author).split(' ').pop();
  if (!wanted || !surname) return null;
  const matches = (docs || [])
    .filter((doc) => normalize(doc.title) === wanted
      && (doc.author_name || []).some((name) => normalize(name).includes(surname))
      && Number(doc.number_of_pages_median) >= MIN_PAGES)
    .sort((a, b) => (b.edition_count || 0) - (a.edition_count || 0));
  return matches.length ? Number(matches[0].number_of_pages_median) : null;
}

const minutesFromPages = (pages) => Math.min(MAX_MINUTES, Math.round(pages * MINUTES_PER_PAGE));

const get = async (url, params) => (await axios.get(url, {
  params,
  headers: { 'User-Agent': USER_AGENT },
  timeout: 15000,
})).data;

const entity = async (qid) => {
  const data = await get(`https://www.wikidata.org/wiki/Special:EntityData/${qid}.json`);
  return Object.values((data && data.entities) || {})[0] || null;
};

const label = (item) => {
  const labels = (item && item.labels) || {};
  return (labels.en && labels.en.value) || (labels.es && labels.es.value) || null;
};

/** Minutes for a play from Wikidata, or null when no edition can be trusted to be that play. */
async function estimate(play) {
  const work = await entity(`Q${play.tmdbId}`);
  if (!work) return null;
  const claim = work.claims && work.claims.P50 && work.claims.P50[0];
  const authorId = claim && claim.mainsnak && claim.mainsnak.datavalue && claim.mainsnak.datavalue.value.id;
  if (!authorId) return null;
  const author = label(await entity(authorId));
  const title = label(work) || play.originalTitle || play.title;
  if (!author || !title) return null;
  const found = await get('https://openlibrary.org/search.json', {
    title,
    author,
    fields: 'title,author_name,number_of_pages_median,edition_count',
    limit: 10,
  });
  const pages = pickPages(found && found.docs, title, author);
  return pages ? minutesFromPages(pages) : null;
}

const tried = new Set();
let running = false;

/** Fills in the plays without a length. Each play is looked up once per run of the server. */
async function estimateMissing() {
  if (running) return;
  running = true;
  try {
    const knex = Database.knex;
    const plays = await knex('mediaItem')
      .where({ mediaType: 'theater', source: 'wikidata' })
      .whereNull('runtime')
      .select('id', 'title', 'originalTitle', 'tmdbId');
    for (const play of plays) {
      if (tried.has(play.id) || !play.tmdbId) continue;
      tried.add(play.id);
      try {
        const minutes = await estimate(play);
        if (minutes) await knex('mediaItem').where('id', play.id).whereNull('runtime').update({ runtime: minutes });
      } catch (error) {
        logger.warn(`theatre length estimate failed for item ${play.id}: ${error.message}`);
      }
    }
  } finally {
    running = false;
  }
}

exports.estimateMissing = estimateMissing;
exports.pickPages = pickPages;
exports.minutesFromPages = minutesFromPages;
