'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { formatPhone } from '@/lib/utils';
import { formatDuration, formatRelativeDateTime } from '@/lib/format';
import { StatusBadge } from '@/components/StatusBadge';
import { useApi } from '../../../lib/api';
import { getErrorMessage, type Call, type CallListResponse } from '@/types/api';
import { useMediaQuery } from '@/lib/useMediaQuery';
import MobileDataCard from '@/components/MobileDataCard';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { DataFetchError } from '@/components/DataFetchError';

interface CallItem extends Call {}

const PAGE_SIZE = 100;
const TRANSCRIPT_PREVIEW_LENGTH = 60;

function transcriptPreview(transcript: string): string {
  return transcript.length > TRANSCRIPT_PREVIEW_LENGTH
    ? `${transcript.slice(0, TRANSCRIPT_PREVIEW_LENGTH)}…`
    : transcript;
}

// Niveau par sens : réservé = terminé ; transféré et message = à suivre ; erreur = erreur.
function OutcomeBadge({ outcome }: { outcome: string | null }) {
  switch (outcome) {
    case 'RESERVED':
      return <StatusBadge level="done">Réservé</StatusBadge>;
    case 'INFO':
      return <StatusBadge level="neutral">Info</StatusBadge>;
    case 'HANDOFF':
      return <StatusBadge level="action">Transféré</StatusBadge>;
    case 'MESSAGE':
      return <StatusBadge level="action">Message</StatusBadge>;
    case 'NO_ACTION':
      return <StatusBadge level="neutral">Aucune action</StatusBadge>;
    case 'ERROR':
      return <StatusBadge level="error">Erreur</StatusBadge>;
    default:
      return <StatusBadge level="neutral">{outcome || 'Inconnu'}</StatusBadge>;
  }
}

function IntentLabel({ intent }: { intent: string | null }) {
  switch (intent) {
    case 'RESERVATION':
      return 'Réservation';
    case 'HOURS':
      return 'Horaires';
    case 'MENU':
      return 'Menu';
    case 'CANCEL':
      return 'Annulation';
    case 'OTHER':
      return 'Autre';
    default:
      return intent || '—';
  }
}

function RecordingPlayer({ call, siteId }: { call: CallItem; siteId?: string }) {
  if (call.recordingStatus === 'PENDING') {
    return <span className="text-xs text-muted-foreground">Traitement…</span>;
  }
  if (call.recordingStatus === 'FAILED') {
    return <span className="text-xs text-muted-foreground">Enregistrement indisponible</span>;
  }
  if (call.recordingStatus === 'DELETED') {
    return <span className="text-xs text-muted-foreground">Expiré</span>;
  }
  if (call.recordingStatus !== 'AVAILABLE') {
    return <span className="text-muted-foreground opacity-50">—</span>;
  }

  return (
    <audio
      controls
      preload="none"
      aria-label={`Réécouter l'appel du ${formatRelativeDateTime(call.createdAt)}`}
      className="h-9 w-full min-w-[220px] max-w-[300px]"
      src={`/api/proxy/calls/${call.id}/recording${siteId ? `?siteId=${encodeURIComponent(siteId)}` : ''}`}
    >
      Votre navigateur ne permet pas la lecture audio.
    </audio>
  );
}

export default function CallsPage() {
  const { get, orgId, siteId } = useApi();
  // Sous 1024 px (iPad compris), un tableau de colonnes larges déborde : la liste en cartes prend le relais.
  const isCompact = useMediaQuery('(max-width: 1023px)');

  const [calls, setCalls] = useState<CallItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState('');
  const [transcriptCall, setTranscriptCall] = useState<CallItem | null>(null);

  const fetchCalls = useCallback(async () => {
    if (!orgId) return;
    setLoading(true);
    setError('');
    try {
      const data = await get<CallListResponse>(`calls?restaurantId=${orgId}&limit=${PAGE_SIZE}`);
      setCalls(Array.isArray(data?.data) ? data.data : []);
      setTotal(typeof data?.total === 'number' ? data.total : 0);
    } catch (err: unknown) {
      setError(getErrorMessage(err, 'Impossible de charger les appels'));
    } finally {
      setLoading(false);
    }
  }, [get, orgId]);

  useEffect(() => {
    void fetchCalls();
  }, [fetchCalls]);

  // L'en-tête annonce le total réel : sans suite, les appels plus anciens seraient inaccessibles.
  const loadMore = useCallback(async () => {
    if (!orgId) return;
    setLoadingMore(true);
    setMoreError('');
    try {
      const data = await get<CallListResponse>(
        `calls?restaurantId=${orgId}&limit=${PAGE_SIZE}&offset=${calls.length}`,
      );
      const next = Array.isArray(data?.data) ? data.data : [];
      setCalls((current) => {
        const known = new Set(current.map((call) => call.id));
        return [...current, ...next.filter((call) => !known.has(call.id))];
      });
      if (typeof data?.total === 'number') setTotal(data.total);
    } catch (err: unknown) {
      setMoreError(getErrorMessage(err, 'Impossible de charger les appels suivants'));
    } finally {
      setLoadingMore(false);
    }
  }, [get, orgId, calls.length]);

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <Skeleton className="h-8 w-32 rounded-full" />
          <Skeleton className="h-4 w-24" />
        </div>
        <div className="space-y-2">
          {[1, 2, 3, 4, 5].map((i) => (
            <Skeleton key={i} className="h-12 w-full rounded-xl" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4 md:space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl md:text-2xl font-semibold tracking-tight">Appels</h1>
        {!error && (
          <span className="text-sm text-muted-foreground">
            {total} appel{total > 1 ? 's' : ''}
          </span>
        )}
      </div>

      {error && <DataFetchError message={error} onRetry={fetchCalls} retrying={loading} />}
      {calls.length === 0 ? (
        error ? null : (
          <p className="text-sm text-muted-foreground">
            Aucun appel.{' '}
            <Link
              href="/dashboard/settings#settings-agent"
              className="font-medium text-foreground underline underline-offset-4 transition-all duration-200 hover:text-primary"
            >
              Vérifier l’assistant
            </Link>
          </p>
        )
      ) : isCompact ? (
        /* ========== MOBILE: Card List ========== */
        <div className="space-y-2.5">
          {calls.map((call) => (
            <div
              key={call.id}
              role="button"
              tabIndex={0}
              className="rounded-xl transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  setTranscriptCall(call);
                }
              }}
            >
              <MobileDataCard
                onClick={() => setTranscriptCall(call)}
                title={call.callerPhone ? formatPhone(call.callerPhone) : 'Numéro masqué'}
                subtitle={
                  call.intent
                    ? `${IntentLabel({ intent: call.intent })} · ${formatRelativeDateTime(call.createdAt)}`
                    : formatRelativeDateTime(call.createdAt)
                }
                badge={<OutcomeBadge outcome={call.outcome} />}
                details={[{ label: 'Durée', value: formatDuration(call.durationSec) }]}
              />
            </div>
          ))}
        </div>
      ) : (
        /* ========== DESKTOP: Table ========== */
        <div className="suppernote-card overflow-hidden">
          <div className="mobile-table-wrapper">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Appelant</TableHead>
                  <TableHead>Date</TableHead>
                  <TableHead>Durée</TableHead>
                  <TableHead>Intention</TableHead>
                  <TableHead>Issue</TableHead>
                  <TableHead>Transcription</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {calls.map((call) => (
                  <TableRow
                    key={call.id}
                    className="cursor-pointer transition-all duration-200 hover:bg-accent"
                    tabIndex={0}
                    onClick={() => setTranscriptCall(call)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        setTranscriptCall(call);
                      }
                    }}
                  >
                    <TableCell className="font-medium">
                      {call.callerPhone ? formatPhone(call.callerPhone) : 'Numéro masqué'}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {formatRelativeDateTime(call.createdAt)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {formatDuration(call.durationSec)}
                    </TableCell>
                    <TableCell>
                      <IntentLabel intent={call.intent} />
                    </TableCell>
                    <TableCell>
                      <OutcomeBadge outcome={call.outcome} />
                    </TableCell>
                    <TableCell className="max-w-xs text-muted-foreground">
                      <span className="block max-w-[200px] truncate">
                        {call.transcript ? transcriptPreview(call.transcript) : '—'}
                      </span>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}

      {calls.length > 0 && calls.length < total && (
        <div className="flex flex-col items-center gap-2">
          {moreError && <p className="text-sm text-destructive">{moreError}</p>}
          <Button
            type="button"
            variant="outline"
            onClick={() => void loadMore()}
            disabled={loadingMore}
            className="transition-all duration-200"
          >
            {loadingMore ? 'Chargement…' : `Afficher plus d'appels (${calls.length} sur ${total})`}
          </Button>
        </div>
      )}

      <Dialog open={!!transcriptCall} onOpenChange={(open) => !open && setTranscriptCall(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Appel</DialogTitle>
            <DialogDescription className="sr-only">
              Informations et transcription de l’appel.
            </DialogDescription>
          </DialogHeader>
          {transcriptCall && (
            <div className="space-y-4 text-sm">
              <dl className="grid grid-cols-2 gap-4">
                <div>
                  <dt className="text-muted-foreground">Appelant</dt>
                  <dd>
                    {transcriptCall.callerPhone
                      ? formatPhone(transcriptCall.callerPhone)
                      : 'Numéro masqué'}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Date</dt>
                  <dd>{formatRelativeDateTime(transcriptCall.createdAt)}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Durée</dt>
                  <dd>{formatDuration(transcriptCall.durationSec)}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Intention</dt>
                  <dd>
                    <IntentLabel intent={transcriptCall.intent} />
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">Issue</dt>
                  <dd>
                    <OutcomeBadge outcome={transcriptCall.outcome} />
                  </dd>
                </div>
              </dl>
              {transcriptCall.recordingStatus !== 'NOT_REQUESTED' && (
                <div>
                  <p className="mb-2 text-muted-foreground">Enregistrement</p>
                  <RecordingPlayer call={transcriptCall} siteId={siteId} />
                </div>
              )}
              <div>
                <p className="mb-2 text-muted-foreground">Transcription</p>
                <div className="max-h-[40vh] overflow-y-auto whitespace-pre-wrap rounded-xl border border-border bg-background p-4 leading-relaxed">
                  {transcriptCall.transcript || '—'}
                </div>
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
