import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../stream/tts-handler', () => ({ speakTtsStreamed: vi.fn(async () => undefined) }));
// Par défaut le modèle ne formule rien : la phrase de secours est dite (comportement historique).
vi.mock('../stream/structured-turn/engine', () => ({
  generateRecoveryReply: vi.fn(async () => null),
}));

import { speakTtsStreamed } from '../stream/tts-handler';
import { generateRecoveryReply } from '../stream/structured-turn/engine';
import {
  armSilenceRecovery,
  cancelNoInputRecovery,
  lastAgentQuestion,
  MAX_RECOVERIES_PER_CALL,
  noInputTimeoutMs,
  recoveryMaxWaitMs,
  OPENING_RECOVERY_QUESTION,
  recoveryQuestion,
  scheduleUnheardRecovery,
  UNHEARD_GRACE_MS,
} from '../stream/no-input-recovery';
import type { CallSession } from '../stream/types';

const RESTAURANT = 'resto-debug';

function makeSession(overrides: Partial<CallSession> = {}): CallSession {
  return {
    callControlId: 'call-test',
    restaurantId: RESTAURANT,
    state: 'LISTENING',
    ended: false,
    history: [
      { role: 'user', content: 'à 18 heures' },
      { role: 'assistant', content: 'Oui, 18 heures ça marche. Vous serez combien ?' },
    ],
    sttLastSpeechStartedAt: Date.now(),
    ...overrides,
  } as unknown as CallSession;
}

function makeManager() {
  return {
    transition: vi.fn((session: CallSession, state: CallSession['state']) => {
      session.state = state;
      return true;
    }),
  };
}

describe('no-input recovery', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(speakTtsStreamed).mockClear();
    vi.mocked(generateRecoveryReply).mockReset();
    vi.mocked(generateRecoveryReply).mockResolvedValue(null);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("reprend la dernière question de l'agent", () => {
    expect(lastAgentQuestion(makeSession())).toBe('Vous serez combien ?');
    expect(
      lastAgentQuestion(
        makeSession({ history: [{ role: 'assistant', content: 'C’est noté, à demain.' }] }),
      ),
    ).toBeNull();
  });

  it("relance avec une question d'ouverture quand l'appelant n'a rien dit après l'accueil", async () => {
    const greetingOnly = () => makeSession({ history: [] });
    expect(recoveryQuestion(greetingOnly())).toBe(OPENING_RECOVERY_QUESTION);
    // Un appelant qui a déjà parlé et un agent qui n'a pas posé de question : pas de relance.
    expect(
      recoveryQuestion(
        makeSession({
          history: [
            { role: 'user', content: 'demain' },
            { role: 'assistant', content: 'C’est noté.' },
          ],
        }),
      ),
    ).toBeNull();

    const silent = greetingOnly();
    armSilenceRecovery(silent, makeManager());
    await vi.advanceTimersByTimeAsync(noInputTimeoutMs());
    expect(speakTtsStreamed).toHaveBeenCalledWith(
      silent,
      'Vous êtes toujours là ? Comment puis-je vous aider ?',
      expect.stringMatching(/^(cartesia|elevenlabs)$/),
    );

    const unheard = greetingOnly();
    scheduleUnheardRecovery(unheard, makeManager());
    await vi.advanceTimersByTimeAsync(UNHEARD_GRACE_MS);
    expect(speakTtsStreamed).toHaveBeenCalledWith(
      unheard,
      "Pardon, je n'ai pas bien entendu. Comment puis-je vous aider ?",
      expect.stringMatching(/^(cartesia|elevenlabs)$/),
    );
  });

  it('relance quand une parole est détectée sans aucun mot reconnu', async () => {
    const session = makeSession();
    const mgr = makeManager();

    scheduleUnheardRecovery(session, mgr);
    await vi.advanceTimersByTimeAsync(UNHEARD_GRACE_MS);

    expect(speakTtsStreamed).toHaveBeenCalledWith(
      session,
      "Pardon, je n'ai pas bien entendu. Vous serez combien ?",
      expect.stringMatching(/^(cartesia|elevenlabs)$/),
    );
    expect(session.history.at(-1)).toEqual({
      role: 'assistant',
      content: "Pardon, je n'ai pas bien entendu. Vous serez combien ?",
    });
    expect(session.state).toBe('LISTENING');
  });

  it("n'a pas de relance si un mot arrive pendant le délai de grâce", async () => {
    const session = makeSession();
    scheduleUnheardRecovery(session, makeManager());
    cancelNoInputRecovery(session);
    await vi.advanceTimersByTimeAsync(UNHEARD_GRACE_MS * 2);
    expect(speakTtsStreamed).not.toHaveBeenCalled();
  });

  it('ignore un speech_final vide sans parole récente (bruit de ligne)', async () => {
    const session = makeSession({ sttLastSpeechStartedAt: Date.now() - 60_000 });
    scheduleUnheardRecovery(session, makeManager());
    await vi.advanceTimersByTimeAsync(UNHEARD_GRACE_MS * 2);
    expect(speakTtsStreamed).not.toHaveBeenCalled();
  });

  it("relance après un silence, puis s'arrête au maximum par appel", async () => {
    const session = makeSession();
    const mgr = makeManager();
    for (let i = 0; i < MAX_RECOVERIES_PER_CALL + 2; i++) {
      armSilenceRecovery(session, mgr);
      await vi.advanceTimersByTimeAsync(noInputTimeoutMs());
    }
    expect(speakTtsStreamed).toHaveBeenCalledTimes(MAX_RECOVERIES_PER_CALL);
    expect(vi.mocked(speakTtsStreamed).mock.calls[0][1]).toBe(
      'Vous êtes toujours là ? Vous serez combien ?',
    );
  });

  it("ne dit rien pendant que l'agent parle ou en clôture", async () => {
    for (const session of [
      makeSession({ state: 'SPEAKING' }),
      makeSession({ ending: { reason: 'test' } as unknown as CallSession['ending'] }),
    ]) {
      armSilenceRecovery(session, makeManager());
      scheduleUnheardRecovery(session, makeManager());
    }
    await vi.advanceTimersByTimeAsync(noInputTimeoutMs() + UNHEARD_GRACE_MS);
    expect(speakTtsStreamed).not.toHaveBeenCalled();
  });

  describe('relance formulée par le modèle', () => {
    it('dit la phrase du modèle à la place de la phrase codée, avec le type de relance', async () => {
      vi.mocked(generateRecoveryReply).mockResolvedValue('Désolé, vous disiez ?');
      const session = makeSession();

      scheduleUnheardRecovery(session, makeManager());
      await vi.advanceTimersByTimeAsync(UNHEARD_GRACE_MS);

      expect(generateRecoveryReply).toHaveBeenCalledWith(
        session,
        expect.anything(),
        'unheard',
        expect.any(AbortSignal),
      );
      expect(speakTtsStreamed).toHaveBeenCalledTimes(1);
      expect(speakTtsStreamed).toHaveBeenCalledWith(
        session,
        'Désolé, vous disiez ?',
        expect.stringMatching(/^(cartesia|elevenlabs)$/),
      );
      expect(session.history.at(-1)).toEqual({
        role: 'assistant',
        content: 'Désolé, vous disiez ?',
      });
      expect(session.state).toBe('LISTENING');
    });

    it('passe le type « silence » puis « opening » selon le moment', async () => {
      vi.mocked(generateRecoveryReply).mockResolvedValue('Vous êtes là ?');
      const silent = makeSession();
      armSilenceRecovery(silent, makeManager());
      await vi.advanceTimersByTimeAsync(noInputTimeoutMs());
      expect(vi.mocked(generateRecoveryReply).mock.calls[0][2]).toBe('silence');

      const greeted = makeSession({ history: [] });
      armSilenceRecovery(greeted, makeManager());
      await vi.advanceTimersByTimeAsync(noInputTimeoutMs());
      expect(vi.mocked(generateRecoveryReply).mock.calls[1][2]).toBe('opening');
    });

    it('retombe sur la phrase de secours quand le modèle ne formule rien ou échoue', async () => {
      const session = makeSession();
      scheduleUnheardRecovery(session, makeManager());
      await vi.advanceTimersByTimeAsync(UNHEARD_GRACE_MS);
      expect(speakTtsStreamed).toHaveBeenLastCalledWith(
        session,
        "Pardon, je n'ai pas bien entendu. Vous serez combien ?",
        expect.stringMatching(/^(cartesia|elevenlabs)$/),
      );

      vi.mocked(generateRecoveryReply).mockRejectedValue(new Error('modèle indisponible'));
      const failing = makeSession();
      scheduleUnheardRecovery(failing, makeManager());
      await vi.advanceTimersByTimeAsync(UNHEARD_GRACE_MS);
      expect(speakTtsStreamed).toHaveBeenLastCalledWith(
        failing,
        "Pardon, je n'ai pas bien entendu. Vous serez combien ?",
        expect.stringMatching(/^(cartesia|elevenlabs)$/),
      );
    });

    it("ne dit rien si l'appelant reprend la parole pendant que le modèle formule, sans consommer la relance", async () => {
      let release: (value: string) => void = () => undefined;
      vi.mocked(generateRecoveryReply).mockImplementation(
        () => new Promise<string>((resolve) => (release = resolve)),
      );
      const session = makeSession();
      const mgr = makeManager();

      armSilenceRecovery(session, mgr);
      await vi.advanceTimersByTimeAsync(noInputTimeoutMs());
      expect(generateRecoveryReply).toHaveBeenCalledTimes(1);
      cancelNoInputRecovery(session);
      release('Vous êtes toujours là ?');
      await vi.advanceTimersByTimeAsync(0);
      expect(speakTtsStreamed).not.toHaveBeenCalled();

      // La relance n'a pas été consommée : on peut encore en dire le maximum.
      vi.mocked(generateRecoveryReply).mockResolvedValue('Vous êtes là ?');
      for (let i = 0; i < MAX_RECOVERIES_PER_CALL + 1; i++) {
        armSilenceRecovery(session, mgr);
        await vi.advanceTimersByTimeAsync(noInputTimeoutMs());
      }
      expect(speakTtsStreamed).toHaveBeenCalledTimes(MAX_RECOVERIES_PER_CALL);
    });

    it("ne dit rien si l'agent s'est remis à parler pendant la formulation", async () => {
      let release: (value: string) => void = () => undefined;
      vi.mocked(generateRecoveryReply).mockImplementation(
        () => new Promise<string>((resolve) => (release = resolve)),
      );
      const session = makeSession();
      armSilenceRecovery(session, makeManager());
      await vi.advanceTimersByTimeAsync(noInputTimeoutMs());
      session.state = 'SPEAKING';
      release('Vous êtes toujours là ?');
      await vi.advanceTimersByTimeAsync(0);
      expect(speakTtsStreamed).not.toHaveBeenCalled();
    });

    it('dit la phrase codée sans attendre plus que le délai maximum, et abandonne la requête', async () => {
      let seenSignal: AbortSignal | undefined;
      vi.mocked(generateRecoveryReply).mockImplementation((_session, _mgr, _kind, signal) => {
        seenSignal = signal;
        return new Promise<string | null>(() => undefined);
      });
      const session = makeSession();
      scheduleUnheardRecovery(session, makeManager());
      await vi.advanceTimersByTimeAsync(UNHEARD_GRACE_MS + recoveryMaxWaitMs() - 1);
      expect(speakTtsStreamed).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(speakTtsStreamed).toHaveBeenCalledWith(
        session,
        "Pardon, je n'ai pas bien entendu. Vous serez combien ?",
        expect.stringMatching(/^(cartesia|elevenlabs)$/),
      );
      expect(seenSignal?.aborted).toBe(true);
    });

    it('une phrase du modèle arrivée avant le délai maximum est dite', async () => {
      vi.mocked(generateRecoveryReply).mockImplementation(
        () =>
          new Promise<string>((resolve) =>
            setTimeout(() => resolve('Désolé, vous disiez ?'), recoveryMaxWaitMs() - 100),
          ),
      );
      const session = makeSession();
      scheduleUnheardRecovery(session, makeManager());
      await vi.advanceTimersByTimeAsync(UNHEARD_GRACE_MS + recoveryMaxWaitMs());
      expect(speakTtsStreamed).toHaveBeenCalledTimes(1);
      expect(speakTtsStreamed).toHaveBeenCalledWith(
        session,
        'Désolé, vous disiez ?',
        expect.stringMatching(/^(cartesia|elevenlabs)$/),
      );
    });

    it('le délai maximum se règle et reste borné', () => {
      expect(recoveryMaxWaitMs({})).toBe(2_000);
      expect(recoveryMaxWaitMs({ VOICE_RECOVERY_MAX_WAIT_MS: '1200' })).toBe(1_200);
      expect(recoveryMaxWaitMs({ VOICE_RECOVERY_MAX_WAIT_MS: '10' })).toBe(2_000);
      expect(recoveryMaxWaitMs({ VOICE_RECOVERY_MAX_WAIT_MS: 'x' })).toBe(2_000);
    });

    it("garde la phrase codée quand l'interrupteur est coupé, sans appeler le modèle", async () => {
      vi.stubEnv('VOICE_RECOVERY_BY_MODEL', 'false');
      vi.mocked(generateRecoveryReply).mockResolvedValue('Désolé, vous disiez ?');
      const session = makeSession();
      scheduleUnheardRecovery(session, makeManager());
      await vi.advanceTimersByTimeAsync(UNHEARD_GRACE_MS);
      expect(generateRecoveryReply).not.toHaveBeenCalled();
      expect(speakTtsStreamed).toHaveBeenCalledWith(
        session,
        "Pardon, je n'ai pas bien entendu. Vous serez combien ?",
        expect.stringMatching(/^(cartesia|elevenlabs)$/),
      );
    });
  });
});
