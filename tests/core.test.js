const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../core.js');

const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const raw = (n, cardN, rarity = 'C', extra = {}) => ({
  id: uuid(n), card_id: uuid(cardN), starred: false, is_shiny: false,
  card: { id: uuid(cardN), rarity, wikipedia_title: `Carte ${cardN}`, image_url: 'https://img/x.png', wikipedia_url: 'https://fr.wikipedia.org/wiki/X' },
  ...extra
});
const entry = (n, cardN, rarity, extra) => core.parseEntry(raw(n, cardN, rarity, extra));
const prices = map => id => map[id];
const ok = averages => ({ ok: true, averages, fetchedAt: 1 });

test('parseEntry garde les champs utiles et rejette les entrées invalides', () => {
  const parsed = entry(1, 10, 'SR', { starred: true });
  assert.equal(parsed.ownedId, uuid(1));
  assert.equal(parsed.cardId, uuid(10));
  assert.equal(parsed.rarity, 'SR');
  assert.equal(parsed.starred, true);
  assert.equal(parsed.shiny, false);
  assert.equal(core.parseEntry({ ...raw(1, 10), id: 'nope' }), null);
  assert.equal(core.parseEntry(raw(1, 10, 'X')), null);
  assert.equal(core.parseEntry(null), null);
});

test('priceInfo distingue connu, sans moyenne et inconnu', () => {
  assert.deepEqual(core.priceInfo(ok({ C: 4.5 }), 'C'), { state: 'known', value: 4.5 });
  assert.deepEqual(core.priceInfo(ok({ C: 4.5 }), 'R'), { state: 'none', value: 0 });
  assert.deepEqual(core.priceInfo(undefined, 'C'), { state: 'unknown' });
  assert.deepEqual(core.priceInfo({ ok: false, averages: {} }, 'C'), { state: 'unknown' });
  assert.deepEqual(core.priceInfo(ok({ C: 'abc' }), 'C'), { state: 'unknown' });
});

test('protections : favoris, brillantes, échanges et ventes ne sont jamais proposés', () => {
  const protections = core.parseProtections([uuid(11)], [{ card_id: uuid(12) }, { card_id: 'bad' }]);
  const rows = [
    entry(1, 10, 'C'), entry(2, 11, 'C'), entry(3, 12, 'C'),
    entry(4, 13, 'C', { starred: true }), entry(5, 14, 'C', { is_shiny: true }), entry(6, 15, 'C')
  ];
  const { queue, stats } = core.buildQueue(rows, { protections }, prices({}));
  assert.deepEqual(queue.map(e => e.ownedId), [uuid(1), uuid(6)]);
  assert.equal(stats.protectedCount, 4);
});

test('une échange peut protéger un exemplaire précis par son identifiant', () => {
  const protections = core.parseProtections([uuid(2)], []);
  const { queue } = core.buildQueue([entry(1, 10, 'C'), entry(2, 10, 'C')], { protections }, prices({}));
  assert.deepEqual(queue.map(e => e.ownedId), [uuid(1)]);
});

test('skip retire les exemplaires déjà traités', () => {
  const done = new Set([uuid(1)]);
  const { queue, stats } = core.buildQueue([entry(1, 10, 'C'), entry(2, 11, 'C')], { skip: id => done.has(id) }, prices({}));
  assert.deepEqual(queue.map(e => e.ownedId), [uuid(2)]);
  assert.equal(stats.done, 1);
});

test('tri par rareté : communes d’abord, copies d’une même carte côte à côte', () => {
  const rows = [entry(1, 20, 'L'), entry(2, 11, 'C'), entry(3, 12, 'PC'), entry(4, 11, 'C'), entry(5, 10, 'C')];
  const { queue } = core.buildQueue(rows, {}, prices({}));
  assert.deepEqual(queue.map(e => e.rarity), ['C', 'C', 'C', 'PC', 'L']);
  const copies = queue.filter(e => e.cardId === uuid(11)).map(e => queue.indexOf(e));
  assert.equal(copies[1] - copies[0], 1);
});

test('filtre de raretés', () => {
  const rows = [entry(1, 10, 'C'), entry(2, 11, 'R'), entry(3, 12, 'L')];
  const { queue, stats } = core.buildQueue(rows, { rarities: ['R', 'L'] }, prices({}));
  assert.deepEqual(queue.map(e => e.rarity), ['R', 'L']);
  assert.equal(stats.rarity, 1);
});

test('tri par prix : inconnus en dernier dans les deux sens', () => {
  const rows = [entry(1, 10, 'C'), entry(2, 11, 'C'), entry(3, 12, 'C')];
  const map = { [uuid(10)]: ok({ C: 9 }), [uuid(12)]: ok({ C: 2 }) };
  const asc = core.buildQueue(rows, { sort: 'price-asc' }, prices(map)).queue.map(e => e.cardId);
  const desc = core.buildQueue(rows, { sort: 'price-desc' }, prices(map)).queue.map(e => e.cardId);
  assert.deepEqual(asc, [uuid(12), uuid(10), uuid(11)]);
  assert.deepEqual(desc, [uuid(10), uuid(12), uuid(11)]);
});

test('prix max : inconnus exclus, « Moy. — » compte pour 0', () => {
  const rows = [entry(1, 10, 'C'), entry(2, 11, 'C'), entry(3, 12, 'C'), entry(4, 13, 'C')];
  const map = { [uuid(10)]: ok({ C: 3 }), [uuid(11)]: ok({ C: 8 }), [uuid(12)]: ok({}) };
  const { queue, stats } = core.buildQueue(rows, { maxPrice: 5 }, prices(map));
  assert.deepEqual(queue.map(e => e.cardId).sort(), [uuid(10), uuid(12)].sort());
  assert.equal(stats.price, 2);
});

test('tri aléatoire : même contenu, ordre piloté par le générateur', () => {
  const rows = [1, 2, 3, 4, 5].map(n => entry(n, n, 'C'));
  const { queue } = core.buildQueue(rows, { sort: 'random' }, prices({}), () => 0);
  assert.equal(queue.length, 5);
  assert.deepEqual(queue.map(e => e.ownedId).sort(), rows.map(e => e.ownedId).sort());
});

test('mergeProgress : union, et la décision la plus récente l’emporte', () => {
  const item = at => ({ c: uuid(10), t: 'X', r: 'C', at });
  const a = { kept: { [uuid(1)]: item(100), [uuid(2)]: item(300) }, discarded: {} };
  const b = { kept: {}, discarded: { [uuid(1)]: item(200), [uuid(3)]: item(50) } };
  const merged = core.mergeProgress(a, b);
  assert.ok(merged.discarded[uuid(1)] && !merged.kept[uuid(1)]);
  assert.ok(merged.kept[uuid(2)]);
  assert.ok(merged.discarded[uuid(3)]);
});

test('export puis import : aller-retour sans perte', () => {
  const progress = {
    kept: { [uuid(1)]: core.progressItem(entry(1, 10, 'C'), 1000) },
    discarded: { [uuid(2)]: core.progressItem(entry(2, 11, 'R'), 2000) }
  };
  const file = core.exportFile(progress, { [uuid(10)]: ok({ C: 3 }) }, 5);
  const parsed = core.parseImport(JSON.stringify(file));
  assert.deepEqual(parsed.progress, progress);
  assert.equal(parsed.prices[uuid(10)].averages.C, 3);
});

test('import : fichiers étrangers, corrompus ou malveillants', () => {
  assert.throws(() => core.parseImport('pas du json'), /JSON/);
  assert.throws(() => core.parseImport('{"app":"autre"}'), /export Wikinder/);
  assert.throws(() => core.parseImport(JSON.stringify({ app: core.FORMAT, version: 99 })), /Version/);
  const parsed = core.parseImport(JSON.stringify({
    app: core.FORMAT, version: 1,
    kept: { 'pas-un-uuid': { c: uuid(1) }, [uuid(1)]: { c: 'x', t: 'a'.repeat(1000), r: 'ZZ', at: 'bad' } },
    discarded: null, prices: { [uuid(2)]: { averages: { C: 'x', R: 4, ZZ: 1 }, fetchedAt: 7 } }
  }));
  assert.deepEqual(Object.keys(parsed.progress.kept), [uuid(1)]);
  const cleaned = parsed.progress.kept[uuid(1)];
  assert.equal(cleaned.c, null);
  assert.equal(cleaned.t.length, 300);
  assert.equal(cleaned.r, null);
  assert.equal(cleaned.at, 0);
  assert.deepEqual(parsed.prices[uuid(2)].averages, { R: 4 });
});
