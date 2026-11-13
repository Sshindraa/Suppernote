'use client';

import { useCallback, useEffect, useState } from 'react';
import { CreditCard, Loader2, X } from 'lucide-react';
import { toast } from 'sonner';
import { cardGuaranteeNotice } from '@suppernote/shared';
import { useApi } from '@/lib/api';
import { ApiError } from '@/lib/api-error';
import { useCapabilities } from '@/lib/use-capabilities';
import { getErrorMessage } from '@/types/api';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { GiftCardStripeConnect } from '@/components/gift-cards/gift-card-stripe-connect';

type Settings = {
  enabled: boolean;
  minPartySize: number | null;
  protectedDates: string[];
  amountPerPerson: string;
  cancellationHours: number;
  version: number | null;
};

const CANCELLATION_CHOICES = [0, 12, 24, 48, 72];

function formatDate(date: string): string {
  return new Intl.DateTimeFormat('fr-FR', {
    weekday: 'short',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(`${date}T00:00:00Z`));
}

/**
 * Réglages de l'empreinte bancaire : quand la demander (groupes, dates protégées), combien et
 * jusqu'à quand l'annulation reste gratuite. Le compte Stripe est celui des cartes cadeaux.
 */
export function CardGuaranteeSettingsCard({ restaurantName }: { restaurantName: string }) {
  const { get, put } = useApi();
  const allowed = useCapabilities()?.['reservations.payments'] === true;
  const [state, setState] = useState<'loading' | 'ready' | 'unavailable' | 'error'>('loading');
  const [saved, setSaved] = useState<Settings | null>(null);
  const [draft, setDraft] = useState<Settings | null>(null);
  const [groupsOn, setGroupsOn] = useState(true);
  const [newDate, setNewDate] = useState('');
  const [stripeReady, setStripeReady] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const { data } = await get<{ data: Settings }>('reservation-guarantee/settings');
      setSaved(data);
      setDraft(data);
      setGroupsOn(data.minPartySize !== null);
      setState('ready');
    } catch (err) {
      // Fonction coupée ou formule sans paiement : la carte ne s'affiche pas.
      setState(
        err instanceof ApiError && [403, 503].includes(err.status) ? 'unavailable' : 'error',
      );
    }
  }, [get]);

  useEffect(() => {
    if (allowed) void load();
  }, [allowed, load]);

  if (!allowed || state === 'unavailable') return null;

  const update = (patch: Partial<Settings>) =>
    setDraft((current) => (current ? { ...current, ...patch } : current));

  async function save(enabled: boolean) {
    if (!draft) return;
    setSaving(true);
    setError('');
    try {
      const { data } = await put<{ data: Settings }>('reservation-guarantee/settings', {
        enabled,
        minPartySize: groupsOn ? draft.minPartySize : null,
        protectedDates: draft.protectedDates,
        amountPerPerson: draft.amountPerPerson,
        cancellationHours: draft.cancellationHours,
      });
      setSaved(data);
      setDraft(data);
      setGroupsOn(data.minPartySize !== null);
      toast.success(enabled ? 'Empreinte bancaire enregistrée.' : 'Empreinte bancaire coupée.');
    } catch (err) {
      setError(getErrorMessage(err, 'Le réglage n’a pas pu être enregistré.'));
    } finally {
      setSaving(false);
    }
  }

  function addDate() {
    if (!draft || !/^\d{4}-\d{2}-\d{2}$/.test(newDate)) return;
    update({ protectedDates: [...new Set([...draft.protectedDates, newDate])].sort() });
    setNewDate('');
  }

  const previewSize = groupsOn && draft?.minPartySize ? draft.minPartySize : 2;
  const amountOk = draft
    ? Number(draft.amountPerPerson) >= 1 && Number(draft.amountPerPerson) <= 200
    : false;
  const hasTrigger = Boolean(
    draft && ((groupsOn && draft.minPartySize) || draft.protectedDates.length),
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <CreditCard className="h-5 w-5" aria-hidden="true" />
          Empreinte bancaire
        </CardTitle>
        <p className="text-sm text-muted-foreground">
          Demandez une carte bancaire pour les groupes et les dates chargées. Aucun montant n’est
          débité à la réservation : vous seul décidez d’un prélèvement après une absence ou une
          annulation tardive.
        </p>
      </CardHeader>
      <CardContent className="space-y-6">
        {state === 'loading' && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground" role="status">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            Chargement du réglage…
          </p>
        )}
        {state === 'error' && (
          <div className="space-y-2 text-sm">
            <p className="text-destructive" role="alert">
              Le réglage n’a pas pu être chargé.
            </p>
            <Button variant="outline" size="sm" onClick={() => void load()}>
              Réessayer
            </Button>
          </div>
        )}

        {state === 'ready' && draft && (
          <>
            <GiftCardStripeConnect onReadinessChange={setStripeReady} />

            <div className="flex items-center justify-between gap-4 rounded-lg border border-border p-4">
              <div>
                <p className="font-medium">{saved?.enabled ? 'Activée' : 'Désactivée'}</p>
                <p className="text-sm text-muted-foreground">
                  {saved?.enabled
                    ? 'Les nouvelles réservations concernées demandent une carte.'
                    : 'Aucune carte n’est demandée aux clients.'}
                </p>
              </div>
              {saved?.enabled && (
                <Button
                  variant="outline"
                  disabled={saving}
                  onClick={() => void save(false)}
                  className="transition-all duration-200"
                >
                  Couper
                </Button>
              )}
            </div>

            <fieldset className="space-y-4">
              <legend className="text-sm font-medium">Quand la demander</legend>
              <label className="flex items-center justify-between gap-4 text-sm">
                <span>Groupes à partir de</span>
                <span className="flex items-center gap-2">
                  <Switch
                    checked={groupsOn}
                    onCheckedChange={setGroupsOn}
                    aria-label="Demander une empreinte aux groupes"
                  />
                  <Input
                    type="number"
                    min={1}
                    max={100}
                    disabled={!groupsOn}
                    value={draft.minPartySize ?? 6}
                    onChange={(event) =>
                      update({ minPartySize: event.target.valueAsNumber || null })
                    }
                    className="w-20"
                    aria-label="Nombre de couverts"
                  />
                  couverts
                </span>
              </label>
              <div className="space-y-2 text-sm">
                <span>Dates protégées (toutes les tables)</span>
                <div className="flex gap-2">
                  <Input
                    type="date"
                    value={newDate}
                    onChange={(event) => setNewDate(event.target.value)}
                    aria-label="Date protégée"
                    className="max-w-48"
                  />
                  <Button type="button" variant="outline" onClick={addDate} disabled={!newDate}>
                    Ajouter
                  </Button>
                </div>
                {draft.protectedDates.length > 0 ? (
                  <ul className="flex flex-wrap gap-2">
                    {draft.protectedDates.map((date) => (
                      <li
                        key={date}
                        className="flex items-center gap-1 rounded-full border border-border bg-muted px-3 py-1"
                      >
                        {formatDate(date)}
                        <button
                          type="button"
                          onClick={() =>
                            update({
                              protectedDates: draft.protectedDates.filter((d) => d !== date),
                            })
                          }
                          aria-label={`Retirer le ${formatDate(date)}`}
                          className="rounded-full p-0.5 text-muted-foreground transition-all duration-200 hover:text-foreground"
                        >
                          <X className="h-3.5 w-3.5" aria-hidden="true" />
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-muted-foreground">Aucune date protégée.</p>
                )}
              </div>
            </fieldset>

            <fieldset className="grid gap-4 sm:grid-cols-2">
              <legend className="sr-only">Montant et délai</legend>
              <label className="space-y-1 text-sm">
                <span className="font-medium">Montant par personne (€)</span>
                <Input
                  type="number"
                  min={1}
                  max={200}
                  step={1}
                  value={draft.amountPerPerson.replace(/\.00$/, '')}
                  onChange={(event) => update({ amountPerPerson: event.target.value })}
                />
              </label>
              <label className="space-y-1 text-sm">
                <span className="font-medium">Annulation gratuite jusqu’à</span>
                <select
                  value={draft.cancellationHours}
                  onChange={(event) => update({ cancellationHours: Number(event.target.value) })}
                  className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm transition-all duration-200"
                >
                  {CANCELLATION_CHOICES.map((hours) => (
                    <option key={hours} value={hours}>
                      {hours === 0 ? 'l’heure de la réservation' : `${hours} h avant`}
                    </option>
                  ))}
                </select>
              </label>
            </fieldset>

            {amountOk && (
              <div className="rounded-lg bg-muted p-4 text-sm">
                <p className="mb-1 font-medium">Texte vu par le client</p>
                <p className="leading-relaxed text-muted-foreground">
                  {cardGuaranteeNotice({
                    restaurantName,
                    partySize: previewSize,
                    terms: {
                      amountPerPerson: Number(draft.amountPerPerson).toFixed(2),
                      totalAmount: (Number(draft.amountPerPerson) * previewSize).toFixed(2),
                      cancellationHours: draft.cancellationHours,
                    },
                  })}
                </p>
              </div>
            )}

            {error && (
              <p className="text-sm text-destructive" role="alert">
                {error}
              </p>
            )}
            {stripeReady === false && (
              <p className="text-sm text-muted-foreground">
                Terminez d’abord l’ouverture de votre compte Stripe ci-dessus.
              </p>
            )}
            <Button
              onClick={() => void save(true)}
              disabled={saving || !amountOk || !hasTrigger || stripeReady !== true}
              className="transition-all duration-200"
            >
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
              {saved?.enabled ? 'Enregistrer les changements' : 'Activer l’empreinte bancaire'}
            </Button>
          </>
        )}
      </CardContent>
    </Card>
  );
}
