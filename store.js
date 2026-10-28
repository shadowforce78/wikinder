// Persistance dans chrome.storage.local : progression, prix, collection, réglages, suppressions en attente.
(() => {
  const W = globalThis.Wikinder;
  const KEYS = {
    progress: 'wikinder_progress_v1',
    prices: 'wikinder_prices_v1',
    collection: 'wikinder_collection_v1',
    settings: 'wikinder_settings_v1',
    pending: 'wikinder_pending_v1'
  };
  const DEFAULT_SETTINGS = { sort: 'rarity', rarities: [...W.core.RARITIES], maxPrice: null };
  const WRITE_DELAY = 400;

  const state = {
    progress: W.core.emptyProgress(),
    prices: {},
    collection: { fetchedAt: 0, entries: [], protections: { tradeIds: [], saleIds: [] } },
    settings: { ...DEFAULT_SETTINGS },
    // Suppressions décidées mais pas encore confirmées par le site : { ownedId: { c, t, r, at, tries, error } }
    pending: {}
  };
  const dirty = new Set();
  let timer = null;

  async function load() {
    const saved = await chrome.storage.local.get(Object.values(KEYS));
    const progress = saved[KEYS.progress];
    state.progress = { kept: progress?.kept || {}, discarded: progress?.discarded || {} };
    state.prices = W.core.cleanPrices(saved[KEYS.prices]);
    const collection = saved[KEYS.collection];
    if (Array.isArray(collection?.entries)) {
      state.collection = {
        fetchedAt: Number(collection.fetchedAt) || 0,
        entries: collection.entries,
        protections: collection.protections || { tradeIds: [], saleIds: [] }
      };
    }
    state.settings = { ...DEFAULT_SETTINGS, ...(saved[KEYS.settings] || {}) };
    state.pending = saved[KEYS.pending] && typeof saved[KEYS.pending] === 'object' ? saved[KEYS.pending] : {};
    return state;
  }

  function flush() {
    clearTimeout(timer); timer = null;
    if (!dirty.size) return Promise.resolve();
    const batch = {};
    for (const name of dirty) batch[KEYS[name]] = state[name];
    dirty.clear();
    return chrome.storage.local.set(batch).catch(error => console.error('[Wikinder] écriture impossible', error));
  }

  // Écriture différée : un balayage rapide de cartes ne réécrit pas tout le stockage à chaque geste.
  function touch(name) {
    dirty.add(name);
    if (!timer) timer = setTimeout(flush, WRITE_DELAY);
  }

  window.addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flush(); });

  W.store = { state, load, touch, flush, KEYS };
})();
