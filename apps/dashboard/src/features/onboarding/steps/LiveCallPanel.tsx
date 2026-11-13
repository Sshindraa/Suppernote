'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Mic, MicOff, Phone, PhoneOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { getErrorMessage } from '@/types/api';
import { useApi } from '@/lib/api';
import {
  LiveCallError,
  LiveCallSession,
  type LiveCallEndReason,
  type LiveCallLevels,
} from '../live-call/live-call-session';

// ─── APPEL EN DIRECT ───────────────────────────────────────────
// La personne qui configure Suppernote l'appelle depuis son navigateur et lui parle comme un client.
// Même pipeline que pour un vrai appel (reconnaissance, dialogue, voix) ; seules les écritures
// (réservation, message) sont simulées côté serveur.

type Phase = 'idle' | 'connecting' | 'live' | 'ended' | 'error';

const BAR_COUNT = 15;
const IDLE_BARS = [12, 20, 32, 18, 40, 28, 48, 32, 20, 38, 24, 16, 28, 12, 20];

const EXAMPLE_REQUESTS = [
  'Bonjour, vous auriez une table pour deux ce soir ?',
  'Bonjour, je voulais annuler ma réservation de demain.',
  'Bonjour, vous êtes ouverts jusqu’à quelle heure ce soir ?',
];

const END_MESSAGES: Record<LiveCallEndReason, string> = {
  hangup: 'Vous avez raccroché.',
  agent_hangup: 'Suppernote a mis fin à l’appel.',
  timeout: 'La durée maximale d’un appel de démonstration est atteinte.',
  start_timeout: 'L’appel n’a pas pu démarrer. Réessayez.',
  network: 'La connexion a été interrompue.',
  busy: 'Un appel d’essai est déjà en cours pour ce restaurant. Fermez-le, ou réessayez dans un instant.',
  invalid_ticket: 'L’appel a expiré avant de démarrer. Réessayez.',
  unavailable: 'L’appel en direct est momentanément indisponible. Réessayez dans un instant.',
};

const MIC_MESSAGES = {
  mic_denied:
    'Le micro est bloqué. Autorisez-le dans votre navigateur (icône à gauche de l’adresse), puis réessayez.',
  mic_missing: 'Aucun micro détecté. Branchez un micro ou un casque, puis réessayez.',
  mic_failed:
    'Le micro n’a pas pu être utilisé. Vérifiez qu’aucune autre application ne le bloque.',
} as const;

class LiveDemoUnavailableError extends Error {}

function formatClock(totalSeconds: number): string {
  const minutes = Math.floor(totalSeconds / 60);
  return `${minutes}:${String(totalSeconds % 60).padStart(2, '0')}`;
}

export function LiveCallPanel({
  beforeCall,
  onCompleted,
  onUnavailable,
}: {
  /** Enregistre la personnalité avant l'appel, pour que l'assistant l'utilise. */
  beforeCall?: () => Promise<void>;
  /** L'appel a eu lieu : la personne a entendu son assistant. */
  onCompleted?: () => void;
  /** Le service ne peut pas répondre : le parent bascule sur l'aperçu pré-enregistré. */
  onUnavailable?: (message: string) => void;
}) {
  const { siteId } = useApi();
  const [phase, setPhase] = useState<Phase>('idle');
  const [elapsed, setElapsed] = useState(0);
  const [maxDuration, setMaxDuration] = useState(180);
  const [muted, setMuted] = useState(false);
  const [levels, setLevels] = useState<LiveCallLevels>({ mic: 0, agent: 0, agentSpeaking: false });
  const [message, setMessage] = useState<string | null>(null);

  const sessionRef = useRef<LiveCallSession | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      sessionRef.current?.dispose();
      sessionRef.current = null;
    };
  }, []);

  // Chronomètre de l'appel.
  useEffect(() => {
    if (phase !== 'live') return;
    const timer = setInterval(() => setElapsed((value) => value + 1), 1000);
    return () => clearInterval(timer);
  }, [phase]);

  const handleEnded = useCallback(
    (reason: LiveCallEndReason, heardAgent: boolean) => {
      if (!mountedRef.current) return;
      sessionRef.current = null;
      setLevels({ mic: 0, agent: 0, agentSpeaking: false });
      setMessage(END_MESSAGES[reason]);
      setPhase(heardAgent || reason === 'hangup' ? 'ended' : 'error');
      if (heardAgent) onCompleted?.();
    },
    [onCompleted],
  );

  async function fetchTicket(): Promise<{ wsUrl: string; maxDurationSec: number }> {
    const res = await fetch('/api/proxy/restaurant/onboarding/live-demo', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(siteId ? { 'X-Suppernote-Site-ID': siteId } : {}),
      },
      body: '{}',
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 503) {
      throw new LiveDemoUnavailableError(data.error || 'L’appel en direct est indisponible.');
    }
    // Limite de débit (plusieurs appels en quelques secondes) : message lisible, sans code technique.
    if (res.status === 429 && !data.code) {
      throw new Error('Trop d’essais rapprochés. Patientez quelques secondes, puis réessayez.');
    }
    if (!res.ok) throw new Error(data.error || `Erreur ${res.status}`);
    return data;
  }

  async function startCall() {
    setMessage(null);
    setElapsed(0);
    setMuted(false);
    setPhase('connecting');

    // Création du contexte audio dans le geste de clic (exigence des navigateurs).
    let heardAgent = false;
    const session: LiveCallSession = new LiveCallSession({
      onLevels: (next) => mountedRef.current && setLevels(next),
      onAgentAudio: () => {
        heardAgent = true;
      },
      onEnded: (reason) => handleEnded(reason, heardAgent),
    });
    session.prepare();
    sessionRef.current = session;

    try {
      await session.acquireMicrophone();
      await beforeCall?.();
      const ticket = await fetchTicket();
      const { maxDurationSec } = await session.connect(ticket.wsUrl);
      if (!mountedRef.current) return session.dispose();
      setMaxDuration(maxDurationSec);
      setPhase('live');
    } catch (err) {
      session.dispose();
      sessionRef.current = null;
      if (!mountedRef.current) return;
      if (err instanceof LiveDemoUnavailableError) {
        onUnavailable?.(err.message);
        return;
      }
      if (err instanceof LiveCallError) {
        setMessage(
          err.code in MIC_MESSAGES
            ? MIC_MESSAGES[err.code as keyof typeof MIC_MESSAGES]
            : (END_MESSAGES[err.code as LiveCallEndReason] ?? err.message),
        );
      } else {
        setMessage(getErrorMessage(err, 'Erreur inconnue'));
      }
      setPhase('error');
    }
  }

  function hangup() {
    sessionRef.current?.hangup();
  }

  function toggleMute() {
    const next = !muted;
    setMuted(next);
    sessionRef.current?.setMuted(next);
  }

  const live = phase === 'live';
  const activeLevel = levels.agentSpeaking ? levels.agent : levels.mic;

  return (
    <div className="relative mx-3 overflow-hidden rounded-2xl bg-foreground px-5 py-5 text-center text-background sm:px-7">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -right-12 -top-12 h-48 w-48 rounded-full border border-background/10"
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -bottom-28 -right-16 h-56 w-56 rounded-full border border-background/5"
      />

      <p
        aria-live="polite"
        className="relative flex items-center justify-center gap-2 text-xs font-medium text-background/60"
      >
        {live ? (
          <>
            <span aria-hidden="true" className="h-2 w-2 animate-pulse rounded-full bg-success" />
            En ligne · {formatClock(elapsed)} / {formatClock(maxDuration)}
          </>
        ) : (
          <>
            <Phone size={13} aria-hidden="true" />
            {phase === 'connecting' ? 'Connexion à Suppernote…' : 'Appel en direct'}
          </>
        )}
      </p>

      <p
        aria-live="polite"
        className="relative mx-auto mt-2 max-w-xl text-lg font-medium leading-7 tracking-tight text-background sm:text-xl [text-wrap:balance]"
      >
        {live
          ? levels.agentSpeaking
            ? 'Suppernote vous répond…'
            : muted
              ? 'Micro coupé'
              : 'Suppernote vous écoute. Parlez normalement.'
          : phase === 'ended'
            ? 'Appel terminé'
            : 'Appelez votre assistant et parlez-lui comme un client.'}
      </p>

      {!live && phase !== 'ended' && phase !== 'error' && (
        <div className="relative mx-auto mt-3 max-w-xl">
          <p className="text-xs text-background/70">Par exemple, dites :</p>
          <ul className="mt-2 flex flex-wrap justify-center gap-2">
            {EXAMPLE_REQUESTS.map((request) => (
              <li
                key={request}
                className="rounded-full border border-background/15 bg-background/5 px-3 py-1 text-xs text-background/85"
              >
                «&nbsp;{request}&nbsp;»
              </li>
            ))}
          </ul>
        </div>
      )}

      <div
        className="relative my-3 flex h-10 items-center justify-center gap-1.5 text-background/70"
        aria-hidden="true"
      >
        {Array.from({ length: BAR_COUNT }, (_, index) => {
          const base = IDLE_BARS[index % IDLE_BARS.length];
          // Les barres suivent le niveau réel : voix de l'assistant ou micro, selon qui parle.
          const height = live ? 6 + (base / 48) * 30 * Math.min(1, activeLevel * 1.4) : base * 0.55;
          return (
            <span
              key={index}
              style={{ height }}
              className={cn(
                'w-1 rounded-full bg-current transition-all duration-100',
                phase === 'connecting' && 'animate-pulse motion-reduce:animate-none',
              )}
            />
          );
        })}
      </div>

      {live ? (
        <div className="relative flex items-center justify-center gap-3">
          <Button
            type="button"
            variant="outline"
            onClick={toggleMute}
            aria-pressed={muted}
            className="min-h-11 gap-2 rounded-full border-background/30 bg-transparent px-5 text-background transition-all duration-200 hover:bg-background/10 hover:text-background"
          >
            {muted ? <MicOff size={18} /> : <Mic size={18} />}
            {muted ? 'Réactiver le micro' : 'Couper le micro'}
          </Button>
          <Button
            type="button"
            onClick={hangup}
            className="min-h-11 gap-2 rounded-full bg-destructive px-5 text-destructive-foreground transition-all duration-200 hover:bg-destructive/90"
          >
            <PhoneOff size={18} />
            Raccrocher
          </Button>
        </div>
      ) : (
        <Button
          type="button"
          onClick={startCall}
          disabled={phase === 'connecting'}
          className="relative min-h-11 gap-3 rounded-full bg-background px-7 text-foreground shadow-sm transition-all duration-200 hover:bg-background/90"
        >
          {phase === 'connecting' ? (
            <Loader2 size={18} className="animate-spin" />
          ) : (
            <Phone size={18} />
          )}
          {phase === 'connecting'
            ? 'Connexion en cours…'
            : phase === 'ended' || phase === 'error'
              ? 'Rappeler Suppernote'
              : 'Appeler Suppernote'}
        </Button>
      )}

      {message && (
        <p
          role={phase === 'error' ? 'alert' : 'status'}
          className="relative mx-auto mt-3 max-w-md text-sm text-background/80"
        >
          {message}
        </p>
      )}
      <p className="relative mt-2.5 text-xs text-background/70">
        {live
          ? 'Un casque limite l’écho si vous êtes sur haut-parleurs.'
          : 'Votre micro n’est utilisé que pendant l’appel.'}
      </p>
    </div>
  );
}
