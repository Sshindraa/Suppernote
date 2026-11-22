import { describe, expect, it } from 'vitest';
import {
  describeInterruptionEvidence,
  hasInterruptionEvidence,
  isNoiseTurn,
} from '../stream/barge-in-evidence';

const word = (text: string, confidence: number, start = 0, end = 0.4) => ({
  word: text,
  confidence,
  start,
  end,
});
const evidenceOf = (text: string, confidence: number, span: [number, number] = [0, 0.4]) =>
  describeInterruptionEvidence(
    text,
    text.split(' ').map((w) => word(w, confidence, span[0], span[1])),
  );

/**
 * Mots seuls des interruptions réelles des journaux (22/09 – 03/10) : confiance minimale du tour
 * qui a suivi, durée de voix, et ce que le moteur en a fait.
 */
const LOGGED_SINGLE_WORD_INTERRUPTIONS = [
  {
    call: 'f2200632',
    text: 'rouge',
    confidence: 0.278,
    voiceMs: 400,
    greeting: true,
    phantom: true,
  },
  { call: 'NKF2Uw', text: 'allo', confidence: 0.207, voiceMs: 400, greeting: true, phantom: true },
  { call: 'ke5ztA', text: 'bon', confidence: 0.166, voiceMs: 320, greeting: true, phantom: true },
  { call: 'r0FZnw', text: 'oui', confidence: 0.349, voiceMs: 480, greeting: true, phantom: false },
  {
    call: 'r0FZnw',
    text: 'quatre',
    confidence: 0.755,
    voiceMs: 80,
    greeting: false,
    phantom: false,
  },
  { call: 'zIb4sg', text: 'non', confidence: 0.862, voiceMs: 240, greeting: false, phantom: false },
  { call: 'hekmTg', text: 'non', confidence: 0.864, voiceMs: 160, greeting: false, phantom: false },
];

describe('preuve minimale pour interrompre', () => {
  it('compte les mots, la confiance minimale et la durée de voix', () => {
    expect(
      describeInterruptionEvidence('deux mots', [
        word('deux', 0.9, 1, 1.2),
        word('mots', 0.5, 1.3, 1.6),
      ]),
    ).toEqual({ wordCount: 2, minConfidence: 0.5, voiceMs: 600 });
    expect(describeInterruptionEvidence('rouge')).toEqual({
      wordCount: 1,
      minConfidence: null,
      voiceMs: null,
    });
  });

  it('refuse un mot seul peu sûr et bref, y compris le cas de l’appel f2200632', () => {
    const evidence = evidenceOf('rouge', 0.278);
    expect(hasInterruptionEvidence(evidence, { greeting: true })).toBe(false);
    expect(hasInterruptionEvidence(evidence, { greeting: false })).toBe(false);
    expect(isNoiseTurn(evidence)).toBe(true);
  });

  it('garde une lettre seule, même peu sûre, quand l’agent attend une épellation (appel bb50c0d3)', () => {
    const evidence = evidenceOf('a', 0.2);
    expect(isNoiseTurn(evidence)).toBe(true);
    expect(isNoiseTurn(evidence, { letterExpected: true, transcript: 'a' })).toBe(false);
    expect(isNoiseTurn(evidenceOf('à', 0.2), { letterExpected: true, transcript: 'à.' })).toBe(
      false,
    );
    // Un mot, même pendant l'épellation, reste un bruit sans preuve.
    expect(
      isNoiseTurn(evidenceOf('rouge', 0.2), { letterExpected: true, transcript: 'rouge' }),
    ).toBe(true);
  });

  it('accepte plusieurs mots, même peu sûrs', () => {
    const evidence = evidenceOf('je voudrais réserver', 0.2);
    expect(hasInterruptionEvidence(evidence, { greeting: true })).toBe(true);
    expect(isNoiseTurn(evidence)).toBe(false);
  });

  it('refuse deux mots très peu sûrs pendant l’accueil, pas ailleurs (appel a663cec3)', () => {
    const evidence = evidenceOf('une escalec', 0.07, [0, 0.72]);
    expect(hasInterruptionEvidence(evidence, { greeting: true })).toBe(false);
    expect(hasInterruptionEvidence(evidence, { greeting: false })).toBe(true);
    // Deux mots sûrs, ou une voix soutenue, coupent toujours l'accueil.
    expect(hasInterruptionEvidence(evidenceOf('bonjour une table', 0.8), { greeting: true })).toBe(
      true,
    );
    expect(
      hasInterruptionEvidence(evidenceOf('une escalec', 0.07, [0, 0.9]), { greeting: true }),
    ).toBe(true);
  });

  it('accepte une voix soutenue, même peu sûre', () => {
    expect(hasInterruptionEvidence(evidenceOf('réserver', 0.2, [0, 0.9]), { greeting: true })).toBe(
      true,
    );
  });

  it('exige plus pendant l’accueil', () => {
    const evidence = evidenceOf('oui', 0.45);
    expect(hasInterruptionEvidence(evidence, { greeting: false })).toBe(true);
    expect(hasInterruptionEvidence(evidence, { greeting: true })).toBe(false);
  });

  it('ne bloque rien quand le fournisseur ne donne pas de confiance', () => {
    expect(hasInterruptionEvidence(describeInterruptionEvidence('rouge'), { greeting: true })).toBe(
      true,
    );
  });

  it('classe comme dans les journaux : tous les fantômes refusés, aucune prise de parole sûre refusée', () => {
    for (const row of LOGGED_SINGLE_WORD_INTERRUPTIONS) {
      const evidence = {
        wordCount: 1,
        minConfidence: row.confidence,
        voiceMs: row.voiceMs,
      };
      const allowed = hasInterruptionEvidence(evidence, { greeting: row.greeting });
      if (row.phantom) expect(allowed, `${row.call} ${row.text}`).toBe(false);
      // Le « oui » à 0,349 pendant l'accueil est le seul cas incertain : il ne coupe pas l'accueil.
      else if (row.greeting) expect(allowed, `${row.call} ${row.text}`).toBe(false);
      else expect(allowed, `${row.call} ${row.text}`).toBe(true);
    }
  });
});
