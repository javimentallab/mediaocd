'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { letterboxdRating } = require('../build/letterboxd');

test('a rating goes out as stored, from 1 to 5 stars', () => {
  for (const stars of [1, 2, 3, 4, 5]) {
    assert.strictEqual(letterboxdRating(stars), stars);
  }
});

test('half stars are kept', () => {
  for (const stars of [0.5, 2.5, 4.5]) {
    assert.strictEqual(letterboxdRating(stars), stars);
  }
});

test('no rating leaves the cell empty', () => {
  for (const none of [null, undefined, 0]) {
    assert.strictEqual(letterboxdRating(none), '');
  }
});

test('the export uses it instead of scaling the rating', () => {
  const file = path.join(__dirname, '..', 'build', 'controllers', 'item.js');
  const source = fs.readFileSync(file, 'utf8');
  assert.match(source, /letterboxdRating\)\(r\.rating\)/);
  assert.doesNotMatch(source, /r\.rating \/ 2/);
});
