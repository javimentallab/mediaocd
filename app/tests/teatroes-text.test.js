'use strict';

// Text taken from the HTML of teatro.es.

const { test } = require('node:test');
const assert = require('node:assert');
const { _decodeEntities } = require('../build/metadata/provider/teatroes');

test('an escaped entity is decoded only once', () => {
  assert.strictEqual(_decodeEntities('Bernarda &amp;lt;Poncia&amp;gt;'), 'Bernarda &lt;Poncia&gt;');
  assert.strictEqual(_decodeEntities('Bernarda &amp; Poncia &lt;2019&gt;'), 'Bernarda & Poncia <2019>');
  assert.strictEqual(_decodeEntities('Teatro de la Abad&iacute;a'), 'Teatro de la Abadía');
});
