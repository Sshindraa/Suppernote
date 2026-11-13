'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  type CreateGiftCardPackInput,
  type GiftCardPack,
  type UpdateGiftCardPackInput,
  useGiftCardApi,
} from '@/lib/api/gift-cards';
import { getErrorMessage } from '@/types/api';

export type GiftCardPackFormProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Pack à éditer, ou null pour création */
  pack?: GiftCardPack | null;
  onSaved?: (pack: GiftCardPack) => void;
};

export default function GiftCardPackForm({
  open,
  onOpenChange,
  pack,
  onSaved,
}: GiftCardPackFormProps) {
  const { createGiftCardPack, updateGiftCardPack } = useGiftCardApi();
  const isEdit = !!pack;

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [minPartySize, setMinPartySize] = useState('1');
  const [maxPartySize, setMaxPartySize] = useState('2');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (open) {
      if (pack) {
        setName(pack.name);
        setDescription(pack.description ?? '');
        setAmount(String(pack.amount));
        setMinPartySize(String(pack.minPartySize));
        setMaxPartySize(String(pack.maxPartySize));
      } else {
        setName('');
        setDescription('');
        setAmount('');
        setMinPartySize('1');
        setMaxPartySize('2');
      }
      setError('');
    }
  }, [open, pack]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');

    const parsedAmount = parseFloat(amount);
    if (!parsedAmount || parsedAmount <= 0) {
      setError('Le montant doit être supérieur à 0');
      return;
    }

    const parsedMin = parseInt(minPartySize, 10);
    const parsedMax = parseInt(maxPartySize, 10);
    if (parsedMin > parsedMax) {
      setError('Le nombre de convives minimum ne peut pas dépasser le maximum');
      return;
    }

    setSubmitting(true);
    try {
      let saved: GiftCardPack;
      if (isEdit && pack) {
        const input: UpdateGiftCardPackInput = {
          name,
          description: description || null,
          amount: parsedAmount,
          minPartySize: parsedMin,
          maxPartySize: parsedMax,
        };
        saved = await updateGiftCardPack(pack.id, input);
      } else {
        const input: CreateGiftCardPackInput = {
          name,
          description: description || undefined,
          amount: parsedAmount,
          minPartySize: parsedMin,
          maxPartySize: parsedMax,
        };
        saved = await createGiftCardPack(input);
      }
      onSaved?.(saved);
      onOpenChange(false);
    } catch (err: unknown) {
      setError(getErrorMessage(err, 'Impossible de sauvegarder le pack'));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{isEdit ? 'Modifier le pack' : 'Créer un pack expérience'}</DialogTitle>
        </DialogHeader>

        <form onSubmit={handleSubmit} className="space-y-4">
          {error && <div className="suppernote-error text-sm">{error}</div>}

          <div className="space-y-2">
            <Label htmlFor="name">Nom du pack</Label>
            <Input
              id="name"
              placeholder="Menu dégustation 5 services"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="description">Description (optionnel)</Label>
            <Input
              id="description"
              placeholder="Menu 5 services avec accord mets et vins"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="amount">Montant (€)</Label>
            <Input
              id="amount"
              type="number"
              step="0.01"
              min="1"
              placeholder="150"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              required
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-2">
              <Label htmlFor="minPartySize">Convives min</Label>
              <Input
                id="minPartySize"
                type="number"
                min="1"
                value={minPartySize}
                onChange={(e) => setMinPartySize(e.target.value)}
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="maxPartySize">Convives max</Label>
              <Input
                id="maxPartySize"
                type="number"
                min="1"
                value={maxPartySize}
                onChange={(e) => setMaxPartySize(e.target.value)}
                required
              />
            </div>
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
              {submitting ? 'Sauvegarde...' : isEdit ? 'Enregistrer' : 'Créer le pack'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
