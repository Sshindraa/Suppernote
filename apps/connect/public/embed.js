/**
 * Suppernote Connect — Widget embed snippet.
 *
 * Usage :
 *   <script src="https://suppernote.com/embed.js" data-slug="chez-suppernote-demo"
 *           data-primary="#0f172a" data-accent="#f97316"></script>
 *
 * Sans data-mode : injecte l'iframe inline (comportement historique, synchrone).
 * Si la page contient un déclencheur (bouton [data-suppernote-book] ou lien vers
 * /restaurant/:slug ou /widget/:slug), le clic ouvre en plus le widget dans un
 * <dialog> par-dessus la page.
 * data-mode="inline" : iframe seule. data-mode="modal" : fenêtre seule.
 */
(function () {
  const script = document.currentScript;
  const slug = script.getAttribute('data-slug');
  const primary = script.getAttribute('data-primary') || '#0f172a';
  const accent = script.getAttribute('data-accent') || '#f97316';
  if (!slug) return;

  const DEFAULT_HOST = 'https://suppernote.com';
  // Validate host to prevent XSS via malicious data-host attribute.
  // Only allow HTTPS URLs or localhost (dev). Reject anything else.
  function cleanHost(raw) {
    const h = raw.replace(/\/$/, '');
    return /^https:\/\/[a-zA-Z0-9.-]+$|^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(h)
      ? h
      : null;
  }
  let host = cleanHost(script.getAttribute('data-host') || DEFAULT_HOST);
  if (!host) {
    console.error('[suppernote-widget] Invalid data-host attribute');
    host = DEFAULT_HOST;
  }
  const hostOrigin = new URL(host).origin;
  const encSlug = encodeURIComponent(slug);

  function widgetUrl(trigger, embedded) {
    // Build URL safely via URL API to prevent DOM injection via data-host.
    const url = new URL(host);
    url.pathname = '/widget/' + encSlug;
    if (embedded) {
      url.searchParams.set('embedded', '1');
      url.searchParams.set('primary', primary.replace('#', ''));
      url.searchParams.set('accent', accent.replace('#', ''));
      // Transmet l'origine du parent au widget pour qu'il puisse cibler
      // window.parent.postMessage même avec Referrer-Policy: no-referrer.
      url.searchParams.set('parentOrigin', window.location.origin);
    }
    // Paramètres de contexte du déclencheur (le widget les ignore aujourd'hui).
    for (const key of ['party', 'date', 'source']) {
      const value = trigger && trigger.getAttribute('data-' + key);
      if (value) url.searchParams.set(key, value);
    }
    return url.toString();
  }

  function emitBooked(source) {
    const detail = { slug, source: source || null };
    window.dispatchEvent(new CustomEvent('suppernote:booked', { detail }));
    window.dataLayer?.push({ event: 'suppernote_booked', ...detail });
  }

  // ---- Mode inline (comportement historique, inchangé) ----
  function mountInline() {
    const iframe = document.createElement('iframe');
    iframe.src = widgetUrl(null, true);
    iframe.style.width = '100%';
    iframe.style.border = '0';
    iframe.scrolling = 'no';
    iframe.title = 'Réserver une table avec Suppernote';

    // Auto-resize via postMessage
    window.addEventListener('message', (e) => {
      if (e.origin !== host) return;
      // Valide que le message provient bien de l'iframe du widget (pas d'une
      // autre fenêtre/iframe du même domaine).
      if (e.source !== iframe.contentWindow) return;
      if (e.data?.type === 'suppernote-booked') emitBooked(null);
      if (
        (e.data?.type === 'suppernote-widget-resize' || e.data?.type === 'sokar-widget-resize') &&
        e.data?.height
      ) {
        if (typeof e.data?.height === 'number' && e.data.height > 0 && e.data.height < 10000) {
          iframe.style.height = e.data.height + 'px';
        }
      }
    });

    script.parentNode.insertBefore(iframe, script.nextSibling);
  }

  // ---- Déclencheurs ----
  function isTrigger(el) {
    if (el.hasAttribute('data-suppernote-book')) return true;
    if (el.tagName !== 'A' || !el.href) return false;
    let url;
    try {
      url = new URL(el.href);
    } catch (_) {
      return false;
    }
    const path = url.pathname.replace(/\/$/, '');
    return (
      url.origin === hostOrigin &&
      (path === '/restaurant/' + encSlug || path === '/widget/' + encSlug)
    );
  }

  function triggerOf(target) {
    const el = target instanceof Element ? target.closest('a[href],[data-suppernote-book]') : null;
    return el && isTrigger(el) ? el : null;
  }

  function countTriggers() {
    return Array.prototype.filter.call(
      document.querySelectorAll('[data-suppernote-book],a[href]'),
      isTrigger,
    ).length;
  }

  // ---- Mode modal ----
  const MODAL_CSS = `
.suppernote-dialog{box-sizing:border-box;width:min(480px,calc(100vw - 32px));max-width:none;height:min(90vh,760px);max-height:none;margin:auto;padding:0;border:0;border-radius:16px;overflow:hidden;background:#fff;box-shadow:0 25px 50px -12px rgba(15,23,42,.35)}
.suppernote-dialog::backdrop{background:rgba(15,23,42,.6)}
.suppernote-frame{display:block;width:100%;height:100%;border:0}
.suppernote-close{position:absolute;top:12px;right:12px;z-index:1;width:40px;height:40px;border:0;border-radius:999px;background:rgba(15,23,42,.08);color:#0f172a;font-size:24px;line-height:1;cursor:pointer;transition:all 200ms}
.suppernote-close:hover{background:rgba(15,23,42,.16)}
.suppernote-close:focus-visible{outline:2px solid #f97316;outline-offset:2px}
@media (max-width:640px){
.suppernote-dialog{width:100vw;max-width:100vw;height:100vh;height:100dvh;max-height:100dvh;margin:0;border-radius:0;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)}
.suppernote-close{top:calc(12px + env(safe-area-inset-top));right:calc(12px + env(safe-area-inset-right))}
}`;

  let dialog = null;
  let frame = null;
  let closeButton = null;
  let lastTrigger = null;
  let fallbackHref = null;
  let isOpen = false;
  let pushed = false;
  let ignorePop = false;
  let ready = false;
  let timer = null;
  let prevOverflow = '';

  function injectStyle() {
    if (document.getElementById('suppernote-embed-style')) return;
    const style = document.createElement('style');
    style.id = 'suppernote-embed-style';
    style.textContent = MODAL_CSS;
    document.head.appendChild(style);
  }

  function setFrameUrl(trigger) {
    const url = widgetUrl(trigger, true);
    if (frame.dataset.src === url) return;
    frame.dataset.src = url;
    frame.src = url;
    ready = false;
  }

  function ensureModal() {
    if (dialog) return;
    injectStyle();
    dialog = document.createElement('dialog');
    dialog.className = 'suppernote-dialog';
    dialog.setAttribute('aria-label', 'Réserver une table avec Suppernote');
    closeButton = document.createElement('button');
    closeButton.type = 'button';
    closeButton.className = 'suppernote-close';
    closeButton.setAttribute('aria-label', 'Fermer');
    closeButton.textContent = '×';
    frame = document.createElement('iframe');
    frame.className = 'suppernote-frame';
    frame.title = 'Réserver une table avec Suppernote';
    dialog.append(closeButton, frame);
    document.body.appendChild(dialog);

    closeButton.addEventListener('click', () => close(false));
    // Échap : on prend la main pour gérer l'historique (pas de double fermeture).
    dialog.addEventListener('cancel', (e) => {
      e.preventDefault();
      close(false);
    });
    // Fermeture native (close-watcher de Chrome : 2e Échap sans activation, pas de
    // « cancel ») : nettoyage idempotent. L'attribut open (= dialog.open) filtre les
    // événements close différés d'une réouverture rapide.
    dialog.addEventListener('close', () => {
      if (!dialog.hasAttribute('open')) close(false);
    });
    window.addEventListener('popstate', onPopState);
    window.addEventListener('message', onMessage);
  }

  // Page de secours : le lien lui-même, ou la page restaurant pour un bouton.
  function fallbackUrl(trigger) {
    return trigger.tagName === 'A' ? trigger.href : host + '/restaurant/' + encSlug;
  }

  function open(trigger) {
    if (isOpen) return;
    ensureModal();
    if (typeof dialog.showModal !== 'function') {
      location.href = fallbackUrl(trigger);
      return;
    }
    lastTrigger = trigger;
    fallbackHref = fallbackUrl(trigger);
    setFrameUrl(trigger);
    isOpen = true;
    prevOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = 'hidden';
    dialog.showModal();
    history.pushState({ suppernoteEmbed: true }, '');
    pushed = true;
    if (!ready) timer = setTimeout(fallback, 5000);
  }

  // fromPop : la fermeture vient du bouton retour (l'historique a déjà reculé).
  // Idempotent : sans effet si la fenêtre est déjà fermée.
  function close(fromPop) {
    if (!isOpen) return;
    isOpen = false;
    clearTimeout(timer);
    dialog.close();
    document.documentElement.style.overflow = prevOverflow;
    if (!fromPop && pushed) {
      ignorePop = true;
      history.back();
    }
    pushed = false;
    if (lastTrigger && lastTrigger.isConnected) lastTrigger.focus();
  }

  // Le widget ne répond pas dans les 5 s : on remplace l'entrée factice par la page
  // de réservation (retour arrière cohérent).
  function fallback() {
    const href = fallbackHref;
    close(true);
    location.replace(href);
  }

  function onPopState() {
    if (ignorePop) {
      ignorePop = false;
      return;
    }
    if (isOpen) close(true);
  }

  function onMessage(e) {
    if (e.origin !== host || !frame || e.source !== frame.contentWindow) return;
    const type = e.data?.type;
    if (
      type === 'suppernote-widget-ready' ||
      type === 'suppernote-widget-resize' ||
      type === 'sokar-widget-resize'
    ) {
      ready = true;
      clearTimeout(timer);
    } else if (type === 'suppernote-booked') {
      emitBooked(lastTrigger && lastTrigger.getAttribute('data-source'));
    }
  }

  function preload(e) {
    if (dialog || isOpen) return;
    const trigger = triggerOf(e.target);
    if (!trigger) return;
    ensureModal();
    setFrameUrl(trigger);
  }

  function onClick(e) {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const trigger = triggerOf(e.target);
    if (!trigger) return;
    if (trigger.tagName === 'A' && trigger.target && trigger.target !== '_self') return;
    e.preventDefault();
    e.stopPropagation();
    open(trigger);
  }

  function initModal() {
    const preconnect = document.createElement('link');
    preconnect.rel = 'preconnect';
    preconnect.href = hostOrigin;
    document.head.appendChild(preconnect);
    document.addEventListener('click', onClick, true);
    document.addEventListener('pointerover', preload);
    document.addEventListener('touchstart', preload, { passive: true });
    document.addEventListener('focusin', preload);
  }

  // Signal d'installation (une fois par chargement). Pas de preflight : text/plain.
  const API_BY_HOST = {
    'https://suppernote.com': 'https://api.suppernote.com',
    'https://staging.suppernote.com': 'https://api-staging.suppernote.com',
  };
  function sendHeartbeat(mode, buttons) {
    try {
      const apiAttr = script.getAttribute('data-api-host');
      const apiBase = apiAttr ? cleanHost(apiAttr) : API_BY_HOST[hostOrigin];
      if (!apiBase || !navigator.sendBeacon) return;
      const payload = { slug, origin: location.origin, version: '2', mode, buttons };
      navigator.sendBeacon(apiBase + '/public/embed/heartbeat', JSON.stringify(payload));
    } catch (_) {
      // Signal best-effort : jamais bloquant pour le site hôte.
    }
  }

  // Modal et heartbeat attendent le DOM pour voir les déclencheurs.
  function setupModalAndHeartbeat() {
    const requested = script.getAttribute('data-mode');
    const buttons = countTriggers();
    if (requested === 'modal' || (requested !== 'inline' && buttons > 0)) initModal();
    sendHeartbeat(requested === 'modal' ? 'modal' : 'inline', buttons);
  }

  // Rétrocompatibilité : l'iframe inline est insérée de façon synchrone, comme avant.
  if (script.getAttribute('data-mode') !== 'modal') mountInline();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupModalAndHeartbeat, { once: true });
  } else {
    setupModalAndHeartbeat();
  }
})();
