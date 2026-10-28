// Point d'entrée : ajoute l'onglet « Wikinder » au menu du site et le maintient après chaque rendu SPA.
(() => {
  const W = globalThis.Wikinder;
  const NAV_ID = 'wikinder-nav';
  // Même ancres que les extensions de référence : le menu du site pointe vers ces pages.
  const ANCHORS = ['nav a[href="/collection"]', 'nav a[href="/global-collection"]', 'nav a[href="/marketplace"]', 'nav a[href^="/"]'];

  function ensureNav() {
    if (document.getElementById(NAV_ID)) { W.app.setLauncher(false); return; }
    const anchor = ANCHORS.map(selector => document.querySelector(selector)).find(Boolean);
    if (!anchor?.parentElement) return;
    const link = document.createElement('a');
    link.id = NAV_ID;
    link.href = '#wikinder';
    link.className = 'wikinder-nav flex items-center gap-3 px-4 py-3 rounded-xl text-sm font-medium transition-all duration-200';
    const icon = document.createElement('span');
    icon.className = 'wikinder-nav-icon';
    icon.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3c1 3-1 4-2 6s0 4 2 4 3-2 2-4c3 2 5 5 5 8a7 7 0 0 1-14 0c0-3 2-5 3-7 1-1 3-4 4-7z"/></svg>';
    const label = document.createElement('span');
    label.textContent = 'Wikinder';
    link.append(icon, label);
    link.addEventListener('click', event => { event.preventDefault(); W.app.open(); });
    anchor.insertAdjacentElement('afterend', link);
    W.app.setLauncher(false);
  }

  let timer = null;
  const schedule = () => { clearTimeout(timer); timer = setTimeout(ensureNav, 120); };

  async function start() {
    await W.store.load();
    W.app.init();
    ensureNav();
    new MutationObserver(mutations => {
      if (mutations.every(mutation => mutation.target?.closest?.('#wikinder-root'))) return;
      schedule();
    }).observe(document.body, { childList: true, subtree: true });
    // Pas de menu après quelques secondes : on propose un bouton flottant.
    setTimeout(() => { if (!document.getElementById(NAV_ID)) W.app.setLauncher(true); }, 4000);
  }

  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start, { once: true });
})();
