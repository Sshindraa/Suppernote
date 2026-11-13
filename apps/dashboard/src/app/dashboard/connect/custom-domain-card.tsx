'use client';

import { useState } from 'react';
import {
  ChevronDown,
  CheckCircle2,
  Copy,
  ExternalLink,
  Loader2,
  MoreHorizontal,
} from 'lucide-react';
import { toast } from 'sonner';
import { StatusBadge, type StatusLevel } from '@/components/StatusBadge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useApi } from '@/lib/api';
import { toApiError } from '@/lib/api-error';
import { ConfirmDialog } from '@/components/ConfirmDialog';

/**
 * Domaine tel que le restaurateur le colle : « https://Reserve.MonResto.fr/ » devient « reserve.monresto.fr ».
 * L'API n'accepte qu'un nom d'hôte nu ; sans cette normalisation, une adresse copiée depuis la barre du
 * navigateur était refusée par une validation sans explication.
 */
export function normalizeDomainInput(value: string): string {
  return value
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .replace(/[/?#].*$/, '')
    .replace(/\.$/, '')
    .toLowerCase();
}

const DOMAIN_PATTERN = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

async function apiErrorFrom(res: Response, fallback: string): Promise<Error> {
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const error = toApiError(res.status, data);
  return error.message ? error : new Error(fallback);
}

type CustomDomainStatus =
  | 'pending'
  | 'dns_validated'
  | 'ssl_provisioning'
  | 'active'
  | 'failed'
  | null;

export type Props = {
  restaurantId: string;
  customDomain: string | null;
  customDomainStatus: CustomDomainStatus;
};

// Niveau par sens : configuration DNS à faire = action ; vérification en cours ou actif = en cours ; échec = erreur.
const STATUS_BADGES: Record<string, { label: string; level: StatusLevel }> = {
  pending: { label: 'En attente', level: 'action' },
  dns_validated: { label: 'En cours', level: 'progress' },
  ssl_provisioning: { label: 'En cours', level: 'progress' },
  active: { label: 'Actif', level: 'progress' },
  failed: { label: 'Échec', level: 'error' },
};

export function CustomDomainCard({ restaurantId, customDomain, customDomainStatus }: Props) {
  const { siteId } = useApi();
  const [domain, setDomain] = useState(customDomain ?? '');
  const [saving, setSaving] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removeConfirmOpen, setRemoveConfirmOpen] = useState(false);
  const [verifyResult, setVerifyResult] = useState<{
    cnameValid: boolean;
    message: string;
  } | null>(null);
  const [copied, setCopied] = useState(false);

  async function saveDomain() {
    setVerifyResult(null);
    const normalized = normalizeDomainInput(domain);
    if (!DOMAIN_PATTERN.test(normalized)) {
      toast.error('Saisissez le nom de domaine seul, par exemple reserve.monrestaurant.fr.');
      return;
    }
    setDomain(normalized);
    setSaving(true);
    try {
      const res = await fetch(`/api/proxy/restaurants/${restaurantId}/connect`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          ...(siteId ? { 'X-Suppernote-Site-ID': siteId } : {}),
        },
        body: JSON.stringify({ customDomain: normalized }),
      });
      if (!res.ok) throw await apiErrorFrom(res, 'Erreur lors de la sauvegarde');
      // Recharger pour refléter le nouveau statut
      window.location.reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erreur inconnue');
    } finally {
      setSaving(false);
    }
  }

  async function verifyDns() {
    setVerifying(true);
    setVerifyResult(null);
    try {
      const res = await fetch(`/api/proxy/restaurants/${restaurantId}/connect/verify-dns`, {
        method: 'POST',
        headers: siteId ? { 'X-Suppernote-Site-ID': siteId } : undefined,
      });
      if (!res.ok) throw await apiErrorFrom(res, 'Erreur lors de la vérification');
      const data = await res.json();
      setVerifyResult({ cnameValid: data.cnameValid, message: data.message });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erreur inconnue');
    } finally {
      setVerifying(false);
    }
  }

  async function removeDomain() {
    setRemoving(true);
    setVerifyResult(null);
    try {
      const res = await fetch(`/api/proxy/restaurants/${restaurantId}/connect`, {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          ...(siteId ? { 'X-Suppernote-Site-ID': siteId } : {}),
        },
        body: JSON.stringify({ customDomain: null }),
      });
      if (!res.ok) throw await apiErrorFrom(res, 'Erreur lors de la suppression');
      setDomain('');
      window.location.reload();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erreur inconnue');
    } finally {
      setRemoving(false);
      setRemoveConfirmOpen(false);
    }
  }

  function copyCname() {
    navigator.clipboard.writeText('suppernote.com');
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const badge = customDomain && customDomainStatus ? STATUS_BADGES[customDomainStatus] : null;
  const isActive = customDomainStatus === 'active';

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0 pb-3">
        <CardTitle className="text-base">Domaine personnalisé</CardTitle>
        <div className="flex items-center gap-2">
          {badge && <StatusBadge level={badge.level}>{badge.label}</StatusBadge>}
          {customDomain && (
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label="Actions du domaine"
                  disabled={removing || saving}
                  className="h-8 w-8 transition-all duration-200"
                >
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  className="text-destructive"
                  onSelect={() => setRemoveConfirmOpen(true)}
                >
                  Retirer le domaine
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {customDomain && isActive && (
          <p className="flex items-center gap-2 text-sm">
            <CheckCircle2 className="h-4 w-4 text-success" />
            <a
              href={`https://${customDomain}`}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex min-w-0 items-center gap-1 break-all font-medium underline underline-offset-2 transition-all duration-200 hover:text-primary"
            >
              {customDomain}
              <ExternalLink className="h-3.5 w-3.5" />
            </a>
          </p>
        )}

        {customDomain && !isActive && (
          <>
            <p className="break-all font-mono text-sm">{customDomain}</p>
            <ol className="list-decimal space-y-3 pl-5 text-sm">
              <li className="space-y-2">
                <span>Ajoutez un CNAME chez votre registrar :</span>
                <div className="flex items-center gap-2 rounded-md border border-border bg-muted/30 p-2 font-mono text-xs">
                  <span className="min-w-0 break-all text-muted-foreground">{customDomain}</span>
                  <span className="text-muted-foreground">→</span>
                  <span className="min-w-0 break-all">suppernote.com</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={copyCname}
                    className="ml-auto h-6 shrink-0 px-2 transition-all duration-200"
                    aria-label="Copier la destination CNAME"
                  >
                    {copied ? (
                      <CheckCircle2 className="h-3 w-3 text-success" />
                    ) : (
                      <Copy className="h-3 w-3" />
                    )}
                  </Button>
                </div>
              </li>
              <li className="space-y-2">
                <span>Vérifiez le DNS. Le SSL est provisionné automatiquement.</span>
                <div>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={verifyDns}
                    disabled={verifying}
                    className="transition-all duration-200"
                  >
                    {verifying && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    {verifying ? 'Vérification…' : 'Vérifier le DNS'}
                  </Button>
                </div>
              </li>
            </ol>
          </>
        )}

        {verifyResult && (
          <p
            role="status"
            className={verifyResult.cnameValid ? 'text-sm text-success' : 'text-sm text-warning'}
          >
            {verifyResult.message}
          </p>
        )}

        <details open={!customDomain} className="group rounded-lg border border-border">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-2 p-3 text-sm font-medium transition-all duration-200 [&::-webkit-details-marker]:hidden">
            {customDomain ? 'Modifier le domaine' : 'Ajouter un domaine'}
            <ChevronDown className="h-4 w-4 text-muted-foreground transition-all duration-200 group-open:rotate-180" />
          </summary>
          <div className="space-y-3 border-t border-border p-3">
            <div className="space-y-2">
              <label htmlFor="custom-domain" className="text-sm font-medium">
                Domaine
              </label>
              <Input
                id="custom-domain"
                type="text"
                placeholder="reserve.monrestaurant.fr"
                value={domain}
                onChange={(e) => setDomain(e.target.value)}
                disabled={saving || removing}
              />
            </div>
            <Button
              onClick={saveDomain}
              disabled={saving || !domain}
              className="w-full transition-all duration-200"
            >
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {customDomain ? 'Mettre à jour' : 'Configurer le domaine'}
            </Button>
          </div>
        </details>
      </CardContent>

      <ConfirmDialog
        open={removeConfirmOpen}
        title="Retirer le domaine personnalisé ?"
        description={`« ${customDomain ?? ''} » ne mènera plus à votre page de réservation. Vos clients devront utiliser l’adresse Suppernote. Vous pourrez le configurer à nouveau plus tard.`}
        confirmLabel="Retirer le domaine"
        variant="destructive"
        pending={removing}
        onConfirm={() => void removeDomain()}
        onCancel={() => setRemoveConfirmOpen(false)}
      />
    </Card>
  );
}
