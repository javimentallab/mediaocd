'use strict';

// The green icon on the cover replaced the "add to history" button under the covers.

const { test } = require('node:test');
const assert = require('node:assert');
const { bundleSource } = require('./helpers/bundle');

test('"Recently released" on the home page has no button under the covers', () => {
  const source = bundleSource();
  const start = source.indexOf('title:xo._("Recently released")');
  assert.ok(start > 0, 'the section is in the bundle');
  const end = source.indexOf('topBar', start);
  assert.ok(end > start);
  assert.ok(!source.slice(start, end).includes('showMarksAsSeen'));
});
