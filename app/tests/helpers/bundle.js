'use strict';

// Reads what the web client really ships. The bundle is minified and has no sources in this
// repository, so these helpers find the pieces by their shape, not by the names the
// minifier gave them, and evaluate only the catalogues and the choice of language: never the
// React application.

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const PUBLIC = path.join(__dirname, '..', '..', 'public');

function bundleSource() {
  const files = fs.readdirSync(PUBLIC).filter((f) => /^main_.*\.js$/.test(f));
  assert.strictEqual(files.length, 1, 'one bundle in app/public');
  return fs.readFileSync(path.join(PUBLIC, files[0]), 'utf8');
}

/**
 * Runs the code of the bundle that builds the catalogues and picks the language, with the
 * browser language and the "UI language" setting given. Returns { catalogues, locale }.
 */
function languageSetup({ browserLanguage = 'en-US', uiLang = null } = {}) {
  const source = bundleSource();
  const open = source.match(/var ([\w$,]+);([\w$]+)=\{da:\{/);
  assert.ok(open, 'the catalogues are in the bundle');
  const start = open.index;
  const load = source.indexOf('.loadLocaleData(', start);
  assert.ok(load > start, 'the bundle loads a language');
  const end = source.lastIndexOf(',', load);
  const locale = source.slice(load).match(/^\.loadLocaleData\([\w$]+\(\{\},([\w$]+),/);
  assert.ok(locale, 'the bundle says which language it loads');

  const context = vm.createContext({
    navigator: { language: browserLanguage },
    localStorage: { getItem: (key) => (key === 'uiLang' ? uiLang : null) },
  });
  const code = `${source.slice(start, end)};JSON.stringify({catalogues:${open[2]},locale:${locale[1]}})`;
  return JSON.parse(vm.runInContext(code, context));
}

/** The label of each kind of media on the button that adds it to the history. */
function historyLabels() {
  const source = bundleSource();
  const first = source.indexOf('{id:"Add to listened history"}');
  assert.ok(first > 0, 'the history button is in the bundle');
  const block = source.slice(source.lastIndexOf('onClick:', first), first + 800);
  const labels = {};
  for (const [, predicate, label] of block.matchAll(/([\w$]+)\(\w+\)&&\w+\.createElement\([\w$]+,\{id:"(Add to [a-z]+ history)"\}\)/g)) {
    const definition = source.match(new RegExp(`[,;\\s]${predicate.replace(/\$/g, '\\$')}=function\\(e\\)\\{return"string"==typeof e\\?"([a-z_]+)"===e`));
    assert.ok(definition, `the predicate of "${label}" says which media it is for`);
    labels[definition[1]] = label;
  }
  return labels;
}

module.exports = { bundleSource, languageSetup, historyLabels };
