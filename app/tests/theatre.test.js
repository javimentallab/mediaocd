'use strict';

// "Theatre with serious metadata": Wikidata SPARQL for canonical works, and teatro.es for
// contemporary stagings. Both are simulated, with answers of the shape they really give.

const { after, before, test } = require('node:test');
const assert = require('node:assert');
const { onRequest, startApp } = require('./helpers/app');

let app;
before(async () => { app = await startApp(); });
after(async () => { await app.stop(); });

const sparqlRow = (qid, label, extra = {}) => ({
  item: { value: `http://www.wikidata.org/entity/${qid}` },
  itemLabel: { value: label },
  itemDescription: { value: `obra de teatro ${label}` },
  ...extra,
});
const stagingBlock = (id, title, year, production) => `
  <div class="row collapse result_item_row result_item_row_estrenos odd" data-id="${id}" data-title="${title}">
    <div><span class="results_estrenos_titulo_temporada">Temporada (<span class="value">${year}</span>)</span></div>
    <div class="results_estrenos_produccion"><span class="value">${production}</span></div>
  </div></div></div>`;

function fakeServices() {
  const removers = [
    onRequest('query.wikidata.org/sparql', {
      results: {
        bindings: [
          sparqlRow('Q1046432', 'La casa de Bernarda Alba', {
            inceptionMin: { value: '1936-00-00T00:00:00Z' },
            imageOne: { value: 'http://commons.wikimedia.org/wiki/Special:FilePath/Bernarda%20Alba.jpg' },
            durationOne: { value: '120' },
          }),
          sparqlRow('Q1046432', 'La casa de Bernarda Alba'),
        ],
      },
    }),
    onRequest('www.teatro.es/estrenos-teatro', `<html>
      ${stagingBlock(501, 'La casa de Bernarda Alba', 2005, 'A staging with the same title as the work')}
      ${stagingBlock(502, 'Bernarda &amp; Poncia', 2019, 'Teatro de la Abad&iacute;a')}
      ${stagingBlock(503, 'Bernarda &amp; Poncia', 2015, 'An earlier staging')}
    </html>`),
  ];
  return () => removers.forEach((remove) => remove());
}

test('a search joins the works of Wikidata and the stagings of teatro.es', async () => {
  const remove = fakeServices();
  const res = await app.api('GET', '/api/search', { query: { mediaType: 'theater', q: 'Bernarda' } });
  assert.strictEqual(res.status, 200, res.text);
  remove();
  const byTitle = Object.fromEntries(res.json.map((item) => [item.title, item]));

  assert.deepStrictEqual(Object.keys(byTitle).sort(), ['Bernarda & Poncia', 'La casa de Bernarda Alba']);
  assert.strictEqual(res.json.length, 2, 'the same title only once');

  const work = byTitle['La casa de Bernarda Alba'];
  assert.strictEqual(work.source, 'wikidata');
  assert.strictEqual(work.mediaType, 'theater');
  assert.strictEqual(work.releaseDate.slice(0, 10), '1936-01-01', 'Wikidata gives only the year');

  const staging = byTitle['Bernarda & Poncia'];
  assert.strictEqual(staging.source, 'teatroes');
  assert.strictEqual(staging.releaseDate.slice(0, 10), '2015-01-01', 'the earliest staging of a title');
  assert.strictEqual(staging.overview, 'Producción: An earlier staging');
});

test('a search still answers when one of the two services is down', async () => {
  const remove = [
    onRequest('query.wikidata.org/sparql', { status: 502, body: 'bad gateway' }),
    onRequest('www.teatro.es/estrenos-teatro', `<html>${stagingBlock(601, 'Only on teatro.es', 2020, 'A company')}</html>`),
  ];
  const res = await app.api('GET', '/api/search', { query: { mediaType: 'theater', q: 'Only' } });
  assert.strictEqual(res.status, 200, res.text);
  assert.deepStrictEqual(res.json.map((item) => item.title), ['Only on teatro.es']);
  remove.forEach((r) => r());
});

test('opening a work fills in its author, genre and synopsis', async () => {
  const id = await app.item({ mediaType: 'theater', source: 'wikidata', title: 'Bernarda', tmdbId: 777001, needsDetails: true });
  const remove = [
    onRequest('wikidata.org/wiki/Special:EntityData/Q777001.json', {
      entities: {
        Q777001: {
          labels: { es: { value: 'La casa de Bernarda Alba' } },
          descriptions: { es: { value: 'obra de teatro' } },
          sitelinks: { eswiki: { title: 'La casa de Bernarda Alba' } },
          claims: {
            P577: [{ mainsnak: { datavalue: { value: { time: '+1945-03-08T00:00:00Z' } } } }],
            P50: [{ mainsnak: { datavalue: { value: { id: 'Q1' } } } }],
            P136: [{ mainsnak: { datavalue: { value: { id: 'Q2' } } } }],
          },
        },
      },
    }),
    onRequest('www.wikidata.org/w/api.php', {
      entities: { Q1: { labels: { es: { value: 'Federico García Lorca' } } }, Q2: { labels: { es: { value: 'drama' } } } },
    }),
    onRequest('es.wikipedia.org/api/rest_v1/page/summary/', { extract: 'Última obra de Lorca.' }),
  ];
  const res = await app.api('GET', `/api/details/${id}`);
  remove.forEach((r) => r());
  assert.strictEqual(res.status, 200, res.text);
  assert.strictEqual(res.json.title, 'La casa de Bernarda Alba');
  assert.strictEqual(res.json.releaseDate.slice(0, 10), '1945-03-08');
  assert.strictEqual(res.json.overview, 'Autor: Federico García Lorca\nGéneros: drama\n\nÚltima obra de Lorca.');
});

test('a staging from teatro.es gets its cast and company from the page', async () => {
  // eslint-disable-next-line global-require
  const { TeatroEsTheater } = require('../build/metadata/provider/teatroes');
  const page = `<html><span class="results_detalle_estreno_titulo titolResults">La casa</span>
    <span>Temporada</span>: <span class="value">2019/20</span>
    <span>Producción</span>: <span class="value">Teatro de la Abad&iacute;a</span>
    <span>Ficha artística</span>: <span class="value">Autoría: Lorca. Dirección: Ana Díaz. Intérpretes: Uno, Dos.</span>
    ${' '.repeat(5000)}</html>`;
  const remove = onRequest('www.teatro.es/estrenos-teatro/x-777', page);
  const details = await new TeatroEsTheater().details({ tmdbId: 777, title: 'La casa', needsDetails: true });
  remove();
  assert.strictEqual(details.title, 'La casa');
  assert.strictEqual(details.overview, 'Autor: Lorca\nProducción: Teatro de la Abadía\nDirección: Ana Díaz\n\nIntérpretes: Uno, Dos');
});
