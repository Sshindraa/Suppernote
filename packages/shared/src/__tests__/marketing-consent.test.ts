import { describe, expect, it } from 'vitest';
import {
  buildCombinedMarketingConsentLabel,
  buildCombinedMarketingConsentProof,
  buildMarketingConsentLabel,
  buildEmailMarketingConsentLabel,
  buildEmailMarketingConsentProof,
  buildMarketingConsentProof,
  describeMarketingConsentSource,
  MARKETING_CONSENT_EMAIL_VERSION,
  MARKETING_CONSENT_CHANNELS,
  MARKETING_CONSENT_COLLECTION_LABELS,
  MARKETING_CONSENT_COLLECTION_METHODS,
  MARKETING_CONSENT_COMBINED_VERSION,
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

  it('names every channel of the single box, in a fixed order', () => {
    expect(buildCombinedMarketingConsentLabel(['SMS', 'EMAIL'], 'Chez Suppernote')).toBe(
      'Recevoir les offres et actualités du restaurant Chez Suppernote par e-mail et par SMS',
    );
    expect(buildCombinedMarketingConsentLabel(['SMS'], 'Chez Suppernote')).toBe(
      buildMarketingConsentLabel('SMS', 'Chez Suppernote'),
    );
    expect(buildCombinedMarketingConsentProof('SMS', ['EMAIL', 'SMS'], 'Chez Suppernote')).toBe(
      `${MARKETING_CONSENT_COMBINED_VERSION}|SMS|Recevoir les offres et actualités du restaurant Chez Suppernote par e-mail et par SMS`,
    );
    expect(MARKETING_CONSENT_COMBINED_VERSION).not.toBe(MARKETING_CONSENT_VERSION);
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

describe('consentement e-mail seul (17/11/2026)', () => {
  it('affiche la phrase validée, avec le retrait et la désinscription', () => {
    expect(buildEmailMarketingConsentLabel('Chez Suppernote')).toBe(
      'Recevoir les offres, nouveautés et événements du restaurant Chez Suppernote par e-mail. Vous pouvez retirer votre accord à tout moment, par le lien de désinscription présent dans chaque message.',
    );
  });

  it('enregistre une preuve qui commence par la nouvelle version et ne mentionne jamais le SMS', () => {
    const proof = buildEmailMarketingConsentProof('Chez Suppernote');
    expect(proof.startsWith(`${MARKETING_CONSENT_EMAIL_VERSION}|EMAIL|`)).toBe(true);
    expect(proof).not.toContain('SMS');
  });
});
