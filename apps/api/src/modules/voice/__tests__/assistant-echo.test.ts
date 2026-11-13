import { afterEach, describe, expect, it, vi } from 'vitest';
import { logger } from '../../../shared/logger/pino';
import { filterAssistantEcho, hasBargeInWordThreshold } from '../stream/assistant-echo';
import { rememberRecentAgentSpeech } from '../stream/debug-dialogue';
import { noteAgentAudioEnded, noteAgentAudioStarted } from '../stream/turn-telemetry';
import type { CallSession } from '../stream/types';

function makeSession(): CallSession {
  return {
    recentAgentSpeechText: 'Avec plaisir. Pour combien de personnes souhaitez-vous réserver ?',
    agentAudioActive: true,
  } as CallSession;
}

describe('assistant echo suppression', () => {
  it('suppresses a transcript contained in currently playing agent speech', () => {
    const result = filterAssistantEcho(
      makeSession(),
      'Avec plaisir, pour combien de personnes',
      'partial',
    );

    expect(result).toMatchObject({ suppressed: true, transcript: '' });
  });

  it('strips the echoed prefix and retains caller words', () => {
    const result = filterAssistantEcho(
      makeSession(),
      'Avec plaisir pour combien de personnes allô bonjour',
      'committed',
    );

    expect(result).toMatchObject({
      suppressed: false,
      strippedPrefix: true,
      transcript: 'allô bonjour',
      nonEchoWordCount: 2,
    });
    expect(hasBargeInWordThreshold(result)).toBe(true);
  });

  it('does not suppress after the one-second echo window', () => {
    const session = makeSession();
    session.agentAudioActive = false;
    session.agentAudioEndedAt = 1_000;

    expect(
      filterAssistantEcho(session, 'Pour combien de personnes', 'committed', 2_001),
    ).toMatchObject({
      suppressed: false,
      transcript: 'Pour combien de personnes',
    });
  });
});

describe('un énoncé d’un seul mot n’est jamais filtré, quel que soit le mot', () => {
  // Aucune liste de mots : un mot isolé ne forme ni préfixe ni recouvrement de deux mots ou plus,
  // donc l'agent qui dit « personnes » juste avant ne peut pas faire disparaître l'appelant.
  it.each(['non', 'stop', 'personnes', 'plaisir', 'combien', 'xylophone', 'oui'])(
    'garde « %s » pendant que l’agent parle',
    (word) => {
      for (const stage of ['partial', 'committed'] as const) {
        expect(filterAssistantEcho(makeSession(), word, stage)).toEqual({
          transcript: word,
          suppressed: false,
          strippedPrefix: false,
          nonEchoWordCount: 1,
        });
      }
    },
  );
});

describe("écho aligné sur le moment où l'appelant a été entendu (appel 1b3f85e9)", () => {
  const T0 = 1_000_000;
  const speech = (text: string, at = T0) => {
    const session = {} as CallSession;
    rememberRecentAgentSpeech(session, text, at);
    return session;
  };

  it("reconnaît l'écho de l'accueil, transcrit bien après la fin du son", () => {
    const session = speech('Bonjour, ici Chez Suppernote. Je vous écoute.');
    noteAgentAudioStarted(session, T0);
    noteAgentAudioEnded(session, T0 + 2_400);
    // Le son revenu a commencé pendant l'accueil ; sa transcription n'arrive que 2,3 s après la fin.
    session.sttLastSpeechStartedAt = T0 + 2_000;
    const echo = filterAssistantEcho(
      session,
      'bonjour ici chez suppernote',
      'committed',
      T0 + 4_700,
    );
    expect(echo).toMatchObject({ suppressed: true, transcript: '' });
  });

  it("garde le mot de l'appelant qui répète la question de l'agent après qu'il a fini de parler", () => {
    const session = speech("C'est bien ça ?");
    noteAgentAudioStarted(session, T0);
    noteAgentAudioEnded(session, T0 + 1_200);
    // L'appelant répond « c'est bien ça » 1,6 s après la fin, transcrit 1,4 s plus tard : hors fenêtre.
    session.sttLastSpeechStartedAt = T0 + 2_800;
    const result = filterAssistantEcho(session, "c'est bien ça", 'committed', T0 + 4_200);
    expect(result).toMatchObject({ suppressed: false, transcript: "c'est bien ça" });
  });

  it("l'écho reste reconnu jusqu'à 0,9 s après la fin du son, pas au-delà", () => {
    const session = speech('Oui, demain on est ouvert de midi à 22 heures.');
    noteAgentAudioStarted(session, T0);
    noteAgentAudioEnded(session, T0 + 3_000);
    session.sttLastSpeechStartedAt = T0 + 3_800;
    expect(filterAssistantEcho(session, 'est ouvert', 'committed', T0 + 6_000).suppressed).toBe(
      true,
    );
    session.sttLastSpeechStartedAt = T0 + 4_000;
    expect(filterAssistantEcho(session, 'est ouvert', 'committed', T0 + 6_000).suppressed).toBe(
      false,
    );
  });

  it('mémorise toutes les phrases récentes, pas seulement celles du tour courant, et oublie les anciennes', () => {
    const session = {} as CallSession;
    rememberRecentAgentSpeech(session, 'Oui, on est ouvert.', T0);
    rememberRecentAgentSpeech(session, 'Vous voulez venir vers quelle heure ?', T0 + 2_000);
    expect(session.recentAgentSpeechText).toBe(
      'Oui, on est ouvert. Vous voulez venir vers quelle heure ?',
    );
    rememberRecentAgentSpeech(session, 'Très bien.', T0 + 25_000);
    expect(session.recentAgentSpeechText).toBe('Très bien.');
  });

  it("ne garde que les derniers intervalles d'audio et ne rouvre pas un intervalle déjà ouvert", () => {
    const session = {} as CallSession;
    noteAgentAudioStarted(session, T0);
    noteAgentAudioStarted(session, T0 + 500);
    expect(session.agentAudioSpans).toEqual([{ startedAt: T0 }]);
    noteAgentAudioEnded(session, T0 + 900);
    expect(session.agentAudioSpans).toEqual([{ startedAt: T0, endedAt: T0 + 900 }]);
    for (let i = 1; i <= 12; i++) {
      noteAgentAudioStarted(session, T0 + i * 10_000);
      noteAgentAudioEnded(session, T0 + i * 10_000 + 500);
    }
    expect(session.agentAudioSpans).toHaveLength(8);
  });
});

describe("l'appelant parle clairement : les mots communs avec l'agent ne sont pas de l'écho", () => {
  const NOW = 1_000_000;
  function speakingOver(agentSpeech: string, clearVoiceAt?: number): CallSession {
    return {
      recentAgentSpeechText: agentSpeech,
      agentAudioActive: true,
      sttLastSpeechStartedAt: NOW - 1_500,
      callerVoice: { noiseFloor: 0, voiceRun: 0, lastClearVoiceAt: clearVoiceAt },
    } as unknown as CallSession;
  }

  it('garde « bonjour vous appelle pour » quand l’agent vient de dire « Bonjour. Vous voulez… » (dernier test)', () => {
    const agent = 'Bonjour. Vous voulez réserver une table ?';
    const withVoice = filterAssistantEcho(
      speakingOver(agent, NOW - 200),
      'Bonjour vous appelle pour',
      'committed',
      NOW,
    );
    expect(withVoice).toMatchObject({
      suppressed: false,
      strippedPrefix: false,
      transcript: 'Bonjour vous appelle pour',
    });
    // Sans preuve audio, le comportement d'avant reste : deux mots communs suffisent.
    const withoutVoice = filterAssistantEcho(
      speakingOver(agent),
      'Bonjour vous appelle pour',
      'committed',
      NOW,
    );
    expect(withoutVoice).toMatchObject({ strippedPrefix: true, transcript: 'appelle pour' });
  });

  it('garde « je vous appelle pour » malgré « comment puis-je vous aider » dans l’accueil (appel 5cebe456)', () => {
    const result = filterAssistantEcho(
      speakingOver('Bonjour, comment puis-je vous aider ? Pour quel jour ?', NOW - 100),
      'je vous appelle pour pour',
      'committed',
      NOW,
    );
    expect(result).toMatchObject({ strippedPrefix: false, suppressed: false });
    expect(result.transcript).toBe('je vous appelle pour pour');
  });

  it('retire quand même une vraie répétition longue de l’agent, même avec de la voix', () => {
    const result = filterAssistantEcho(
      speakingOver('Avec plaisir. Pour combien de personnes souhaitez-vous réserver ?', NOW - 100),
      'Avec plaisir pour combien de personnes allô bonjour',
      'committed',
      NOW,
    );
    expect(result).toMatchObject({ strippedPrefix: true, transcript: 'allô bonjour' });
    const whole = filterAssistantEcho(
      speakingOver('Avec plaisir. Pour combien de personnes souhaitez-vous réserver ?', NOW - 100),
      'Avec plaisir pour combien de personnes souhaitez vous réserver',
      'partial',
      NOW,
    );
    expect(whole).toMatchObject({ suppressed: true, transcript: '' });
  });

  it('ne tient pas compte d’une voix antérieure au début de l’énoncé (c’est l’écho qui parle)', () => {
    const session = speakingOver(
      'Avec plaisir. Pour combien de personnes souhaitez-vous réserver ?',
      NOW - 4_000,
    );
    const result = filterAssistantEcho(session, 'Avec plaisir pour combien', 'partial', NOW);
    expect(result.suppressed).toBe(true);
  });
});

describe('texte brut du filtre d’écho pour les restaurants de test', () => {
  afterEach(() => {
    delete process.env.VOICE_DEBUG_TRANSCRIPT_RESTAURANT_IDS;
    vi.restoreAllMocks();
  });

  it('journalise ce que le filtre a reçu et ce qu’il a rendu, pour comprendre un mot perdu', () => {
    process.env.VOICE_DEBUG_TRANSCRIPT_RESTAURANT_IDS = 'resto-test';
    const info = vi.spyOn(logger, 'info');
    const session = {
      restaurantId: 'resto-test',
      callControlId: 'cc-1',
      recentAgentSpeechText: 'Bonjour. Vous voulez réserver une table ?',
      agentAudioActive: true,
    } as unknown as CallSession;
    filterAssistantEcho(session, 'bonjour vous appelle pour', 'committed');
    const debug = info.mock.calls
      .map(([fields]) => fields as Record<string, unknown>)
      .find((fields) => fields.voiceDebug === 'echo_prefix_stripped');
    expect(debug).toMatchObject({
      before: 'bonjour vous appelle pour',
      after: 'appelle pour',
      stage: 'committed',
    });
  });

  it('ne journalise aucun texte pour un restaurant client', () => {
    process.env.VOICE_DEBUG_TRANSCRIPT_RESTAURANT_IDS = 'resto-test';
    const info = vi.spyOn(logger, 'info');
    const session = {
      restaurantId: 'resto-client',
      callControlId: 'cc-2',
      recentAgentSpeechText: 'Bonjour. Vous voulez réserver une table ?',
      agentAudioActive: true,
    } as unknown as CallSession;
    filterAssistantEcho(session, 'bonjour vous appelle pour', 'committed');
    expect(info.mock.calls.some(([fields]) => 'voiceDebug' in (fields as object))).toBe(false);
  });
});
