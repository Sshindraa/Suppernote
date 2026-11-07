import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../shared/db/client', () => ({ db: { restaurant: { findMany: vi.fn() } } }));

vi.mock('../../../shared/logger/pino', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock('../tts-cache', () => ({
  getTtsCached: vi.fn(),
  setTtsCached: vi.fn(),
}));

import { db } from '../../../shared/db/client';
import { logger } from '../../../shared/logger/pino';
import { getTtsCached, setTtsCached } from '../tts-cache';
import { initGreetingCache, buildGreetingText } from '../stream/greeting-cache';
import { cleanTextForTts, ttsSegments } from '../stream/tts-handler';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe('initGreetingCache — voix Cartesia manquante', () => {
  it('nomme CARTESIA_VOICE_ID dans l’avertissement quand la voix est vide', async () => {
    vi.stubEnv('VOICE_TTS_PROVIDER', '');
    vi.stubEnv('CARTESIA_API_KEY', 'unit-test-placeholder-credential');
    vi.stubEnv('CARTESIA_VOICE_ID', '');

    await initGreetingCache(['Chez Test']);

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('CARTESIA_VOICE_ID'));
    expect(logger.warn).not.toHaveBeenCalledWith(expect.stringContaining('ELEVENLABS'));
  });
});

describe('initGreetingCache — mêmes clés que le runtime', () => {
  it("met en cache l'accueil en un seul bloc, comme speakTtsStreamed le relit", async () => {
    vi.stubEnv('VOICE_TTS_PROVIDER', '');
    vi.stubEnv('CARTESIA_API_KEY', 'unit-test-placeholder-credential');
    vi.stubEnv('CARTESIA_VOICE_ID', 'unit-test-voice');
    vi.mocked(getTtsCached).mockResolvedValue(null);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Uint8Array([1, 2, 3]))),
    );

    await initGreetingCache(['Chez Test']);
    vi.unstubAllGlobals();

    const expected = ttsSegments(cleanTextForTts(buildGreetingText('Chez Test')));
    expect(expected).toHaveLength(1);
    expect(vi.mocked(setTtsCached).mock.calls.map((c) => c[0])).toEqual(expected);
  });
});

describe('initGreetingCache — restaurants concernés', () => {
  it('ignore les restaurants sans numéro attribué et ne génère qu’une fois par nom', async () => {
    vi.stubEnv('VOICE_TTS_PROVIDER', '');
    vi.stubEnv('CARTESIA_API_KEY', 'unit-test-placeholder-credential');
    vi.stubEnv('CARTESIA_VOICE_ID', 'unit-test-voice');
    vi.mocked(getTtsCached).mockResolvedValue(null);
    vi.mocked(db.restaurant.findMany).mockResolvedValue([
      { name: 'Chez Test' },
      { name: 'Chez Test' },
      { name: 'Autre' },
    ] as never);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Uint8Array([1, 2, 3]))),
    );

    await initGreetingCache();
    vi.unstubAllGlobals();

    expect(db.restaurant.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { provisioningStatus: { not: 'PENDING' } } }),
    );
    expect(setTtsCached).toHaveBeenCalledTimes(2);
  });
});
