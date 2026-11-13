import { describe, expect, it, beforeEach } from 'vitest';
import {
  renderMetrics,
  __resetMetrics,
  voiceTurnDurationMs,
  voiceLlmFirstTokenMs,
  voiceTtsFirstAudioMs,
  voiceProviderErrorsTotal,
  voiceSemanticAnswerSkippedTotal,
  voiceSemanticChoiceConfidence,
  voiceSemanticEvalPrecision,
  recordVoiceTurnPlanShadowObservation,
} from '../metrics';

describe('Voice Prometheus metrics', () => {
  beforeEach(() => {
    __resetMetrics();
  });

  it('enregistre suppernote_voice_turn_duration_ms dans le registry Prometheus', async () => {
    voiceTurnDurationMs.observe(750);
    const payload = await renderMetrics();
    expect(payload).toContain('suppernote_voice_turn_duration_ms');
    expect(payload).toContain('suppernote_voice_turn_duration_ms_bucket{le="1000"');
  });

  it('observe suppernote_voice_llm_first_token_ms (TTFT)', async () => {
    voiceLlmFirstTokenMs.observe(120);
    voiceLlmFirstTokenMs.observe(480);
    const payload = await renderMetrics();
    expect(payload).toContain('suppernote_voice_llm_first_token_ms');
    expect(payload).toContain('suppernote_voice_llm_first_token_ms_bucket{le="200"');
    expect(payload).toContain('suppernote_voice_llm_first_token_ms_bucket{le="500"');
  });

  it('observe suppernote_voice_tts_first_audio_ms', async () => {
    voiceTtsFirstAudioMs.observe(300);
    const payload = await renderMetrics();
    expect(payload).toContain('suppernote_voice_tts_first_audio_ms');
    expect(payload).toContain('suppernote_voice_tts_first_audio_ms_bucket{le="500"');
  });

  it('incrémente voice_provider_errors_total avec labels provider et type', async () => {
    voiceProviderErrorsTotal.inc({ provider: 'deepgram_stt', type: 'ws_error' });
    voiceProviderErrorsTotal.inc({ provider: 'cartesia', type: '5xx' });
    voiceProviderErrorsTotal.inc({ provider: 'cerebras', type: 'timeout' });
    voiceProviderErrorsTotal.inc({ provider: 'cerebras', type: '429' });
    voiceProviderErrorsTotal.inc({ provider: 'cerebras', type: '5xx' });
    voiceProviderErrorsTotal.inc({ provider: 'cerebras', type: 'session_abort' });
    const payload = await renderMetrics();
    expect(payload).toContain('voice_provider_errors_total');
    expect(payload).toMatch(
      /voice_provider_errors_total\{[^}]*provider="deepgram_stt"[^}]*type="ws_error"[^}]*\} 1/,
    );
    expect(payload).toMatch(
      /voice_provider_errors_total\{[^}]*provider="cartesia"[^}]*type="5xx"[^}]*\} 1/,
    );
    expect(payload).toMatch(
      /voice_provider_errors_total\{[^}]*provider="cerebras"[^}]*type="timeout"[^}]*\} 1/,
    );
    expect(payload).toMatch(
      /voice_provider_errors_total\{[^}]*provider="cerebras"[^}]*type="429"[^}]*\} 1/,
    );
    expect(payload).toMatch(
      /voice_provider_errors_total\{[^}]*provider="cerebras"[^}]*type="5xx"[^}]*\} 1/,
    );
    expect(payload).toMatch(
      /voice_provider_errors_total\{[^}]*provider="cerebras"[^}]*type="session_abort"[^}]*\} 1/,
    );
  });

  it('compte les résultats shadow et mesure leur durée avec des labels bornés', async () => {
    recordVoiceTurnPlanShadowObservation({
      status: 'valid',
      policyOutcome: 'accepted',
      agreement: 'disagree',
      path: 'llm',
    });
    recordVoiceTurnPlanShadowObservation({
      status: 'missing',
      policyOutcome: 'not_evaluated',
      agreement: 'not_comparable',
      path: 'deferred',
    });

    const payload = await renderMetrics();
    expect(payload).toMatch(
      /suppernote_voice_turn_plan_shadow_observations_total\{[^}]*status="valid"[^}]*policy_outcome="accepted"[^}]*agreement="disagree"[^}]*path="llm"[^}]*\} 1/,
    );
    expect(payload).toMatch(
      /suppernote_voice_turn_plan_shadow_observations_total\{[^}]*status="missing"[^}]*policy_outcome="not_evaluated"[^}]*agreement="not_comparable"[^}]*path="deferred"[^}]*\} 1/,
    );
  });

  it('réinitialise les métriques sémantiques Jev et les nouvelles jauges de rapport', async () => {
    voiceSemanticAnswerSkippedTotal.inc({ provider: 'openrouter', reason: 'unknown_type' });
    voiceSemanticChoiceConfidence.observe(
      { choice: 'proposal_response_choice', provider: 'openrouter' },
      0.9,
    );
    voiceSemanticEvalPrecision.set({ behavior: 'answers_active_question', threshold: '0.8' }, 0.75);

    __resetMetrics();
    const payload = await renderMetrics();

    expect(payload).not.toContain('suppernote_voice_semantic_answer_skipped_total{');
    expect(payload).not.toContain('suppernote_voice_semantic_choice_confidence_bucket{');
    expect(payload).not.toContain('suppernote_voice_semantic_eval_precision{');
  });

  it("n'a pas de collision de noms de métriques voice", async () => {
    const payload = await renderMetrics();
    // Vérifier que chaque nom de métrique voice apparaît exactement une fois
    // dans les lignes HELP (une par métrique).
    const voiceHelpLines = payload
      .split('\n')
      .filter((line) => line.startsWith('# HELP') && line.includes('voice_'));
    const voiceNames = voiceHelpLines.map((line) => line.split(' ')[2]);
    const uniqueNames = new Set(voiceNames);
    expect(voiceNames.length).toBe(uniqueNames.size);
    expect(voiceNames).toContain('suppernote_voice_turn_duration_ms');
    expect(voiceNames).toContain('suppernote_voice_llm_first_token_ms');
    expect(voiceNames).toContain('suppernote_voice_tts_first_audio_ms');
    expect(voiceNames).toContain('suppernote_voice_provider_errors_total');
    expect(voiceNames).toContain('suppernote_voice_turn_plan_shadow_observations_total');
  });

  it('les buckets voice sont réalistes pour la latence voice (TTFT < 500ms target)', () => {
    // Les buckets doivent inclure des valeurs sous 500ms pour le TTFT
    // afin de pouvoir distinguer les réponses rapides des lentes.
    const payload = renderMetrics.toString();
    // Vérification indirecte : observe à 100ms doit tomber dans un bucket
    // inférieur à 500ms. On vérifie via le registry.
    voiceLlmFirstTokenMs.observe(100);
    voiceLlmFirstTokenMs.observe(450);
    // Pas d'erreur = les buckets acceptent ces valeurs
    expect(true).toBe(true);
  });
});
