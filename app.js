// Contrôleur + interface de Wikinder : plein écran en Shadow DOM, ouvert depuis l'onglet « Wikinder » du site.
(() => {
  const W = globalThis.Wikinder;
  const { core, store, api } = W;
  const { state } = store;
  const COLLECTION_MAX_AGE_MS = 30 * 60 * 1000;
  const PROTECTION_MAX_AGE_MS = 5 * 60 * 1000;
  const SWIPE_DISTANCE = 110;
  const RARITY_LABELS = { C: 'Commune', PC: 'Peu commune', R: 'Rare', SR: 'Super rare', UR: 'Ultra rare', L: 'Légendaire' };
  const SORT_LABELS = {
    rarity: 'Rareté (communes d’abord)', 'price-asc': 'Prix croissant', 'price-desc': 'Prix décroissant',
    title: 'Titre (A → Z)', random: 'Aléatoire'
  };
  const number = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 2 });
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  };

  let ui = null;
  let entries = [];
  let protections = { tradeIds: new Set(), saleIds: new Set(), fetchedAt: 0 };
  let queue = [], pos = 0, orderIndex = new Map(), copies = new Map(), undoStack = [];
  let hidden = { done: 0, protectedCount: 0, rarity: 0, price: 0 };
  let loading = null, loadError = null, isOpen = false, releaseLock = null, cardEl = null, uiTimer = null;
  const preloaded = new Set();

  function setProtections(raw, fallbackAt = 0) {
    protections = {
      tradeIds: new Set(raw?.tradeIds || []), saleIds: new Set(raw?.saleIds || []),
      fetchedAt: Number(raw?.fetchedAt) || fallbackAt
    };
  }

  const loader = new api.PriceLoader(() => scheduleUi());
  const discards = new api.DiscardQueue({
    onChange: () => scheduleUi(),
    // Les échanges/enchères ont pu changer depuis le chargement : revérification avant d'envoyer.
    async checkBlocked(ownedId, item) {
      if (Date.now() - protections.fetchedAt > PROTECTION_MAX_AGE_MS) {
        const fresh = await api.fetchProtections();
        setProtections(fresh);
        state.collection.protections = fresh; store.touch('collection');
      }
      return core.protectionReason({ ownedId, cardId: item.c, starred: false, shiny: false }, protections);
    },
    onBlocked(item, reason) {
      toast(`« ${item.t} » est ${reason === 'trade' ? 'dans un échange' : 'en vente'} : elle n’a pas été supprimée.`);
    }
  });

  const isDone = ownedId => Boolean(state.progress.kept[ownedId] || state.progress.discarded[ownedId] || state.pending[ownedId]);
  const getPrice = cardId => state.prices[cardId];

  // ---------- file de tri ----------
  function rebuild() {
    const base = {
      skip: isDone, protections, rarities: state.settings.rarities, sort: state.settings.sort,
      maxPrice: null
    };
    // Les prix à charger sont déterminés AVANT le filtre de prix, sinon une carte masquée ne serait jamais chiffrée.
    const all = core.buildQueue(entries, base, getPrice);
    const maxPrice = state.settings.maxPrice;
    const filtered = maxPrice == null ? all : core.buildQueue(entries, { ...base, maxPrice }, getPrice);
    queue = filtered.queue; pos = 0; undoStack = [];
    hidden = { ...filtered.stats, done: all.stats.done };
    copies = new Map();
    for (const entry of entries) if (!isDone(entry.ownedId)) copies.set(entry.cardId, (copies.get(entry.cardId) || 0) + 1);
    const order = [...new Set(all.queue.map(entry => entry.cardId))];
    orderIndex = new Map(order.map((id, index) => [id, index]));
    loader.setOrder(order, orderIndex.get(queue[0]?.cardId) ?? 0);
    render();
  }

  function skipDone() { while (pos < queue.length && isDone(queue[pos].ownedId)) pos++; }
  const current = () => queue[pos] || null;

  function decide(kind) {
    const entry = current();
    if (!entry || loading) return;
    const record = { kind, entry, pos };
    if (kind === 'keep') {
      state.progress.kept[entry.ownedId] = core.progressItem(entry);
      store.touch('progress');
    } else {
      discards.add(entry);
      copies.set(entry.cardId, Math.max(0, (copies.get(entry.cardId) || 1) - 1));
    }
    undoStack.push(record); if (undoStack.length > 100) undoStack.shift();
    flyOut(kind);
    pos++; skipDone();
    render();
  }

  function undo() {
    const last = undoStack[undoStack.length - 1];
    if (!last) return toast('Rien à annuler.');
    if (last.kind === 'keep') {
      delete state.progress.kept[last.entry.ownedId]; store.touch('progress');
    } else if (discards.cancel(last.entry.ownedId)) {
      copies.set(last.entry.cardId, (copies.get(last.entry.cardId) || 0) + 1);
    } else {
      undoStack.pop();
      return toast('Cette suppression est déjà envoyée au site : impossible de l’annuler.');
    }
    undoStack.pop();
    pos = last.pos;
    render();
  }

  // ---------- collection ----------
  function useCollection(collection) {
    entries = collection.entries;
    setProtections(collection.protections, collection.fetchedAt);
    rebuild();
  }

  async function ensureCollection(force = false) {
    const saved = state.collection;
    if (!force && saved.entries.length && Date.now() - saved.fetchedAt < COLLECTION_MAX_AGE_MS) {
      if (!entries.length) useCollection(saved); else render();
      return;
    }
    if (loading) return;
    loadError = null; loading = 'Chargement de la collection…'; render();
    try {
      const result = await api.fetchCollection((done, total) => { loading = `Collection : ${done} / ${total} exemplaires`; renderLoading(); });
      state.collection = { fetchedAt: result.fetchedAt, entries: result.entries, protections: result.protections };
      store.touch('collection');
      loading = null; useCollection(state.collection);
      if (result.invalid) toast(`${result.invalid} exemplaire(s) illisible(s) ignoré(s).`);
    } catch (error) {
      loading = null;
      if (saved.entries.length) { toast(`Rechargement impossible (${error.message}) : collection enregistrée utilisée.`); useCollection(saved); }
      else { loadError = error.message; render(); }
    }
  }

  // ---------- export / import ----------
  function exportProgress() {
    const progress = { kept: state.progress.kept, discarded: { ...state.progress.discarded } };
    // Une suppression décidée mais pas encore confirmée compte comme faite : elle ne doit pas revenir ailleurs.
    for (const [id, item] of Object.entries(state.pending)) progress.discarded[id] = { c: item.c, t: item.t, r: item.r, at: item.at };
    const file = core.exportFile(progress, state.prices);
    const blob = new Blob([JSON.stringify(file)], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = `wikinder-progression-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 10000);
    toast(`Export : ${Object.keys(progress.kept).length} gardées, ${Object.keys(progress.discarded).length} supprimées, ${Object.keys(state.prices).length} prix.`);
  }

  async function importProgress(file) {
    try {
      const imported = core.parseImport(await file.text());
      const before = { kept: Object.keys(state.progress.kept).length, discarded: Object.keys(state.progress.discarded).length, prices: Object.keys(state.prices).length };
      state.progress = core.mergeProgress(state.progress, imported.progress);
      for (const [id, price] of Object.entries(imported.prices)) {
        if (!state.prices[id] || price.fetchedAt > state.prices[id].fetchedAt) state.prices[id] = price;
      }
      // Une décision importée plus récente annule une suppression locale encore en attente.
      for (const [id, item] of Object.entries(state.pending)) {
        const newer = imported.progress.kept[id];
        if (newer && newer.at > item.at) discards.cancel(id);
      }
      store.touch('progress'); store.touch('prices'); store.flush();
      if (entries.length) rebuild();
      toast(`Import : +${Object.keys(state.progress.kept).length - before.kept} gardées, +${Object.keys(state.progress.discarded).length - before.discarded} supprimées, +${Object.keys(state.prices).length - before.prices} prix.`);
    } catch (error) { toast(error.message); }
  }

  // ---------- vue ----------
  function build() {
    const host = document.createElement('div');
    host.id = 'wikinder-root';
    const shadow = host.attachShadow({ mode: 'open' });
    const css = document.createElement('link');
    css.rel = 'stylesheet'; css.href = chrome.runtime.getURL('ui.css');
    shadow.append(css);
    const overlay = el('div', 'overlay'); overlay.hidden = true;
    overlay.setAttribute('role', 'dialog'); overlay.setAttribute('aria-modal', 'true'); overlay.setAttribute('aria-label', 'Wikinder');
    overlay.innerHTML = `
      <header class="bar">
        <h1>🔥 Wikinder</h1>
        <div class="stats" data-stats></div>
        <div class="bar-actions">
          <button type="button" data-act="filters">Filtres</button>
          <button type="button" data-act="export">Exporter</button>
          <button type="button" data-act="import">Importer</button>
          <button type="button" data-act="reload" title="Relire la collection sur le site">Recharger</button>
          <button type="button" data-act="close" class="close" aria-label="Fermer">✕</button>
        </div>
        <input type="file" accept="application/json,.json" data-file hidden>
      </header>
      <section class="filters" data-filters hidden>
        <label>Tri <select data-sort></select></label>
        <fieldset data-rarities><legend>Raretés</legend></fieldset>
        <label>Prix moyen max (W) <input type="number" min="0" step="any" data-max placeholder="aucun"></label>
        <button type="button" data-act="apply">Appliquer</button>
        <p class="hint" data-filter-hint></p>
      </section>
      <main class="main">
        <div class="stage" data-stage></div>
        <div class="controls" data-controls>
          <button type="button" class="round del" data-act="delete" aria-label="Supprimer la carte">✕</button>
          <button type="button" class="round undo" data-act="undo" aria-label="Annuler le dernier geste">↩</button>
          <button type="button" class="round keep" data-act="keep" aria-label="Garder la carte">♥</button>
        </div>
        <p class="keys">← supprimer · → garder · Z annuler · Échap fermer</p>
      </main>
      <footer class="foot" data-foot></footer>
      <div class="toasts" data-toasts aria-live="polite"></div>`;
    const launcher = el('button', 'launcher', '🔥 Wikinder'); launcher.type = 'button'; launcher.hidden = true;
    shadow.append(overlay, launcher);

    const q = selector => overlay.querySelector(selector);
    const sort = q('[data-sort]');
    for (const [value, label] of Object.entries(SORT_LABELS)) sort.append(new Option(label, value));
    const rarityBox = q('[data-rarities]'), rarityInputs = new Map();
    for (const rarity of core.RARITIES) {
      const label = el('label', 'check'); label.title = RARITY_LABELS[rarity];
      const input = el('input'); input.type = 'checkbox'; rarityInputs.set(rarity, input);
      label.append(input, document.createTextNode(` ${rarity}`)); rarityBox.append(label);
    }
    overlay.addEventListener('click', event => {
      const action = event.target.closest('[data-act]')?.dataset.act;
      if (action) handleAction(action);
    });
    q('[data-file]').addEventListener('change', event => {
      const file = event.target.files?.[0]; event.target.value = '';
      if (file) importProgress(file);
    });
    launcher.addEventListener('click', open);
    document.documentElement.append(host);
    return {
      host, overlay, launcher, q, sort, rarityInputs,
      stage: q('[data-stage]'), stats: q('[data-stats]'), foot: q('[data-foot]'), toasts: q('[data-toasts]'),
      controls: q('[data-controls]'), filters: q('[data-filters]'), max: q('[data-max]'), hint: q('[data-filter-hint]')
    };
  }

  function handleAction(action) {
    if (action === 'close') close();
    else if (action === 'delete') decide('delete');
    else if (action === 'keep') decide('keep');
    else if (action === 'undo') undo();
    else if (action === 'export') exportProgress();
    else if (action === 'import') ui.q('[data-file]').click();
    else if (action === 'reload') ensureCollection(true);
    else if (action === 'filters') {
      ui.filters.hidden = !ui.filters.hidden;
      if (!ui.filters.hidden) fillFilters();
    } else if (action === 'apply') applyFilters();
  }

  function fillFilters() {
    ui.sort.value = state.settings.sort;
    for (const [rarity, input] of ui.rarityInputs) input.checked = state.settings.rarities.includes(rarity);
    ui.max.value = state.settings.maxPrice ?? '';
    ui.hint.textContent = 'Avec un prix max, les cartes dont le prix n’est pas encore chargé sont masquées : ré-applique les filtres quand les prix sont arrivés. Les cartes « Moy. — » comptent pour 0 W.';
  }

  function applyFilters() {
    const rarities = [...ui.rarityInputs].filter(([, input]) => input.checked).map(([rarity]) => rarity);
    if (!rarities.length) return toast('Choisis au moins une rareté.');
    const raw = ui.max.value.trim().replace(',', '.');
    const maxPrice = raw === '' ? null : Number(raw);
    if (maxPrice != null && (!Number.isFinite(maxPrice) || maxPrice < 0)) return toast('Le prix max doit être un nombre positif ou nul.');
    state.settings = { sort: ui.sort.value, rarities, maxPrice };
    store.touch('settings');
    if (entries.length) rebuild();
    ui.filters.hidden = true;
  }

  function priceView(entry) {
    const info = core.priceInfo(getPrice(entry.cardId), entry.rarity);
    if (info.state === 'known') return { text: `${number.format(info.value)} W`, caption: 'Prix moyen', cls: '' };
    if (info.state === 'none') return { text: 'Moy. —', caption: 'Pas de moyenne disponible', cls: 'muted' };
    if (loader.paused) return { text: '⏸', caption: `Prix en pause (${loader.pauseLabel})`, cls: 'muted' };
    if (loader.fails.get(entry.cardId)?.tries >= 3) return { text: '?', caption: 'Prix indisponible', cls: 'muted' };
    return { text: '…', caption: 'Chargement du prix', cls: 'muted' };
  }

  function buildCard(entry) {
    const card = el('article', `card rarity-${entry.rarity}`);
    const media = el('div', 'media');
    const fallback = el('div', 'fallback', entry.title);
    media.append(fallback);
    if (entry.imageUrl) {
      const img = el('img'); img.alt = ''; img.draggable = false; img.decoding = 'async';
      img.addEventListener('load', () => { fallback.hidden = true; });
      img.addEventListener('error', () => { img.remove(); });
      img.src = entry.imageUrl; media.append(img);
    }
    media.append(el('span', 'badge', entry.rarity), el('span', 'stamp keep', 'GARDER'), el('span', 'stamp del', 'SUPPRIMER'));
    const info = el('div', 'info');
    info.append(el('h2', 'title', entry.title));
    const owned = copies.get(entry.cardId) || 1;
    info.append(el('p', 'meta', `${RARITY_LABELS[entry.rarity]}${owned > 1 ? ` · ${owned} exemplaires possédés` : ''}`));
    const price = el('div', 'price');
    price.append(el('strong'), el('span', 'caption'));
    info.append(price);
    if (entry.wikipediaUrl) {
      const link = el('a', 'wiki', 'Voir sur Wikipédia ↗');
      link.href = entry.wikipediaUrl; link.target = '_blank'; link.rel = 'noopener noreferrer';
      info.append(link);
    }
    card.append(media, info);
    attachDrag(card);
    return card;
  }

  function updatePrice() {
    const entry = current();
    const price = cardEl?.querySelector('.price');
    if (!entry || !price) return;
    const view = priceView(entry);
    price.className = `price ${view.cls}`;
    price.querySelector('strong').textContent = view.text;
    price.querySelector('.caption').textContent = view.caption;
  }

  function updateStats() {
    const kept = Object.keys(state.progress.kept).length;
    const removed = Object.keys(state.progress.discarded).length;
    const sending = discards.count;
    ui.stats.textContent = '';
    for (const [value, label] of [[Math.max(0, queue.length - pos), 'à trier'], [kept, 'gardées'], [removed + sending, 'supprimées']]) {
      const item = el('span', 'stat'); item.append(el('strong', '', number.format(value)), document.createTextNode(` ${label}`));
      ui.stats.append(item);
    }
    const price = loader.status();
    const parts = [];
    parts.push(`Prix : ${price.known} / ${price.total}${price.pausedUntil ? ` · pause (${loader.pauseLabel}) ${Math.ceil((price.pausedUntil - Date.now()) / 1000)} s` : ''}`);
    if (sending) {
      const failing = Object.values(state.pending).find(item => item.error);
      parts.push(`Suppressions en cours d’envoi : ${sending}${discards.paused ? ` · pause (${discards.pauseLabel})` : failing ? ` · nouvel essai prévu (${failing.error})` : ''}`);
    }
    const masked = hidden.protectedCount + hidden.rarity + hidden.price;
    if (masked) parts.push(`${masked} masquée(s) (${hidden.protectedCount} protégée(s), ${hidden.rarity} hors raretés, ${hidden.price} hors prix)`);
    if (state.collection.fetchedAt) parts.push(`Collection du ${new Date(state.collection.fetchedAt).toLocaleString('fr-FR')}`);
    ui.foot.textContent = parts.join('  ·  ');
  }

  function renderLoading() {
    if (!ui.stage.querySelector('.message.loading')) {
      ui.stage.replaceChildren(el('div', 'message loading'));
      ui.controls.hidden = true;
    }
    ui.stage.querySelector('.message').textContent = loading;
  }

  function preload() {
    for (let i = 1; i <= 3; i++) {
      const url = queue[pos + i]?.imageUrl;
      if (!url || preloaded.has(url)) continue;
      preloaded.add(url); new Image().src = url;
      if (preloaded.size > 200) preloaded.delete(preloaded.values().next().value);
    }
  }

  function render() {
    if (!ui) return;
    updateStats();
    if (loading) return renderLoading();
    skipDone();
    const entry = current();
    ui.controls.hidden = !entry;
    cardEl = null;
    if (entry) {
      const next = queue[pos + 1];
      const stack = [];
      if (next) { const back = el('div', 'card back'); back.append(el('div', 'media')); stack.push(back); }
      cardEl = buildCard(entry); stack.push(cardEl);
      setStage(stack);
      updatePrice(); preload();
      loader.focus(orderIndex.get(entry.cardId) ?? 0);
    } else {
      const box = el('div', 'message');
      if (loadError) {
        box.append(el('p', '', `Impossible de charger la collection : ${loadError}`));
        const retry = el('button', '', 'Réessayer'); retry.type = 'button'; retry.dataset.act = 'reload'; box.append(retry);
      } else if (!entries.length) {
        box.append(el('p', '', 'Aucune carte dans la collection.'));
      } else {
        box.append(el('p', 'big', 'Tout est trié 🎉'), el('p', '', 'Plus aucune carte à trier avec ces filtres. Change les filtres ou recharge la collection pour voir les nouvelles cartes.'));
      }
      setStage([box]);
    }
  }

  // Remplace le contenu de la scène en laissant finir l'animation de la carte qui s'envole.
  function setStage(nodes) {
    for (const node of [...ui.stage.children]) if (!node.classList.contains('ghost')) node.remove();
    ui.stage.append(...nodes);
  }

  // La carte quitte l'écran sur un clone : la suivante est déjà affichée et utilisable.
  function flyOut(kind) {
    if (!cardEl) return;
    const ghost = cardEl.cloneNode(true);
    ghost.classList.add('ghost', kind === 'keep' ? 'go-keep' : 'go-del');
    ghost.classList.remove('dragging');
    ui.stage.append(ghost);
    ghost.getBoundingClientRect();
    const sign = kind === 'keep' ? 1 : -1;
    ghost.style.transform = `translate(${sign * 140}%, -6%) rotate(${sign * 24}deg)`;
    ghost.style.opacity = '0';
    setTimeout(() => ghost.remove(), 320);
  }

  function attachDrag(card) {
    const keep = card.querySelector('.stamp.keep'), del = card.querySelector('.stamp.del');
    let startX = 0, startY = 0, dragging = false;
    card.addEventListener('pointerdown', event => {
      if (event.button !== 0 || event.target.closest('a')) return;
      dragging = true; startX = event.clientX; startY = event.clientY;
      card.setPointerCapture(event.pointerId); card.classList.add('dragging');
    });
    card.addEventListener('pointermove', event => {
      if (!dragging) return;
      const dx = event.clientX - startX, dy = event.clientY - startY;
      card.style.transform = `translate(${dx}px, ${dy * 0.25}px) rotate(${dx / 18}deg)`;
      keep.style.opacity = String(Math.min(1, Math.max(0, dx / SWIPE_DISTANCE)));
      del.style.opacity = String(Math.min(1, Math.max(0, -dx / SWIPE_DISTANCE)));
    });
    const end = event => {
      if (!dragging) return;
      dragging = false; card.classList.remove('dragging');
      const dx = event.clientX - startX;
      if (event.type === 'pointerup' && Math.abs(dx) > SWIPE_DISTANCE) decide(dx > 0 ? 'keep' : 'delete');
      else { card.style.transform = ''; keep.style.opacity = '0'; del.style.opacity = '0'; }
    };
    card.addEventListener('pointerup', end);
    card.addEventListener('pointercancel', end);
  }

  function toast(message) {
    if (!ui) return;
    const node = el('div', 'toast', message);
    ui.toasts.append(node);
    setTimeout(() => node.remove(), 5000);
  }

  // Les chargements de prix arrivent en rafale : l'interface ne se met à jour qu'à intervalle raisonnable.
  function scheduleUi() {
    if (!ui || !isOpen || uiTimer) return;
    uiTimer = setTimeout(() => { uiTimer = null; updateStats(); updatePrice(); }, 300);
  }

  function onKey(event) {
    if (!isOpen) return;
    const typing = event.composedPath().some(node => ['INPUT', 'SELECT', 'TEXTAREA'].includes(node.tagName));
    let handled = true;
    if (event.key === 'Escape') close();
    else if (typing || event.ctrlKey || event.metaKey || event.altKey) handled = false;
    else if (event.key === 'ArrowLeft') decide('delete');
    else if (event.key === 'ArrowRight') decide('keep');
    else if (event.key === 'z' || event.key === 'Z' || event.key === 'Backspace') undo();
    else handled = false;
    // Le site ne doit pas réagir aux touches utilisées par Wikinder.
    if (handled || !typing) event.stopPropagation();
    if (handled) event.preventDefault();
  }

  // Un seul onglet Wikinder à la fois : deux onglets se réécriraient la progression.
  function acquireLock() {
    if (!navigator.locks?.request) return Promise.resolve(() => {});
    return new Promise(resolve => {
      // Si les verrous sont indisponibles (contexte restreint), on ouvre quand même.
      const unavailable = () => resolve(() => {});
      setTimeout(unavailable, 1500);
      try {
        navigator.locks.request('wikinder-ui', { ifAvailable: true }, lock => {
          if (!lock) { resolve(null); return; }
          return new Promise(release => resolve(release));
        }).catch(unavailable);
      } catch { unavailable(); }
    });
  }

  async function open() {
    if (isOpen) return;
    ui ||= build();
    const release = await acquireLock();
    if (!release) { alert('Wikinder est déjà ouvert dans un autre onglet. Ferme-le d’abord.'); return; }
    releaseLock = release; isOpen = true;
    ui.overlay.hidden = false; ui.launcher.hidden = true;
    document.documentElement.style.overflow = 'hidden';
    document.addEventListener('keydown', onKey, true);
    document.getElementById('wikinder-nav')?.classList.add('is-active');
    await ensureCollection();
    render();
  }

  function close() {
    if (!isOpen) return;
    isOpen = false;
    ui.overlay.hidden = true;
    document.documentElement.style.overflow = '';
    document.removeEventListener('keydown', onKey, true);
    document.getElementById('wikinder-nav')?.classList.remove('is-active');
    releaseLock?.(); releaseLock = null;
    store.flush();
    syncLauncher();
  }

  let launcherWanted = false;
  function syncLauncher() { if (ui) ui.launcher.hidden = !launcherWanted || isOpen; }
  // Repli si le menu du site est introuvable (mise en page mobile, refonte du site).
  function setLauncher(wanted) { ui ||= build(); launcherWanted = wanted; syncLauncher(); }

  function init() {
    // Reprend les suppressions décidées lors d'une session précédente.
    setProtections(state.collection.protections, state.collection.fetchedAt);
    discards.schedule();
  }

  W.app = { init, open, close, setLauncher };
})();
