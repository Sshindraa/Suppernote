import { afterEach, describe, it, expect, vi } from 'vitest';
import { offTurnTtsProvider } from '../stream/elevenlabs-tts';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('fournisseur TTS hors tour (secours, au revoir)', () => {
  it('passe par ElevenLabs dès que sa clé est présente, même si le téléphone reste sur Cartesia', () => {
    expect(offTurnTtsProvider({ ELEVENLABS_API_KEY: 'k', VOICE_TTS_PROVIDER: 'cartesia' })).toBe(
      'elevenlabs',
    );
  });

  it('retombe sur le fournisseur téléphone sans clé ElevenLabs', () => {
    expect(offTurnTtsProvider({ VOICE_TTS_PROVIDER: 'cartesia' })).toBe('cartesia');
    expect(offTurnTtsProvider({ ELEVENLABS_API_KEY: '  ' })).toBe('cartesia');
  });
});
