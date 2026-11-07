'use strict';

// Removing an item from Pending (or adding it) rewrote every cached section list with
// setQueriesData, also the sections still loading for the first time: those got
// {data: undefined}, the grid read `.length` of nothing and React unmounted the whole page,
// which stayed black in dark mode. The instant-paint copy in localStorage stored that empty
// answer too, so a reload of the same section went black again before asking the server.
// These run the pieces of the bundle that now prevent it.

const { test } = require('node:test');
const assert = require('node:assert');
const vm = require('node:vm');
const { bundleSource } = require('./helpers/bundle');

const source = bundleSource();

function statement(start) {
  const i = source.indexOf(start);
  assert.ok(i >= 0, `the bundle has ${start}`);
  const end = source.indexOf('\n', i);
  return source.slice(i, end);
}

function fakeStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => (k in data ? data[k] : null),
    setItem: (k, v) => { data[k] = String(v); },
    removeItem: (k) => { delete data[k]; },
  };
}

function instantPaint(storage) {
  const context = { window: {}, localStorage: storage, JSON };
  vm.runInNewContext(statement('window._mtIpc='), context);
  return context.window._mtIpc;
}

const ARGS = { orderBy: 'listedAt', sortOrder: 'desc', mediaType: 'movie', onlyOnWatchlist: true, all: true, page: 1 };
const KEY = `mt_ipc:${JSON.stringify(ARGS)}`;

test('a section answer without its list is not kept for the next visit', () => {
  const storage = fakeStorage();
  const ipc = instantPaint(storage);
  ipc.set(ARGS, { data: undefined });
  ipc.set(ARGS, {});
  assert.deepStrictEqual(storage.data, {});
  ipc.set(ARGS, { data: [{ id: 1 }], total: 1, totalPages: 1 });
  assert.deepStrictEqual(ipc.get(ARGS).data, [{ id: 1 }]);
});

test('an empty copy already stored is dropped instead of painted', () => {
  const storage = fakeStorage({ [KEY]: '{}' });
  const ipc = instantPaint(storage);
  assert.strictEqual(ipc.get(ARGS), undefined);
  assert.ok(!(KEY in storage.data), 'the broken copy is removed');
  storage.setItem(KEY, 'not json');
  assert.strictEqual(ipc.get(ARGS), undefined);
});

test('updating the cache after a write leaves the sections still loading alone', () => {
  const context = { window: {} };
  vm.runInNewContext(statement('window._mtPatchCache='), context);
  const queries = [
    { queryKey: ['items', { a: 1 }], state: { data: undefined } },
    { queryKey: ['items', { a: 2 }], state: { data: { data: [{ id: 7, t: 'old' }] } } },
  ];
  const writes = [];
  const qc = {
    getQueryCache: () => ({ findAll: () => queries }),
    setQueryData: (key, value) => writes.push([key, value]),
  };
  context.window._mtPatchCache(qc, ['items'], (e) => ({ ...e, data: e.data.map((x) => ({ ...x, t: 'new' })) }));
  assert.strictEqual(writes.length, 1, 'only the loaded section is written');
  assert.deepStrictEqual(writes[0][0], ['items', { a: 2 }]);
  assert.strictEqual(writes[0][1].data[0].t, 'new');
});

test('no write rewrites every cached list blindly any more', () => {
  assert.strictEqual(source.split('setQueriesData(').length - 1, 0);
  assert.ok(source.includes('0===(A||[]).length'), 'the grid copes with a section without its list');
});

test('a failure while painting a page keeps the app on screen', () => {
  assert.ok(source.includes('/*mediaocd:page-error-boundary*/'));
  assert.ok(source.includes('B.getDerivedStateFromError='), 'the page has an error boundary');
  assert.ok(source.includes('r.createElement(_MtEB,null,r.createElement($,null))'), 'it wraps the routed page, under the menu');
  assert.ok(source.includes('addEventListener("hashchange",this._h)'), 'moving to another section paints again');
});
