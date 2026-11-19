import { describe, it, expect } from 'vitest';
import {
  createStructuredTurnStateWithName,
  speakableName,
} from '../stream/structured-turn/fact-guards';

describe('client reconnu : nom pré-rempli', () => {
  it('écrit le nom en casse normale, lisible comme un nom et non épelé', () => {
    expect(speakableName('DURAND')).toBe('Durand');
    expect(speakableName('  jean-pierre DUPONT ')).toBe('Jean-Pierre Dupont');
  });

  it('pré-remplit le brouillon avec le nom connu, sans autre champ', () => {
    const state = createStructuredTurnStateWithName('DURAND');
    expect(state.draft).toEqual({ date: '', time: '', partySize: 0, customerName: 'Durand' });
  });
});
