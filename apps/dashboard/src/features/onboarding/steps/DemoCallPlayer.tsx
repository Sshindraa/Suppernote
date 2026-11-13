'use client';

import { useEffect, useRef, useState } from 'react';
import { Loader2, Play, Pause, AudioLines, Phone, Volume2, VolumeX } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { getErrorMessage } from '@/types/api';
import { useApi } from '@/lib/api';
import { isLiveCallSupported } from '../live-call/live-call-session';
import { LiveCallPanel } from './LiveCallPanel';

// ─── DEMO CALL PLAYER ──────────────────────────────────────────
// Aha moment mid-onboarding : l'utilisateur appelle son assistant vocal depuis le navigateur,
// avec sa personnalité courante, avant d'avoir fini la config (mode « live »).
// Repli « scripted » : aperçu pré-enregistré (navigateur sans micro, service indisponible).
// Fallback transcript-only si Cartesia n'est pas configurée (dev local).

type DemoCallState = {
  loading: boolean;
  audioUrl: string | null;
  transcript: string | null;
  fallback: boolean;
  error: string | null;
};

const INITIAL_DEMO_STATE: DemoCallState = {
  loading: false,
  audioUrl: null,
  transcript: null,
  fallback: false,
  error: null,
};

const INITIAL_PLAYBACK_STATE = {
  currentTime: 0,
  duration: 0,
  isPlaying: false,
  muted: false,
};

function formatPlaybackTime(seconds: number) {
  if (!Number.isFinite(seconds)) return '0:00';

  const totalSeconds = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(totalSeconds / 60);
  const remainingSeconds = String(totalSeconds % 60).padStart(2, '0');

  return `${minutes}:${remainingSeconds}`;
}

const DEMO_SCRIPTS = [
  { id: 'reservation', label: 'Réservation' },
  { id: 'cancellation', label: 'Annulation' },
  { id: 'menu', label: 'Question menu' },
] as const;

export function DemoCallPlayer({
  onPlayed,
  beforePlay,
}: {
  onPlayed?: () => void;
  beforePlay?: () => Promise<void>;
}) {
  const { siteId } = useApi();
  const audioRef = useRef<HTMLAudioElement>(null);
  const [mode, setMode] = useState<'live' | 'scripted'>('live');
  const [notice, setNotice] = useState<string | null>(null);
  const [activeScript, setActiveScript] = useState<'reservation' | 'cancellation' | 'menu'>(
    'reservation',
  );
  const [demo, setDemo] = useState<DemoCallState>(INITIAL_DEMO_STATE);
  const [playback, setPlayback] = useState(INITIAL_PLAYBACK_STATE);

  // Sans API micro/audio (navigateur ancien), l'appel en direct est impossible : aperçu seul.
  useEffect(() => {
    if (!isLiveCallSupported()) {
      setMode('scripted');
      setNotice('L’appel en direct n’est pas disponible sur ce navigateur.');
    }
  }, []);

  // Révoque l'object URL précédente pour éviter les fuites mémoire.
  useEffect(() => {
    return () => {
      if (demo.audioUrl) URL.revokeObjectURL(demo.audioUrl);
    };
  }, [demo.audioUrl]);

  // Reset l'audio quand on change de script.
  useEffect(() => {
    if (demo.audioUrl) URL.revokeObjectURL(demo.audioUrl);
    setDemo(INITIAL_DEMO_STATE);
    setPlayback(INITIAL_PLAYBACK_STATE);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeScript]);

  async function handlePlay() {
    setDemo({ ...INITIAL_DEMO_STATE, loading: true });
    setPlayback(INITIAL_PLAYBACK_STATE);
    try {
      await beforePlay?.();
      const res = await fetch('/api/proxy/restaurant/onboarding/demo-call', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(siteId ? { 'X-Suppernote-Site-ID': siteId } : {}),
        },
        body: JSON.stringify({ scriptId: activeScript }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `Erreur ${res.status}`);
      }

      const contentType = res.headers.get('content-type') ?? '';

      if (contentType.includes('audio/')) {
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        setDemo({ loading: false, audioUrl: url, transcript: null, fallback: false, error: null });
      } else {
        const data = await res.json();
        setDemo({
          loading: false,
          audioUrl: null,
          transcript: data.transcript ?? null,
          fallback: Boolean(data.fallback),
          error: null,
        });
        onPlayed?.();
      }
    } catch (err: unknown) {
      setDemo({ ...INITIAL_DEMO_STATE, error: getErrorMessage(err, 'Erreur inconnue') });
    }
  }

  function toggleAudioPlayback() {
    const audio = audioRef.current;
    if (!audio) return;

    if (audio.paused) {
      void audio.play().catch(() => {
        setDemo((current) => ({
          ...current,
          error: 'La lecture audio est indisponible. Réessayez.',
        }));
      });
    } else {
      audio.pause();
    }
  }

  function toggleMute() {
    const audio = audioRef.current;
    if (!audio) return;

    audio.muted = !audio.muted;
    setPlayback((current) => ({ ...current, muted: audio.muted }));
  }

  const playbackProgress = playback.duration
    ? Math.min(100, (playback.currentTime / playback.duration) * 100)
    : 0;

  return (
    <div className="overflow-hidden rounded-3xl border border-border bg-background shadow-sm">
      <div className="px-6 py-4 sm:px-8">
        <h3 className="text-xl font-semibold tracking-tight text-foreground">
          {mode === 'live' ? 'Parlez à Suppernote' : 'Écoutez Suppernote'}
        </h3>
      </div>
      {mode === 'live' ? (
        <LiveCallPanel
          beforeCall={beforePlay}
          onCompleted={onPlayed}
          onUnavailable={(message) => {
            setNotice(message);
            setMode('scripted');
          }}
        />
      ) : (
        <div className="relative mx-3 overflow-hidden rounded-2xl bg-foreground px-5 py-6 text-center text-background sm:px-7">
          <div
            aria-hidden="true"
            className="pointer-events-none absolute -right-12 -top-12 h-48 w-48 rounded-full border border-background/10"
          />
          <div
            aria-hidden="true"
            className="pointer-events-none absolute -bottom-28 -right-16 h-56 w-56 rounded-full border border-background/5"
          />
          <p className="relative flex items-center justify-center gap-2 text-xs font-medium text-background/60">
            <Phone size={13} aria-hidden="true" />
            Un client appelle…
          </p>
          <p className="mx-auto mt-3 max-w-md text-xl font-medium leading-7 tracking-tight text-background [text-wrap:balance]">
            «{' '}
            {activeScript === 'reservation'
              ? 'Bonjour, avez-vous une table pour deux ce soir ?'
              : activeScript === 'cancellation'
                ? 'Bonjour, je souhaite annuler ma réservation.'
                : 'Bonjour, proposez-vous des plats végétariens ?'}{' '}
            »
          </p>
          {demo.audioUrl ? (
            <div className="my-4 rounded-2xl bg-background px-3 py-3 text-left text-foreground shadow-sm sm:rounded-full sm:px-4">
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={toggleAudioPlayback}
                  aria-label={
                    playback.isPlaying
                      ? 'Mettre la lecture en pause'
                      : 'Lire la réponse de Suppernote'
                  }
                  className="inline-flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-foreground text-background transition-all duration-200 hover:opacity-80 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
                >
                  {playback.isPlaying ? (
                    <Pause size={17} fill="currentColor" aria-hidden="true" />
                  ) : (
                    <Play size={17} fill="currentColor" aria-hidden="true" />
                  )}
                </button>

                <div className="min-w-0 flex-1">
                  <div className="mb-1 flex items-center justify-between gap-3 text-xs">
                    <span className="truncate font-medium">Réponse de Suppernote</span>
                    <span className="shrink-0 tabular-nums text-muted-foreground">
                      {formatPlaybackTime(playback.currentTime)}
                      <span aria-hidden="true"> / </span>
                      {formatPlaybackTime(playback.duration)}
                    </span>
                  </div>
                  <div className="relative flex h-7 items-center sm:h-6">
                    <div
                      aria-hidden="true"
                      className="pointer-events-none absolute inset-x-0 h-1 rounded-full bg-muted"
                    />
                    <div
                      aria-hidden="true"
                      className="pointer-events-none absolute left-0 h-1 rounded-full bg-foreground transition-[width] duration-100"
                      style={{ width: `${playbackProgress}%` }}
                    />
                    <input
                      type="range"
                      min={0}
                      max={playback.duration || 1}
                      step={0.1}
                      value={Math.min(playback.currentTime, playback.duration || 0)}
                      disabled={!playback.duration}
                      aria-label="Position dans la réponse audio"
                      aria-valuetext={`${formatPlaybackTime(playback.currentTime)} sur ${formatPlaybackTime(playback.duration)}`}
                      onChange={(event) => {
                        const currentTime = Number(event.target.value);
                        if (audioRef.current) audioRef.current.currentTime = currentTime;
                        setPlayback((current) => ({ ...current, currentTime }));
                      }}
                      className="relative z-10 h-full w-full cursor-pointer appearance-none bg-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default"
                    />
                  </div>
                </div>

                <button
                  type="button"
                  onClick={toggleMute}
                  aria-label={playback.muted ? 'Activer le son' : 'Couper le son'}
                  aria-pressed={playback.muted}
                  className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-all duration-200 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {playback.muted ? (
                    <VolumeX size={18} aria-hidden="true" />
                  ) : (
                    <Volume2 size={18} aria-hidden="true" />
                  )}
                </button>
              </div>
              <audio
                ref={audioRef}
                autoPlay
                onPlay={() => setPlayback((current) => ({ ...current, isPlaying: true }))}
                onPause={() => setPlayback((current) => ({ ...current, isPlaying: false }))}
                onTimeUpdate={(event) => {
                  const currentTime = event.currentTarget.currentTime;
                  setPlayback((current) => ({
                    ...current,
                    currentTime,
                  }));
                }}
                onLoadedMetadata={(event) => {
                  const duration = event.currentTarget.duration;
                  setPlayback((current) => ({
                    ...current,
                    duration,
                  }));
                }}
                onEnded={() => {
                  setPlayback((current) => ({
                    ...current,
                    currentTime: current.duration,
                    isPlaying: false,
                  }));
                  onPlayed?.();
                }}
                onError={() =>
                  setDemo((current) => ({
                    ...current,
                    error: 'La lecture audio est indisponible. Réessayez.',
                  }))
                }
                src={demo.audioUrl}
                className="sr-only"
              >
                <track kind="captions" />
              </audio>
            </div>
          ) : demo.transcript ? (
            <div className="my-4 rounded-2xl border border-background/15 bg-background/5 p-4 text-left">
              <p className="text-xs font-medium uppercase tracking-wide text-background/60">
                {demo.fallback ? 'Aperçu écrit · audio indisponible' : 'Réponse de Suppernote'}
              </p>
              <p className="mt-1 text-sm italic text-background">
                &laquo;&nbsp;{demo.transcript}&nbsp;&raquo;
              </p>
            </div>
          ) : (
            <div
              className="my-4 flex items-center justify-center gap-1.5 text-background/70"
              aria-hidden="true"
            >
              {[12, 20, 32, 18, 40, 28, 48, 32, 20, 38, 24, 16, 28, 12, 20].map((height, index) => (
                <span
                  key={index}
                  style={{ height: height * 0.65 }}
                  className={cn(
                    'w-1 rounded-full bg-current',
                    demo.loading && 'animate-pulse motion-reduce:animate-none',
                  )}
                />
              ))}
            </div>
          )}
          <Button
            type="button"
            onClick={handlePlay}
            disabled={demo.loading}
            className="relative min-h-11 gap-3 rounded-full bg-background px-7 text-foreground shadow-sm transition-all duration-200 hover:bg-background/90"
          >
            {demo.loading ? <Loader2 size={18} className="animate-spin" /> : <Play size={18} />}
            {demo.loading
              ? 'Préparation de votre aperçu…'
              : demo.audioUrl || demo.transcript
                ? 'Réécouter Suppernote'
                : 'Écouter Suppernote'}
          </Button>
        </div>
      )}
      <div className="px-6 py-4 sm:px-8">
        {mode === 'scripted' && (
          <>
            <p className="text-xs font-medium text-muted-foreground">
              Essayez une autre conversation
            </p>
            {/* Sélecteur de scénario — montre comment les choix de personnalité
          se traduisent en comportement sur 3 types d'appels différents. */}
            <div className="mt-2 flex flex-wrap gap-1.5">
              {DEMO_SCRIPTS.map((script) => (
                <button
                  key={script.id}
                  type="button"
                  disabled={demo.loading}
                  aria-pressed={activeScript === script.id}
                  onClick={() => setActiveScript(script.id)}
                  className={cn(
                    'rounded-full border px-3 py-1.5 text-xs font-medium transition-all duration-200',
                    activeScript === script.id
                      ? 'border-foreground/30 bg-muted text-foreground'
                      : 'border-border bg-background/60 text-muted-foreground hover:bg-accent hover:text-foreground',
                  )}
                >
                  {script.label}
                </button>
              ))}
            </div>
          </>
        )}

        {notice && mode === 'scripted' && (
          <p role="status" className="mt-3 text-sm text-muted-foreground">
            {notice}
          </p>
        )}
        <div
          className={cn(
            'flex flex-wrap items-center justify-between gap-x-4 gap-y-2',
            (notice || mode === 'scripted') && 'mt-3',
          )}
        >
          {mode === 'live' ? (
            <button
              type="button"
              onClick={() => setMode('scripted')}
              className="text-xs font-medium text-muted-foreground underline underline-offset-4 transition-all duration-200 hover:text-foreground"
            >
              Écouter un exemple pré-enregistré
            </button>
          ) : (
            isLiveCallSupported() && (
              <button
                type="button"
                onClick={() => {
                  setNotice(null);
                  setMode('live');
                }}
                className="text-xs font-medium text-muted-foreground underline underline-offset-4 transition-all duration-200 hover:text-foreground"
              >
                Appeler Suppernote en direct
              </button>
            )
          )}
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <AudioLines size={14} aria-hidden="true" />
            Une démonstration, sans réservation réelle.
          </p>
        </div>

        {demo.error && (
          <p role="alert" className="mt-3 text-sm text-destructive">
            {demo.error}
          </p>
        )}
      </div>
    </div>
  );
}
