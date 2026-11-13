'use client';

import { useCallback, useEffect, useState } from 'react';
import { CreditCard, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { formatGuaranteeEuros } from '@suppernote/shared';
import { useApi } from '@/lib/api';
import { ApiError } from '@/lib/api-error';
import { useCapabilities } from '@/lib/use-capabilities';
import { getErrorMessage } from '@/types/api';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { ConfirmDialog } from '@/components/ConfirmDialog';

type Payment = {
  status:
    | 'REQUIRES_PAYMENT_METHOD'
    | 'REQUIRES_ACTION'
    | 'AUTHORIZED'
    | 'CAPTURED'
    | 'PARTIALLY_REFUNDED'
    | 'REFUNDED'
    | 'FAILED'
    | 'CANCELLED'
    | 'EXPIRED';
  amount: string;
  capturedAmount: string | null;
  refundedAmount: string | null;
  failureCode: string | null;
  disputeStatus: string | null;
  expiresAt: string | null;
};

/** L'équipe peut prélever jusqu'à 7 jours après l'heure de la réservation (spec §4). */
const CAPTURE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const OPEN_DISPUTES = [
  'warning_needs_response',
  'needs_response',
  'under_review',
  'warning_under_review',
];

function money(amount: string | null): string {
  return formatGuaranteeEuros(Number(amount ?? 0).toFixed(2));
}

function cents(value: string): number {
  return Math.round(Number(value.replace(',', '.')) * 100);
}

function describe(payment: Payment): { label: string; detail: string } {
  switch (payment.status) {
    case 'REQUIRES_PAYMENT_METHOD':
    case 'REQUIRES_ACTION':
      return {
        label: 'En attente de carte',
        detail: payment.expiresAt
          ? `La table est tenue jusqu’à ${new Date(payment.expiresAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}.`
          : 'La table est tenue jusqu’à l’enregistrement de la carte.',
      };
    case 'AUTHORIZED':
      return payment.capturedAmount && !payment.failureCode
        ? {
            label: 'Prélèvement en cours',
            detail: `${money(payment.capturedAmount)} en attente de confirmation par la banque.`,
          }
        : {
            label: 'Carte enregistrée',
            detail: payment.failureCode
              ? `Dernier prélèvement refusé par la banque. Jusqu’à ${money(payment.amount)} prélevables.`
              : `Jusqu’à ${money(payment.amount)} prélevables après une absence ou une annulation tardive.`,
          };
    case 'CAPTURED':
      return {
        label: `Prélevé ${money(payment.capturedAmount)}`,
        detail: 'Reçu envoyé par Stripe si l’e-mail est connu.',
      };
    case 'PARTIALLY_REFUNDED':
      return {
        label: `Prélevé ${money(payment.capturedAmount)}`,
        detail: `${money(payment.refundedAmount)} remboursés.`,
      };
    case 'REFUNDED':
      return {
        label: 'Remboursé',
        detail: `${money(payment.refundedAmount)} remboursés au client.`,
      };
    case 'CANCELLED':
      return {
        label: 'Empreinte fermée',
        detail: 'Annulation gratuite ou par l’équipe : aucun prélèvement possible.',
      };
    default:
      return {
        label: 'Carte non enregistrée',
        detail: 'Le délai est passé, la réservation n’a pas été confirmée.',
      };
  }
}

/**
 * Empreinte bancaire d'une réservation sur sa fiche : état, puis prélever (après une absence
 * ou une annulation tardive, 7 jours au plus) et rembourser. Rien ne s'affiche sans empreinte.
 */
export function ReservationCardGuarantee({
  reservation,
}: {
  reservation: { id: string; reservedAt: string; state: string };
}) {
  const { get, post } = useApi();
  const allowed = useCapabilities()?.['reservations.payments'] === true;
  const [payment, setPayment] = useState<Payment | null>(null);
  const [amount, setAmount] = useState('');
  const [action, setAction] = useState<'capture' | 'refund' | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const { data } = await get<{ data: Payment | null }>(
        `reservations/${reservation.id}/payment`,
      );
      setPayment(data);
    } catch (err) {
      // Fonction coupée ou formule sans paiement : rien à montrer.
      if (!(err instanceof ApiError && [403, 503].includes(err.status))) {
        setError('L’état de l’empreinte n’a pas pu être chargé.');
      }
    }
  }, [get, reservation.id]);

  useEffect(() => {
    if (allowed) void load();
  }, [allowed, load]);

  if (!allowed || (!payment && !error)) return null;

  const withinWindow = Date.now() <= new Date(reservation.reservedAt).getTime() + CAPTURE_WINDOW_MS;
  const capturable =
    payment?.status === 'AUTHORIZED' &&
    !(payment.capturedAmount && !payment.failureCode) &&
    ['NO_SHOW', 'CANCELLED'].includes(reservation.state) &&
    withinWindow;
  const refundable =
    (payment?.status === 'CAPTURED' || payment?.status === 'PARTIALLY_REFUNDED') &&
    !!payment.capturedAmount;
  const maxCents = payment
    ? capturable
      ? cents(payment.amount)
      : cents(payment.capturedAmount ?? '0') - cents(payment.refundedAmount ?? '0')
    : 0;
  const askedCents = amount ? cents(amount) : maxCents;
  const amountValid = Number.isFinite(askedCents) && askedCents > 0 && askedCents <= maxCents;
  const askedLabel = formatGuaranteeEuros((askedCents / 100).toFixed(2));

  async function run() {
    if (!action) return;
    setPending(true);
    setError('');
    try {
      await post(`reservations/${reservation.id}/payment/${action}`, {
        amount: (askedCents / 100).toFixed(2),
      });
      toast.success(
        action === 'capture'
          ? `Prélèvement de ${askedLabel} demandé à la banque.`
          : `Remboursement de ${askedLabel} demandé.`,
      );
      setAmount('');
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 402
          ? 'La banque a refusé le prélèvement. La carte reste enregistrée : vous pouvez réessayer plus tard.'
          : getErrorMessage(err, 'L’opération n’a pas pu être faite.'),
      );
    } finally {
      setPending(false);
      setAction(null);
      await load();
    }
  }

  const info = payment ? describe(payment) : null;
  const disputeOpen = payment?.disputeStatus && OPEN_DISPUTES.includes(payment.disputeStatus);

  return (
    <section
      className="space-y-3 rounded-lg border border-border p-4 text-sm"
      aria-label="Empreinte bancaire"
    >
      <p className="flex items-center gap-2 font-medium">
        <CreditCard className="h-4 w-4" aria-hidden="true" />
        Empreinte bancaire{info ? ` · ${info.label}` : ''}
      </p>
      {info && <p className="text-muted-foreground">{info.detail}</p>}
      {disputeOpen && (
        <p className="text-destructive">
          Litige ouvert par le client : répondez-y depuis votre tableau de bord Stripe.
        </p>
      )}
      {(capturable || refundable) && (
        <div className="flex items-end gap-2">
          <label className="space-y-1">
            <span className="text-muted-foreground">Montant (€)</span>
            <Input
              type="number"
              min={0.01}
              step={0.01}
              placeholder={(maxCents / 100).toFixed(2)}
              value={amount}
              onChange={(event) => setAmount(event.target.value)}
              className="w-32"
            />
          </label>
          <Button
            variant={capturable ? 'default' : 'outline'}
            disabled={!amountValid || pending}
            onClick={() => setAction(capturable ? 'capture' : 'refund')}
            className="transition-all duration-200"
          >
            {pending && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
            {capturable ? `Prélever ${askedLabel}` : `Rembourser ${askedLabel}`}
          </Button>
        </div>
      )}
      {error && (
        <p className="text-destructive" role="alert">
          {error}
        </p>
      )}
      <ConfirmDialog
        open={action !== null}
        onCancel={() => setAction(null)}
        onConfirm={() => void run()}
        pending={pending}
        title={action === 'capture' ? `Prélever ${askedLabel} ?` : `Rembourser ${askedLabel} ?`}
        description={
          action === 'capture'
            ? 'Le montant sera débité sur la carte enregistrée par le client, au nom de votre restaurant. Le client peut contester ce prélèvement auprès de sa banque.'
            : 'Le montant sera recrédité sur la carte du client sous quelques jours.'
        }
        confirmLabel={action === 'capture' ? 'Prélever' : 'Rembourser'}
        variant={action === 'capture' ? 'destructive' : 'default'}
      />
    </section>
  );
}
