'use strict';

// A search that forgives: case, accents, typos, words written together and any language.
// TMDB and Wikipedia are simulated.

const { after, before, test } = require('node:test');
const assert = require('node:assert');
const { onRequest, startApp } = require('./helpers/app');

let app;
let fuzzy;
before(async () => {
  app = await startApp();
  // eslint-disable-next-line global-require
  fuzzy = require('../build/search/fuzzy');
});
after(async () => { await app.stop(); });

const add = async (title, extra = {}) => {
  const id = await app.item({ title, mediaType: 'movie', releaseDate: '2010-01-01', ...extra });
  const res = await app.api('PUT', '/api/watchlist', { query: { mediaItemId: id } });
  assert.strictEqual(res.status, 200, res.text);
  return id;
};
const titles = async (filter) => {
  const res = await app.api('GET', '/api/items', { query: { filter, orderBy: 'title', sortOrder: 'asc' } });
  assert.strictEqual(res.status, 200, res.text);
  return res.json.map((item) => item.title);
};

test('upper and lower case and accents do not matter, either way', async () => {
  await add('Pokémon: The First Movie');
  await add('Amelie');
  assert.ok((await titles('POKEMON')).includes('Pokémon: The First Movie'));
  assert.ok((await titles('pokémon')).includes('Pokémon: The First Movie'));
  assert.ok((await titles('AMÉLIE')).includes('Amelie'));
});

test('typos are forgiven, also two letters swapped', async () => {
  await add('The Matrix');
  await add('Harry Potter and the Goblet of Fire');
  assert.ok((await titles('matirx')).includes('The Matrix'));
  assert.ok((await titles('the matrx')).includes('The Matrix'));
  assert.ok((await titles('hary poter')).includes('Harry Potter and the Goblet of Fire'));
});

test('a search that is right does not bring lookalikes', async () => {
  await add('Larry Crowne');
  assert.deepStrictEqual(await titles('larry'), ['Larry Crowne']);
  await add('Barry Lyndon');
  assert.deepStrictEqual(await titles('barry'), ['Barry Lyndon']);
});

test('words together or apart, punctuation and roman numerals', async () => {
  await add('Spider-Man: Homecoming');
  await add('Antman Returns');
  await add('Rocky II');
  await add('S.T.A.L.K.E.R. 2: Heart of Chornobyl');
  await add("Schindler's List");
  assert.ok((await titles('spiderman')).includes('Spider-Man: Homecoming'));
  assert.ok((await titles('ant man')).includes('Antman Returns'));
  assert.ok((await titles('rocky 2')).includes('Rocky II'));
  assert.ok((await titles('stalker 2')).includes('S.T.A.L.K.E.R. 2: Heart of Chornobyl'));
  assert.ok((await titles('schindlers list')).includes("Schindler's List"));
});

test('a book is found by its author, also with a typo and mixed with words of its title', async () => {
  await add('Cien años de soledad', { mediaType: 'book', authors: 'Gabriel García Márquez' });
  await add('Dune', { mediaType: 'audiobook', authors: 'Frank Herbert', narrators: 'Scott Brick' });
  await add('Dead Space 2', { mediaType: 'video_game', developer: 'Visceral Games' });
  assert.ok((await titles('garcia marquez')).includes('Cien años de soledad'));
  assert.ok((await titles('GABRIEL GARCÍA')).includes('Cien años de soledad'));
  assert.ok((await titles('garcia marqez')).includes('Cien años de soledad'));
  assert.ok((await titles('marquez soledad')).includes('Cien años de soledad'));
  assert.ok((await titles('frank herbert')).includes('Dune'));
  assert.ok((await titles('scott brick')).includes('Dune'));
  assert.ok((await titles('visceral')).includes('Dead Space 2'));
});

test('the original title counts, in its own script', async () => {
  await add('Seven Samurai', { originalTitle: '七人の侍' });
  await add('The Good, the Bad and the Ugly', { originalTitle: 'Il buono, il brutto, il cattivo' });
  assert.ok((await titles('七人の侍')).includes('Seven Samurai'));
  assert.ok((await titles('il bueno il bruto')).includes('The Good, the Bad and the Ugly'));
});

test('the best match goes first, whatever the order asked for', async () => {
  await add('Aaa Alien Story of a Long Name Indeed');
  await add('Alien');
  assert.strictEqual((await titles('alien'))[0], 'Alien');
});

test('one word too many still finds it', async () => {
  await add('Blade Runner');
  assert.ok((await titles('blade runner pelicula')).includes('Blade Runner'));
  assert.ok((await titles('matirx pelicula')).includes('The Matrix'));
});

test('a title that only looks like one of the words does not come out', async () => {
  await add('Pete and the Dragon');
  const id = await add('A Film With Many Translations', { tmdbId: 777 });
  const remove = onRequest('api.themoviedb.org/3/movie/777', {
    id: 777,
    title: 'A Film With Many Translations',
    translations: { translations: [{ iso_639_1: 'de', data: { title: 'Wer gute Date hat' } }, { iso_639_1: 'xx', data: { title: 'Dee Rata' } }] },
    alternative_titles: { titles: [] },
  });
  await fuzzy.refreshTitles({ id, mediaType: 'movie', title: 'A Film With Many Translations', tmdbId: 777 });
  remove();
  fuzzy.invalidate();
  assert.deepStrictEqual(await titles('der pate'), []);
  assert.deepStrictEqual(await titles('xqzwv kkjh'), []);
});

test('a title can be found in any language once its translations are known', async () => {
  const id = await add('The Godfather Trilogy', { tmdbId: 238 });
  const remove = onRequest('api.themoviedb.org/3/movie/238', {
    id: 238,
    title: 'The Godfather Trilogy',
    translations: { translations: [{ iso_639_1: 'es', data: { title: 'El padrino' } }, { iso_639_1: 'it', data: { title: 'Il padrino' } }] },
    alternative_titles: { titles: [{ title: 'Der Pate' }] },
  });
  assert.deepStrictEqual(await titles('padrino'), []);
  await fuzzy.refreshTitles({ id, mediaType: 'movie', title: 'The Godfather Trilogy', tmdbId: 238 });
  remove();
  fuzzy.invalidate();
  assert.deepStrictEqual(await titles('el padrino'), ['The Godfather Trilogy']);
  assert.deepStrictEqual(await titles('der pate'), ['The Godfather Trilogy']);
  assert.deepStrictEqual(await titles('il padrno'), ['The Godfather Trilogy']);
});

const tmdbSearch = (query) => new RegExp(`api\\.themoviedb\\.org/3/search/movie\\?.*query=${query}(&|$)`);
const catalogue = async (q) => {
  const res = await app.api('GET', '/api/search', { query: { mediaType: 'movie', q } });
  assert.strictEqual(res.status, 200, res.text);
  return res.json.map((item) => item.title);
};

test('when a catalogue finds nothing, it asks again with the spelling from the library', async () => {
  await add('Interstellar', { tmdbId: 157336 });
  const removers = [
    onRequest(tmdbSearch('intersetllar'), { results: [] }),
    onRequest(tmdbSearch('interstellar'), { results: [{ id: 999001, title: 'Interstellar: Nolan\'s Odyssey' }] }),
  ];
  const found = await catalogue('intersetllar');
  removers.forEach((remove) => remove());
  assert.ok(found.includes('Interstellar'), 'what is already in the library');
  assert.ok(found.includes("Interstellar: Nolan's Odyssey"), 'what the catalogue has under the right spelling');
});

test('then with the suggestion of Wikipedia, if it really is a correction', async () => {
  const before_ = process.env.SEARCH_SPELLCHECK;
  process.env.SEARCH_SPELLCHECK = '1';
  const removers = [
    onRequest(tmdbSearch('brakng'), { results: [] }),
    onRequest(tmdbSearch('nothing.*like.*this'), { results: [] }),
    onRequest(tmdbSearch('breaking'), { results: [{ id: 999002, title: 'Breaking' }] }),
    onRequest(/wikipedia\.org.*list=search.*srsearch=brakng/, { query: { searchinfo: { suggestion: 'breaking' } } }),
    onRequest(/wikipedia\.org.*list=search.*srsearch=nothing/, { query: { searchinfo: { suggestion: 'some other film' } } }),
    onRequest(/wikipedia\.org.*action=opensearch/, ['', []]),
  ];
  const fixed = await catalogue('brakng');
  const notFixed = await catalogue('nothing like this');
  removers.forEach((remove) => remove());
  process.env.SEARCH_SPELLCHECK = before_;
  assert.deepStrictEqual(fixed, ['Breaking']);
  assert.deepStrictEqual(notFixed, []);
});
