import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetMetrics,
  recordVoiceQualityTurnEvent,
  renderMetrics,
} from '../../../shared/observability/metrics';
import {
  observeVoiceReadbackResponse,
  recordVoiceChoiceResponse,
  recordVoiceQuestionForTurn,
  recordVoiceReadbackForTurn,
} from '../stream/voice-quality';
import type { CallSession } from '../stream/types';

function makeMetricSession(): CallSession {
  return { currentTurn: { id: 'turn-1' } } as unknown as CallSession;
}

describe('voice quality metrics', () => {
  beforeEach(() => {
    __resetMetrics();
  });

  it('compte les issues attendues, la confiance shadow, les choix et les cohorts de relance', async () => {
    recordVoiceQualityTurnEvent('expected_answer', { kind: 'partySize', status: 'accepted' });
    recordVoiceQualityTurnEvent('expected_answer', { kind: 'weekday', status: 'choice' });
    recordVoiceQualityTurnEvent('expected_answer', { kind: 'time', status: 'unresolved' });
    recordVoiceQualityTurnEvent('slot_confidence', {
      kind: 'time',
      decision: 'wouldBeChoice',
    });
    recordVoiceQualityTurnEvent('slot_confidence', {
      kind: 'weekday',
      decision: 'wouldBeReadBack',
    });
    recordVoiceQualityTurnEvent('slot_confidence', {
      kind: 'partySize',
      decision: 'wouldBeReprompt',
    });
    recordVoiceChoiceResponse({ kind: 'partySize', values: ['2', '4'] }, '2', 'content');
    recordVoiceChoiceResponse({ kind: 'time', values: ['18:00', '19:00'] }, '19:00', 'content');
    recordVoiceChoiceResponse({ kind: 'time', values: ['18:00', '19:00'] }, '20:00', 'content');
    recordVoiceChoiceResponse(
      { kind: 'weekday', values: ['mardi', 'mercredi'] },
      undefined,
      'content',
      true,
    );
    const session = makeMetricSession();
    recordVoiceQuestionForTurn(session, 'party_size', 'flag_off', false);
    recordVoiceQuestionForTurn(session, 'party_size', 'flag_off', true);
    recordVoiceQuestionForTurn(makeMetricSession(), 'time', 'flag_on', true);

    const payload = await renderMetrics();
    expect(payload).toMatch(
      /suppernote_voice_expected_answer_total\{kind="party_size",status="accepted"\} 1/,
    );
    expect(payload).toMatch(
      /suppernote_voice_expected_answer_total\{kind="date",status="choice"\} 1/,
    );
    expect(payload).toMatch(
      /suppernote_voice_expected_answer_total\{kind="time",status="unresolved"\} 1/,
    );
    expect(payload).toMatch(
      /suppernote_voice_slot_confidence_total\{kind="time",decision="wouldBeChoice"\} 1/,
    );
    expect(payload).toMatch(
      /suppernote_voice_slot_confidence_total\{kind="date",decision="wouldBeReadBack"\} 1/,
    );
    expect(payload).toMatch(
      /suppernote_voice_slot_confidence_total\{kind="party_size",decision="wouldBeReprompt"\} 1/,
    );
    expect(payload).toMatch(
      /suppernote_voice_choice_answer_total\{kind="party_size",outcome="first"\} 1/,
    );
    expect(payload).toMatch(
      /suppernote_voice_choice_answer_total\{kind="time",outcome="second"\} 1/,
    );
    expect(payload).toMatch(
      /suppernote_voice_choice_answer_total\{kind="time",outcome="other"\} 1/,
    );
    expect(payload).toMatch(
      /suppernote_voice_choice_answer_total\{kind="date",outcome="neither"\} 1/,
    );
    expect(payload).toMatch(
      /suppernote_voice_reprompt_total\{kind="party_size",cohort="flag_off"\} 1/,
    );
    expect(payload).toMatch(
      /suppernote_voice_question_total\{kind="party_size",cohort="flag_off"\} 1/,
    );
    expect(payload).toMatch(/suppernote_voice_reprompt_total\{kind="time",cohort="flag_on"\} 1/);
  });

  it('compte une valeur relue puis corrigée au tour suivant', async () => {
    const session = makeMetricSession();
    recordVoiceReadbackForTurn(session, 'party_size', 4);
    observeVoiceReadbackResponse(session, { partySize: 5 }, 'correction');

    const payload = await renderMetrics();
    expect(payload).toMatch(/suppernote_voice_readback_total\{kind="party_size"\} 1/);
    expect(payload).toMatch(/suppernote_voice_readback_corrected_total\{kind="party_size"\} 1/);
  });

  it('ne compte une nouvelle valeur que pour le champ relu', async () => {
    const session = makeMetricSession();
    recordVoiceReadbackForTurn(session, 'date', '2026-10-02');
    recordVoiceReadbackForTurn(session, 'time', '19:00');
    observeVoiceReadbackResponse(session, { date: '2026-10-03', time: '19:00' }, 'content');

    const payload = await renderMetrics();
    expect(payload).toMatch(/suppernote_voice_readback_corrected_total\{kind="date"\} 1/);
    expect(payload).not.toContain('suppernote_voice_readback_corrected_total{kind="time"}');
  });

  it('compte un acte de correction explicite quand un seul champ a été relu', async () => {
    const session = makeMetricSession();
    recordVoiceReadbackForTurn(session, 'date', '2026-10-02');
    observeVoiceReadbackResponse(session, {}, 'correction');

    const payload = await renderMetrics();
    expect(payload).toMatch(/suppernote_voice_readback_corrected_total\{kind="date"\} 1/);
  });

  it('limite la correction à un tour et n’expose ni valeur ni donnée personnelle', async () => {
    const session = makeMetricSession();
    recordVoiceReadbackForTurn(session, 'time', '20:30');
    observeVoiceReadbackResponse(session, {}, 'content');
    session.currentTurn = { id: 'turn-2' } as NonNullable<CallSession['currentTurn']>;
    observeVoiceReadbackResponse(session, { time: '21:00' }, 'correction');
    recordVoiceQualityTurnEvent('expected_answer', {
      kind: 'time',
      status: 'accepted',
      value: '20:30',
      transcript: 'SECRET_TRANSCRIPT',
      phone: '+33600000000',
      callId: 'call-secret',
    });

    const payload = await renderMetrics();
    expect(payload).not.toContain('SECRET_TRANSCRIPT');
    expect(payload).not.toContain('+33600000000');
    expect(payload).not.toContain('call-secret');
    expect(payload).not.toContain('20:30');
    expect(payload).not.toContain('21:00');
    expect(payload).not.toContain('suppernote_voice_readback_corrected_total{kind="time"}');
  });
});
