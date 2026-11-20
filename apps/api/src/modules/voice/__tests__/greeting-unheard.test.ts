import { describe, expect, it } from 'vitest';
import { describeInterruptionEvidence, hasInterruptionEvidence } from '../stream/barge-in-evidence';
import { keepUnheardGreeting, prependUnheardGreeting } from '../stream/greeting-unheard';
import type { CallSession } from '../stream/types';

const GREETING = "Chez Suppernote, bonjour. Léa, l'assistante IA, je vous écoute.";
const accepts = (text: string) =>
  hasInterruptionEvidence(describeInterruptionEvidence(text), { greeting: true });

describe('accueil : transcriptions parasites du 20/11', () => {
  it('une transcription hindi ne coupe pas l’accueil', () => {
    expect(accepts('जन्म संयोग 70.')).toBe(false);
  });
  it('la parole française par-dessus l’accueil le coupe toujours', () => {
    expect(accepts('allô, oui bonjour')).toBe(true);
    expect(accepts('ce que je veux dire.')).toBe(true);
  });
});

describe('reste de l’accueil coupé avant l’annonce IA', () => {
  const cut = () =>
    ({
      greetingInterrupted: true,
      greetingText: GREETING,
      interruptedReply: {
        said: GREETING,
        heard: 'Chez Suppernote, bonjour.',
        unheard: "Léa, l'assistante IA, je vous écoute.",
      },
    }) as unknown as CallSession;

  it('ne reprend que l’annonce IA, en tête de la prochaine réplique, une seule fois', () => {
    const session = cut();
    keepUnheardGreeting(session);
    expect(prependUnheardGreeting(session, 'Oui, pour combien ?')).toBe(
      "Léa, l'assistante IA. Oui, pour combien ?",
    );
    expect(prependUnheardGreeting(session, 'Et à quelle heure ?')).toBe('Et à quelle heure ?');
  });
  it('coupure non mesurée : l’annonce ; annonce déjà entendue : rien', () => {
    const unmeasured = cut();
    unmeasured.interruptedReply = undefined;
    keepUnheardGreeting(unmeasured);
    expect(unmeasured.greetingUnheard).toBe("Léa, l'assistante IA.");
    const heardAll = cut();
    heardAll.interruptedReply = {
      said: GREETING,
      heard: "Chez Suppernote, bonjour. Léa, l'assistante IA,",
      unheard: 'je vous écoute.',
    };
    keepUnheardGreeting(heardAll);
    expect(heardAll.greetingUnheard).toBeUndefined();
  });
  it('ne touche pas l’accueil encore en lecture', () => {
    const session = cut();
    session.greetingUnheard = 'reste';
    session.greetingPlaying = true;
    expect(prependUnheardGreeting(session, 'x')).toBe('x');
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
