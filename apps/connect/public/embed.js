/**
 * Suppernote Connect — Widget embed snippet.
 *
 * Usage :
 *   <script src="https://suppernote.com/embed.js" data-slug="chez-suppernote-demo"
 *           data-primary="#0f172a" data-accent="#f97316"></script>
 *
 * Le script injecte un iframe responsive vers /widget/:slug. L'iframe
 * s'auto-redimensionne via postMessage.
 */
(function () {
  const script = document.currentScript;
  const slug = script.getAttribute('data-slug');
  const primary = script.getAttribute('data-primary') || '#0f172a';
  const accent = script.getAttribute('data-accent') || '#f97316';
  if (!slug) return;

  let rawHost = (script.getAttribute('data-host') || 'https://suppernote.com').replace(/\/$/, '');
  // Validate host to prevent XSS via malicious data-host attribute.
  // Only allow HTTPS URLs or localhost (dev). Reject anything else.
  if (!/^https:\/\/[a-zA-Z0-9.-]+$|^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(rawHost)) {
    console.error('[suppernote-widget] Invalid data-host attribute');
    rawHost = 'https://suppernote.com';
  }
  const host = rawHost;
  const iframe = document.createElement('iframe');
  // Build URL safely via URL API to prevent DOM injection via data-host.
  const widgetUrl = new URL(host);
  widgetUrl.pathname = '/widget/' + encodeURIComponent(slug);
  widgetUrl.searchParams.set('embedded', '1');
  widgetUrl.searchParams.set('primary', primary.replace('#', ''));
  widgetUrl.searchParams.set('accent', accent.replace('#', ''));
  // Transmet l'origine du parent au widget pour qu'il puisse cibler
  // window.parent.postMessage même avec Referrer-Policy: no-referrer.
  widgetUrl.searchParams.set('parentOrigin', window.location.origin);
  iframe.src = widgetUrl.toString();
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
    if (e.data?.type === 'sokar-widget-resize' && e.data?.height) {
      if (typeof e.data?.height === 'number' && e.data.height > 0 && e.data.height < 10000) {
        iframe.style.height = e.data.height + 'px';
      }
    }
  });

  script.parentNode.insertBefore(iframe, script.nextSibling);
})();
