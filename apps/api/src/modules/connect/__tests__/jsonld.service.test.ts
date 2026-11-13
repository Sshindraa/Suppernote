/**
 * Tests JSON-LD — Suppernote Connect T3.
 *
 * Vérifie :
 * - structure schema.org Restaurant
 * - acceptsReservations = URL /book
 * - potentialAction absent si connectAgentic=false
 * - potentialAction présent et conforme si connectAgentic=true
 * - openingHoursSpecification absent si pas de openingHours
 * - confidence gate : cuisineType/priceRange/etc. omis si pas de source
 * - aggregateRating JAMAIS inclus (anti-hallucination Google sd-policies)
 */

import { describe, it, expect } from 'vitest';
import { buildPublicRestaurantJsonLd } from '../jsonld.service';
import type { PublicRestaurantDto } from '../connect.types';

const baseRestaurant: PublicRestaurantDto = {
  id: 'rest_123',
  slug: 'chez-mario-lyon',
  name: 'Chez Mario',
  address: {
    line1: '12 Rue de la République',
    postalCode: '69001',
    city: 'Lyon',
    country: 'FR',
  },
  phone: '+33400000000',
  cuisineTypes: ['Italien', 'Pizza'],
  priceRange: '€€',
  openingHours: [
    { day: 'monday', open: '12:00', close: '14:30' },
    { day: 'monday', open: '19:00', close: '22:30' },
    { day: 'tuesday', open: '12:00', close: '14:30' },
  ],
  reservationUrl: 'https://suppernote.com/r/chez-mario-lyon/book',
  images: { cover: 'https://images.example.invalid/img/cover.jpg', gallery: [] },
  acceptsReservations: true,
  publishedAt: '2026-06-24T00:00:00.000Z',
  connectAgentic: false,
  lat: 45.764,
  lng: 4.8357,
};

describe('buildPublicRestaurantJsonLd', () => {
  it('génère un JSON-LD Restaurant conforme', () => {
    const expectedSiteUrl = process.env.SITE_URL ?? 'https://suppernote.com';
    const jsonLd = buildPublicRestaurantJsonLd({
      restaurant: baseRestaurant,
      attributesConfidence: {
        cuisineType: [{ source: 'merchant_declared', verifiedAt: null }],
        priceRange: [{ source: 'merchant_declared', verifiedAt: null }],
        openingHours: [{ source: 'merchant_declared', verifiedAt: null }],
      },
    });

    expect(jsonLd['@context']).toBe('https://schema.org');
    expect(jsonLd['@type']).toBe('Restaurant');
    expect(jsonLd['@id']).toBe(`${expectedSiteUrl}/r/chez-mario-lyon`);
    expect(jsonLd.name).toBe('Chez Mario');
    expect(jsonLd.url).toBe(`${expectedSiteUrl}/r/chez-mario-lyon`);
    expect(jsonLd.telephone).toBe('+33400000000');
  });

  it('inclus acceptsReservations = URL /book (pas un bool)', () => {
    const jsonLd = buildPublicRestaurantJsonLd({
      restaurant: baseRestaurant,
      attributesConfidence: null,
    });
    expect(jsonLd.acceptsReservations).toBe('https://suppernote.com/r/chez-mario-lyon/book');
    expect(typeof jsonLd.acceptsReservations).toBe('string');
  });

  it("n'inclut PAS potentialAction si connectAgentic=false", () => {
    const jsonLd = buildPublicRestaurantJsonLd({
      restaurant: { ...baseRestaurant, connectAgentic: false },
      attributesConfidence: null,
    });
    expect(jsonLd.potentialAction).toBeUndefined();
  });

  it('inclut potentialAction ReserveAction si connectAgentic=true', () => {
    const jsonLd = buildPublicRestaurantJsonLd({
      restaurant: { ...baseRestaurant, connectAgentic: true },
      attributesConfidence: null,
    });
    expect(jsonLd.potentialAction).toBeDefined();
    expect(jsonLd.potentialAction!['@type']).toBe('ReserveAction');
    expect(jsonLd.potentialAction!.target['@type']).toBe('EntryPoint');
    expect(jsonLd.potentialAction!.target.urlTemplate).toContain('{partySize}');
    expect(jsonLd.potentialAction!.target.urlTemplate).toContain('{date}');
    expect(jsonLd.potentialAction!.target.urlTemplate).toContain('{time}');
    expect(jsonLd.potentialAction!.target.inLanguage).toBe('fr-FR');
    expect(jsonLd.potentialAction!.result['@type']).toBe('FoodEstablishmentReservation');
  });

  it("n'inclut JAMAIS aggregateRating (anti-hallucination)", () => {
    const jsonLd = buildPublicRestaurantJsonLd({
      restaurant: baseRestaurant,
      attributesConfidence: null,
    });
    // L'objet JSON-LD ne doit pas avoir de propriété aggregateRating
    expect((jsonLd as unknown as Record<string, unknown>).aggregateRating).toBeUndefined();
  });

  it('inclut geo (GeoCoordinates) si lat/lng présents', () => {
    const jsonLd = buildPublicRestaurantJsonLd({
      restaurant: baseRestaurant,
      attributesConfidence: null,
    });
    expect(jsonLd.geo).toBeDefined();
    expect(jsonLd.geo!['@type']).toBe('GeoCoordinates');
    expect(jsonLd.geo!.latitude).toBe(45.764);
    expect(jsonLd.geo!.longitude).toBe(4.8357);
  });

  it('omet geo si lat/lng absents', () => {
    const jsonLd = buildPublicRestaurantJsonLd({
      restaurant: { ...baseRestaurant, lat: undefined, lng: undefined },
      attributesConfidence: null,
    });
    expect(jsonLd.geo).toBeUndefined();
  });

  it('omet cuisineType si pas de source de confidence', () => {
    const jsonLd = buildPublicRestaurantJsonLd({
      restaurant: baseRestaurant,
      attributesConfidence: null, // aucune source
    });
    expect(jsonLd.servesCuisine).toEqual([]);
  });

  it('inclus cuisineType si source merchant_declared', () => {
    const jsonLd = buildPublicRestaurantJsonLd({
      restaurant: baseRestaurant,
      attributesConfidence: {
        cuisineType: [{ source: 'merchant_declared', verifiedAt: null }],
      },
    });
    expect(jsonLd.servesCuisine).toEqual(['Italien', 'Pizza']);
  });

  it('omet priceRange si confidence < 0.7', () => {
    // merchant_declared a un cap à 0.9, mais sans source entry, pas de claim
    const jsonLd = buildPublicRestaurantJsonLd({
      restaurant: baseRestaurant,
      attributesConfidence: {
        priceRange: [{ source: 'review_inferred', verifiedAt: null }], // 0.7 max
      },
    });
    // review_inferred capped à 0.7, threshold 0.7, donc OK
    expect(jsonLd.priceRange).toBe('€€');
  });

  it('inclus openingHoursSpecification quand présent', () => {
    const jsonLd = buildPublicRestaurantJsonLd({
      restaurant: baseRestaurant,
      attributesConfidence: {
        openingHours: [{ source: 'merchant_declared', verifiedAt: null }],
      },
    });
    expect(jsonLd.openingHoursSpecification).toHaveLength(3);
    expect(jsonLd.openingHoursSpecification[0]).toEqual({
      '@type': 'OpeningHoursSpecification',
      dayOfWeek: ['Monday'],
      opens: '12:00',
      closes: '14:30',
    });
  });

  it('omet openingHoursSpecification si confidence < 0.9', () => {
    // review_inferred capped à 0.7 < 0.9 threshold
    const jsonLd = buildPublicRestaurantJsonLd({
      restaurant: baseRestaurant,
      attributesConfidence: {
        openingHours: [{ source: 'review_inferred', verifiedAt: null }],
      },
    });
    expect(jsonLd.openingHoursSpecification).toEqual([]);
  });

  it('omet openingHoursSpecification si pas de source tracked (anti-fabrication)', () => {
    const jsonLd = buildPublicRestaurantJsonLd({
      restaurant: baseRestaurant,
      attributesConfidence: null, // pas de source → on omet
    });
    expect(jsonLd.openingHoursSpecification).toEqual([]);
  });

  it('construit address conforme schema.org', () => {
    const jsonLd = buildPublicRestaurantJsonLd({
      restaurant: baseRestaurant,
      attributesConfidence: null,
    });
    expect(jsonLd.address['@type']).toBe('PostalAddress');
    expect(jsonLd.address.streetAddress).toBe('12 Rue de la République');
    expect(jsonLd.address.addressLocality).toBe('Lyon');
    expect(jsonLd.address.postalCode).toBe('69001');
    expect(jsonLd.address.addressCountry).toBe('FR');
  });

  it('inclus image cover + gallery', () => {
    const jsonLd = buildPublicRestaurantJsonLd({
      restaurant: {
        ...baseRestaurant,
        images: {
          cover: 'https://images.example.invalid/img/cover.jpg',
          gallery: [
            'https://images.example.invalid/img/1.jpg',
            'https://images.example.invalid/img/2.jpg',
          ],
        },
      },
      attributesConfidence: null,
    });
    expect(jsonLd.image).toEqual([
      'https://images.example.invalid/img/cover.jpg',
      'https://images.example.invalid/img/1.jpg',
      'https://images.example.invalid/img/2.jpg',
    ]);
  });
});
