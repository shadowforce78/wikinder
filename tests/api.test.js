const test = require('node:test');
const assert = require('node:assert/strict');

// Environnement navigateur minimal pour store.js / api.js.
const disk = {};
globalThis.window = globalThis;
globalThis.addEventListener = () => {};
globalThis.document = { addEventListener() {}, visibilityState: 'visible' };
globalThis.chrome = {
  storage: { local: {
    get: async keys => Object.fromEntries(keys.filter(k => k in disk).map(k => [k, structuredClone(disk[k])])),
    set: async batch => { Object.assign(disk, structuredClone(batch)); }
  } }
};
let routes = [];
const calls = [];
globalThis.fetch = async (url, options = {}) => {
  const method = options.method || 'GET';
  calls.push(`${method} ${url}`);
  const route = routes.find(r => r.method === method && r.match.test(url));
  const reply = route ? (typeof route.reply === 'function' ? route.reply(url) : route.reply) : { status: 500, body: {} };
  return { ok: reply.status < 400, status: reply.status, json: async () => reply.body ?? null, headers: { get: name => reply.headers?.[name] ?? null } };
};
const on = (method, match, reply) => routes.unshift({ method, match, reply });

require('../core.js');
require('../store.js');
require('../api.js');
const W = globalThis.Wikinder;
const { core, store, api } = W;

const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const rawEntry = (n, cardN, rarity = 'C') => ({
  id: uuid(n), card_id: uuid(cardN), starred: false, is_shiny: false,
  card: { id: uuid(cardN), rarity, wikipedia_title: `Carte ${cardN}`, image_url: null, wikipedia_url: null }
});
const entry = (n, cardN, rarity) => core.parseEntry(rawEntry(n, cardN, rarity));

function reset() {
  routes = []; calls.length = 0;
  store.state.progress = core.emptyProgress(); store.state.pending = {}; store.state.prices = {};
}
const queue = (extra = {}) => {
  const log = { blocked: [], changes: 0 };
  const q = new api.DiscardQueue({
    grace: 0, onChange: () => { log.changes++; }, checkBlocked: async () => null, onBlocked: (item, reason) => log.blocked.push([item.t, reason]), ...extra
  });
  return { q, log };
};

test('suppression : envoyée en arrière-plan puis enregistrée comme supprimée', async () => {
  reset();
  on('POST', /\/discard$/, { status: 200, body: { ok: true } });
  const { q } = queue();
  q.add(entry(1, 10)); q.add(entry(2, 11));
  assert.equal(q.count, 2);
  await q.run();
  assert.equal(q.count, 0);
  assert.deepEqual(Object.keys(store.state.progress.discarded).sort(), [uuid(1), uuid(2)]);
  assert.deepEqual(calls, [`POST /api/user-cards/${uuid(1)}/discard`, `POST /api/user-cards/${uuid(2)}/discard`]);
});

test('suppression : un 404 (déjà supprimée) compte comme fait', async () => {
  reset();
  on('POST', /\/discard$/, { status: 404, body: { error: 'not found' } });
  const { q } = queue();
  q.add(entry(1, 10));
  await q.run();
  assert.equal(q.count, 0);
  assert.ok(store.state.progress.discarded[uuid(1)]);
});

test('suppression : 429 met en pause sans rien marquer comme supprimé', async () => {
  reset();
  on('POST', /\/discard$/, { status: 429, body: {}, headers: { 'Retry-After': '5' } });
  const { q } = queue();
  q.add(entry(1, 10)); q.add(entry(2, 11));
  await q.run();
  assert.equal(q.count, 2);
  assert.equal(calls.length, 1, 'plus aucun envoi après la limite');
  assert.ok(q.paused);
  assert.deepEqual(store.state.progress.discarded, {});
  clearTimeout(q.timer);
});

test('suppression : erreur serveur = nouvel essai plus tard, pas de perte', async () => {
  reset();
  on('POST', /\/discard$/, { status: 500, body: {} });
  const { q } = queue();
  q.add(entry(1, 10));
  await q.run();
  const item = store.state.pending[uuid(1)];
  assert.equal(item.tries, 1);
  assert.ok(item.retryAt > Date.now());
  assert.equal(item.error, 'HTTP 500');
  assert.deepEqual(store.state.progress.discarded, {});
  clearTimeout(q.timer);
});

test('suppression : annulable avant l’envoi, pas pendant', async () => {
  reset();
  const { q } = queue({ grace: 60000 });
  q.add(entry(1, 10));
  assert.equal(q.cancel(uuid(1)), true);
  assert.equal(q.count, 0);
  assert.equal(calls.length, 0);
  clearTimeout(q.timer);

  let release;
  on('POST', /\/discard$/, () => ({ status: 200, body: {} }));
  const gate = new Promise(resolve => { release = resolve; });
  const second = queue({ checkBlocked: async () => { await gate; return null; } }).q;
  second.add(entry(2, 11));
  const running = second.run();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(second.cancel(uuid(2)), false, 'déjà en cours d’envoi');
  release(); await running;
  assert.ok(store.state.progress.discarded[uuid(2)]);
});

test('suppression : une carte devenue protégée n’est jamais envoyée', async () => {
  reset();
  on('POST', /\/discard$/, { status: 200, body: {} });
  const { q, log } = queue({ checkBlocked: async () => 'sale' });
  q.add(entry(1, 10));
  await q.run();
  assert.equal(calls.length, 0);
  assert.equal(q.count, 0);
  assert.deepEqual(store.state.progress.discarded, {});
  assert.deepEqual(log.blocked, [['Carte 10', 'sale']]);
});

test('suppression : reprise des éléments persistés d’une session précédente', async () => {
  reset();
  on('POST', /\/discard$/, { status: 200, body: {} });
  store.state.pending = { [uuid(7)]: { c: uuid(70), t: 'Ancienne', r: 'C', at: 1, tries: 0, retryAt: 0 } };
  const { q } = queue();
  await q.run();
  assert.ok(store.state.progress.discarded[uuid(7)]);
});

test('collection : pagination complète, entrées illisibles ignorées, protections lues', async () => {
  reset();
  const page = n => Array.from({ length: 50 }, (_, i) => rawEntry(n * 50 + i + 1, 1000 + n * 50 + i));
  const pages = [page(0), page(1), [rawEntry(101, 2000), { id: 'cassé' }]];
  on('GET', /\/api\/my-collection\?/, url => {
    const n = Number(new URL(url, 'https://x').searchParams.get('page'));
    return { status: 200, body: { collection: pages[n] || [], total: 102, pendingTradeCardIds: [uuid(1000)] } };
  });
  on('GET', /\/api\/marketplace\?/, { status: 200, body: { selling: [{ card_id: uuid(1001) }] } });
  const progress = [];
  const result = await api.fetchCollection((done, total) => progress.push([done, total]));
  assert.equal(result.entries.length, 101);
  assert.equal(result.invalid, 1);
  assert.deepEqual(progress.at(-1), [102, 102]);
  assert.deepEqual(result.protections.tradeIds, [uuid(1000)]);
  assert.deepEqual(result.protections.saleIds, [uuid(1001)]);
});

test('prix : moyenne par rareté enregistrée, la carte prioritaire passe d’abord', async () => {
  reset();
  const order = [];
  on('GET', /\/sales\?scope=summary$/, url => {
    order.push(url.match(/cards\/([^/]+)\//)[1]);
    return { status: 200, body: { summary: { C: { average: 4.5 }, R: { average: null } } } };
  });
  const loader = new api.PriceLoader(() => {});
  loader.setOrder([uuid(1), uuid(2), uuid(3)], 2);
  await new Promise(resolve => setTimeout(resolve, 1500));
  assert.equal(order[0], uuid(3));
  assert.equal(store.state.prices[uuid(1)].averages.C, 4.5);
  assert.equal('R' in store.state.prices[uuid(1)].averages, false);
  assert.equal(Object.keys(store.state.prices).length, 3);
});

test('prix : limite du site (automation_limit) = pause générale', async () => {
  reset();
  on('GET', /\/sales\?scope=summary$/, { status: 429, body: { code: 'automation_limit' } });
  const loader = new api.PriceLoader(() => {});
  loader.setOrder([uuid(1), uuid(2), uuid(3), uuid(4)]);
  await new Promise(resolve => setTimeout(resolve, 800));
  assert.ok(loader.paused);
  assert.equal(loader.pauseLabel, 'Limite du site');
  assert.ok(calls.length <= 2, `trop de requêtes pendant la pause : ${calls.length}`);
  loader.order = [];
});
