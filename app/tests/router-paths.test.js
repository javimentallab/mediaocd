'use strict';

// CVE-2025-68470 and CVE-2026-53669: a path with doubled or mixed slashes could send the browser
// to another site. The bundle carries react-router 6.3.0, and upgrading needs React 18, so it has
// the normalisation of the upstream fix by hand. This runs its code against those paths.

const { test } = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');
const { bundleSource } = require('./helpers/bundle');

const BASE = 'https://app.example/';
const source = bundleSource();

// The function of the bundle that every navigate() and <Link> goes through, with its helper.
function resolveTo() {
  const start = source.indexOf('function _samePath(e)');
  assert.ok(start >= 0, 'the bundle keeps the fix');
  const zStart = source.indexOf('function z(e,t,n){let r,a="string"==typeof e?w(e):e', start);
  assert.ok(zStart >= 0, 'the fix sits right before the function that resolves paths');
  const zEnd = source.indexOf('function O(e,t){if("/"===t)return e', zStart);
  assert.ok(zEnd > zStart);
  const parsePath = (path) => {
    const out = {};
    let rest = path;
    const hash = rest.indexOf('#');
    if (hash >= 0) { out.hash = rest.slice(hash); rest = rest.slice(0, hash); }
    const search = rest.indexOf('?');
    if (search >= 0) { out.search = rest.slice(search); rest = rest.slice(0, search); }
    if (rest) out.pathname = rest;
    return out;
  };
  const context = { w: parsePath, _: (s) => s, F: (s) => s };
  vm.runInNewContext(`${source.slice(start, zEnd)};this.z=z;`, context);
  return (to, from = '/') => context.z(to, [from], from);
}

test('no path goes to another site, whichever way the slashes are written', () => {
  const resolve = resolveTo();
  for (const attack of [
    '//evil.example',
    '//evil.example/x',
    '///evil.example/x',
    '/\\evil.example',
    '\\/evil.example',
    '\\\\evil.example',
    '/\\/evil.example',
    '\\\\\\evil.example/x',
  ]) {
    const { pathname } = resolve(attack);
    assert.strictEqual(new URL(pathname, BASE).host, 'app.example', `${attack} -> ${pathname}`);
    assert.ok(!/^[\\/]{2}/.test(pathname), `${attack} -> ${pathname}`);
  }
});

test('the same from a page whose own address carries the trick', () => {
  const resolve = resolveTo();
  const { pathname } = resolve('next', '//evil.example/page');
  assert.strictEqual(new URL(pathname, BASE).host, 'app.example', pathname);
});

test('normal paths stay as they were', () => {
  const resolve = resolveTo();
  assert.strictEqual(resolve('/details/12').pathname, '/details/12');
  assert.strictEqual(resolve('/library-search/a%2F%2Fb').pathname, '/library-search/a%2F%2Fb');
  assert.strictEqual(resolve('/').pathname, '/');
  assert.deepStrictEqual(
    { ...resolve('/movies?orderBy=title&url=https://x.example#top') },
    { pathname: '/movies', search: '?orderBy=title&url=https://x.example', hash: '#top' },
  );
});
