'use strict';

// "16 interface languages ... It follows the browser's language; Settings > Configuration >
// UI language forces one." This runs the code of the bundle that builds the catalogues and
// picks the language.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { bundleSource, languageSetup } = require('./helpers/bundle');

const LANGUAGES = ['da', 'de', 'en', 'es', 'fr', 'hi', 'it', 'ja', 'ko', 'nl', 'pl', 'pt', 'ru', 'th', 'uk', 'zh'];
const { catalogues } = languageSetup();
const STAR = '{count, plural, one {# star} other {# stars}}';

test('the sixteen languages of the README are there', () => {
  assert.deepStrictEqual(Object.keys(catalogues).sort(), LANGUAGES);
});

test('no language misses a text', () => {
  const all = new Set(LANGUAGES.flatMap((language) => Object.keys(catalogues[language])));
  for (const language of LANGUAGES) {
    const missing = [...all].filter((key) => !(key in catalogues[language]));
    assert.deepStrictEqual(missing, [], `missing in ${language}`);
  }
});

// {name}, {0} and the <0> tags: a translation that loses one breaks the text on the screen.
function placeholders(value) {
  const found = [];
  const walk = (node) => {
    if (typeof node === 'string') {
      for (const [tag] of node.matchAll(/<\/?\d+\/?>/g)) found.push(tag);
    } else if (Array.isArray(node)) {
      if (node.length === 1 && typeof node[0] === 'string') found.push(`{${node[0]}}`);
      else node.forEach(walk);
    }
  };
  walk(value);
  return found.sort().join(' ');
}
const isPlural = (value) => Array.isArray(value) && Array.isArray(value[0]) && value[0][1] === 'plural';

function wrongPlaceholders() {
  const wrong = [];
  for (const language of LANGUAGES) {
    for (const [key, english] of Object.entries(catalogues.en)) {
      const translated = catalogues[language][key];
      if (isPlural(english) && isPlural(translated)) {
        if (english[0][0] !== translated[0][0]) wrong.push(`${language}: ${key}`);
        // Each form against the same form in English, or "other" if English does not have it.
        for (const [rule, form] of Object.entries(translated[0][2])) {
          const model = english[0][2][rule] || english[0][2].other;
          if (placeholders(model) !== placeholders(form)) wrong.push(`${language}/${rule}: ${key}`);
        }
      } else if (Array.isArray(english) && placeholders(english) !== placeholders(translated)) {
        // A plain text has no placeholders and can be reworded freely.
        wrong.push(`${language}: ${key}`);
      }
    }
  }
  return wrong;
}
const GERMAN_TAG = 'de/one: {0, plural, one { Found # item for query "<0>{searchQuery}</0>"} other { Found # items for query "<1>{searchQuery}</1>"}}';

test('the placeholders of every text match those of English', () => {
  assert.deepStrictEqual(wrongPlaceholders().filter((entry) => entry !== GERMAN_TAG), []);
});

test('the German text of a search closes its tag', () => {
  assert.ok(!wrongPlaceholders().includes(GERMAN_TAG));
});

test('every plural has the "other" form that lingui falls back to', () => {
  const wrong = [];
  for (const language of LANGUAGES) {
    for (const [key, value] of Object.entries(catalogues[language])) {
      if (isPlural(value) && !('other' in value[0][2])) wrong.push(`${language}: ${key}`);
    }
  }
  assert.deepStrictEqual(wrong, []);
});

test('the texts that used to stay in English are translated', () => {
  const samples = ['Where to watch', 'Release date', 'Remove from watchlist', 'Seen history'];
  for (const language of LANGUAGES.filter((l) => l !== 'en')) {
    for (const key of samples) {
      assert.notStrictEqual(catalogues[language][key], key, `${key} in ${language}`);
    }
  }
});

test('the tooltip of the rating stars comes from the catalogues, in the right plural', () => {
  const render = (language, n) => {
    const [[, , rules]] = catalogues[language][STAR];
    const message = rules[new Intl.PluralRules(language).select(n)];
    return (Array.isArray(message) ? message.join('') : message).replace('#', String(n));
  };
  assert.strictEqual(render('en', 1), '1 star');
  assert.strictEqual(render('es', 5), '5 estrellas');
  assert.strictEqual(render('pl', 2), '2 gwiazdki');
  assert.strictEqual(render('pl', 5), '5 gwiazdek');
  assert.strictEqual(render('ru', 5), '5 звёзд');
  assert.strictEqual(bundleSource().includes('" estrella":" estrellas"'), false, 'no longer fixed in Spanish');
});

// Texts that were written in Spanish in the code of the bundle, so they came out in Spanish in
// every language. The catalogues, which are not code, hold them too, and there they are right.
const FIXED_IN_SPANISH = [
  'Aplicado', 'Episodio actual:', 'Normal: ', 'Completo: ', ' votos', '(estim.)', 'Streaming', 'Gratis', 'Alquiler', 'Compra',
  'Subiendo...', 'Subido OK (', 'Error desconocido', 'Importando ', ') · Ratings: +', 'Eliminados ', ' items', 'Modo oscuro', 'Modo claro',
  'Buscando duplicados...', 'Duplicados', 'Duplicados (', ' grupos)',
  'Items con mismo título+año+tipo pero IDs externos distintos. Pulsa el ítem que quieras conservar; los demás se fusionan en él.',
  'Guardando...', 'Importados: ', ' | Saltados: ', ' | Total revisados: ', 'Conectado a ', 'desconocido', 'No configurado',
  ' — importados: ', ', saltados: ', 'Sincronizando...', 'Sincronizar ahora', ', total ',
  '¿Desvincular tu cuenta de YouTube? Los canales ya añadidos se quedan; solo se borra el token de acceso.',
  'youtube.com/@canal o UC...', 'Consultando IGDB...', 'Total: ', ' · actualizados: ', ' · fallidos: ',
  'Importados desde Jellyfin: ', ' items · nuevos: ', 'Jugando', ' juegos) ', ' jugando', 'Duraciones actualizadas: ', ' episodios',
  'Cargar duraciones desde TMDB', 'Error: ',
];

function bundleCode() {
  const source = bundleSource();
  const open = source.match(/var [\w$,]+;[\w$]+=\{da:\{/);
  assert.ok(open, 'the catalogues are in the bundle');
  return source.slice(0, open.index) + source.slice(source.indexOf('.loadLocaleData(', open.index));
}

// A literal as the minifier may have written it: with its accents, or as \uXXXX.
function asLiterals(text) {
  const plain = JSON.stringify(text);
  const escaped = plain.replace(/[\u0080-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return [plain, escaped, `'${text}'`, `\`${text}\``];
}

// Some keys are written as the Spanish was ("Total: "): those count as translated, not as fixed.
function isFixed(code, literal) {
  for (let i = code.indexOf(literal); i >= 0; i = code.indexOf(literal, i + 1)) {
    if (code.slice(Math.max(0, i - 5), i) !== 'xo._(') return true;
  }
  return false;
}

test('the texts that used to be fixed in Spanish come from the catalogues', () => {
  const code = bundleCode();
  assert.deepStrictEqual(FIXED_IN_SPANISH.filter((text) => asLiterals(text).some((literal) => isFixed(code, literal))), []);
});

test('those texts keep their Spanish wording, and only Spanish shows it', () => {
  const texts = {
    'Not configured': 'No configurado',
    'Load durations from TMDB': 'Cargar duraciones desde TMDB',
    'Saving...': 'Guardando...',
    'Syncing...': 'Sincronizando...',
    'Sync now': 'Sincronizar ahora',
    'Dark mode': 'Modo oscuro',
    'Uploading...': 'Subiendo...',
    'Unknown error': 'Error desconocido',
    'Searching for duplicates...': 'Buscando duplicados...',
    'Querying IGDB...': 'Consultando IGDB...',
    Playing: 'Jugando',
    'Current episode:': 'Episodio actual:',
  };
  for (const [key, spanish] of Object.entries(texts)) {
    assert.strictEqual(catalogues.es[key], spanish);
    for (const language of LANGUAGES.filter((l) => l !== 'es')) {
      assert.notStrictEqual(catalogues[language][key], spanish, `${key} in ${language}`);
    }
  }
  assert.deepStrictEqual(catalogues.es['Connected to {name}'], ['Conectado a ', ['name']]);
  assert.strictEqual(catalogues.en['Dupes desc page'].startsWith('Items with the same'), true);
  assert.strictEqual(catalogues.en['Unlink YouTube confirm'].startsWith('Unlink your YouTube'), true);
});

test('what they count takes the right plural', () => {
  const render = (language, key, n) => {
    const [[, , rules]] = catalogues[language][key];
    const message = rules[new Intl.PluralRules(language).select(n)] || rules.other;
    return (Array.isArray(message) ? message.join('') : message).replace('#', String(n));
  };
  const groups = '{count, plural, one {Duplicates (# group)} other {Duplicates (# groups)}}';
  assert.strictEqual(render('es', groups, 1), 'Duplicados (1 grupo)');
  assert.strictEqual(render('es', groups, 5), 'Duplicados (5 grupos)');
  assert.strictEqual(render('pl', groups, 2), 'Duplikaty (2 grupy)');
  assert.strictEqual(render('pl', groups, 5), 'Duplikaty (5 grup)');
  assert.strictEqual(render('ru', groups, 5), 'Дубликаты (5 групп)');
  const durations = '{count, plural, one {Durations updated: # episode} other {Durations updated: # episodes}}';
  assert.strictEqual(render('es', durations, 5), 'Duraciones actualizadas: 5 episodios');
  assert.strictEqual(render('en', durations, 1), 'Durations updated: 1 episode');
  const imported = '{count, plural, one {Imported from Jellyfin: # item} other {Imported from Jellyfin: # items}}';
  assert.strictEqual(render('es', imported, 3), 'Importados desde Jellyfin: 3 items');
  const deleted = '{count, plural, one {Deleted # item} other {Deleted # items}}';
  assert.strictEqual(render('es', deleted, 2), 'Eliminados 2 items');
  assert.strictEqual(render('ru', deleted, 21), 'Удалён 21 элемент');
  const votes = '{count, plural, one {# vote} other {# votes}}';
  assert.strictEqual(render('es', votes, 5), '5 votos');
  assert.strictEqual(render('uk', votes, 3), '3 голоси');
  const games = '{count, plural, one {game} other {games}}';
  assert.strictEqual(render('es', games, 1), 'juego');
  assert.strictEqual(render('es', games, 5), 'juegos');
});

test('dates and scores follow the language instead of being fixed in Spanish', () => {
  const code = bundleCode();
  assert.doesNotMatch(code, /toLocale(?:Date|Time)?String\("es/);
  assert.strictEqual(code.includes('.replace(".",",")'), false);
});

test('the restore screen warns that an invalid copy is set aside', () => {
  // In the description of the row and in the message after the upload.
  assert.strictEqual(bundleCode().split('xo._("Restore invalid desc")').length - 1, 2);
  const server = fs.readFileSync(path.join(__dirname, '..', 'build', 'restoreUploadedBackup.js'), 'utf8');
  assert.ok(server.includes('.rejected-'), 'the name the text gives is the name the server uses');
  for (const language of LANGUAGES) {
    assert.ok(catalogues[language]['Restore invalid desc'].includes('data.db.uploaded.rejected-*'), language);
  }
});

test('the language follows the browser', () => {
  assert.strictEqual(languageSetup({ browserLanguage: 'pl-PL' }).locale, 'pl');
  assert.strictEqual(languageSetup({ browserLanguage: 'zh-CN' }).locale, 'zh');
  assert.strictEqual(languageSetup({ browserLanguage: 'es' }).locale, 'es');
});

test('a browser in any other language gets English', () => {
  assert.strictEqual(languageSetup({ browserLanguage: 'sv-SE' }).locale, 'en');
});

test('the UI language setting wins over the browser, unless it is not a language we have', () => {
  assert.strictEqual(languageSetup({ browserLanguage: 'en-US', uiLang: 'ja' }).locale, 'ja');
  assert.strictEqual(languageSetup({ browserLanguage: 'de-DE', uiLang: 'xx' }).locale, 'de');
});
