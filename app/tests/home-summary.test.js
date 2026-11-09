'use strict';

// The summary on the home page: two columns with fixed places, so that a category with no
// data leaves its place empty instead of moving the others to another column.

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { bundleSource } = require('./helpers/bundle');

const PUBLIC = path.join(__dirname, '..', 'public');
const css = fs.readFileSync(path.join(PUBLIC, fs.readdirSync(PUBLIC).find((f) => /^main_.*\.css$/.test(f))), 'utf8');

const PLACES = {
  tv: [1, 1], game: [1, 2], theater: [1, 3], movie: [2, 1], book: [2, 2], youtube: [2, 3],
};

test('every category has its column and row', () => {
  const source = bundleSource();
  for (const [name, [column, row]] of Object.entries(PLACES)) {
    assert.strictEqual(source.split(`mb-6 mr-6 mt-hs-${name}"`).length - 1, 1, name);
    assert.ok(css.includes(`.mt-hs-${name}{grid-column:${column};grid-row:${row}}`), name);
  }
});

test('the rating dialog fits on a phone', () => {
  assert.ok(bundleSource().includes('min-w-max w-96 mt-rate-dlg"'));
  assert.ok(css.includes('.mt-rate-dlg{min-width:0!important;width:calc(100vw - 2rem)!important}'));
});

test('the summary is a grid of two columns', () => {
  assert.ok(css.includes('.mt-home-stats{display:grid!important;grid-template-columns:repeat(2,'));
});
