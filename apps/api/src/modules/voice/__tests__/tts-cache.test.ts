import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../shared/redis/client', () => ({
  redisCache: {
    getBuffer: vi.fn(),
    set: vi.fn(),
    expire: vi.fn().mockResolvedValue(1),
  },
}));

describe('TTS Cache', () => {
  it('retourne null si cache vide', async () => {
    const { getTtsCached } = await import('../../../modules/voice/tts-cache');
    const { redisCache } = await import('../../../shared/redis/client');
    vi.mocked(redisCache.getBuffer).mockResolvedValue(null);
    expect(await getTtsCached('Bonjour, en quoi puis-je vous aider ?', 'voice-id')).toBeNull();
  });

  it('retourne le buffer si cache hit', async () => {
    const { getTtsCached } = await import('../../../modules/voice/tts-cache');
    const { redisCache } = await import('../../../shared/redis/client');
    const fakeBuffer = Buffer.from('audio');
    vi.mocked(redisCache.getBuffer).mockResolvedValue(fakeBuffer);
    const result = await getTtsCached('Bonjour, en quoi puis-je vous aider ?', 'voice-id');
    expect(result).toEqual(fakeBuffer);
  });

  it('prolonge la durée de vie d’un audio relu, pas d’un audio absent', async () => {
    const { getTtsCached } = await import('../../../modules/voice/tts-cache');
    const { redisCache } = await import('../../../shared/redis/client');
    const { TTS_CACHE_TTL_SECONDS } = await import('@suppernote/config');
    vi.mocked(redisCache.expire).mockClear();

    vi.mocked(redisCache.getBuffer).mockResolvedValue(null);
    await getTtsCached('Bonjour, en quoi puis-je vous aider ?', 'voice-id');
    expect(redisCache.expire).not.toHaveBeenCalled();

    vi.mocked(redisCache.getBuffer).mockResolvedValue(Buffer.from('audio'));
    await getTtsCached('Bonjour, en quoi puis-je vous aider ?', 'voice-id');
    expect(redisCache.expire).toHaveBeenCalledWith(expect.any(String), TTS_CACHE_TTL_SECONDS);
  });

  it('ne cache pas les phrases trop courtes', async () => {
    const { setTtsCached } = await import('../../../modules/voice/tts-cache');
    const { redisCache } = await import('../../../shared/redis/client');
    vi.mocked(redisCache.set).mockClear();
    await setTtsCached('Ok.', 'voice-id', Buffer.from('audio'));
    expect(redisCache.set).not.toHaveBeenCalled();
  });
});
