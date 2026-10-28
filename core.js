// Logique pure de Wikinder (aucun accès DOM / réseau / stockage) : testable avec Node.
(() => {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  // Du moins rare au plus rare : l'ordre de tri « Rareté » commence par les communes.
  const RARITIES = ['C', 'PC', 'R', 'SR', 'UR', 'L'];
  const SORTS = ['rarity', 'price-asc', 'price-desc', 'title', 'random'];
  const FORMAT = 'wikinder-progress';
  const FORMAT_VERSION = 1;

  const rarityIndex = rarity => RARITIES.indexOf(rarity);

  // Un exemplaire possédé (entrée de /api/my-collection) -> ligne compacte, ou null si inutilisable.
  function parseEntry(raw) {
    const card = raw?.card;
    const cardId = raw?.card_id || card?.id;
    if (!UUID.test(raw?.id) || !UUID.test(cardId) || !RARITIES.includes(card?.rarity)) return null;
    return {
      ownedId: raw.id,
      cardId,
      title: String(card.wikipedia_title || cardId),
      rarity: card.rarity,
      imageUrl: card.image_url || null,
      wikipediaUrl: card.wikipedia_url || null,
      starred: raw.starred === true,
      shiny: raw.is_shiny === true
    };
  }

  // Cartes à ne jamais proposer à la suppression : échanges en cours et enchères en vente.
  function parseProtections(pendingTradeCardIds, selling) {
    const tradeIds = new Set((Array.isArray(pendingTradeCardIds) ? pendingTradeCardIds : []).filter(id => UUID.test(id)));
    // L'endpoint des ventes expose des identifiants de catalogue : toutes les copies sont protégées.
    const saleIds = new Set((Array.isArray(selling) ? selling : []).map(auction => auction?.card_id).filter(id => UUID.test(id)));
    return { tradeIds, saleIds };
  }

  function protectionReason(entry, protections) {
    if (entry.starred) return 'favorite';
    if (entry.shiny) return 'shiny';
    if (protections?.tradeIds?.has(entry.cardId) || protections?.tradeIds?.has(entry.ownedId)) return 'trade';
    if (protections?.saleIds?.has(entry.cardId)) return 'sale';
    return null;
  }

  // Prix moyen d'une carte pour SA rareté.
  // known : valeur connue · none : réponse réussie sans moyenne (« Moy. — ») · unknown : pas encore chargé.
  function priceInfo(price, rarity) {
    if (!price || price.ok !== true || !price.averages || typeof price.averages !== 'object') return { state: 'unknown' };
    const value = price.averages[rarity];
    if (value == null) return { state: 'none', value: 0 };
    return Number.isFinite(Number(value)) ? { state: 'known', value: Number(value) } : { state: 'unknown' };
  }

  function shuffle(list, random = Math.random) {
    const copy = [...list];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  }

  // File de tri : exemplaires non encore traités, filtrés puis ordonnés.
  // Les exemplaires d'une même carte restent côte à côte (sauf en tri aléatoire).
  function buildQueue(entries, options, getPrice, random = Math.random) {
    const { skip = () => false, protections = null, rarities = RARITIES, maxPrice = null, sort = 'rarity' } = options || {};
    const allowed = new Set(rarities);
    const stats = { total: entries.length, done: 0, protectedCount: 0, rarity: 0, price: 0 };
    const rows = [];
    for (const entry of entries) {
      if (skip(entry.ownedId)) { stats.done++; continue; }
      if (protectionReason(entry, protections)) { stats.protectedCount++; continue; }
      if (!allowed.has(entry.rarity)) { stats.rarity++; continue; }
      const info = priceInfo(getPrice(entry.cardId), entry.rarity);
      if (maxPrice != null && (info.state === 'unknown' || info.value > maxPrice)) { stats.price++; continue; }
      rows.push({ entry, value: info.state === 'unknown' ? null : info.value });
    }
    const byTitle = (a, b) => a.entry.title.localeCompare(b.entry.title, 'fr')
      || a.entry.cardId.localeCompare(b.entry.cardId) || a.entry.ownedId.localeCompare(b.entry.ownedId);
    const byPrice = direction => (a, b) => {
      if (a.value == null || b.value == null) return a.value == null ? (b.value == null ? 0 : 1) : -1; // inconnus en dernier
      return (a.value - b.value) * direction || byTitle(a, b);
    };
    let sorted;
    if (sort === 'random') sorted = shuffle(rows, random);
    else if (sort === 'title') sorted = rows.sort(byTitle);
    else if (sort === 'price-asc') sorted = rows.sort(byPrice(1));
    else if (sort === 'price-desc') sorted = rows.sort(byPrice(-1));
    else sorted = rows.sort((a, b) => rarityIndex(a.entry.rarity) - rarityIndex(b.entry.rarity) || byTitle(a, b));
    return { queue: sorted.map(row => row.entry), stats };
  }

  // Progression : { kept: {ownedId: item}, discarded: {ownedId: item} } avec item = { c: cardId, t: titre, r: rareté, at }.
  const emptyProgress = () => ({ kept: {}, discarded: {} });

  function progressItem(entry, at = Date.now()) {
    return { c: entry.cardId, t: entry.title, r: entry.rarity, at };
  }

  // Union de deux progressions. Pour un même exemplaire, la décision la plus récente l'emporte.
  function mergeProgress(base, incoming) {
    const result = emptyProgress();
    const latest = new Map();
    for (const [bucket, source] of [['kept', base], ['discarded', base], ['kept', incoming], ['discarded', incoming]]) {
      for (const [id, item] of Object.entries(source?.[bucket] || {})) {
        const known = latest.get(id);
        if (!known || (item.at || 0) >= (known.item.at || 0)) latest.set(id, { bucket, item });
      }
    }
    for (const [id, { bucket, item }] of latest) result[bucket][id] = item;
    return result;
  }

  function cleanItem(item) {
    if (!item || typeof item !== 'object') return null;
    const at = Number(item.at);
    return {
      c: UUID.test(item.c) ? item.c : null,
      t: typeof item.t === 'string' ? item.t.slice(0, 300) : '',
      r: RARITIES.includes(item.r) ? item.r : null,
      at: Number.isFinite(at) && at > 0 ? at : 0
    };
  }

  function cleanPrices(raw) {
    const prices = {};
    for (const [id, price] of Object.entries(raw && typeof raw === 'object' ? raw : {})) {
      if (!UUID.test(id) || !price?.averages || typeof price.averages !== 'object') continue;
      const averages = {};
      for (const [rarity, value] of Object.entries(price.averages)) {
        if (RARITIES.includes(rarity) && value != null && Number.isFinite(Number(value))) averages[rarity] = Number(value);
      }
      const fetchedAt = Number(price.fetchedAt);
      prices[id] = { ok: true, averages, fetchedAt: Number.isFinite(fetchedAt) && fetchedAt > 0 ? fetchedAt : 0 };
    }
    return prices;
  }

  function exportFile(progress, prices, now = Date.now()) {
    return { app: FORMAT, version: FORMAT_VERSION, exportedAt: now, kept: progress.kept, discarded: progress.discarded, prices };
  }

  // Valide et nettoie un fichier importé. Lève une erreur lisible s'il n'est pas un export Wikinder.
  function parseImport(text) {
    let data;
    try { data = typeof text === 'string' ? JSON.parse(text) : text; } catch { throw Error('Fichier illisible : ce n’est pas du JSON.'); }
    if (!data || data.app !== FORMAT) throw Error('Ce fichier n’est pas un export Wikinder.');
    if (data.version !== FORMAT_VERSION) throw Error(`Version d’export non prise en charge (${data.version}).`);
    const progress = emptyProgress();
    for (const bucket of ['kept', 'discarded']) {
      for (const [id, item] of Object.entries(data[bucket] && typeof data[bucket] === 'object' ? data[bucket] : {})) {
        const clean = UUID.test(id) ? cleanItem(item) : null;
        if (clean) progress[bucket][id] = clean;
      }
    }
    return { progress, prices: cleanPrices(data.prices) };
  }

  const api = {
    UUID, RARITIES, SORTS, FORMAT, FORMAT_VERSION,
    parseEntry, parseProtections, protectionReason, priceInfo, shuffle, buildQueue,
    emptyProgress, progressItem, mergeProgress, exportFile, parseImport, cleanPrices
  };
  (globalThis.Wikinder ||= {}).core = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
