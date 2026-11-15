'use client';

import { useMemo, useRef, useState } from 'react';
import { Pencil } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import ReservationWidget, {
  type WidgetModification,
} from '@/components/reservation/reservation-widget';

type Booking = {
  restaurantName: string;
  restaurantAddress?: string | null;
  date: string;
  time: string;
  partySize: number;
  state: string;
  modification?: { available: boolean; message: string; maxDate?: string };
  cancellation?: { available: boolean };
};
type Options = {
  date: string;
  partySize: number;
  maxPartySize: number;
  slots: Array<{ time: string; proposalToken: string }>;
  message: string;
};
class ReservationRequestError extends Error {}

export function ReservationModification<T extends Booking>({
  booking,
  token,
  disabled,
  terms,
  onUpdated,
  demoRequest,
  onCancelRequest,
}: {
  booking: T;
  token: string;
  disabled: boolean;
  terms?: string;
  onUpdated: (booking: T) => void;
  onCancelRequest?: () => void;
  demoRequest?: (body: Record<string, unknown>) => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [snapshot, setSnapshot] = useState<T | null>(null);
  const inFlight = useRef(false);
  const loadingRef = useRef(false);
  const proposals = useRef(new Map<string, { time: string; partySize: number; date: string }>());
  // Stable adapter for the lifetime of an open widget; ordinary parent rerenders must not
  // reset the current selection or issue competing availability requests.
  const operations = useRef({ token, onUpdated, demoRequest, onCancelRequest });
  operations.current = { token, onUpdated, demoRequest, onCancelRequest };

  async function request<R>(body: Record<string, unknown>): Promise<R> {
    if (operations.current.demoRequest) return (await operations.current.demoRequest(body)) as R;
    const response = await fetch('/api/reservation-management', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: operations.current.token, ...body }),
      cache: 'no-store',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      signal: AbortSignal.timeout(10000),
    });
    const data = await response.json();
    if (!response.ok)
      throw new ReservationRequestError(
        typeof data.error === 'string' ? data.error : 'La demande n’a pas pu être confirmée.',
      );
    return data as R;
  }
  async function start() {
    if (loadingRef.current || inFlight.current) return;
    loadingRef.current = true;
    setLoading(true);
    setError('');
    try {
      const fresh = await request<T>({ action: 'view' });
      operations.current.onUpdated(fresh);
      if (!fresh.modification?.available)
        throw new ReservationRequestError(
          fresh.modification?.message ?? 'Veuillez contacter le restaurant.',
        );
      proposals.current.clear();
      setSnapshot(fresh);
      setOpen(true);
    } catch (e) {
      setError(
        e instanceof ReservationRequestError
          ? e.message
          : 'La réservation n’est pas accessible. Veuillez réessayer.',
      );
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }
  const modification = useMemo<WidgetModification | undefined>(
    () =>
      snapshot
        ? {
            ...snapshot,
            terms,
            demo: Boolean(demoRequest),
            close: () => {
              if (!inFlight.current) setOpen(false);
            },
            cancel:
              snapshot.cancellation?.available && operations.current.onCancelRequest
                ? () => {
                    if (!inFlight.current) {
                      setOpen(false);
                      operations.current.onCancelRequest?.();
                    }
                  }
                : undefined,
            maxDate: snapshot.modification?.maxDate,
            getOptions: async (partySize, date) => {
              const options = await request<Options>({
                action: 'modification_options',
                partySize,
                date,
              });
              for (const slot of options.slots)
                proposals.current.set(slot.proposalToken, {
                  time: slot.time,
                  date: options.date,
                  partySize: options.partySize,
                });
              return options;
            },
            onBusyChange: (value) => {
              inFlight.current = value;
            },
            confirm: async (proposalToken) => {
              try {
                const updated = await request<T>({
                  action: 'modify',
                  confirmed: true,
                  proposalToken,
                });
                operations.current.onUpdated(updated);
                setOpen(false);
              } catch (e) {
                let actual: T;
                try {
                  actual = await request<T>({ action: 'view' });
                } catch {
                  throw new Error(
                    'Impossible de vérifier le résultat. Fermez cette fenêtre puis rouvrez-la pour relire votre réservation.',
                  );
                }
                operations.current.onUpdated(actual);
                const desired = proposals.current.get(proposalToken);
                if (
                  desired &&
                  actual.date === desired.date &&
                  actual.time === desired.time &&
                  actual.partySize === desired.partySize &&
                  ['PENDING', 'CONFIRMED'].includes(actual.state)
                ) {
                  setOpen(false);
                  return;
                }
                throw new Error(
                  e instanceof ReservationRequestError
                    ? e.message
                    : 'La modification n’a pas pu être confirmée. Consultez les disponibilités à nouveau.',
                );
              }
            },
          }
        : undefined,
    [snapshot, terms, demoRequest],
  );

  return (
    <>
      <Button
        variant="outline"
        disabled={disabled || loading}
        onClick={() => void start()}
        className="min-h-11 w-fit justify-start gap-3 rounded-none border-0 bg-transparent px-0 text-sm font-medium text-foreground shadow-none transition-all duration-200 hover:gap-4 hover:bg-transparent hover:text-foreground/80"
      >
        {loading ? 'Ouverture…' : 'Modifier la réservation'}
        <Pencil className="h-3.5 w-3.5 opacity-60" aria-hidden="true" />
      </Button>
      {error && (
        <p role="alert" className="text-sm">
          {error}
        </p>
      )}
      <Dialog
        open={open}
        onOpenChange={(value) => {
          if (!inFlight.current) setOpen(value);
        }}
      >
        <DialogContent
          showCloseButton={false}
          className="inset-0 left-0 top-0 h-[100dvh] max-h-none w-full max-w-none translate-x-0 translate-y-0 gap-0 overflow-hidden rounded-none border-0 p-0 sm:rounded-none"
          onEscapeKeyDown={(event) => {
            if (inFlight.current) event.preventDefault();
          }}
          onPointerDownOutside={(event) => {
            if (inFlight.current) event.preventDefault();
          }}
        >
          <DialogTitle className="sr-only">Modifier la réservation</DialogTitle>
          <DialogDescription className="sr-only">
            Choisissez votre nouvel horaire et le nombre de personnes, puis confirmez le changement.
          </DialogDescription>
          {modification && (
            <ReservationWidget restaurantId="personal-reservation" modification={modification} />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
