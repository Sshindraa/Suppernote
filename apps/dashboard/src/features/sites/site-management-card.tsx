'use client';

import { roleLabel } from '@/features/team/roles';
import { useState } from 'react';
import { AlertCircle, Building2, CheckCircle2, Loader2, Plus, ShieldCheck } from 'lucide-react';
import { useApi } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { getErrorMessage } from '@/types/api';
import { useSiteSelection } from './site-context';

export function SiteManagementCard() {
  const { post, patch } = useApi();
  const { sites, activeSiteId, activeSite, status, refresh } = useSiteSelection();
  const [name, setName] = useState('');
  const [phoneNumber, setPhoneNumber] = useState('');
  const [saving, setSaving] = useState(false);
  const [updatingSiteId, setUpdatingSiteId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (status === 'idle' || (sites.length === 0 && status === 'error')) return null;
  if (activeSite?.role !== 'OWNER') return null;

  async function handleCreate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!name.trim() || !phoneNumber.trim()) return;
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      await post('restaurants/sites', { name: name.trim(), phoneNumber: phoneNumber.trim() });
      setName('');
      setPhoneNumber('');
      setMessage('Établissement ajouté.');
      refresh();
    } catch (reason: unknown) {
      setError(getErrorMessage(reason, "Impossible d'ajouter l'établissement."));
    } finally {
      setSaving(false);
    }
  }

  async function handleStatusChange(siteId: string, siteStatus: 'ACTIVE' | 'SUSPENDED') {
    setUpdatingSiteId(siteId);
    setError(null);
    setMessage(null);
    try {
      await patch(`restaurants/sites/${siteId}`, { siteStatus });
      setMessage(siteStatus === 'ACTIVE' ? 'Établissement réactivé.' : 'Établissement suspendu.');
      refresh();
    } catch (reason: unknown) {
      setError(getErrorMessage(reason, "Impossible de modifier l'établissement."));
    } finally {
      setUpdatingSiteId(null);
    }
  }

  return (
    <Card className="suppernote-card">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <Building2 size={18} />
          Établissements
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          Gérez les sites de votre compte et leurs accès. Les données restent isolées par
          établissement.
        </p>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="space-y-2">
          {sites.map((site) => {
            const isCurrent = site.id === activeSiteId;
            const updating = updatingSiteId === site.id;
            return (
              <div
                key={site.id}
                className="flex flex-col gap-3 rounded-xl border border-border bg-secondary p-4 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="truncate font-medium">{site.name}</p>
                    {site.isPrimary && (
                      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                        principal
                      </span>
                    )}
                  </div>
                  <p className="mt-1 flex items-center gap-1 text-xs text-muted-foreground">
                    <ShieldCheck size={13} />
                    {roleLabel(site.role)}
                    {' · '}
                    {site.siteStatus === 'ACTIVE' ? 'Actif' : 'Suspendu'}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {isCurrent && <span className="text-xs text-muted-foreground">Site actif</span>}
                  {!site.isPrimary && !isCurrent && site.siteStatus === 'ACTIVE' && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={updating}
                      onClick={() => void handleStatusChange(site.id, 'SUSPENDED')}
                    >
                      {updating && <Loader2 className="animate-spin" />}
                      Suspendre
                    </Button>
                  )}
                  {!site.isPrimary && !isCurrent && site.siteStatus === 'SUSPENDED' && (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={updating}
                      onClick={() => void handleStatusChange(site.id, 'ACTIVE')}
                    >
                      {updating && <Loader2 className="animate-spin" />}
                      Réactiver
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <form onSubmit={handleCreate} className="space-y-3 border-t border-border pt-5">
          <p className="text-sm font-medium">Ajouter un établissement</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Nom du site"
              aria-label="Nom du site"
              required
            />
            <Input
              value={phoneNumber}
              onChange={(event) => setPhoneNumber(event.target.value)}
              placeholder="Téléphone du site"
              aria-label="Téléphone du site"
              required
            />
          </div>
          <p className="text-xs text-muted-foreground">
            Indiquez la ligne actuelle du site. L’équipe Suppernote lui attribuera ensuite son
            numéro Suppernote, vers lequel vous renverrez vos appels.
          </p>
          <Button type="submit" disabled={saving || !name.trim() || !phoneNumber.trim()}>
            {saving ? <Loader2 className="animate-spin" /> : <Plus />}
            {saving ? 'Ajout…' : 'Ajouter le site'}
          </Button>
        </form>

        {message && (
          <p className="flex items-center gap-2 text-sm text-primary">
            <CheckCircle2 size={16} />
            {message}
          </p>
        )}
        {error && (
          <p className="flex items-center gap-2 text-sm text-destructive">
            <AlertCircle size={16} />
            {error}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
