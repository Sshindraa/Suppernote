import { describe, it, expect } from 'vitest';
import { buildSystemPrompt } from '../prompts';
import { ambiguousDayPair, isEarlyMorning, weekdayFr } from '../stream/relative-day';

// 2026-11-18T23:16Z = 00 h 16 à Paris, jeudi 19 novembre : « demain » vise vendredi 20, mais la nuit en cours compte.
const ONE_SIXTEEN_AM = new Date('2026-11-18T23:16:00Z');
const NINE_AM = new Date('2026-11-19T08:00:00Z');

describe('« demain » après minuit (fuseau du restaurant)', () => {
  it('détecte le petit matin à Paris (00 h 16), pas à 9 h', () => {
    expect(isEarlyMorning(ONE_SIXTEEN_AM, 'Europe/Paris')).toBe(true);
    expect(isEarlyMorning(NINE_AM, 'Europe/Paris')).toBe(false);
  });

  it('nomme les deux jours possibles avant 5 h : jeudi ou vendredi', () => {
    expect(ambiguousDayPair(ONE_SIXTEEN_AM, 'Europe/Paris')).toBe('jeudi ou vendredi');
  });

  it('donne le jour de la semaine en français', () => {
    expect(weekdayFr('2026-11-20')).toBe('vendredi');
    expect(weekdayFr('2026-12-31')).toBe('jeudi');
  });

  it('demande de nommer le jour dans le prompt à 00 h 16, sans cette consigne à 9 h', () => {
    const ctx = { name: 'Chez Suppernote', timezone: 'Europe/Paris' } as Parameters<
      typeof buildSystemPrompt
    >[0];
    const night = buildSystemPrompt(ctx, ONE_SIXTEEN_AM);
    expect(night).toContain('jeudi ou vendredi ?');
    expect(night).toContain('jamais « demain »');
    expect(buildSystemPrompt(ctx, NINE_AM)).not.toContain('moins de 5 h');
  });
});
