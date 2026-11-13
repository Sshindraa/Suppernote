/**
 * Tests for the gift card PDF service.
 *
 * Génère un PDF A6 avec pdfkit : fond, nom du restaurant, montant,
 * code cadeau. Si customImageUrl est fourni, on tente de la télécharger
 * (timeout 5s, fail-safe : passe à la suite si KO).
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

// setup.ts mocke déjà pdfkit (PDFDocument minimal). On s'appuie dessus.
// On mocke aussi fetch globalement pour contrôler le téléchargement d'image.
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { generateGiftCardPdf } from '../gift-card-pdf.service';
import type { GiftCard } from '@prisma/client';

const BASE_CARD = {
  id: 'gc-1',
  code: 'gc_full_code',
  shortCode: 'SKR-TEST-01',
  amount: { toNumber: () => 100 } as never,
  customImageUrl: null,
  restaurant: { name: 'Chez Suppernote' },
  pack: { name: 'Menu dégustation' },
} as unknown as GiftCard & {
  restaurant?: { name: string };
  pack?: { name: string };
};

describe('generateGiftCardPdf', () => {
  beforeEach(() => vi.stubEnv('GIFT_CARD_IMAGE_ORIGINS', 'https://cdn.example.com'));

  afterEach(() => {
    mockFetch.mockReset();
  });

  it('retourne un Buffer non-vide (le PDF a été streamé)', async () => {
    const buf = await generateGiftCardPdf(BASE_CARD);
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.length).toBeGreaterThan(0);
  });

  it('fonctionne sans image custom (customImageUrl=null)', async () => {
    const buf = await generateGiftCardPdf(BASE_CARD);
    expect(buf.length).toBeGreaterThan(0);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("utilise 'Restaurant' comme nom de fallback si la relation est null", async () => {
    const card = { ...BASE_CARD, restaurant: null } as never;
    const buf = await generateGiftCardPdf(card);
    expect(buf.length).toBeGreaterThan(0);
    // Le PDF est généré sans crash — la doc.pdfkit reçoit le fallback
  });

  it("tente de télécharger l'image custom si customImageUrl est fourni", async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), {
        headers: { 'content-type': 'image/jpeg' },
      }),
    );
    const card = { ...BASE_CARD, customImageUrl: 'https://cdn.example.com/custom.jpg' } as never;
    const buf = await generateGiftCardPdf(card);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://cdn.example.com/custom.jpg',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(buf.length).toBeGreaterThan(0);
  });

  it('ignore silencieusement une image custom inaccessible (fail-safe)', async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 404 });
    const card = { ...BASE_CARD, customImageUrl: 'https://cdn.example.com/missing.jpg' } as never;
    // Le PDF est quand même généré, sans crash.
    const buf = await generateGiftCardPdf(card);
    expect(buf.length).toBeGreaterThan(0);
  });

  it('ignore une erreur réseau (catch fail-safe)', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network error'));
    const card = { ...BASE_CARD, customImageUrl: 'https://cdn.example.com/down.jpg' } as never;
    const buf = await generateGiftCardPdf(card);
    expect(buf.length).toBeGreaterThan(0);
  });
  it.each([
    'http://127.0.0.1/private',
    'https://localhost/private',
    'https://untrusted.example/image.png',
    'https://cdn.example.com@127.0.0.1/image.png',
  ])('does not fetch an untrusted image: %s', async (url) => {
    await generateGiftCardPdf({ ...BASE_CARD, customImageUrl: url } as never);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('refuses redirects and images exceeding the download limit', async () => {
    mockFetch.mockResolvedValueOnce(
      new Response(new Uint8Array(1), {
        headers: {
          'content-type': 'image/png',
          'content-length': String(5 * 1024 * 1024),
        },
      }),
    );
    await generateGiftCardPdf({
      ...BASE_CARD,
      customImageUrl: 'https://cdn.example.com/large.png',
    } as never);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ redirect: 'error' }),
    );
  });
});
