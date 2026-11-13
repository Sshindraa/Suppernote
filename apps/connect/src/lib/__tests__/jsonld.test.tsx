/**
 * Tests unitaires pour le composant ReservationJsonLd.
 */

import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { ReservationJsonLd, type RestaurantJsonLd } from '@/lib/jsonld';

function makeJsonLd(overrides: Partial<RestaurantJsonLd> = {}): RestaurantJsonLd {
  return {
    '@context': 'https://schema.org',
    '@type': 'Restaurant',
    '@id': 'https://suppernote.com/restaurant/chez-sokar',
    name: 'Chez Suppernote',
    url: 'https://suppernote.com/restaurant/chez-sokar',
    telephone: '+33123456789',
    servesCuisine: ['Française'],
    acceptsReservations: true,
    address: {
      '@type': 'PostalAddress',
      streetAddress: '12 rue de la Paix',
      addressLocality: 'Paris',
      addressCountry: 'FR',
    },
    openingHoursSpecification: [],
    ...overrides,
  };
}

describe('ReservationJsonLd component', () => {
  it('renders a script tag with application/ld+json type', () => {
    const { container } = render(<ReservationJsonLd jsonLd={makeJsonLd()} />);
    const script = container.querySelector('script[type="application/ld+json"]');
    expect(script).not.toBeNull();
  });

  it('injects the JSON-LD content via dangerouslySetInnerHTML', () => {
    const { container } = render(
      <ReservationJsonLd jsonLd={makeJsonLd({ name: 'Chez Suppernote' })} />,
    );
    const script = container.querySelector('script[type="application/ld+json"]');
    expect(script?.textContent).toContain('"@type":"Restaurant"');
    expect(script?.textContent).toContain('"name":"Chez Suppernote"');
  });

  it('does not add a per-request nonce to the data block', () => {
    const { container } = render(<ReservationJsonLd jsonLd={makeJsonLd()} />);
    const script = container.querySelector('script[type="application/ld+json"]');
    expect(script?.getAttribute('nonce')).toBeNull();
  });
});
