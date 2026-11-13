'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  type CreateGiftCardInput,
  type GiftCardPack,
  type GiftCardListItem,
  useGiftCardApi,
} from '@/lib/api/gift-cards';
import { getErrorMessage } from '@/types/api';

type FormMode = 'free' | 'pack';

export type GiftCardFormProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  packs: GiftCardPack[];
  onCreated?: (card: GiftCardListItem) => void;
};

export default function GiftCardForm({ open, onOpenChange, packs, onCreated }: GiftCardFormProps) {
  const { createGiftCard } = useGiftCardApi();
  const activePacks = packs.filter((p) => p.isActive);

  const [mode, setMode] = useState<FormMode>('free');
  const [amount, setAmount] = useState('');
  const [packId, setPackId] = useState('');
  const [recipientName, setRecipientName] = useState('');
  const [recipientEmail, setRecipientEmail] = useState('');
  const [recipientPhone, setRecipientPhone] = useState('');
  const [senderName, setSenderName] = useState('');
  const [message, setMessage] = useState('');
  const [occasion, setOccasion] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) {
      setMode('free');
      setAmount('');
      setPackId('');
      setRecipientName('');
      setRecipientEmail('');
      setRecipientPhone('');
      setSenderName('');
      setMessage('');
      setOccasion('');
      setExpiresAt('');
      setError('');
    }
  }, [open]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');

    if (mode === 'free') {
      const parsed = parseFloat(amount);
      if (!parsed || parsed <= 0) {
        setError('Le montant doit être supérieur à 0');
        return;
      }
    } else if (!packId) {
      setError('Veuillez sélectionner un pack');
      return;
    }

    const input: CreateGiftCardInput = {
      recipientName: recipientName || undefined,
      recipientEmail: recipientEmail || undefined,
      recipientPhone: recipientPhone || undefined,
      senderName: senderName || undefined,
      message: message || undefined,
      occasion: occasion || undefined,
      expiresAt: expiresAt || undefined,
    };

    if (mode === 'free') {
      input.amount = parseFloat(amount);
    } else {
      input.packId = packId;
    }

    setSubmitting(true);
    try {
      const card = await createGiftCard(input);
      onCreated?.(card);
      onOpenChange(false);
    } catch (err: unknown) {
      setError(getErrorMessage(err, 'Impossible de créer la carte cadeau'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Créer une carte cadeau</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          {error && <div className="suppernote-error text-sm">{error}</div>}

          {/* Type */}
          <div className="space-y-2">
            <Label>Type de carte</Label>
            <Select value={mode} onValueChange={(v) => setMode(v as FormMode)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="free">Montant libre</SelectItem>
                <SelectItem value="pack" disabled={activePacks.length === 0}>
                  Pack expérience{activePacks.length === 0 ? ' (aucun pack actif)' : ''}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* Montant ou pack */}
          {mode === 'free' ? (
            <div className="space-y-2">
              <Label htmlFor="amount">Montant (€)</Label>
              <Input
                id="amount"
                type="number"
                step="0.01"
                min="1"
                placeholder="100"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                required
              />
            </div>
          ) : (
            <div className="space-y-2">
              <Label htmlFor="pack">Pack expérience</Label>
              <Select value={packId} onValueChange={setPackId}>
                <SelectTrigger>
                  <SelectValue placeholder="Sélectionnez un pack" />
                </SelectTrigger>
                <SelectContent>
                  {activePacks.map((pack) => (
                    <SelectItem key={pack.id} value={pack.id}>
                      {pack.name} —{' '}
                      {new Intl.NumberFormat('fr-FR', {
                        style: 'currency',
                        currency: 'EUR',
                      }).format(pack.amount)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          {/* Destinataire */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="recipientName">Nom du destinataire</Label>
              <Input
                id="recipientName"
                placeholder="Alice Dupont"
                value={recipientName}
                onChange={(e) => setRecipientName(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="recipientEmail">Email du destinataire</Label>
              <Input
                id="recipientEmail"
                type="email"
                placeholder="alice@example.com"
                value={recipientEmail}
                onChange={(e) => setRecipientEmail(e.target.value)}
              />
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="recipientPhone">Téléphone du destinataire</Label>
              <Input
                id="recipientPhone"
                placeholder="+33612345678"
                value={recipientPhone}
                onChange={(e) => setRecipientPhone(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="senderName">Nom de l&rsquo;expéditeur</Label>
              <Input
                id="senderName"
                placeholder="Bob Martin"
                value={senderName}
                onChange={(e) => setSenderName(e.target.value)}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="occasion">Occasion (optionnel)</Label>
            <Input
              id="occasion"
              placeholder="Anniversaire, remerciement..."
              value={occasion}
              onChange={(e) => setOccasion(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="message">Message (optionnel)</Label>
            <textarea
              id="message"
              className="flex min-h-[80px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50 transition-all duration-200"
              placeholder="Joyeux anniversaire !"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="expiresAt">Date d&rsquo;expiration (optionnel)</Label>
            <Input
              id="expiresAt"
              type="date"
              value={expiresAt}
              onChange={(e) => setExpiresAt(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Par défaut, la carte expire dans 12 mois.
            </p>
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              Annuler
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? 'Création...' : 'Créer la carte'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
