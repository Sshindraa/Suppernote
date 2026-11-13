'use client';

import { useCallback, useEffect, useState } from 'react';
import { useApi } from '../../../lib/api';
import { featureLockFromError, type FeatureLock } from '@/lib/api-error';
import { getErrorMessage } from '@/types/api';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { DataFetchError } from '@/components/DataFetchError';
import { FeatureLockCard } from '@/components/FeatureLockCard';
import { useIsMobile } from '@/lib/useMediaQuery';
import MobileDataCard from '@/components/MobileDataCard';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@/components/ui/table';
import { Badge } from '@/components/ui/badge';
import { StatusBadge as StatusPill } from '@/components/StatusBadge';
import { Skeleton } from '@/components/ui/skeleton';
import { Button } from '@/components/ui/button';
import { Check, ChevronDown, MoreHorizontal } from 'lucide-react';
import { toast } from 'sonner';
import { formatPhone } from '@/lib/utils';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { formatDate } from '@suppernote/shared';
import { MS_PER_DAY } from '@/constants/ui';

interface ReactivationCustomer {
  id: string;
  name: string;
  phone: string | null;
  visitCount: number;
  lastSeenAt: string | null;
}

interface ReactivationCampaign {
  id: string;
  status: string;
  sentCount: number;
  sentAt: string | null;
  createdAt: string;
  customerCount: number;
  marketingCampaignId?: string | null;
  marketingCampaignStatus?: string | null;
  lastErrorCode?: string | null;
  customers: ReactivationCustomer[];
}

function StatusBadge({ status }: { status: string }) {
  if (status === 'PENDING') return <StatusPill level="action">En attente</StatusPill>;
  if (status === 'SENT') return <StatusPill level="done">Envoyée</StatusPill>;
  if (status === 'DISMISSED') return <StatusPill level="neutral">Ignorée</StatusPill>;
  if (status === 'MIGRATED') return <StatusPill level="progress">Envoi préparé</StatusPill>;
  if (status === 'FAILED') return <StatusPill level="error">Échec</StatusPill>;
  if (status === 'CANCELLED') return <StatusPill level="error">Annulée</StatusPill>;
  return <StatusPill level="neutral">{status}</StatusPill>;
}

function daysSince(dateStr: string | null): string {
  if (!dateStr) return '—';
  const days = Math.floor((Date.now() - new Date(dateStr).getTime()) / MS_PER_DAY);
  if (days < 30) return `${days}j`;
  const months = Math.floor(days / 30);
  return `${months} mois`;
}

export default function ReactivationPage() {
  const { get, post, orgId } = useApi();
  const isMobile = useIsMobile();

  const [campaigns, setCampaigns] = useState<ReactivationCampaign[]>([]);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState('');
  // Échec du chargement : distinct des erreurs d'action, pour ne jamais afficher « Aucune campagne » à tort.
  const [loadError, setLoadError] = useState('');
  const [lock, setLock] = useState<FeatureLock | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [campaignToDismiss, setCampaignToDismiss] = useState<ReactivationCampaign | null>(null);
  const [campaignToSend, setCampaignToSend] = useState<ReactivationCampaign | null>(null);
  // `false` seulement quand l'API dit explicitement que les envois sont gelés ; inconnu = on laisse essayer.
  const [sendsEnabled, setSendsEnabled] = useState<boolean | null>(null);

  const fetchCampaigns = useCallback(async () => {
    setLoading(true);
    setLoadError('');
    setLock(null);
    try {
      const [data, readiness] = await Promise.all([
        get<ReactivationCampaign[]>('dashboard/reactivation'),
        get<{ data?: { sendsEnabled?: boolean } }>('marketing/providers/readiness').catch(
          () => null,
        ),
      ]);
      setCampaigns(Array.isArray(data) ? data : []);
      setSendsEnabled(
        typeof readiness?.data?.sendsEnabled === 'boolean' ? readiness.data.sendsEnabled : null,
      );
    } catch (err: unknown) {
      setLock(featureLockFromError(err));
      setLoadError(getErrorMessage(err, 'Impossible de charger les campagnes.'));
    }
    setLoading(false);
  }, [get]);

  useEffect(() => {
    if (!orgId) return;
    fetchCampaigns();
  }, [orgId, fetchCampaigns]);

  async function sendCampaign(id: string) {
    setActionLoading(id);
    setNotice('');
    try {
      const result = await post<{
        campaignId: string;
        audienceCount: number;
        droppedCustomerCount: number;
      }>(`dashboard/reactivation/${id}/send`);
      setCampaigns((prev) =>
        prev.map((c) =>
          c.id === id
            ? {
                ...c,
                status: 'MIGRATED',
                marketingCampaignId: result.campaignId,
                marketingCampaignStatus: 'READY',
                customerCount: result.audienceCount,
              }
            : c,
        ),
      );
      setNotice(
        `Envoi lancé pour ${result.audienceCount} client${result.audienceCount > 1 ? 's' : ''}. Ceux qui n’ont pas accepté les messages sont exclus avant l’envoi.` +
          (result.droppedCustomerCount > 0
            ? ` ${result.droppedCustomerCount} client${result.droppedCustomerCount > 1 ? 's' : ''} archivé${result.droppedCustomerCount > 1 ? 's' : ''} ou fusionné${result.droppedCustomerCount > 1 ? 's' : ''} retiré${result.droppedCustomerCount > 1 ? 's' : ''} de la liste.`
            : ''),
      );
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, 'Impossible d’envoyer la campagne.'));
    }
    setCampaignToSend(null);
    setActionLoading(null);
  }

  async function dismissCampaign(id: string) {
    setActionLoading(id);
    setNotice('');
    try {
      await post(`dashboard/reactivation/${id}/dismiss`);
      setCampaigns((prev) => prev.map((c) => (c.id === id ? { ...c, status: 'DISMISSED' } : c)));
    } catch (err: unknown) {
      toast.error(getErrorMessage(err, "Impossible d'ignorer la campagne"));
    }
    setActionLoading(null);
  }

  const pendingCampaigns = campaigns.filter((c) => c.status === 'PENDING');
  const pastCampaigns = campaigns.filter((c) => c.status !== 'PENDING');

  if (loading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-32 rounded-full" />
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-24 w-full rounded-xl" />
          ))}
        </div>
      </div>
    );
  }

  if (loadError) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-3">
          <h1 className="text-xl font-semibold tracking-tight md:text-2xl">Réactivation VIP</h1>
        </div>
        {lock ? (
          <FeatureLockCard lock={lock} feature="Réactivation VIP" />
        ) : (
          <DataFetchError message={loadError} onRetry={() => void fetchCampaigns()} />
        )}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight md:text-2xl">Réactivation VIP</h1>
        </div>
      </div>

      {notice && (
        <div
          role="status"
          className="flex items-center gap-2 rounded-lg border border-success/30 bg-success/10 p-3 text-sm text-success"
        >
          <Check size={16} />
          {notice}
        </div>
      )}

      {pendingCampaigns.length === 0 && pastCampaigns.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Aucune campagne de réactivation pour le moment
        </p>
      ) : (
        <>
          {/* Campaigns en attente */}
          {pendingCampaigns.length > 0 && (
            <div className="space-y-3">
              <h2 className="text-sm font-medium text-muted-foreground">À valider</h2>
              {pendingCampaigns.map((campaign) => (
                <div key={campaign.id} className="suppernote-card p-4">
                  <div className="mb-3 flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">
                        {campaign.customerCount} client{campaign.customerCount > 1 ? 's' : ''} VIP
                        inactif
                        {campaign.customerCount > 1 ? 's' : ''}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        ·{' '}
                        {formatDate(campaign.createdAt, 'fr-FR', {
                          day: 'numeric',
                          month: 'short',
                          year: 'numeric',
                        })}
                      </span>
                    </div>
                    <StatusBadge status={campaign.status} />
                  </div>

                  <details className="group mb-4">
                    <summary className="flex cursor-pointer list-none items-center gap-2 text-sm font-medium transition-all duration-200 [&::-webkit-details-marker]:hidden">
                      <ChevronDown
                        className="h-4 w-4 transition-all duration-200 group-open:rotate-180"
                        aria-hidden="true"
                      />{' '}
                      Clients concernés
                    </summary>
                    <div className="mt-3">
                      {isMobile ? (
                        <div className="space-y-2">
                          {campaign.customers.map((c) => (
                            <div key={c.id} className="rounded-xl border border-border bg-card p-4">
                              <div className="flex items-start justify-between gap-2">
                                <div className="min-w-0">
                                  <p className="break-words text-sm font-semibold">{c.name}</p>
                                  {c.phone && (
                                    <p className="mt-1 break-words text-xs text-muted-foreground">
                                      {formatPhone(c.phone)}
                                    </p>
                                  )}
                                </div>
                                <Badge variant="secondary" className="shrink-0 tabular-nums">
                                  {c.visitCount} visites
                                </Badge>
                              </div>
                              <p className="mt-3 text-xs text-muted-foreground">Dernière visite</p>
                              <p className="text-sm tabular-nums">{daysSince(c.lastSeenAt)}</p>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div className="mb-4 overflow-hidden rounded-lg border border-border">
                          <Table>
                            <TableHeader>
                              <TableRow>
                                <TableHead>Client</TableHead>
                                <TableHead>Téléphone</TableHead>
                                <TableHead>Visites</TableHead>
                                <TableHead>Dernière visite</TableHead>
                              </TableRow>
                            </TableHeader>
                            <TableBody>
                              {campaign.customers.map((c) => (
                                <TableRow key={c.id}>
                                  <TableCell className="font-medium">{c.name}</TableCell>
                                  <TableCell className="text-muted-foreground">
                                    {c.phone ? <span>{formatPhone(c.phone)}</span> : '—'}
                                  </TableCell>
                                  <TableCell>{c.visitCount}</TableCell>
                                  <TableCell className="text-muted-foreground">
                                    {daysSince(c.lastSeenAt)}
                                  </TableCell>
                                </TableRow>
                              ))}
                            </TableBody>
                          </Table>
                        </div>
                      )}
                    </div>
                  </details>
                  {/* Actions */}
                  {sendsEnabled === false && (
                    <p className="mb-3 text-xs text-muted-foreground">
                      Les envois SMS ne sont pas encore ouverts sur votre compte : vous pourrez
                      lancer cette campagne dès leur ouverture.
                    </p>
                  )}
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      className="transition-all duration-200"
                      onClick={() => setCampaignToSend(campaign)}
                      disabled={actionLoading === campaign.id || sendsEnabled === false}
                    >
                      Envoyer la campagne
                    </Button>
                    <DropdownMenu modal={false}>
                      <DropdownMenuTrigger asChild>
                        <Button
                          size="icon"
                          variant="outline"
                          className="h-8 w-8 transition-all duration-200"
                          aria-label={`Autres actions pour la campagne du ${formatDate(campaign.createdAt, 'fr-FR', { day: 'numeric', month: 'short', year: 'numeric' })}`}
                          disabled={actionLoading === campaign.id}
                        >
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onSelect={() => setCampaignToDismiss(campaign)}>
                          Ignorer
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Historique */}
          {pastCampaigns.length > 0 && (
            <div className="space-y-3">
              <h2 className="text-sm font-medium text-muted-foreground">Historique</h2>
              {isMobile ? (
                <div className="space-y-2">
                  {pastCampaigns.map((c) => (
                    <MobileDataCard
                      key={c.id}
                      title={`${c.customerCount} client${c.customerCount > 1 ? 's' : ''} VIP`}
                      subtitle={formatDate(c.createdAt, 'fr-FR', {
                        day: 'numeric',
                        month: 'short',
                        year: 'numeric',
                      })}
                      badge={<StatusBadge status={c.status} />}
                      details={
                        c.status === 'SENT'
                          ? [{ label: 'SMS envoyés', value: `${c.sentCount}/${c.customerCount}` }]
                          : undefined
                      }
                    />
                  ))}
                </div>
              ) : (
                <div className="suppernote-card overflow-hidden">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Date</TableHead>
                        <TableHead>Clients VIP</TableHead>
                        <TableHead>SMS envoyés</TableHead>
                        <TableHead>Statut</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {pastCampaigns.map((c) => (
                        <TableRow key={c.id}>
                          <TableCell>
                            {formatDate(c.createdAt, 'fr-FR', {
                              day: 'numeric',
                              month: 'short',
                              year: 'numeric',
                            })}
                          </TableCell>
                          <TableCell>{c.customerCount}</TableCell>
                          <TableCell>
                            {c.status === 'SENT' ? (
                              <span className="tabular-nums">
                                {c.sentCount}/{c.customerCount}
                              </span>
                            ) : (
                              '—'
                            )}
                          </TableCell>
                          <TableCell>
                            <StatusBadge status={c.status} />
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </div>
          )}
        </>
      )}

      <ConfirmDialog
        open={campaignToDismiss !== null}
        title="Ignorer cette campagne ?"
        description="Cette campagne sera retirée des campagnes à valider."
        confirmLabel="Ignorer la campagne"
        pending={campaignToDismiss !== null && actionLoading === campaignToDismiss.id}
        onConfirm={async () => {
          if (campaignToDismiss) await dismissCampaign(campaignToDismiss.id);
          setCampaignToDismiss(null);
        }}
        onCancel={() => setCampaignToDismiss(null)}
      />
      <ConfirmDialog
        open={campaignToSend !== null}
        title="Envoyer la campagne de réactivation ?"
        description={
          'Un SMS sera envoyé aux clients de cette liste qui ont accepté les messages marketing. ' +
          'Les clients désinscrits ou sans consentement sont exclus automatiquement. ' +
          'Cette action est irréversible.'
        }
        confirmLabel="Confirmer l’envoi"
        pending={campaignToSend !== null && actionLoading === campaignToSend.id}
        onConfirm={() => campaignToSend && void sendCampaign(campaignToSend.id)}
        onCancel={() => setCampaignToSend(null)}
      />
    </div>
  );
}
