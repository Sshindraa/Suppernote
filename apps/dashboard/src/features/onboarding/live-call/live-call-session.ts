import { ALAW_SILENCE, decodeAlaw, encodeAlaw } from './alaw';
import { Downsampler, FrameAssembler } from './downsampler';

// ─── APPEL EN DIRECT DANS LE NAVIGATEUR ────────────────────────
// Le navigateur joue le rôle de l'opérateur : il envoie le micro en A-law 8 kHz au pipeline
// vocal de l'API et joue l'audio qui revient. Même protocole que le Media Stream Telnyx
// (`start`, `media`, `mark` ; `clear` pour couper la voix de l'assistant quand le client
// l'interrompt), plus `ready` / `ended` / `error` côté serveur.

const SAMPLE_RATE = 8000;
const FRAME_SAMPLES = 160; // 20 ms à 8 kHz
/** Avance de lecture avant la première trame : absorbe la gigue réseau sans retarder la voix. */
const PLAYBACK_LEAD_SECONDS = 0.12;
const READY_TIMEOUT_MS = 10_000;
const LEVEL_INTERVAL_MS = 100;

export type LiveCallEndReason =
  | 'hangup'
  | 'agent_hangup'
  | 'timeout'
  | 'start_timeout'
  | 'network'
  | 'busy'
  | 'invalid_ticket'
  | 'unavailable';

export type LiveCallMicError = 'mic_denied' | 'mic_missing' | 'mic_failed';

export class LiveCallError extends Error {
  constructor(
    readonly code: LiveCallMicError | LiveCallEndReason,
    message: string,
  ) {
    super(message);
    this.name = 'LiveCallError';
  }
}

export interface LiveCallLevels {
  /** Niveau du micro, 0..1. */
  mic: number;
  /** Niveau de la voix de l'assistant, 0..1. */
  agent: number;
  /** L'assistant est en train de parler (audio planifié et non terminé). */
  agentSpeaking: boolean;
}

export interface LiveCallHandlers {
  onLevels?: (levels: LiveCallLevels) => void;
  /** Premier audio de l'assistant reçu : l'appel est réellement établi. */
  onAgentAudio?: () => void;
  onEnded: (reason: LiveCallEndReason) => void;
}

type ServerMessage =
  | { event: 'ready'; maxDurationSec?: number }
  | { event: 'media'; media?: { payload?: string } }
  | { event: 'clear' }
  | { event: 'mark'; mark?: { name?: string } }
  | { event: 'ended'; reason?: string }
  | { event: 'error'; code?: string };

const CLOSE_CODE_REASON: Record<number, LiveCallEndReason> = {
  4401: 'invalid_ticket',
  4409: 'busy',
  4503: 'unavailable',
};

/** Le navigateur sait-il capturer le micro et jouer de l'audio en direct ? */
export function isLiveCallSupported(): boolean {
  if (typeof window === 'undefined') return false;
  const hasAudioContext = Boolean(
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: unknown }).webkitAudioContext,
  );
  return (
    hasAudioContext &&
    typeof WebSocket !== 'undefined' &&
    Boolean(navigator.mediaDevices?.getUserMedia)
  );
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function rms(analyser: AnalyserNode, buffer: Float32Array<ArrayBuffer>): number {
  analyser.getFloatTimeDomainData(buffer);
  let sum = 0;
  for (let i = 0; i < buffer.length; i++) sum += buffer[i] * buffer[i];
  // Racine puis gain : la parole normale tourne autour de 0,05–0,2 de RMS.
  return Math.min(1, Math.sqrt(sum / buffer.length) * 4);
}

const CAPTURE_WORKLET = `
class SuppernoteMicCapture extends AudioWorkletProcessor {
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) this.port.postMessage(channel.slice());
    return true;
  }
}
registerProcessor('suppernote-mic-capture', SuppernoteMicCapture);
`;

export class LiveCallSession {
  private context: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private socket: WebSocket | null = null;
  private captureNode: AudioNode | null = null;
  private micAnalyser: AnalyserNode | null = null;
  private agentAnalyser: AnalyserNode | null = null;
  private workletUrl: string | null = null;

  private downsampler: Downsampler | null = null;
  private readonly frames = new FrameAssembler(FRAME_SAMPLES);
  private streaming = false;
  private muted = false;

  private nextPlayTime = 0;
  private readonly sources = new Set<AudioBufferSourceNode>();
  private readonly markTimers = new Map<ReturnType<typeof setTimeout>, string>();
  private heardAgent = false;

  private levelTimer: ReturnType<typeof setInterval> | null = null;
  private ended = false;

  constructor(private readonly handlers: LiveCallHandlers) {}

  /**
   * À appeler de façon synchrone dans le gestionnaire du clic : les navigateurs n'autorisent la
   * lecture audio que si le contexte est créé et repris pendant un geste de l'utilisateur.
   */
  prepare(): void {
    if (this.context) return;
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.context = new Ctor();
    void this.context.resume();
  }

  /** Demande le micro. Echo, bruit et gain sont traités par le navigateur : indispensable, car la voix de l'assistant sort des mêmes haut-parleurs. */
  async acquireMicrophone(): Promise<void> {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch (err) {
      const name = (err as DOMException)?.name;
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        throw new LiveCallError('mic_denied', 'Accès au micro refusé.');
      }
      if (name === 'NotFoundError' || name === 'OverconstrainedError') {
        throw new LiveCallError('mic_missing', 'Aucun micro détecté.');
      }
      throw new LiveCallError('mic_failed', 'Le micro est inutilisable.');
    }
  }

  /** Ouvre la socket, attend que le serveur soit prêt, puis démarre l'appel. Retourne la durée maximale. */
  async connect(wsUrl: string): Promise<{ maxDurationSec: number }> {
    const context = this.context;
    if (!context || !this.stream) throw new Error('prepare() et acquireMicrophone() d’abord');

    const socket = new WebSocket(wsUrl);
    this.socket = socket;

    const ready = await new Promise<{ maxDurationSec: number }>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new LiveCallError('network', 'Connexion trop longue.')),
        READY_TIMEOUT_MS,
      );
      socket.onmessage = (event) => {
        const message = parseMessage(event.data);
        if (message?.event === 'ready') {
          clearTimeout(timeout);
          resolve({ maxDurationSec: message.maxDurationSec ?? 180 });
        } else if (message?.event === 'error') {
          clearTimeout(timeout);
          reject(new LiveCallError(reasonFromErrorCode(message.code), 'Appel refusé.'));
        }
      };
      socket.onclose = (event) => {
        clearTimeout(timeout);
        reject(new LiveCallError(CLOSE_CODE_REASON[event.code] ?? 'network', 'Connexion fermée.'));
      };
      socket.onerror = () => {
        clearTimeout(timeout);
        reject(new LiveCallError('network', 'Connexion impossible.'));
      };
    });

    socket.onmessage = (event) => this.onServerMessage(event.data);
    socket.onclose = (event) => this.finish(CLOSE_CODE_REASON[event.code] ?? 'network');
    socket.onerror = () => this.finish('network');

    await this.startCapture();
    this.startLevels();
    this.send({ event: 'start' });
    this.streaming = true;
    return ready;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.stream?.getAudioTracks().forEach((track) => (track.enabled = !muted));
  }

  hangup(): void {
    if (this.ended) return;
    this.send({ event: 'stop' });
    this.finish('hangup');
  }

  get hasHeardAgent(): boolean {
    return this.heardAgent;
  }

  /** Libère tout sans notifier : à utiliser au démontage du composant. */
  dispose(): void {
    this.ended = true;
    this.teardown();
  }

  // ─── Capture ─────────────────────────────────────────────────

  private async startCapture(): Promise<void> {
    const context = this.context!;
    const source = context.createMediaStreamSource(this.stream!);
    this.downsampler = new Downsampler(context.sampleRate, SAMPLE_RATE);

    this.micAnalyser = context.createAnalyser();
    this.micAnalyser.fftSize = 1024;
    source.connect(this.micAnalyser);

    // Le nœud de capture doit être relié à la sortie pour être exécuté ; un gain nul évite l'écho local.
    const sink = context.createGain();
    sink.gain.value = 0;
    sink.connect(context.destination);

    let node: AudioNode;
    try {
      if (!context.audioWorklet) throw new Error('AudioWorklet indisponible');
      this.workletUrl = URL.createObjectURL(
        new Blob([CAPTURE_WORKLET], { type: 'application/javascript' }),
      );
      await context.audioWorklet.addModule(this.workletUrl);
      const worklet = new AudioWorkletNode(context, 'suppernote-mic-capture');
      worklet.port.onmessage = (event: MessageEvent<Float32Array>) => this.onMicSamples(event.data);
      node = worklet;
    } catch {
      // Repli : ScriptProcessor est déprécié mais présent partout, sans contrainte de CSP.
      const processor = context.createScriptProcessor(2048, 1, 1);
      processor.onaudioprocess = (event) =>
        this.onMicSamples(new Float32Array(event.inputBuffer.getChannelData(0)));
      node = processor;
    }
    source.connect(node);
    node.connect(sink);
    this.captureNode = node;
  }

  private onMicSamples(samples: Float32Array): void {
    if (!this.streaming || this.ended || !this.downsampler) return;
    const downsampled = this.downsampler.process(samples);
    for (const frame of this.frames.push(downsampled)) {
      // Micro coupé : on envoie du silence plutôt que rien, pour que la reconnaissance reste active.
      const bytes = this.muted
        ? new Uint8Array(FRAME_SAMPLES).fill(ALAW_SILENCE)
        : encodeAlaw(frame);
      this.send({ event: 'media', media: { payload: toBase64(bytes) } });
    }
  }

  // ─── Lecture ─────────────────────────────────────────────────

  private onServerMessage(data: unknown): void {
    const message = parseMessage(data);
    if (!message) return;
    switch (message.event) {
      case 'media':
        if (message.media?.payload) this.play(message.media.payload);
        return;
      case 'clear':
        this.clearPlayback();
        return;
      case 'mark':
        if (message.mark?.name) this.acknowledgeMarkAfterPlayback(message.mark.name);
        return;
      case 'ended':
        this.finish(mapEndedReason(message.reason));
        return;
      case 'error':
        this.finish(reasonFromErrorCode(message.code));
        return;
      default:
        return;
    }
  }

  private play(payload: string): void {
    const context = this.context;
    if (!context || this.ended) return;
    const pcm = decodeAlaw(fromBase64(payload));
    if (pcm.length === 0) return;

    const buffer = context.createBuffer(1, pcm.length, SAMPLE_RATE);
    buffer.copyToChannel(pcm as Float32Array<ArrayBuffer>, 0);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.agentOutput());

    // File gapless ; si le flux a pris du retard, on se recale plutôt que de jouer dans le passé.
    const now = context.currentTime;
    if (this.nextPlayTime < now) this.nextPlayTime = now + PLAYBACK_LEAD_SECONDS;
    source.start(this.nextPlayTime);
    this.nextPlayTime += buffer.duration;

    this.sources.add(source);
    source.onended = () => this.sources.delete(source);

    if (!this.heardAgent) {
      this.heardAgent = true;
      this.handlers.onAgentAudio?.();
    }
  }

  private agentOutput(): AudioNode {
    const context = this.context!;
    if (!this.agentAnalyser) {
      this.agentAnalyser = context.createAnalyser();
      this.agentAnalyser.fftSize = 1024;
      this.agentAnalyser.connect(context.destination);
    }
    return this.agentAnalyser;
  }

  /** Barge-in : le client a parlé, l'assistant doit se taire immédiatement. */
  private clearPlayback(): void {
    for (const source of this.sources) {
      try {
        source.stop();
      } catch {
        /* déjà arrêtée */
      }
    }
    this.sources.clear();
    this.nextPlayTime = 0;
    // Comme Telnyx, un `clear` acquitte aussitôt les marks en attente.
    for (const [timer, name] of this.markTimers) {
      clearTimeout(timer);
      this.send({ event: 'mark', mark: { name } });
    }
    this.markTimers.clear();
  }

  /** Acquitte une mark une fois tout l'audio planifié joué (le serveur raccroche alors). */
  private acknowledgeMarkAfterPlayback(name: string): void {
    const context = this.context;
    const remainingMs = context ? Math.max(0, (this.nextPlayTime - context.currentTime) * 1000) : 0;
    const timer = setTimeout(() => {
      this.markTimers.delete(timer);
      this.send({ event: 'mark', mark: { name } });
    }, remainingMs);
    this.markTimers.set(timer, name);
  }

  // ─── Niveaux, fin d'appel ────────────────────────────────────

  private startLevels(): void {
    if (!this.handlers.onLevels) return;
    const micBuffer = new Float32Array(1024);
    const agentBuffer = new Float32Array(1024);
    this.levelTimer = setInterval(() => {
      const context = this.context;
      if (!context || this.ended) return;
      this.handlers.onLevels?.({
        mic: this.micAnalyser && !this.muted ? rms(this.micAnalyser, micBuffer) : 0,
        agent: this.agentAnalyser ? rms(this.agentAnalyser, agentBuffer) : 0,
        agentSpeaking: this.nextPlayTime > context.currentTime,
      });
    }, LEVEL_INTERVAL_MS);
  }

  private send(payload: Record<string, unknown>): void {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(payload));
  }

  private finish(reason: LiveCallEndReason): void {
    if (this.ended) return;
    this.ended = true;
    this.teardown();
    this.handlers.onEnded(reason);
  }

  private teardown(): void {
    this.streaming = false;
    if (this.levelTimer) clearInterval(this.levelTimer);
    for (const timer of this.markTimers.keys()) clearTimeout(timer);
    this.markTimers.clear();
    for (const source of this.sources) {
      try {
        source.stop();
      } catch {
        /* déjà arrêtée */
      }
    }
    this.sources.clear();

    if (this.socket) {
      this.socket.onmessage = null;
      this.socket.onclose = null;
      this.socket.onerror = null;
      if (
        this.socket.readyState === WebSocket.OPEN ||
        this.socket.readyState === WebSocket.CONNECTING
      ) {
        this.socket.close(1000);
      }
    }
    if (this.captureNode) {
      this.captureNode.disconnect();
      if ('port' in this.captureNode) (this.captureNode as AudioWorkletNode).port.onmessage = null;
      if ('onaudioprocess' in this.captureNode) {
        (this.captureNode as ScriptProcessorNode).onaudioprocess = null;
      }
    }
    this.stream?.getTracks().forEach((track) => track.stop());
    if (this.workletUrl) URL.revokeObjectURL(this.workletUrl);
    if (this.context && this.context.state !== 'closed') void this.context.close();
  }
}

function parseMessage(data: unknown): ServerMessage | null {
  if (typeof data !== 'string') return null;
  try {
    return JSON.parse(data) as ServerMessage;
  } catch {
    return null;
  }
}

function reasonFromErrorCode(code: string | undefined): LiveCallEndReason {
  if (code === 'busy') return 'busy';
  if (code === 'invalid_ticket') return 'invalid_ticket';
  if (code === 'unavailable') return 'unavailable';
  return 'network';
}

function mapEndedReason(reason: string | undefined): LiveCallEndReason {
  if (reason === 'agent_hangup') return 'agent_hangup';
  if (reason === 'timeout') return 'timeout';
  if (reason === 'start_timeout') return 'start_timeout';
  return 'network';
}
