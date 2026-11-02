'use strict';

// "External scores on the details page": FilmAffinity for movies and shows, Metacritic for
// games, cached server-side. Wikidata, FilmAffinity and Metacritic are simulated.

const { after, before, test } = require('node:test');
const assert = require('node:assert');
const { calls, onRequest, startApp } = require('./helpers/app');

let app;
before(async () => { app = await startApp(); });
after(async () => { await app.stop(); });

const filmaffinity = (mediaItemId) => app.api('GET', '/api/filmaffinity', { query: { mediaItemId } });
const metacritic = (mediaItemId) => app.api('GET', '/api/metacritic', { query: { mediaItemId } });
const moviePage = (title, rating, votes) => `<html>
  <meta property="og:title" content="${title}">
  <div id="movie-rat-avg" itemprop="ratingValue" content="${rating}">${rating}</div>
  <meta itemprop="ratingCount" content="${votes}">
</html>`;
const wikidataWithFilm = (filmId) => (url) => (url.includes('action=wbgetentities')
  ? { entities: { Q9: { claims: { P480: [{ mainsnak: { datavalue: { value: filmId } } }] } } } }
  : { query: { search: [{ title: 'Q9' }] } });
const game = (title, year, score, slug = 'a-game') => ({
  typeId: 13, slug, title, premiereYear: year, criticScoreSummary: { score },
});
const metacriticSearch = 'backend.metacritic.com/finder/metacritic/search/';

test('a movie gets its FilmAffinity score through its IMDb id, and it stays cached', async () => {
  const removers = [
    onRequest('www.wikidata.org/w/api.php', wikidataWithFilm('123456')),
    onRequest('www.filmaffinity.com/es/film123456.html', moviePage('A movie (2001)', 7.4, 1234)),
  ];
  const id = await app.item({ title: 'A movie', imdbId: 'tt0000001', releaseDate: '2001-01-01' });
  const res = await filmaffinity(id);
  assert.strictEqual(res.status, 200, res.text);
  assert.deepStrictEqual(res.json, {
    found: true,
    id: '123456',
    url: 'https://www.filmaffinity.com/es/film123456.html',
    rating: 7.4,
    votes: 1234,
    title: 'A movie (2001)',
  });

  const before = calls.length;
  removers.forEach((remove) => remove());
  assert.deepStrictEqual((await filmaffinity(id)).json.rating, 7.4);
  assert.strictEqual(calls.length, before, 'the second time asks nobody');
});

test('without an id in Wikidata, the search of FilmAffinity decides only if it is unambiguous', async () => {
  const removers = [
    onRequest('www.wikidata.org/w/api.php', { query: { search: [] } }),
    onRequest('www.filmaffinity.com/es/search.php', `
      <div data-movie-id="111"><span class="mc-year">1990</span> mc-director</div>
      <div data-movie-id="222"><span class="mc-year">2005</span> mc-director</div>`),
    onRequest('www.filmaffinity.com/es/film222.html', moviePage('Found by search (2005)', 6.1, 50)),
  ];
  const id = await app.item({ title: 'Found by search', tmdbId: 8001, releaseDate: '2005-06-01' });
  const res = await filmaffinity(id);
  removers.forEach((remove) => remove());
  assert.deepStrictEqual([res.json.found, res.json.id, res.json.rating], [true, '222', 6.1]);
});

test('FilmAffinity scores are only for movies and shows', async () => {
  const id = await app.item({ title: 'A game', mediaType: 'video_game' });
  assert.deepStrictEqual((await filmaffinity(id)).json, { found: false });
  assert.strictEqual((await filmaffinity(999999)).status, 404);
  assert.strictEqual((await filmaffinity('nonsense')).status, 400);
});

test('when Cloudflare stops FilmAffinity, the answer says so and nothing is saved as a score', async () => {
  const removers = [
    onRequest('www.wikidata.org/w/api.php', wikidataWithFilm('333')),
    onRequest('www.filmaffinity.com/es/film333.html', { status: 403, body: '<title>Just a moment...</title>' }),
  ];
  const id = await app.item({ title: 'Blocked', tmdbId: 8002, releaseDate: '2010-01-01' });
  const res = await filmaffinity(id);
  removers.forEach((remove) => remove());
  assert.strictEqual(res.json.found, false);
  assert.match(res.json.error, /cloudflare/);
});

test('a game gets its Metascore, and it stays cached', async () => {
  const remove = onRequest(metacriticSearch, { data: { items: [game('A great game', 2015, 87.4, 'a-great-game')] } });
  const id = await app.item({ title: 'A great game', mediaType: 'video_game', igdbId: 1, releaseDate: '2015-05-05' });
  const res = await metacritic(id);
  assert.strictEqual(res.status, 200, res.text);
  assert.deepStrictEqual(res.json, {
    found: true,
    url: 'https://www.metacritic.com/game/a-great-game/',
    score: 87,
    title: 'A great game',
    year: 2015,
  });
  const before = calls.length;
  remove();
  assert.strictEqual((await metacritic(id)).json.score, 87);
  assert.strictEqual(calls.length, before, 'the second time asks nobody');
});

test('titles match despite roman numerals, accents and punctuation, and only at the right date', async () => {
  const remove = onRequest(metacriticSearch, {
    data: {
      items: [
        game('Pokémon: Final Quest VII', 1997, 92, 'old'),
        game('Pokemon Final Quest 7', 2020, 80, 'remake'),
        game('A different game', 2020, 10, 'different'),
      ],
    },
  });
  const remake = await app.item({ title: 'Pokémon Final Quest VII', mediaType: 'video_game', igdbId: 2, releaseDate: '2020-04-10' });
  assert.strictEqual((await metacritic(remake)).json.score, 80);

  const tooFar = await app.item({ title: 'Pokemon Final Quest 7', mediaType: 'video_game', igdbId: 3, releaseDate: '2010-01-01' });
  assert.deepStrictEqual((await metacritic(tooFar)).json, { found: false });
  remove();
});

test('Metacritic scores are only for games', async () => {
  const id = await app.item({ title: 'A movie', mediaType: 'movie' });
  assert.deepStrictEqual((await metacritic(id)).json, { found: false });
});

test('if Metacritic rotates its key, it is read again from the web page', async () => {
  const asked = [];
  const removers = [
    onRequest(metacriticSearch, (url) => {
      asked.push(url);
      return url.includes('apiKey=newkey0123456789abcd')
        ? { data: { items: [game('Key rotated', 2018, 70, 'key-rotated')] } }
        : { status: 401, body: 'unauthorized' };
    }),
    onRequest('www.metacritic.com/game/', '<script>var u="x?apiKey=newkey0123456789abcd&y=1"</script>'),
  ];
  const id = await app.item({ title: 'Key rotated', mediaType: 'video_game', igdbId: 4, releaseDate: '2018-02-02' });
  const res = await metacritic(id);
  removers.forEach((remove) => remove());
  assert.strictEqual(res.json.score, 70);
  assert.strictEqual(asked.length, 2);
});
