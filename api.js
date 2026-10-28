// Accès à l'API de Wiki Masters (session déjà ouverte), chargeur de prix et file de suppressions.
(() => {
  const W = globalThis.Wikinder;
  const { core, store } = W;
  const PAGE_PAUSE_MS = 150;
  const PRICE_GAP_MS = 300;
  const PRICE_WORKERS = 2;
  const PRICE_MAX_AGE_MS = 14 * 24 * 3600 * 1000;
  const MIN_PAUSE_MS = 120000;
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

  class ApiError extends Error {
    constructor(message, { status = null, code = null, retryAfterMs = 0 } = {}) {
      super(message);
      this.status = status; this.code = code; this.retryAfterMs = retryAfterMs;
    }
    // Le site demande de ralentir ou refuse la session : on met tout en pause un moment.
    get isLimit() { return [401, 403, 429].includes(this.status) || this.code === 'automation_limit'; }
    get isTransient() { return this.status == null || this.status >= 500; }
  }

  function retryAfter(header) {
    if (!header) return 0;
    const seconds = Number(header);
    const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
    return Number.isFinite(ms) ? Math.max(0, ms) : 0;
  }

  async function request(path, { method = 'GET', timeout = 30000 } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(path, {
        method, credentials: 'include', cache: 'no-store', headers: { accept: 'application/json' }, signal: controller.signal
      });
      const data = await response.json().catch(() => null);
      if (!response.ok) {
        throw new ApiError(`HTTP ${response.status}`, {
          status: response.status, code: data?.code || null, retryAfterMs: retryAfter(response.headers.get('Retry-After'))
        });
      }
      return data;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(error?.name === 'AbortError' ? 'Délai dépassé' : 'Erreur réseau');
    } finally { clearTimeout(timer); }
  }

  // Lecture de la collection : on retente les erreurs passagères, mais jamais une limite d'accès.
  async function readRetry(path, attempts = 4) {
    for (let attempt = 1; ; attempt++) {
      try { return await request(path); }
      catch (error) {
        const retryable = error.isTransient || error.status === 429;
        if (!retryable || attempt >= attempts) throw error;
        await sleep(Math.min(30000, Math.max(error.retryAfterMs || 0, 500 * 2 ** attempt)));
      }
    }
  }

  async function fetchProtections(first = null) {
    const stats = first || await readRetry('/api/my-collection?sort=rarity&page=0&stats=1');
    const mine = await readRetry('/api/marketplace?page=1&limit=50&sort=recent&mine=1');
    const { tradeIds, saleIds } = core.parseProtections(stats?.pendingTradeCardIds, mine?.selling);
    return { tradeIds: [...tradeIds], saleIds: [...saleIds], fetchedAt: Date.now() };
  }

  // Toute la collection, un exemplaire par entrée. onProgress(chargés, total).
  async function fetchCollection(onProgress = () => {}) {
    const first = await readRetry('/api/my-collection?sort=rarity&page=0&stats=1');
    if (!Array.isArray(first?.collection) || !Number.isSafeInteger(first.total) || first.total < 0) throw Error('Réponse de collection incomplète.');
    const entries = new Map();
    let rawCount = 0, invalid = 0;
    const absorb = rows => {
      rawCount += rows.length;
      for (const row of rows) {
        const entry = core.parseEntry(row);
        if (entry) entries.set(entry.ownedId, entry); else invalid++;
      }
      onProgress(rawCount, first.total);
    };
    absorb(first.collection);
    for (let page = 1; rawCount < first.total && page < 5000; page++) {
      await sleep(PAGE_PAUSE_MS);
      const data = await readRetry(`/api/my-collection?sort=rarity&page=${page}&stats=0`);
      if (!Array.isArray(data?.collection)) throw Error('Page de collection invalide.');
      if (!data.collection.length) break;
      absorb(data.collection);
    }
    const protections = await fetchProtections(first);
    return { entries: [...entries.values()], total: first.total, invalid, protections, fetchedAt: Date.now() };
  }

  async function fetchAverages(cardId) {
    const json = await request(`/api/marketplace/cards/${encodeURIComponent(cardId)}/sales?scope=summary`);
    if (!json?.summary || typeof json.summary !== 'object' || Array.isArray(json.summary)) throw new ApiError('Réponse invalide');
    const averages = {};
    for (const [rarity, value] of Object.entries(json.summary)) {
      const average = value?.average;
      if (average == null || average === '' || !core.RARITIES.includes(rarity)) continue;
      if (typeof average === 'boolean' || !Number.isFinite(Number(average))) throw new ApiError('Réponse invalide');
      averages[rarity] = Number(average);
    }
    return averages;
  }

  const discardCopy = ownedId => request(`/api/user-cards/${encodeURIComponent(ownedId)}/discard`, { method: 'POST' });

  // ---- Prix moyens en arrière-plan : la carte affichée et les suivantes passent en premier. ----
  class PriceLoader {
    constructor(onChange) {
      this.onChange = onChange;
      this.order = []; this.cursor = 0; this.workers = 0;
      this.inflight = new Set(); this.fails = new Map();
      this.pauseUntil = 0; this.pauseLabel = '';
    }
    isFresh(id) {
      const price = store.state.prices[id];
      return Boolean(price) && Date.now() - price.fetchedAt < PRICE_MAX_AGE_MS;
    }
    // cursor : position de la carte affichée, pour qu'elle soit chiffrée avant les autres.
    setOrder(cardIds, cursor = 0) {
      this.order = [...new Set(cardIds)]; this.cursor = Math.max(0, cursor); this.start();
    }
    focus(index) { this.cursor = Math.max(0, index); this.start(); }
    get paused() { return this.pauseUntil > Date.now(); }
    status() {
      let known = 0;
      for (const id of this.order) if (store.state.prices[id]) known++;
      return { known, total: this.order.length, pausedUntil: this.paused ? this.pauseUntil : 0, label: this.pauseLabel };
    }
    next() {
      const n = this.order.length;
      for (let k = 0; k < n; k++) {
        const id = this.order[(this.cursor + k) % n];
        if (this.inflight.has(id) || this.isFresh(id)) continue;
        const failure = this.fails.get(id);
        if (failure && (failure.tries >= 3 || failure.retryAt > Date.now())) continue;
        return id;
      }
      return null;
    }
    start() { while (this.workers < PRICE_WORKERS && this.next()) { this.workers++; this.work().finally(() => { this.workers--; }); } }
    async work() {
      while (true) {
        if (this.paused) { await sleep(Math.min(1000, this.pauseUntil - Date.now())); continue; }
        const id = this.next();
        if (!id) return;
        this.inflight.add(id);
        try {
          store.state.prices[id] = { ok: true, averages: await fetchAverages(id), fetchedAt: Date.now() };
          store.touch('prices'); this.fails.delete(id);
        } catch (error) {
          if (error.isLimit) {
            this.pauseUntil = Date.now() + Math.max(error.retryAfterMs || 0, MIN_PAUSE_MS);
            this.pauseLabel = error.code === 'automation_limit' ? 'Limite du site' : `HTTP ${error.status}`;
          } else {
            const tries = (this.fails.get(id)?.tries || 0) + 1;
            this.fails.set(id, { tries, retryAt: Date.now() + 30000 * tries });
            setTimeout(() => this.start(), 30000 * tries + 50);
          }
        } finally { this.inflight.delete(id); }
        this.onChange(id);
        await sleep(PRICE_GAP_MS);
      }
    }
  }

  // ---- Suppressions : la carte suivante s'affiche tout de suite, l'envoi se fait ici, en arrière-plan. ----
  // Un court délai de grâce permet d'annuler un geste malheureux avant l'envoi.
  class DiscardQueue {
    constructor({ onChange, checkBlocked, onBlocked, grace = 3000 }) {
      Object.assign(this, { onChange, checkBlocked, onBlocked, grace });
      this.timer = null; this.busy = false; this.sending = null; this.pauseUntil = 0; this.pauseLabel = '';
    }
    get items() { return store.state.pending; }
    get count() { return Object.keys(this.items).length; }
    get paused() { return this.pauseUntil > Date.now(); }
    add(entry) {
      this.items[entry.ownedId] = { ...core.progressItem(entry), tries: 0, retryAt: 0 };
      store.touch('pending'); this.schedule(); this.onChange();
    }
    // Annulable tant que la requête n'est pas partie.
    cancel(ownedId) {
      if (this.sending === ownedId || !this.items[ownedId]) return false;
      delete this.items[ownedId]; store.touch('pending'); this.schedule(); this.onChange();
      return true;
    }
    due(id, item) { return Math.max(item.at + this.grace, item.retryAt || 0, this.pauseUntil); }
    schedule() {
      clearTimeout(this.timer); this.timer = null;
      const times = Object.entries(this.items).map(([id, item]) => this.due(id, item));
      if (!times.length) return;
      this.timer = setTimeout(() => this.run(), Math.max(50, Math.min(...times) - Date.now()));
    }
    run() {
      if (this.busy) return Promise.resolve();
      this.busy = true;
      const task = async () => {
        try {
          while (true) {
            const ready = Object.entries(this.items).filter(([id, item]) => this.due(id, item) <= Date.now()).sort((a, b) => a[1].at - b[1].at)[0];
            if (!ready) return;
            if (!await this.send(ready[0], ready[1])) return;
            await sleep(250);
          }
        } finally { this.busy = false; this.schedule(); this.onChange(); }
      };
      // Un seul onglet envoie à la fois ; l'autre reprendra plus tard grâce à la persistance.
      if (!navigator.locks?.request) return task();
      let started = false;
      return navigator.locks.request('wikinder-discard', { ifAvailable: true }, lock => {
        if (!lock) { this.busy = false; return; }
        started = true; return task();
      }).catch(error => {
        if (started) throw error;
        return task(); // verrous indisponibles : on envoie quand même
      });
    }
    // Retourne false pour interrompre la boucle d'envoi (pause ou erreur à réessayer plus tard).
    async send(ownedId, item) {
      this.sending = ownedId; this.onChange();
      try {
        const reason = await this.checkBlocked(ownedId, item);
        if (reason) {
          delete this.items[ownedId]; store.touch('pending'); this.onBlocked(item, reason);
          return true;
        }
        try { await discardCopy(ownedId); }
        // 404 : l'exemplaire n'existe plus (déjà défaussé) -> l'objectif est atteint.
        catch (error) { if (error.status !== 404) throw error; }
        delete this.items[ownedId];
        store.state.progress.discarded[ownedId] = { c: item.c, t: item.t, r: item.r, at: Date.now() };
        store.touch('pending'); store.touch('progress');
        return true;
      } catch (error) {
        if (error.isLimit) {
          this.pauseUntil = Date.now() + Math.max(error.retryAfterMs || 0, MIN_PAUSE_MS);
          this.pauseLabel = error.code === 'automation_limit' ? 'Limite du site' : `HTTP ${error.status}`;
        } else {
          item.tries = (item.tries || 0) + 1;
          item.retryAt = Date.now() + Math.min(600000, 20000 * 2 ** (item.tries - 1));
          item.error = error.message;
          store.touch('pending');
        }
        return false;
      } finally { this.sending = null; this.onChange(); }
    }
  }

  W.api = { ApiError, request, fetchCollection, fetchProtections, fetchAverages, discardCopy, PriceLoader, DiscardQueue };
})();
