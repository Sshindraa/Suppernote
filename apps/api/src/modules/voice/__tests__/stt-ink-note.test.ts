import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../shared/redis/client', () => ({ redisCache: {} }));

import {
  currentInkDisagreementNote,
  INK_NOTE_TTL_MS,
  partySizeDiffers,
  partySizeValues,
} from '../stream/stt-ink-parallel';
import {
  buildSecondOpinionBlock,
  buildStructuredTurnMessages,
} from '../stream/structured-turn/prompt';
import { createStructuredTurnState } from '../stream/structured-turn/fact-guards';
import type { CallSession } from '../stream/types';
import { systemOf } from './helpers/system-of';

describe('désaccord sur le nombre de personnes', () => {
  it('ne retient que les nombres suivis de « personnes » ou « couverts »', () => {
    expect(partySizeValues('une table pour six personnes demain à 20 h')).toEqual(['6']);
    expect(partySizeValues('pour 4 couverts')).toEqual(['4']);
    // Articles, lettres épelées et heures ne comptent pas : c'étaient les faux désaccords du banc.
    expect(
      partySizeValues('je voudrais faire une réservation, au nom de A 2 S A, à 20 heures'),
    ).toEqual([]);
  });

  it('signale six contre dix, pas une simple différence de forme', () => {
    expect(partySizeDiffers('pour six personnes', 'pour dix personnes')).toBe(true);
    expect(partySizeDiffers('pour 6 personnes', 'pour six personnes')).toBe(false);
    expect(partySizeDiffers('une réservation demain', 'une réservation pour demain')).toBe(false);
  });
});

describe('note du tour', () => {
  const note = { heard: 'pour six personnes', secondHeard: 'pour dix personnes', at: 1_000_000 };

  it('vaut pour le tour de sa phrase seulement', () => {
    const session = { sttInkNote: { ...note, validThrough: 3 }, sttFinalCount: 3 } as CallSession;
    expect(currentInkDisagreementNote(session, false, note.at + 1000)).toBeDefined();
    session.sttFinalCount = 4;
    expect(currentInkDisagreementNote(session, false, note.at + 1000)).toBeUndefined();
  });

  it('disparaît après 90 s ou une fois la réservation créée', () => {
    const session = { sttInkNote: { ...note, validThrough: 1 }, sttFinalCount: 1 } as CallSession;
    expect(currentInkDisagreementNote(session, true, note.at + 1000)).toBeUndefined();
    expect(
      currentInkDisagreementNote(session, false, note.at + INK_NOTE_TTL_MS + 1),
    ).toBeUndefined();
  });

  it('demande une confirmation dans le récapitulatif, sans question à part', () => {
    const block = buildSecondOpinionBlock(note);
    expect(block).toContain('SECONDE ÉCOUTE');
    expect(block).toContain('dans le récapitulatif que tu fais de toute façon');
    expect(block).toContain('sans poser de question à part');
    expect(block).toContain('Ne parle jamais de cette seconde écoute');
    const state = createStructuredTurnState();
    const withNote = buildStructuredTurnMessages({
      systemPrompt: 'base',
      history: [],
      transcript: 'oui',
      state,
      secondOpinion: note,
    });
    const without = buildStructuredTurnMessages({
      systemPrompt: 'base',
      history: [],
      transcript: 'oui',
      state,
    });
    expect(String(systemOf(withNote).content)).toContain('SECONDE ÉCOUTE');
    expect(String(without[0].content)).not.toContain('SECONDE ÉCOUTE');
  });
});
