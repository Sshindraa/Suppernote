import { describe, expect, it } from 'vitest';
import {
  hasReliableLanguageEvidence,
  normalizeVoiceLocale,
  normalizeVoiceLanguage,
  requestedVoiceLanguage,
  resolveVoiceLanguage,
} from '../stream/voice-language';

describe('voice language routing', () => {
  it('normalizes Scribe BCP-47 and bibliographic language codes', () => {
    expect(normalizeVoiceLanguage('en-US')).toBe('en');
    expect(normalizeVoiceLanguage('ENG')).toBe('en');
    expect(normalizeVoiceLanguage('fr-FR')).toBe('fr');
    expect(normalizeVoiceLanguage('unknown')).toBeNull();
  });

  it('maps the detected language to a regional Cartesia locale', () => {
    expect(normalizeVoiceLocale('en-US')).toBe('en-US');
    expect(normalizeVoiceLocale('en-GB')).toBe('en-GB');
    expect(normalizeVoiceLocale('fr')).toBe('fr-FR');
    expect(normalizeVoiceLocale('ur')).toBe('ur-IN');
    expect(normalizeVoiceLocale('unknown')).toBeNull();
  });

  it('écarte les fragments et répétitions avant de changer de langue', () => {
    expect(hasReliableLanguageEvidence('Euh, on se...')).toBe(false);
    expect(hasReliableLanguageEvidence('Waouh, waouh, waouh, waouh, calme-toi.')).toBe(false);
    expect(hasReliableLanguageEvidence('I would like a table for four people.')).toBe(true);
  });

  it('demande deux segments avant un changement de langue en cours d’appel', () => {
    const first = resolveVoiceLanguage(
      'fr',
      'it',
      'Vorrei prenotare un tavolo per quattro.',
      2,
      null,
    );
    expect(first).toEqual({
      language: 'fr',
      candidate: { code: 'it', count: 1 },
      accepted: false,
      changed: false,
    });

    const second = resolveVoiceLanguage(
      'fr',
      'it',
      'Domani sera alle otto, grazie.',
      3,
      first.candidate,
    );
    expect(second).toEqual({
      language: 'it',
      candidate: null,
      accepted: true,
      changed: true,
    });
  });

  it('accepte une langue claire sur le premier tour', () => {
    expect(resolveVoiceLanguage('fr', 'en', 'I need a table for two tomorrow.', 0, null)).toEqual({
      language: 'en',
      candidate: null,
      accepted: true,
      changed: true,
    });
  });
});

describe('langue demandée par l’appelant', () => {
  it('reconnaît une demande explicite', () => {
    expect(requestedVoiceLanguage('Can you speak English?')).toBe('en');
    expect(requestedVoiceLanguage('vous parlez anglais ?')).toBe('en');
    expect(requestedVoiceLanguage('Could you talk in Spanish please')).toBe('es');
  });

  it('ignore une phrase qui ne demande rien', () => {
    expect(requestedVoiceLanguage('I would like a table for four')).toBeNull();
    expect(requestedVoiceLanguage('un menu anglais')).toBeNull();
  });

  it('applique la demande tout de suite, sans second segment', () => {
    const decision = resolveVoiceLanguage('fr', 'en', 'Can you speak English?', 3, null, true);
    expect(decision).toMatchObject({ language: 'en', accepted: true, changed: true });
  });
});
