/**
 * Vérifie que le snippet JS embarquable est bien présent et structuré,
 * puis exécute son comportement dans jsdom (mode inline, mode fenêtre, signal).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInThisContext } from 'node:vm';

const embedPath = resolve(__dirname, '../../public/embed.js');
const code = readFileSync(embedPath, 'utf-8');

describe('/embed.js', () => {
  it('exists and contains the required data attributes', () => {
    expect(code).toContain('data-slug');
    expect(code).toContain('data-host');
    expect(code).toContain('data-primary');
    expect(code).toContain('data-accent');
    expect(code).toContain('sokar-widget-resize');
    expect(code).toContain('/widget/');
  });

  it('transmet parentOrigin au widget dans l URL', () => {
    expect(code).toContain("searchParams.set('parentOrigin'");
  });

  it('valide e.source === iframe.contentWindow dans le listener', () => {
    expect(code).toContain('e.source !== iframe.contentWindow');
  });
});

// ---- Comportement (jsdom) ----

type Recorded = [EventTarget, string, EventListenerOrEventListenerObject, unknown];

const realAddEventListener = EventTarget.prototype.addEventListener;
const realRemoveEventListener = EventTarget.prototype.removeEventListener;
let recorded: Recorded[] = [];

// jsdom ne gère pas <dialog> : on ajoute une implémentation minimale pour les tests.
if (typeof HTMLDialogElement.prototype.showModal !== 'function') {
  HTMLDialogElement.prototype.showModal = function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
}
if (typeof HTMLDialogElement.prototype.close !== 'function') {
  HTMLDialogElement.prototype.close = function (this: HTMLDialogElement) {
    this.removeAttribute('open');
  };
}

// Le snippet ajoute des écouteurs sur document/window : on les retire après chaque test
// pour qu'une instance ne intercepte pas les clics du test suivant.
function runEmbed(attrs: Record<string, string>, body = '') {
  document.body.replaceChildren();
  document.body.insertAdjacentHTML('beforeend', body);
  const script = document.createElement('script');
  script.setAttribute('data-slug', 'demo');
  for (const [k, v] of Object.entries(attrs)) script.setAttribute(k, v);
  document.body.appendChild(script);
  Object.defineProperty(document, 'currentScript', { configurable: true, get: () => script });
  // Le snippet est un IIFE : on l'exécute avec document.currentScript = notre <script>.
  runInThisContext(code);
  return script;
}

function click(el: Element, init: MouseEventInit = {}) {
  const ev = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init });
  el.dispatchEvent(ev);
  return ev;
}

function widgetFrame(): HTMLIFrameElement {
  return document.querySelector('dialog iframe') as HTMLIFrameElement;
}

function isOpen(): boolean {
  return document.querySelector('dialog')?.hasAttribute('open') ?? false;
}

describe('/embed.js — comportement', () => {
  let beacon: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    recorded = [];
    EventTarget.prototype.addEventListener = function (
      this: EventTarget,
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ) {
      if (this === document || this === window) recorded.push([this, type, listener, options]);
      return realAddEventListener.call(this, type, listener, options);
    } as typeof realAddEventListener;
    beacon = vi.fn(() => true);
    Object.defineProperty(navigator, 'sendBeacon', { configurable: true, value: beacon });
  });

  afterEach(() => {
    EventTarget.prototype.addEventListener = realAddEventListener;
    for (const [target, type, listener, options] of recorded) {
      realRemoveEventListener.call(target, type, listener, options as boolean);
    }
    recorded = [];
    delete (document as Partial<Document> & { currentScript?: unknown }).currentScript;
    delete (navigator as Partial<Navigator> & { sendBeacon?: unknown }).sendBeacon;
    document.getElementById('suppernote-embed-style')?.remove();
    delete (window as Partial<Window> & { dataLayer?: unknown[] }).dataLayer;
    vi.useRealTimers();
    document.body.replaceChildren();
  });

  describe('mode inline (rétrocompatibilité)', () => {
    it('data-mode="inline" : iframe insérée après le script, pas de dialog', () => {
      const script = runEmbed(
        { 'data-mode': 'inline', 'data-primary': '#112233', 'data-accent': '#ff0000' },
        '<a href="https://suppernote.com/restaurant/demo">Réserver</a>',
      );
      const iframe = script.nextElementSibling as HTMLIFrameElement;
      expect(iframe.tagName).toBe('IFRAME');
      expect(iframe.src).toContain('/widget/demo');
      expect(iframe.src).toContain('embedded=1');
      expect(iframe.src).toContain('primary=112233');
      expect(iframe.src).toContain('accent=ff0000');
      expect(iframe.src).toContain('parentOrigin=');
      expect(document.querySelector('dialog')).toBeNull();
    });

    it('sans aucun déclencheur : iframe inline', () => {
      const script = runEmbed({}, '<p>Pas de bouton</p>');
      expect((script.nextElementSibling as HTMLIFrameElement).tagName).toBe('IFRAME');
      expect(document.querySelector('dialog')).toBeNull();
    });
  });

  describe('mode fenêtre', () => {
    const LINK = '<a id="cta" href="https://suppernote.com/restaurant/demo">Réserver</a>';

    it('clic sur un lien de réservation : annulé et dialog ouvert', () => {
      runEmbed({}, LINK);
      const ev = click(document.getElementById('cta')!);
      expect(ev.defaultPrevented).toBe(true);
      expect(isOpen()).toBe(true);
      expect(widgetFrame().src).toContain('/widget/demo');
      expect(widgetFrame().src).toContain('embedded=1');
    });

    it('cmd-clic : non intercepté', () => {
      runEmbed({}, LINK);
      const ev = click(document.getElementById('cta')!, { metaKey: true });
      expect(ev.defaultPrevented).toBe(false);
      expect(document.querySelector('dialog')).toBeNull();
    });

    it('target="_blank" : non intercepté', () => {
      runEmbed(
        {},
        '<a id="cta" target="_blank" href="https://suppernote.com/restaurant/demo">R</a>',
      );
      const ev = click(document.getElementById('cta')!);
      expect(ev.defaultPrevented).toBe(false);
    });

    it('Échap ferme et rend le focus au déclencheur', () => {
      runEmbed({}, LINK);
      const trigger = document.getElementById('cta')!;
      click(trigger);
      expect(isOpen()).toBe(true);
      document.querySelector('dialog')!.dispatchEvent(new Event('cancel', { cancelable: true }));
      expect(isOpen()).toBe(false);
      expect(document.activeElement).toBe(trigger);
    });

    it('bouton fermer accessible', () => {
      runEmbed({}, LINK);
      click(document.getElementById('cta')!);
      const close = document.querySelector('dialog .suppernote-close') as HTMLButtonElement;
      expect(close.getAttribute('aria-label')).toBe('Fermer');
      close.click();
      expect(isOpen()).toBe(false);
    });

    it('secours : sans réponse du widget après 3 s, la page se recharge sur le lien', () => {
      vi.useFakeTimers();
      runEmbed({}, LINK);
      click(document.getElementById('cta')!);
      vi.advanceTimersByTime(2999);
      expect(isOpen()).toBe(true);
      vi.advanceTimersByTime(1);
      expect(isOpen()).toBe(false);
    });

    it('un message ready du widget annule le secours', () => {
      vi.useFakeTimers();
      runEmbed({}, LINK);
      click(document.getElementById('cta')!);
      window.dispatchEvent(
        new MessageEvent('message', {
          origin: 'https://suppernote.com',
          source: widgetFrame().contentWindow,
          data: { type: 'suppernote-widget-ready' },
        }),
      );
      vi.advanceTimersByTime(5000);
      expect(isOpen()).toBe(true);
    });

    it('data-suppernote-book : déclencheur, paramètres party/date/source transmis', () => {
      runEmbed(
        {},
        '<button id="b" data-suppernote-book data-party="2" data-date="2026-12-01" data-source="gbp">R</button>',
      );
      click(document.getElementById('b')!);
      const src = new URL(widgetFrame().src);
      expect(src.searchParams.get('party')).toBe('2');
      expect(src.searchParams.get('date')).toBe('2026-12-01');
      expect(src.searchParams.get('source')).toBe('gbp');
    });

    it('préchargement : pointerover crée une iframe cachée', () => {
      runEmbed({}, LINK);
      document.getElementById('cta')!.dispatchEvent(new Event('pointerover', { bubbles: true }));
      expect(widgetFrame()).not.toBeNull();
      expect(widgetFrame().src).toContain('/widget/demo');
      expect(isOpen()).toBe(false);
    });

    it('suppernote-booked : événement window et dataLayer, sans donnée personnelle', () => {
      const dataLayer: unknown[] = [];
      (window as Window & { dataLayer?: unknown[] }).dataLayer = dataLayer;
      const onBooked = vi.fn();
      window.addEventListener('suppernote:booked', onBooked);
      runEmbed(
        {},
        '<a id="cta" data-source="gbp" href="https://suppernote.com/restaurant/demo">R</a>',
      );
      click(document.getElementById('cta')!);
      window.dispatchEvent(
        new MessageEvent('message', {
          origin: 'https://suppernote.com',
          source: widgetFrame().contentWindow,
          data: { type: 'suppernote-booked' },
        }),
      );
      const expected = { slug: 'demo', source: 'gbp' };
      expect((onBooked.mock.calls[0][0] as CustomEvent).detail).toEqual(expected);
      expect(dataLayer).toEqual([{ event: 'suppernote_booked', ...expected }]);
      window.removeEventListener('suppernote:booked', onBooked);
    });

    it('message d’une autre source ignoré', () => {
      runEmbed({}, LINK);
      click(document.getElementById('cta')!);
      window.dispatchEvent(
        new MessageEvent('message', {
          origin: 'https://evil.example',
          source: widgetFrame().contentWindow,
          data: { type: 'suppernote-booked' },
        }),
      );
      expect((window as Window & { dataLayer?: unknown }).dataLayer).toBeUndefined();
    });
  });

  describe('signal d’installation (heartbeat)', () => {
    it('envoie le payload attendu vers l’API de la prod', () => {
      runEmbed(
        {},
        '<button data-suppernote-book>R</button><a href="https://suppernote.com/widget/demo">W</a>',
      );
      expect(beacon).toHaveBeenCalledTimes(1);
      const [url, payload] = beacon.mock.calls[0] as unknown as [string, string];
      expect(url).toBe('https://api.suppernote.com/public/embed/heartbeat');
      expect(JSON.parse(payload)).toEqual({
        slug: 'demo',
        origin: window.location.origin,
        version: '2',
        mode: 'modal',
        buttons: 2,
      });
    });

    it('pas d’envoi sur localhost sans data-api-host', () => {
      runEmbed({ 'data-host': 'http://localhost:4002' }, LINK_DEV);
      expect(beacon).not.toHaveBeenCalled();
    });
  });
});

const LINK_DEV = '<a href="http://localhost:4002/restaurant/demo">R</a>';
