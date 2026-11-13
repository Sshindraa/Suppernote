import { describe, expect, it } from 'vitest';
import {
  formatMcpErrorContent,
  formatMcpErrorMessage,
  formatMcpSuccessContent,
  formatMcpSuccessMessage,
} from '../presentation';

describe('MCP human-facing messages', () => {
  it('returns the minimal availability answer unchanged', () => {
    const message =
      'Oui, une table est disponible pour 2 personnes au restaurant Chez Suppernote à 19 h.';
    expect(formatMcpSuccessMessage('answer_availability', { message }, {})).toBe(message);
    expect(formatMcpSuccessContent('2025-06-18', 'answer_availability', { message }, {})).toBe(
      message,
    );
  });

  it('résume en français une recherche exacte sans exposer le résultat structuré', () => {
    const message = formatMcpSuccessMessage(
      'search_restaurants',
      {
        searchOutcome: 'no_exact_slot_available',
        requestedRestaurant: {
          id: '550e8400-e29b-41d4-a716-446655440003',
          name: 'Chez Suppernote',
          status: 'unavailable',
        },
        restaurants: [],
        capacityLimits: [],
      },
      {
        city: 'Lyon',
        restaurantName: 'Chez Suppernote',
        partySize: 2,
        slotStart: '2026-10-01T19:00:00',
      },
    );

    expect(message).toBe(
      'Le restaurant Chez Suppernote n’a pas de disponibilité le jeudi 1er octobre à 19 h pour 2 personnes.',
    );
    expect(message).not.toContain('550e8400');
    expect(message).not.toContain('{');
  });

  it('formule une disponibilité naturelle sans inventer une fin de créneau', () => {
    expect(
      formatMcpSuccessMessage(
        'check_availability',
        { available: true, decision: 'available' },
        { partySize: 2, slotStart: '2026-10-01T19:00:00', timezone: 'Europe/Paris' },
      ),
    ).toBe('Une table est disponible le jeudi 1er octobre à 19 h pour 2 personnes.');
  });

  it('prépare une réponse complète et naturelle pour la recherche nommée', () => {
    expect(
      formatMcpSuccessMessage(
        'search_restaurants',
        {
          requestedRestaurant: { name: 'Chez Suppernote', status: 'available' },
          restaurants: [
            {
              name: 'Chez Suppernote',
              availableSlots: [
                {
                  startsAt: '2026-10-01T17:00:00.000Z',
                  endsAt: '2026-10-01T18:30:00.000Z',
                },
              ],
            },
          ],
          capacityLimits: [],
        },
        {
          city: 'Lyon',
          restaurantName: 'Chez Suppernote',
          partySize: 2,
          slotStart: '2026-10-01T19:00:00',
          timezone: 'Europe/Paris',
        },
      ),
    ).toBe(
      'Oui, une table est disponible pour 2 personnes au restaurant Chez Suppernote le jeudi 1er octobre à 19 h.',
    );
  });

  it('distingue une fiche absente sans dire au client de fournir un identifiant', () => {
    expect(
      formatMcpSuccessMessage(
        'search_restaurants',
        {
          requestedRestaurant: { name: 'Chez Suppernote', status: 'not_found' },
          restaurants: [],
          capacityLimits: [],
        },
        {
          city: 'Lyon',
          restaurantName: 'Chez Suppernote',
          partySize: 2,
          slotStart: '2026-10-01T19:00:00',
        },
      ),
    ).toBe('Je ne trouve pas de fiche accessible pour Chez Suppernote à Lyon.');
  });

  it('formule les autres succès sans identifiants ni détails internes', () => {
    expect(
      formatMcpSuccessMessage(
        'create_reservation',
        { reservationId: '550e8400-e29b-41d4-a716-446655440003', state: 'CONFIRMED', reused: true },
        {},
      ),
    ).toBe('La réservation est confirmée.');
    expect(formatMcpSuccessMessage('cancel_reservation', { cancelled: true }, {})).toBe(
      'Votre réservation est annulée.',
    );
  });

  it('transforme les erreurs techniques en prochaine étape compréhensible', () => {
    expect(formatMcpErrorMessage('create_reservation', 'IDEMPOTENCY_CONFLICT')).toBe(
      'Cette réservation n’a pas été répétée, car les informations ne correspondent pas au premier essai.',
    );
    expect(formatMcpErrorMessage('check_availability', 'SLOT_UNAVAILABLE')).toContain(
      'Ce créneau n’est plus disponible',
    );
  });

  it('préserve le format JSON pour les clients MCP sans structuredContent', () => {
    const data = { reservationId: 'reservation-id', state: 'CONFIRMED', reused: false };
    expect(formatMcpSuccessContent('2025-03-26', 'create_reservation', data, {})).toBe(
      JSON.stringify(data),
    );
    expect(formatMcpSuccessContent('2025-11-25', 'create_reservation', data, {})).toBe(
      'La réservation est confirmée.',
    );
    expect(
      formatMcpErrorContent('2025-03-26', 'create_reservation', 'internal detail', 'INTERNAL'),
    ).toBe(JSON.stringify({ ok: false, error: 'internal detail', code: 'INTERNAL' }));
    expect(
      formatMcpErrorContent('2025-11-25', 'create_reservation', 'internal detail', 'INTERNAL'),
    ).toBe(
      'Je rencontre un problème temporaire et je n’ai pas pu terminer. Réessayez un peu plus tard.',
    );
  });
});
