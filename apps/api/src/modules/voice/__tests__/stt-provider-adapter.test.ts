import { describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { createDeepgramSttAdapter } from '../stream/stt-provider-adapter';

function makeSocket(): WebSocket {
  return {
    readyState: WebSocket.OPEN,
    send: vi.fn(),
    close: vi.fn(),
  } as unknown as WebSocket;
}

describe('STT provider adapters', () => {
  it('sends Deepgram audio as binary and converts Telnyx L16 to linear16 little-endian', () => {
    const adapter = createDeepgramSttAdapter({ model: 'nova-3' });
    const socket = makeSocket();
    const source = Buffer.from([0x12, 0x34, 0xab, 0xcd]);
    const audio = adapter.toProviderAudio('L16', source);

    adapter.sendAudio(socket, audio);

    expect(audio).toEqual(Buffer.from([0x34, 0x12, 0xcd, 0xab]));
    expect(vi.mocked(socket.send)).toHaveBeenCalledWith(audio, { binary: true });
    expect(adapter.chunkBytesPerMs('L16')).toBe(32);
    expect(adapter.samplesForAudio('L16', audio.length)).toBe(2);
  });

  it('passes G.711 bytes unchanged for Deepgram and counts one sample per byte', () => {
    const adapter = createDeepgramSttAdapter({ model: 'nova-3' });
    const source = Buffer.from([0xd5, 0x55, 0x10]);

    expect(adapter.toProviderAudio('PCMA', source)).toBe(source);
    expect(adapter.toProviderAudio('PCMU', source)).toBe(source);
    expect(adapter.samplesForAudio('PCMA', source.length)).toBe(3);
    expect(adapter.samplesForAudio('PCMU', source.length)).toBe(3);
  });

  it('uses Deepgram control messages only on an open socket', () => {
    const deepgram = createDeepgramSttAdapter({ model: 'nova-3' });
    const openSocket = makeSocket();
    const closedSocket = { ...makeSocket(), readyState: WebSocket.CLOSED } as unknown as WebSocket;

    deepgram.finalize(openSocket);
    deepgram.keepAlive(openSocket);
    deepgram.finalize(closedSocket);
    deepgram.keepAlive(closedSocket);

    expect(vi.mocked(openSocket.send).mock.calls).toEqual([
      [JSON.stringify({ type: 'Finalize' })],
      [JSON.stringify({ type: 'KeepAlive' })],
    ]);
    expect(closedSocket.send).not.toHaveBeenCalled();
  });

  it('normalizes Deepgram finals, partials, speech boundaries and provider errors', () => {
    const adapter = createDeepgramSttAdapter({ model: 'nova-3' });
    const normalize = (message: unknown) =>
      adapter.normalizeMessage(Buffer.from(JSON.stringify(message)));

    expect(
      normalize({
        type: 'Results',
        start: 1.2,
        duration: 0.9,
        is_final: true,
        speech_final: true,
        channel: {
          alternatives: [
            {
              transcript: 'à dix-neuf heures',
              languages: ['fr'],
              words: [{ word: 'dix-neuf', start: 1.2, end: 1.7, confidence: 0.91 }],
            },
          ],
        },
      }),
    ).toEqual([
      {
        type: 'final_segment',
        transcript: 'à dix-neuf heures',
        languageCode: 'fr',
        words: [{ word: 'dix-neuf', confidence: 0.91, start: 1.2, end: 1.7 }],
        speechFinal: true,
        fromFinalize: false,
        speechEndOffsetMs: 1700,
        providerResultEndMs: 2100,
        providerLastWordEndMs: 1700,
      },
    ]);
    expect(
      normalize({
        type: 'Results',
        is_final: true,
        speech_final: false,
        from_finalize: true,
        channel: { alternatives: [{ transcript: 'sept' }] },
      }),
    ).toMatchObject([{ type: 'final_segment', speechFinal: false, fromFinalize: true }]);
    expect(normalize({ type: 'SpeechStarted' })).toEqual([{ type: 'speech_started' }]);
    expect(normalize({ type: 'UtteranceEnd', last_word_end: 3.25 })).toEqual([
      {
        type: 'utterance_end',
        speechEndOffsetMs: 3250,
        providerLastWordEndMs: 3250,
      },
    ]);
    expect(normalize({ type: 'Error', code: 'not_authorized', description: 'denied' })).toEqual([
      { type: 'provider_error', messageType: 'not_authorized', message: 'denied' },
    ]);
  });

  it('uses the documented Flux v2 turn events and ForceEndTurn controls', () => {
    const adapter = createDeepgramSttAdapter({ model: 'flux-general-multi' });
    const normalize = (message: unknown) =>
      adapter.normalizeMessage(Buffer.from(JSON.stringify(message)));
    const socket = makeSocket();

    expect(adapter.model).toBe('flux-general-multi');
    expect(normalize({ type: 'Connected' })).toEqual([{ type: 'session_started' }]);
    expect(
      normalize({
        type: 'TurnInfo',
        event: 'StartOfTurn',
        audio_window_start: 0.2,
        transcript: 'Demain soir',
        words: [{ word: 'soir', start: 0.4, end: 0.8, confidence: 0.9 }],
      }),
    ).toEqual([
      { type: 'speech_started', speechStartOffsetMs: 200 },
      {
        type: 'partial',
        transcript: 'Demain soir',
        words: [{ word: 'soir', start: 0.4, end: 0.8, confidence: 0.9 }],
      },
    ]);
    expect(
      normalize({
        type: 'TurnInfo',
        event: 'EndOfTurn',
        audio_window_end: 1.1,
        transcript: 'Demain soir',
        words: [{ word: 'soir', start: 0.4, end: 0.8 }],
      }),
    ).toEqual([
      {
        type: 'final_segment',
        transcript: 'Demain soir',
        words: [{ word: 'soir', start: 0.4, end: 0.8 }],
        speechFinal: true,
        speechEndOffsetMs: 800,
        providerResultEndMs: 1_100,
        providerLastWordEndMs: 800,
      },
    ]);
    expect(
      normalize({
        type: 'TurnInfo',
        event: 'EndOfTurn',
        audio_window_end: 1.1,
        transcript: 'Demain soir',
      }),
    ).toEqual([
      expect.objectContaining({
        type: 'final_segment',
        providerResultEndMs: 1_100,
        speechEndOffsetMs: undefined,
        providerLastWordEndMs: undefined,
      }),
    ]);

    adapter.finalize(socket);
    adapter.keepAlive(socket);
    adapter.close(socket, 1000, 'done');
    expect(vi.mocked(socket.send).mock.calls).toEqual([
      [JSON.stringify({ type: 'ForceEndTurn' })],
      [JSON.stringify({ type: 'CloseStream' })],
    ]);
    expect(socket.close).toHaveBeenCalledOnce();
  });
});

describe('Cartesia Ink-2 en mode tours (secours)', () => {
  it('traduit les tours Cartesia dans le format commun', async () => {
    const { normalizeCartesiaTurnsMessage } = await import('../stream/stt-provider-adapter');
    expect(normalizeCartesiaTurnsMessage({ type: 'connected' })).toEqual([
      { type: 'session_started' },
    ]);
    expect(
      normalizeCartesiaTurnsMessage({ type: 'turn.update', transcript: ' je voudrais ' }),
    ).toEqual([{ type: 'partial', transcript: 'je voudrais' }]);
    expect(
      normalizeCartesiaTurnsMessage({ type: 'turn.end', transcript: 'pour six personnes' }),
    ).toEqual([{ type: 'turn_commit', transcript: 'pour six personnes' }]);
    expect(normalizeCartesiaTurnsMessage({ type: 'turn.end', transcript: '' })).toEqual([]);
    expect(normalizeCartesiaTurnsMessage({ type: 'turn.resume' })).toEqual([]);
    expect(
      normalizeCartesiaTurnsMessage({ type: 'error', error_code: 'quota_exceeded', message: 'q' }),
    ).toEqual([{ type: 'provider_error', messageType: 'quota_exceeded', message: 'q' }]);
  });

  it("envoie l'A-law tel quel et construit l'adresse en français avec un délai de fin de tour court", async () => {
    const { buildCartesiaTurnsUrl, createCartesiaTurnsSttAdapter } =
      await import('../stream/stt-provider-adapter');
    const adapter = createCartesiaTurnsSttAdapter({ model: 'ink-2' });
    const frame = Buffer.alloc(160, 0xd5);
    expect(adapter.toProviderAudio('PCMA', frame)).toBe(frame);
    expect(adapter.chunkBytesPerMs('PCMA')).toBe(8);
    const url = new URL(buildCartesiaTurnsUrl('PCMA', 'Chez Suppernote'));
    expect(url.pathname).toBe('/stt/turns/websocket');
    expect(Object.fromEntries(url.searchParams)).toEqual(
      expect.objectContaining({
        model: 'ink-2',
        language: 'fr',
        encoding: 'pcm_alaw',
        sample_rate: '8000',
        turn_end_timeout_ms: '1500',
        keyterm: 'Chez Suppernote',
      }),
    );
  });
});
