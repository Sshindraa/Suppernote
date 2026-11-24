/**
 * Lecture des journaux pino de l'API (`/var/log/suppernote/api-out.log`, rotation quotidienne, 14 jours)
 * pour reconstituer ce que le système a vu et décidé pendant un appel.
 *
 * Les journaux portent le `callControlId` ; l'appel en base porte le `callSid`. La ligne
 * `[voice-report] call linked` les relie. Pour les appels qui la précèdent, on relie par l'heure
 * de création de l'appel, et le rapport le dit. Rien ici n'appelle un service : lecture seule.
 */

export interface LogEvent {
  atMs: number;
  /** Nom normalisé : événement de tour (`tts_first_audio`), texte brut (`final_segment`) ou message. */
  type: string;
  callKey: string | null;
  turnId?: string;
  fields: Record<string, unknown>;
}

const MESSAGE_TYPES: Record<string, string> = {
  '[stream] Start call': 'stream_start',
  '[stream] New Telnyx WS connection for call': 'stream_connect',
  '[stream] Telnyx stream stop': 'stream_stop',
  '[voice-report] call linked': 'call_linked',
  '[barge-in] User spoke while assistant was speaking. Interrupting.': 'barge_in_detected',
  '[barge-in] Call interrupted': 'call_interrupted',
  '[barge-in] Refused: a single weak word is not enough to interrupt': 'barge_in_refused',
  '[stt] Ignoring a single weak word: noise, not a turn': 'noise_word_ignored',
  '[greeting] Resuming the greeting after a noise': 'greeting_resumed',
  '[stt] Transcript ignored: no caller voice in the incoming audio': 'no_caller_voice',
  '[stt] Assistant echo filtered': 'echo_filtered',
  '[voice] No-input recovery': 'no_input_recovery',
};

export function parseLogLine(line: string): LogEvent | null {
  const start = line.indexOf('{');
  if (start < 0) return null;
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(line.slice(start)) as Record<string, unknown>;
  } catch {
    return null;
  }
  const voiceTurn = record.voiceTurn as Record<string, unknown> | undefined;
  const time = typeof record.time === 'string' ? Date.parse(record.time) : NaN;
  const eventAt = typeof voiceTurn?.eventAt === 'number' ? voiceTurn.eventAt : NaN;
  const atMs = Number.isNaN(time) ? eventAt : time;
  if (Number.isNaN(atMs)) return null;

  const callKey = [record.callId, record.call_id, voiceTurn?.callId].find(
    (value): value is string => typeof value === 'string',
  );
  if (voiceTurn && typeof voiceTurn.event === 'string') {
    return {
      atMs,
      type: voiceTurn.event,
      callKey: callKey ?? null,
      ...(typeof voiceTurn.turnId === 'string' ? { turnId: voiceTurn.turnId } : {}),
      fields: voiceTurn,
    };
  }
  if (typeof record.voiceDebug === 'string') {
    return { atMs, type: record.voiceDebug, callKey: callKey ?? null, fields: record };
  }
  const msg = typeof record.msg === 'string' ? record.msg : '';
  return { atMs, type: MESSAGE_TYPES[msg] ?? 'log', callKey: callKey ?? null, fields: record };
}

export type LogSelection =
  | { status: 'linked' | 'matched_by_time'; callKey: string; events: LogEvent[] }
  | { status: 'missing' | 'ambiguous'; callKey: null; events: LogEvent[] };

/** Écart toléré entre la création de l'appel en base et le démarrage du flux dans les journaux. */
const MATCH_WINDOW_MS = 15_000;

export function selectCallLog(
  events: readonly LogEvent[],
  call: { callLegId: string; createdAtMs: number },
): LogSelection {
  const link = events.find(
    (event) =>
      event.type === 'call_linked' && event.fields.callLegId === call.callLegId && event.callKey,
  );
  const forKey = (key: string) =>
    events.filter((event) => event.callKey === key).sort((a, b) => a.atMs - b.atMs);
  if (link?.callKey)
    return { status: 'linked', callKey: link.callKey, events: forKey(link.callKey) };

  const starts = new Map<string, number>();
  for (const event of events) {
    if (event.type !== 'stream_start' && event.type !== 'stream_connect') continue;
    if (!event.callKey || Math.abs(event.atMs - call.createdAtMs) > MATCH_WINDOW_MS) continue;
    const known = starts.get(event.callKey);
    if (known === undefined || event.atMs < known) starts.set(event.callKey, event.atMs);
  }
  const candidates = [...starts.entries()].sort(
    (a, b) => Math.abs(a[1] - call.createdAtMs) - Math.abs(b[1] - call.createdAtMs),
  );
  if (candidates.length === 0) return { status: 'missing', callKey: null, events: [] };
  if (candidates.length > 1) {
    const gap =
      Math.abs(candidates[1][1] - call.createdAtMs) - Math.abs(candidates[0][1] - call.createdAtMs);
    if (gap < 5_000) return { status: 'ambiguous', callKey: null, events: [] };
  }
  const [callKey] = candidates[0];
  return { status: 'matched_by_time', callKey, events: forKey(callKey) };
}

export interface LogDecision {
  pass?: number;
  interpretation?: string;
  action?: string;
  awaiting?: string;
  actionDecision?: string;
  judge?: 'complete' | 'incomplete' | 'unavailable';
  changedFields?: string | null;
  rejectedFields?: string | null;
  atMs: number;
}

export interface LogOutput {
  transcript?: string;
  say?: string;
  reading?: string;
  understanding?: string;
  draft?: string;
  atMs: number;
}

export interface LogTurn {
  turnId: string;
  startedAtMs: number;
  /** Segments finals du moteur de transcription en direct, dans l'ordre. */
  finals: string[];
  finalizes: Array<{ trigger?: string; partial?: string; callerSilenceMs?: number; atMs: number }>;
  droppedPhrases: Array<{ text: string; reason?: string; atMs: number }>;
  echoEvents: Array<{ type: string; before?: string; after?: string; kept?: string; atMs: number }>;
  outputs: LogOutput[];
  decisions: LogDecision[];
  firstAudioAtMs?: number;
  endOfSpeechToFirstAudioMs?: number;
  firstAudioIsFiller?: boolean;
  endOfSpeechToSttFinalMs?: number;
  holdMs?: number;
  llmFirstPhraseMs?: number;
  ttsFirstByteMs?: number;
  interruptions: Array<{ type: string; atMs: number }>;
}

const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const num = (value: unknown): number | undefined => (typeof value === 'number' ? value : undefined);

export function buildLogTurns(events: readonly LogEvent[]): LogTurn[] {
  const ordered = [...events].sort((a, b) => a.atMs - b.atMs);
  const turns = new Map<string, LogTurn>();
  for (const event of ordered) {
    if (event.type !== 'started' || !event.turnId || turns.has(event.turnId)) continue;
    turns.set(event.turnId, {
      turnId: event.turnId,
      startedAtMs: event.atMs,
      finals: [],
      finalizes: [],
      droppedPhrases: [],
      echoEvents: [],
      outputs: [],
      decisions: [],
      interruptions: [],
    });
  }
  const list = [...turns.values()];
  const turnAt = (atMs: number): LogTurn | undefined => {
    let found: LogTurn | undefined;
    for (const turn of list) if (turn.startedAtMs <= atMs) found = turn;
    return found;
  };

  for (const event of ordered) {
    const turn = (event.turnId ? turns.get(event.turnId) : undefined) ?? turnAt(event.atMs);
    if (!turn) continue;
    const f = event.fields;
    switch (event.type) {
      case 'final_segment': {
        const text = str(f.text);
        if (text) turn.finals.push(text);
        break;
      }
      case 'finalize_sent':
        turn.finalizes.push({
          trigger: str(f.trigger),
          partial: str(f.partial),
          callerSilenceMs: num(f.callerSilenceMs),
          atMs: event.atMs,
        });
        break;
      case 'phrase_dropped':
        turn.droppedPhrases.push({
          text: str(f.text) ?? '',
          reason: str(f.reason),
          atMs: event.atMs,
        });
        break;
      case 'echo_suppressed':
      case 'echo_spared':
      case 'echo_prefix_stripped':
        turn.echoEvents.push({
          type: event.type,
          before: str(f.before),
          after: str(f.after),
          kept: str(f.kept),
          atMs: event.atMs,
        });
        break;
      case 'structured_output':
        turn.outputs.push({
          transcript: str(f.transcript),
          say: str(f.say),
          reading: str(f.reading),
          understanding: str(f.understanding),
          draft: str(f.draft),
          atMs: event.atMs,
        });
        break;
      case 'structured_turn':
        turn.decisions.push({
          pass: num(f.pass),
          interpretation: str(f.interpretation),
          action: str(f.action),
          awaiting: str(f.awaiting),
          actionDecision: str(f.actionDecision),
          judge: str(f.judge) as LogDecision['judge'],
          changedFields: (f.changedFields as string | null | undefined) ?? null,
          rejectedFields: (f.rejectedFields as string | null | undefined) ?? null,
          atMs: event.atMs,
        });
        break;
      case 'tts_first_audio':
        turn.firstAudioAtMs ??= event.atMs;
        turn.endOfSpeechToFirstAudioMs ??= num(f.endOfSpeechToFirstAudioMs);
        turn.firstAudioIsFiller ??=
          typeof f.firstAudioIsFiller === 'boolean' ? f.firstAudioIsFiller : undefined;
        break;
      case 'stt_final':
        turn.endOfSpeechToSttFinalMs ??= num(f.endOfSpeechToSttFinalMs);
        turn.holdMs ??= num(f.holdMs);
        break;
      case 'llm_first_phrase':
        turn.llmFirstPhraseMs ??= num(f.llmFirstPhraseMs);
        break;
      case 'tts_synthesis_first_byte':
        turn.ttsFirstByteMs ??= num(f.ttsFirstByteMs);
        break;
      case 'tts_interrupted':
      case 'barge_in':
      case 'barge_in_detected':
        turn.interruptions.push({ type: event.type, atMs: event.atMs });
        break;
    }
  }
  return list;
}

export type LoggedInterruptionType =
  | 'barge_in_detected'
  | 'barge_in_refused'
  | 'noise_word_ignored'
  | 'greeting_resumed';

/** Interruption (ou refus d'interrompre) vue par le serveur, indépendamment de l'enregistrement audio. */
export interface LoggedInterruption {
  type: LoggedInterruptionType;
  atMs: number;
  /** Secondes depuis le démarrage du flux : repère indépendant de l'audio, qui peut commencer plus tard. */
  offsetSec: number | null;
  /** Avant le premier tour : l'accueil est en cours ou vient d'être coupé. */
  beforeFirstTurn: boolean;
  wordCount?: number;
  minWordConfidence?: number | null;
  voiceMs?: number | null;
}

const LOGGED_INTERRUPTION_TYPES = new Set<string>([
  'barge_in_detected',
  'barge_in_refused',
  'noise_word_ignored',
  'greeting_resumed',
]);

/**
 * Les interruptions des journaux, y compris celles d'avant le premier tour (l'accueil) et d'avant le
 * début de l'enregistrement : `buildLogTurns` ne les voit pas, faute de tour qui les contienne.
 */
export function buildLoggedInterruptions(events: readonly LogEvent[]): LoggedInterruption[] {
  const ordered = [...events].sort((a, b) => a.atMs - b.atMs);
  const startMs = ordered.find((event) => event.type === 'stream_start')?.atMs ?? null;
  const firstTurnMs = ordered.find((event) => event.type === 'started')?.atMs ?? Infinity;
  return ordered
    .filter((event) => LOGGED_INTERRUPTION_TYPES.has(event.type))
    .map((event) => {
      const f = event.fields;
      return {
        type: event.type as LoggedInterruptionType,
        atMs: event.atMs,
        offsetSec: startMs === null ? null : Math.round(((event.atMs - startMs) / 1000) * 10) / 10,
        beforeFirstTurn: event.atMs <= firstTurnMs,
        ...(num(f.wordCount) !== undefined ? { wordCount: num(f.wordCount) } : {}),
        ...('minWordConfidence' in f
          ? { minWordConfidence: num(f.minWordConfidence) ?? null }
          : {}),
        ...('voiceMs' in f ? { voiceMs: num(f.voiceMs) ?? null } : {}),
      };
    });
}
