import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getOnboardingPlaceDetails,
  isOnboardingPlacesEnabled,
  searchOnboardingPlaces,
} from './onboarding-places.service';

const fetchMock = vi.fn();

describe('onboarding Google Places service', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('keeps onboarding search disabled until its dedicated flag and server key are set', () => {
    vi.stubEnv('GOOGLE_PLACES_API_KEY', 'test-server-key');
    vi.stubEnv('GOOGLE_PLACES_ONBOARDING_ENABLED', 'false');
    expect(isOnboardingPlacesEnabled()).toBe(false);

    vi.stubEnv('GOOGLE_PLACES_ONBOARDING_ENABLED', 'true');
    expect(isOnboardingPlacesEnabled()).toBe(true);

    vi.stubEnv('GOOGLE_PLACES_API_KEY', '');
    expect(isOnboardingPlacesEnabled()).toBe(false);
  });

  it('uses one autocomplete session token and returns only place identifiers and labels', async () => {
    vi.stubEnv('GOOGLE_PLACES_API_KEY', 'test-server-key');
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          suggestions: [
            {
              placePrediction: {
                placeId: 'ChIJrestaurant123',
                text: { text: 'Chez Suppernote, Lyon' },
                structuredFormat: {
                  mainText: { text: 'Chez Suppernote' },
                  secondaryText: { text: 'Lyon, France' },
                },
              },
            },
          ],
        }),
        { status: 200 },
      ),
    );

    const suggestions = await searchOnboardingPlaces('Chez Suppernote Lyon', 'test');

    expect(suggestions).toEqual([
      { placeId: 'ChIJrestaurant123', mainText: 'Chez Suppernote', secondaryText: 'Lyon, France' },
    ]);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({
      input: 'Chez Suppernote Lyon',
      sessionToken: 'test',
      languageCode: 'fr',
      includedRegionCodes: ['fr'],
      includedPrimaryTypes: ['restaurant'],
    });
    expect(fetchMock.mock.calls[0][1].headers['X-Goog-Api-Key']).toBe('test-server-key');
  });

  it('maps reservation-friendly hours, normalizes the public phone, and flags unsupported hours', async () => {
    vi.stubEnv('GOOGLE_PLACES_API_KEY', 'test-server-key');
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          displayName: { text: 'Chez Suppernote' },
          location: { latitude: 45.76, longitude: 4.83 },
          formattedAddress: '12 Rue de la Paix, 69002 Lyon, France',
          addressComponents: [
            { longText: '12', types: ['street_number'] },
            { longText: 'Rue de la Paix', types: ['route'] },
            { longText: '69002', types: ['postal_code'] },
            { longText: 'Lyon', types: ['locality'] },
            { longText: 'France', shortText: 'FR', types: ['country'] },
          ],
          internationalPhoneNumber: '+33 4 12 34 56 78',
          regularOpeningHours: {
            periods: [
              { open: { day: 1, hour: 12, minute: 0 }, close: { day: 1, hour: 14, minute: 30 } },
              { open: { day: 1, hour: 19, minute: 0 }, close: { day: 1, hour: 22, minute: 0 } },
              { open: { day: 2, hour: 0, minute: 0 } },
            ],
          },
        }),
        { status: 200 },
      ),
    );

    const details = await getOnboardingPlaceDetails('ChIJrestaurant123', 'session-token');

    expect(details).toMatchObject({
      placeId: 'ChIJrestaurant123',
      name: 'Chez Suppernote',
      lat: 45.76,
      lng: 4.83,
      formattedAddress: '12 Rue de la Paix',
      postalCode: '69002',
      city: 'Lyon',
      country: 'FR',
      phoneE164: '+33412345678',
      openingHours: {
        mon: {
          open: '12:00',
          close: '22:00',
          slots: [
            { open: '12:00', close: '14:30' },
            { open: '19:00', close: '22:00' },
          ],
        },
        tue: null,
      },
      hoursNeedReview: ['tue'],
    });
    expect(fetchMock.mock.calls[0][1].headers['X-Goog-FieldMask']).toContain('regularOpeningHours');
    expect(fetchMock.mock.calls[0][0]).not.toContain('location=');
  });
});
