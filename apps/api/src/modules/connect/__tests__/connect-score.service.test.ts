/**
 * Tests for the Suppernote Connect completeness score (pure function, no DB).
 *
 * Score = somme des poids (0-100) des items complétés. Chaque item est
 * vérifié via `isItemDone(key, input)`. Le score alimente la barre de
 * progression du dashboard Connect.
 */
import { describe, it, expect } from 'vitest';
import { computeConnectScore } from '../connect-score.service';
import type { ConnectScoreResult } from '../connect-score.service';

function makeBaseRestaurant(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'Chez Suppernote',
    slug: 'chez-suppernote-demo',
    description: 'Une cuisine française raffinée au cœur de Paris, avec une touche créative.',
    coverImageUrl: 'https://cdn.example.com/cover.jpg',
    city: 'Paris',
    formattedAddress: '12 Rue de la Paix, 75002 Paris',
    lat: 48.8698,
    lng: 2.3311,
    cuisineType: ['Français', 'Bistronomique'],
    priceRange: 2,
    ambiance: ['Romantique'],
    dietary: ['Végétarien'],
    openingHours: {
      mon: { open: '12:00', close: '14:30' },
      tue: { open: '12:00', close: '14:30' },
      wed: { open: '12:00', close: '14:30' },
      thu: { open: '12:00', close: '14:30' },
      fri: { open: '12:00', close: '14:30' },
    },
    ...overrides,
  };
}

function makeInput(overrides: Record<string, unknown> = {}) {
  return {
    restaurant: makeBaseRestaurant() as never,
    exposure: {
      maxPartySize: 8,
      capacitySpecials: { totalCapacity: 40 },
    } as never,
    images: [{ id: 'img-1' }] as never,
    ...overrides,
  };
}

describe('computeConnectScore', () => {
  it('retourne un score de 100 pour un profil entièrement rempli', () => {
    const result = computeConnectScore(makeInput());
    expect(result.score).toBe(100);
    expect(result.completed).toBe(result.total);
    expect(result.missing).toEqual([]);
    expect(result.level).toBe('premium');
  });

  it('level = starter quand score < 30', () => {
    const result = computeConnectScore(
      makeInput({
        restaurant: makeBaseRestaurant({
          name: '',
          slug: '',
          description: '',
          coverImageUrl: null,
          city: null,
          formattedAddress: null,
          cuisineType: [],
          openingHours: {},
          priceRange: null,
          ambiance: [],
          dietary: [],
        }),
        exposure: null,
        images: [],
      }),
    );
    expect(result.score).toBe(0);
    expect(result.level).toBe('starter');
    expect(result.missing.length).toBe(result.total);
  });

  it('level = progress quand score entre 30 et 59', () => {
    // name (10) + slug (5) + description (15) + coverImageUrl (15) = 45
    const result = computeConnectScore(
      makeInput({
        restaurant: makeBaseRestaurant({
          city: null,
          formattedAddress: null,
          lat: null,
          lng: null,
          cuisineType: [],
          openingHours: {},
          priceRange: null,
          ambiance: [],
          dietary: [],
        }),
        exposure: null,
        images: [],
      }),
    );
    expect(result.score).toBe(45);
    expect(result.level).toBe('progress');
  });

  it('level = almost quand score entre 60 et 84', () => {
    // 45 (depuis progress) + cuisineType (10) + openingHours (10) + priceRange (5) + ambianceDietary (5) = 75
    const result = computeConnectScore(
      makeInput({
        restaurant: makeBaseRestaurant({
          city: null,
          formattedAddress: null,
          lat: null,
          lng: null,
        }),
        exposure: null,
        images: [],
      }),
    );
    expect(result.score).toBe(75);
    expect(result.level).toBe('almost');
  });

  it('description trop courte (< 20 caractères) ne compte pas comme complétée', () => {
    const result = computeConnectScore(
      makeInput({
        restaurant: makeBaseRestaurant({ description: 'Court.' }),
      }),
    );
    const descItem = result.items.find((i) => i.key === 'description');
    expect(descItem?.done).toBe(false);
  });

  it('openingHours doit couvrir au moins 3 jours pour être complété', () => {
    const twoDays = computeConnectScore(
      makeInput({
        restaurant: makeBaseRestaurant({
          openingHours: {
            mon: { open: '12:00', close: '14:30' },
            tue: { open: '12:00', close: '14:30' },
          },
        }),
      }),
    );
    expect(twoDays.items.find((i) => i.key === 'openingHours')?.done).toBe(false);

    const threeDays = computeConnectScore(
      makeInput({
        restaurant: makeBaseRestaurant({
          openingHours: {
            mon: { open: '12:00', close: '14:30' },
            tue: { open: '12:00', close: '14:30' },
            wed: { open: '12:00', close: '14:30' },
          },
        }),
      }),
    );
    expect(threeDays.items.find((i) => i.key === 'openingHours')?.done).toBe(true);
  });

  it('capacity est complété si maxPartySize > 0 OU totalCapacity > 0', () => {
    const onlyMax = computeConnectScore(
      makeInput({ exposure: { maxPartySize: 6, capacitySpecials: null } as never }),
    );
    expect(onlyMax.items.find((i) => i.key === 'capacity')?.done).toBe(true);

    const onlyTotal = computeConnectScore(
      makeInput({
        exposure: { maxPartySize: 0, capacitySpecials: { totalCapacity: 20 } } as never,
      }),
    );
    expect(onlyTotal.items.find((i) => i.key === 'capacity')?.done).toBe(true);

    const none = computeConnectScore(
      makeInput({ exposure: { maxPartySize: 0, capacitySpecials: null } as never }),
    );
    expect(none.items.find((i) => i.key === 'capacity')?.done).toBe(false);
  });

  it('images est complété à partir de 1 image', () => {
    const zero = computeConnectScore(makeInput({ images: [] }));
    expect(zero.items.find((i) => i.key === 'images')?.done).toBe(false);

    const one = computeConnectScore(makeInput({ images: [{ id: 'img-1' }] }));
    expect(one.items.find((i) => i.key === 'images')?.done).toBe(true);
  });

  it('ambianceDietary est complété si ambiance OU dietary est rempli', () => {
    const onlyAmbiance = computeConnectScore(
      makeInput({
        restaurant: makeBaseRestaurant({ dietary: [] }),
      }),
    );
    expect(onlyAmbiance.items.find((i) => i.key === 'ambianceDietary')?.done).toBe(true);

    const onlyDietary = computeConnectScore(
      makeInput({
        restaurant: makeBaseRestaurant({ ambiance: [] }),
      }),
    );
    expect(onlyDietary.items.find((i) => i.key === 'ambianceDietary')?.done).toBe(true);

    const none = computeConnectScore(
      makeInput({
        restaurant: makeBaseRestaurant({ ambiance: [], dietary: [] }),
      }),
    );
    expect(none.items.find((i) => i.key === 'ambianceDietary')?.done).toBe(false);
  });

  it('la somme des poids fait 100 (invariant du système de score)', () => {
    const result = computeConnectScore(makeInput());
    const totalWeight = result.items.reduce((sum: number, i) => sum + i.weight, 0);
    expect(totalWeight).toBe(100);
  });

  it('missing est trié par poids décroissant', () => {
    const result = computeConnectScore(
      makeInput({
        restaurant: makeBaseRestaurant({ description: '' }),
        exposure: null,
        images: [],
      }),
    );
    for (let i = 1; i < result.missing.length; i++) {
      const prev = result.missing[i - 1] as ConnectScoreResult['missing'][number];
      const curr = result.missing[i] as ConnectScoreResult['missing'][number];
      expect(prev.weight).toBeGreaterThanOrEqual(curr.weight);
    }
  });

  it('le score ne dépasse jamais 100 (capping Math.min)', () => {
    const result = computeConnectScore(makeInput());
    expect(result.score).toBeLessThanOrEqual(100);
  });
});
