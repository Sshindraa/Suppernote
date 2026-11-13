import { describe, expect, it } from 'vitest';
import {
  buildMarketingConsentLabel,
  buildMarketingConsentProof,
  describeMarketingConsentSource,
  MARKETING_CONSENT_CHANNELS,
  MARKETING_CONSENT_COLLECTION_LABELS,
  MARKETING_CONSENT_COLLECTION_METHODS,
  MARKETING_CONSENT_VERSION,
} from '../marketing-consent';

describe('marketing consent wording', () => {
  it('names the restaurant and the channel in a short label', () => {
    expect(buildMarketingConsentLabel('EMAIL', 'Chez Suppernote')).toBe(
      'Recevoir les offres et actualités du restaurant Chez Suppernote par e-mail',
    );
    expect(buildMarketingConsentLabel('SMS', 'Chez Suppernote')).toBe(
      'Recevoir les offres et actualités du restaurant Chez Suppernote par SMS',
    );
  });

  it('falls back to a neutral name when the restaurant has none', () => {
    expect(buildMarketingConsentLabel('EMAIL', '   ')).toBe(
      'Recevoir les offres et actualités de ce restaurant par e-mail',
    );
  });

  it('builds a proof bound to the version, the channel and the exact sentence', () => {
    const proof = buildMarketingConsentProof('EMAIL', 'Chez Suppernote');
    expect(proof).toBe(
      `${MARKETING_CONSENT_VERSION}|EMAIL|${buildMarketingConsentLabel('EMAIL', 'Chez Suppernote')}`,
    );
    expect(buildMarketingConsentProof('SMS', 'Chez Suppernote')).not.toBe(proof);
    expect(buildMarketingConsentProof('EMAIL', 'Autre')).not.toBe(proof);
  });

  it('never uses informal « tu » wording', () => {
    for (const channel of MARKETING_CONSENT_CHANNELS) {
      expect(buildMarketingConsentLabel(channel, 'Chez Suppernote')).not.toMatch(
        /\b(tu|ton|ta|tes)\b/i,
      );
    }
    for (const method of MARKETING_CONSENT_COLLECTION_METHODS) {
      expect(MARKETING_CONSENT_COLLECTION_LABELS[method]).not.toMatch(/\b(tu|ton|ta|tes)\b/i);
    }
  });

  it('describes known sources and keeps unknown ones readable as they are', () => {
    expect(describeMarketingConsentSource('CONNECT')).toBe(
      'Page de réservation Suppernote Connect',
    );
    expect(describeMarketingConsentSource('PILOT_INTERNAL')).toBe('PILOT_INTERNAL');
  });
});
