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

  it('dit la partie non entendue en tête de la prochaine réplique, une seule fois', () => {
    const session = cut();
    keepUnheardGreeting(session);
    expect(prependUnheardGreeting(session, 'Oui, pour combien ?')).toBe(
      "Léa, l'assistante IA, je vous écoute. Oui, pour combien ?",
    );
    expect(prependUnheardGreeting(session, 'Et à quelle heure ?')).toBe('Et à quelle heure ?');
  });
  it('coupure non mesurée : tout l’accueil ; tout entendu : rien', () => {
    const unmeasured = cut();
    unmeasured.interruptedReply = undefined;
    keepUnheardGreeting(unmeasured);
    expect(unmeasured.greetingUnheard).toBe(GREETING);
    const heardAll = cut();
    heardAll.interruptedReply = { said: GREETING, heard: GREETING, unheard: '' };
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
