'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, Clock3, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useApi } from '@/lib/api';
import { cn } from '@/lib/utils';

type DemoRequestStatus = 'NEW' | 'CONTACTED' | 'DEMO_DONE' | 'CLOSED';

interface DemoRequestRow {
  id: string;
  establishmentName: string;
  contactEmail: string;
  contactPhone: string | null;
  currentTool: string | null;
  mainProblem: string | null;
  status: DemoRequestStatus;
  isTest: boolean;
  notifiedAt: string | null;
  contactedAt: string | null;
  lastInteractionAt: string | null;
  pageVersion?: string;
  createdAt: string;
}

const STATUS_LABELS: Record<DemoRequestStatus, string> = {
  NEW: 'Nouvelle',
  CONTACTED: 'Contactée',
  DEMO_DONE: 'Démo faite',
  CLOSED: 'Clôturée',
};

function formatDate(value: string) {
  return new Date(value).toLocaleString('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
}

function addTwelveMonths(value: string) {
  const date = new Date(value);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + 12);
  const lastDayOfMonth = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0),
  ).getUTCDate();
  date.setUTCDate(Math.min(day, lastDayOfMonth));
  return date;
}

function toDateTimeLocal(value: string) {
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

/**
 * Suivi opérateur des demandes de démonstration. Les coordonnées ne sont visibles qu'aux
 * opérateurs Suppernote : l'API les refuse aux autres comptes.
 */
export default function DemoRequestsPage() {
  const { get, patch, post } = useApi();
  const [rows, setRows] = useState<DemoRequestRow[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [saveFailed, setSaveFailed] = useState(false);
  const [editingInteractionId, setEditingInteractionId] = useState<string | null>(null);
  const [interactionDateDraft, setInteractionDateDraft] = useState('');

  const requestId = useRef(0);

  const load = useCallback(async () => {
    const current = ++requestId.current;
    setLoadFailed(false);
    setRows(null);
    try {
      const all: DemoRequestRow[] = [];
      let cursor: string | undefined;
      do {
        const params = new URLSearchParams({ limit: '200' });
        if (cursor) params.set('cursor', cursor);
        const response = await get<{ data: DemoRequestRow[] }>(`/admin/demo-requests?${params}`);
        if (current !== requestId.current) return;
        all.push(...response.data);
        const next =
          response.data.length === 200 ? response.data[response.data.length - 1].id : undefined;
        if (next && next === cursor) throw new Error('Duplicate cursor');
        cursor = next;
      } while (cursor);
      setRows(all);
    } catch {
      if (current !== requestId.current) return;
      setLoadFailed(true);
    }
  }, [get]);

  useEffect(() => {
    void load();
  }, [load]);

  async function updateStatus(id: string, status: DemoRequestStatus) {
    setSavingId(id);
    setSaveFailed(false);
    try {
      const response = await patch<{ data: DemoRequestRow }>(`/admin/demo-requests/${id}`, {
        status,
      });
      setRows(
        (current) =>
          current?.map((row) => (row.id === id ? { ...row, ...response.data } : row)) ?? current,
      );
    } catch {
      setSaveFailed(true);
    } finally {
      setSavingId(null);
    }
  }

  async function setTest(id: string, isTest: boolean) {
    setSavingId(id);
    setSaveFailed(false);
    try {
      await patch(`/admin/demo-requests/${id}/test`, { isTest });
      setRows(
        (current) => current?.map((row) => (row.id === id ? { ...row, isTest } : row)) ?? current,
      );
    } catch {
      setSaveFailed(true);
    } finally {
      setSavingId(null);
    }
  }

  async function recordInteraction(id: string, occurredAt?: string) {
    setSavingId(id);
    setSaveFailed(false);
    try {
      const response = await post<{ data: DemoRequestRow }>(
        `/admin/demo-requests/${id}/interaction`,
        occurredAt ? { occurredAt: new Date(occurredAt).toISOString() } : undefined,
      );
      setRows(
        (current) =>
          current?.map((row) => (row.id === id ? { ...row, ...response.data } : row)) ?? current,
      );
      setEditingInteractionId(null);
      setInteractionDateDraft('');
    } catch {
      setSaveFailed(true);
    } finally {
      setSavingId(null);
    }
  }

  return (
    <main className="mx-auto flex w-full max-w-4xl flex-col gap-6 p-6 md:p-8">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">
          Demandes de démonstration
        </h1>
        <p className="text-sm text-muted-foreground">
          Prospects issus de la vitrine. Les coordonnées sont réservées à l’équipe Suppernote.
        </p>
      </header>

      {rows && (
        <p className="text-sm text-muted-foreground">
          {rows.length} demande{rows.length === 1 ? '' : 's'}
        </p>
      )}

      {saveFailed && (
        <p role="alert" className="text-sm text-destructive">
          La modification n’a pas pu être enregistrée. Réessayez dans un instant.
        </p>
      )}

      {loadFailed ? (
        <div
          role="alert"
          className="flex flex-col items-start gap-3 rounded-2xl border border-border p-6"
        >
          <p className="flex items-center gap-2 text-sm text-destructive">
            <AlertCircle size={16} aria-hidden="true" />
            Impossible de charger les demandes.
          </p>
          <Button type="button" variant="outline" size="sm" onClick={() => void load()}>
            Réessayer
          </Button>
        </div>
      ) : rows === null ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 size={16} className="animate-spin" aria-hidden="true" />
          Chargement des demandes…
        </p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">Aucune demande pour le moment.</p>
      ) : (
        <>
          <ul className="flex flex-col gap-3">
            {rows.map((row) => {
              const trackedAt = row.lastInteractionAt ?? row.contactedAt ?? row.createdAt;
              const reviewDate = addTwelveMonths(trackedAt);
              const needsRetentionReview = reviewDate.getTime() <= Date.now();

              return (
                <li
                  key={row.id}
                  className="flex flex-col gap-3 rounded-2xl border border-border bg-card p-5 md:flex-row md:items-start md:justify-between"
                >
                  <div className="flex min-w-0 flex-col gap-1">
                    <p className="font-semibold text-foreground">{row.establishmentName}</p>
                    {row.isTest && <p className="text-xs font-medium text-foreground">Test</p>}
                    {row.pageVersion === 'demo-assistant-tel-v1' && (
                      <p className="text-xs text-muted-foreground">Source : démo du téléphone</p>
                    )}
                    <p className="break-all text-sm text-muted-foreground">
                      <a
                        className="underline transition-all duration-200"
                        href={`mailto:${encodeURIComponent(row.contactEmail)}`}
                      >
                        {row.contactEmail}
                      </a>
                      {row.contactPhone && (
                        <>
                          {' '}
                          ·{' '}
                          <a
                            className="underline transition-all duration-200"
                            href={`tel:${row.contactPhone.replace(/[^+\d]/g, '')}`}
                          >
                            {row.contactPhone}
                          </a>
                        </>
                      )}
                    </p>
                    {row.currentTool && (
                      <p className="text-sm text-muted-foreground">
                        Outil actuel : {row.currentTool}
                      </p>
                    )}
                    {row.mainProblem && (
                      <p className="text-sm text-muted-foreground">Problème : {row.mainProblem}</p>
                    )}
                    <p className="text-xs text-muted-foreground">
                      Reçue le {formatDate(row.createdAt)} ·{' '}
                      <span className={cn(row.notifiedAt ? 'text-foreground' : 'text-destructive')}>
                        {row.notifiedAt ? 'Envoi accepté' : 'Envoi non confirmé'}
                      </span>
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {row.lastInteractionAt
                        ? `Dernier échange enregistré le ${formatDate(row.lastInteractionAt)}`
                        : row.contactedAt
                          ? `Premier contact enregistré le ${formatDate(row.contactedAt)}`
                          : 'Aucun échange enregistré'}
                    </p>
                    {needsRetentionReview && (
                      <p className="text-xs font-medium text-destructive">
                        À examiner depuis le {formatDate(reviewDate.toISOString())}
                      </p>
                    )}
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <label className="flex items-center gap-2 text-sm font-medium">
                      Phase
                      <select
                        aria-label={`Phase de ${row.establishmentName}`}
                        value={row.status}
                        disabled={savingId === row.id}
                        onChange={(event) =>
                          void updateStatus(row.id, event.target.value as DemoRequestStatus)
                        }
                        className="h-10 rounded-xl border border-border bg-background px-3 text-sm text-foreground transition-all duration-200 disabled:opacity-60"
                      >
                        {(Object.keys(STATUS_LABELS) as DemoRequestStatus[]).map((status) => (
                          <option key={status} value={status}>
                            {STATUS_LABELS[status]}
                          </option>
                        ))}
                      </select>
                    </label>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      disabled={savingId === row.id}
                      onClick={() => void setTest(row.id, !row.isTest)}
                      className="transition-all duration-200"
                    >
                      {row.isTest ? 'Retirer le marquage test' : 'Marquer comme test'}
                    </Button>
                    {editingInteractionId === row.id ? (
                      <>
                        <input
                          aria-label={`Date du dernier échange pour ${row.establishmentName}`}
                          type="datetime-local"
                          max={toDateTimeLocal(new Date().toISOString())}
                          value={interactionDateDraft}
                          onChange={(event) => setInteractionDateDraft(event.target.value)}
                          className="h-10 min-w-0 rounded-xl border border-border bg-background px-3 text-sm text-foreground transition-all duration-200"
                        />
                        <Button
                          type="button"
                          size="sm"
                          disabled={savingId === row.id || !interactionDateDraft}
                          onClick={() => void recordInteraction(row.id, interactionDateDraft)}
                          className="transition-all duration-200"
                        >
                          Enregistrer la date
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={savingId === row.id}
                          onClick={() => {
                            setEditingInteractionId(null);
                            setInteractionDateDraft('');
                          }}
                          className="transition-all duration-200"
                        >
                          Annuler
                        </Button>
                      </>
                    ) : (
                      <>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={savingId === row.id}
                          onClick={() => void recordInteraction(row.id)}
                          aria-label={`Enregistrer un échange pour ${row.establishmentName}`}
                          className="transition-all duration-200"
                        >
                          <Clock3 size={16} aria-hidden="true" />
                          Enregistrer un échange
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={() => {
                            setInteractionDateDraft(
                              row.lastInteractionAt ? toDateTimeLocal(row.lastInteractionAt) : '',
                            );
                            setEditingInteractionId(row.id);
                          }}
                          className="transition-all duration-200"
                        >
                          Corriger la date
                        </Button>
                      </>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </main>
  );
}
