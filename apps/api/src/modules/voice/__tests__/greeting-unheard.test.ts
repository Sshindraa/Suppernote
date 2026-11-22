import { describe, expect, it } from 'vitest';
import { describeInterruptionEvidence, hasInterruptionEvidence } from '../stream/barge-in-evidence';
import { keepUnheardGreeting } from '../stream/greeting-unheard';
import { buildStructuredTurnMessages } from '../stream/structured-turn/prompt';
import type { CallSession } from '../stream/types';

const GREETING = "Chez Suppernote, Léa, l'IA du restaurant, bonjour !";
const accepts = (text: string) =>
  hasInterruptionEvidence(describeInterruptionEvidence(text), { greeting: true });

describe('accueil : transcriptions parasites du 20/11', () => {
  it('une transcription hindi ne coupe pas l’accueil', () => {
    expect(accepts('जन्म संयोग 70.')).toBe(false);
  });
  it('la parole française par-dessus l’accueil le coupe toujours', () => {
    expect(accepts('allô, je voudrais une table')).toBe(true);
    expect(accepts('ce que je veux dire.')).toBe(true);
  });
});

describe('accueil coupé avant l’annonce IA : le modèle est prévenu', () => {
  const cut = (heard: string) =>
    ({
      greetingInterrupted: true,
      greetingText: GREETING,
      interruptedReply: { said: GREETING, heard, unheard: '' },
    }) as unknown as CallSession;

  it('annonce non entendue : drapeau levé ; coupure non mesurée aussi', () => {
    const session = cut('Chez Suppernote,');
    keepUnheardGreeting(session);
    expect(session.greetingAiUnheard).toBe(true);
    const unmeasured = cut('');
    unmeasured.interruptedReply = undefined;
    keepUnheardGreeting(unmeasured);
    expect(unmeasured.greetingAiUnheard).toBe(true);
  });
  it('annonce entendue : rien à signaler', () => {
    const session = cut("Chez Suppernote, Léa, l'IA du restaurant,");
    keepUnheardGreeting(session);
    expect(session.greetingAiUnheard).toBeUndefined();
  });
  it('la consigne d’état figure dans le prompt du tour, sans phrase à dire', () => {
    const base = {
      systemPrompt: 'Tu es Léa.',
      history: [],
      transcript: 'je voudrais réserver',
      state: { draft: { customerName: '' }, lastAwaiting: 'open' },
    } as unknown as Parameters<typeof buildStructuredTurnMessages>[0];
    const text = (aiNotHeard: boolean) =>
      JSON.stringify(buildStructuredTurnMessages({ ...base, aiNotHeard }));
    expect(text(true)).toContain('ANNONCE IA NON ENTENDUE');
    expect(text(false)).not.toContain('ANNONCE IA NON ENTENDUE');
  });
});

describe('salutation par-dessus l’accueil : il continue', () => {
  it.each(['oui', 'bonjour', 'oui bonjour', 'allô', 'Allô ?', 'oui bon', 'oui, bonjour madame'])(
    '« %s » ne coupe pas',
    (text) => expect(accepts(text)).toBe(false),
  );
  it.each(['je voudrais réserver', 'oui je voudrais réserver', 'bonjour une table pour deux'])(
    '« %s » coupe',
    (text) => expect(accepts(text)).toBe(true),
  );
  it('hors accueil, une salutation reste une prise de parole', () => {
    expect(
      hasInterruptionEvidence(describeInterruptionEvidence('oui bonjour'), { greeting: false }),
    ).toBe(true);
  });
});

describe('parasites latins du 20/11 : aucun critère général ne les sépare d’un vrai « allô »', () => {
  // Preuves des journaux : nombre de mots, confiance minimale, durée de voix.
  const parasite1 = { wordCount: 5, minConfidence: 0.6035156, voiceMs: 880 };
  const parasite2 = { wordCount: 5, minConfidence: null, voiceMs: null };
  const vrai = { wordCount: 3, minConfidence: 0.9, voiceMs: 1000 };
  it('tous passent le même seuil, et aucun ne recoupe le texte de l’accueil', () => {
    for (const e of [parasite1, parasite2, vrai])
      expect(hasInterruptionEvidence(e, { greeting: true })).toBe(true);
    const overlap = (t: string) =>
      t
        .toLowerCase()
        .match(/\p{L}+/gu)!
        .filter((w) => GREETING.toLowerCase().includes(w) && w.length > 3);
    expect(overlap('voici le reste en place')).toEqual([]);
    expect(overlap('ce que je veux dire.')).toEqual([]);
  });
});
