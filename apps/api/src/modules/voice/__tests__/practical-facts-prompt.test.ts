import { describe, expect, it } from 'vitest';
import { buildSystemPrompt, type OpeningHours } from '../prompts';

const hours: OpeningHours = { tue: { open: '12:00', close: '22:00' } } as unknown as OpeningHours;
const now = new Date('2026-10-07T10:00:00Z');
const base = { name: 'Chez Suppernote', openingHours: hours };

describe('bloc « ce que tu sais du restaurant »', () => {
  it('est absent sans faits : le prompt reste identique', () => {
    const without = buildSystemPrompt(base, now);
    expect(buildSystemPrompt({ ...base, restaurantFacts: [] }, now)).toBe(without);
    expect(without).not.toContain('CE QUE TU SAIS DU RESTAURANT');
  });

  it('liste chaque fait et interdit de deviner le reste', () => {
    const prompt = buildSystemPrompt(
      { ...base, restaurantFacts: ['Il n’y a pas de parking.', 'Le restaurant a une terrasse.'] },
      now,
    );
    expect(prompt).toContain('CE QUE TU SAIS DU RESTAURANT');
    expect(prompt).toContain('- Il n’y a pas de parking.');
    expect(prompt).toContain('- Le restaurant a une terrasse.');
    expect(prompt).toMatch(/ne devines pas/);
    expect(prompt).toMatch(/gérant/);
  });

  it('vient après les horaires et n’en change pas le contenu', () => {
    const without = buildSystemPrompt(base, now);
    const withFacts = buildSystemPrompt({ ...base, restaurantFacts: ['Fait.'] }, now);
    expect(withFacts.startsWith(without.trimEnd())).toBe(true);
  });
});
