'use strict';

// "16 interface languages ... It follows the browser's language; Settings > Configuration >
// UI language forces one." This runs the code of the bundle that builds the catalogues and
// picks the language.

const { test } = require('node:test');
const assert = require('node:assert');
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

test('the German text of a search closes its tag', { todo: 'BUG: it has <0>...<0> instead of <0>...</0>' }, () => {
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
