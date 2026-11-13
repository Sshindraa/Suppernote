'use client';

import { useCallback, useEffect, useState } from 'react';
import { Package, Pencil, Plus, Power, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { useGiftCardApi } from '@/lib/api/gift-cards';
import { getErrorMessage } from '@/types/api';
import { formatEuro } from '@suppernote/shared';
import type { GiftCardPack } from '@/lib/api/gift-cards';
import GiftCardPackForm from '@/components/gift-cards/gift-card-pack-form';
import { GiftCardSectionNav } from '@/components/gift-cards/GiftCardSectionNav';
import { ConfirmDialog } from '@/components/ConfirmDialog';
import { DataFetchError } from '@/components/DataFetchError';

export default function GiftCardPacksPage() {
  const { listGiftCardPacks, toggleGiftCardPack, deleteGiftCardPack, orgId } = useGiftCardApi();

  const [packs, setPacks] = useState<GiftCardPack[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [formOpen, setFormOpen] = useState(false);
  const [editPack, setEditPack] = useState<GiftCardPack | null>(null);

  const fetchPacks = useCallback(async () => {
    if (!orgId) return;
    setLoading(true);
    setError('');
    try {
      const data = await listGiftCardPacks();
      setPacks(data);
    } catch (err: unknown) {
      setError(getErrorMessage(err, 'Impossible de charger les packs'));
    } finally {
      setLoading(false);
    }
  }, [orgId, listGiftCardPacks]);

  useEffect(() => {
    void fetchPacks();
  }, [fetchPacks]);

  const [packToDelete, setPackToDelete] = useState<GiftCardPack | null>(null);

  async function handleToggle(pack: GiftCardPack) {
    try {
      setError('');
      const updated = await toggleGiftCardPack(pack.id);
      setPacks((prev) => prev.map((p) => (p.id === pack.id ? updated : p)));
    } catch (err: unknown) {
      setError(getErrorMessage(err, 'Impossible de modifier le statut du pack'));
    }
  }

  async function handleDelete(pack: GiftCardPack) {
    setPackToDelete(pack);
  }

  async function confirmDelete() {
    const pack = packToDelete;
    if (!pack) return;
    setPackToDelete(null);
    try {
      setError('');
      await deleteGiftCardPack(pack.id);
      setPacks((prev) => prev.filter((p) => p.id !== pack.id));
    } catch (err: unknown) {
      setError(getErrorMessage(err, 'Impossible de supprimer le pack'));
    }
  }

  function handleEdit(pack: GiftCardPack) {
    setEditPack(pack);
    setFormOpen(true);
  }

  function handleCreate() {
    setEditPack(null);
    setFormOpen(true);
  }

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <Skeleton className="h-8 w-36 rounded-full" />
          <Skeleton className="h-10 w-24 rounded-lg" />
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {[1, 2, 3, 4].map((i) => (
            <Skeleton key={i} className="h-32 rounded-2xl" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4 md:space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl md:text-2xl font-semibold tracking-tight">Packs cadeaux</h1>
        <Button onClick={handleCreate} size="sm">
          <Plus size={16} />
          Créer
        </Button>
      </div>

      <GiftCardSectionNav />

      {error && <DataFetchError message={error} onRetry={fetchPacks} retrying={loading} />}

      {packs.length === 0 ? (
        error ? null : (
          <div className="suppernote-empty">
            <Package size={40} className="opacity-30" />
            <p className="text-sm">Aucun pack expérience pour le moment</p>
            <p className="text-xs opacity-60">
              Créez votre premier pack pour proposer des expériences clés en main à vos clients.
            </p>
          </div>
        )
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {packs.map((pack) => (
            <Card
              key={pack.id}
              className={`transition-all duration-200 hover:border-primary/30 ${
                !pack.isActive ? 'opacity-60' : ''
              }`}
            >
              <CardHeader className="pb-3">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <CardTitle className="text-base font-semibold truncate">{pack.name}</CardTitle>
                    {pack.description && (
                      <p className="mt-1 text-sm text-muted-foreground line-clamp-2">
                        {pack.description}
                      </p>
                    )}
                  </div>
                  <Badge
                    variant={pack.isActive ? 'default' : 'secondary'}
                    className={
                      pack.isActive
                        ? 'border-success/30 bg-success/10 text-success'
                        : 'border-border bg-secondary text-muted-foreground'
                    }
                  >
                    {pack.isActive ? 'Actif' : 'Inactif'}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="pt-0">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-4 text-sm">
                    <div>
                      <p className="text-xs text-muted-foreground">Montant</p>
                      <p className="font-semibold">{formatEuro(pack.amount)}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">Convives</p>
                      <p className="font-medium">
                        {pack.minPartySize === pack.maxPartySize
                          ? `${pack.minPartySize} pers.`
                          : `${pack.minPartySize}–${pack.maxPartySize} pers.`}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => handleEdit(pack)}
                      title="Modifier le pack"
                      className="transition-all duration-200"
                    >
                      <Pencil size={16} />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => handleToggle(pack)}
                      title={pack.isActive ? 'Désactiver le pack' : 'Activer le pack'}
                      className="transition-all duration-200"
                    >
                      <Power size={16} className={pack.isActive ? 'text-success' : ''} />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => handleDelete(pack)}
                      title="Supprimer le pack"
                      className="transition-all duration-200 hover:text-destructive"
                    >
                      <Trash2 size={16} />
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <GiftCardPackForm
        open={formOpen}
        onOpenChange={setFormOpen}
        pack={editPack}
        onSaved={() => fetchPacks()}
      />
      <ConfirmDialog
        open={packToDelete !== null}
        title="Supprimer ce pack ?"
        description={`Le pack « ${packToDelete?.name ?? ''} » ne sera plus proposé. Les cartes déjà vendues ne sont pas touchées. Cette action est irréversible.`}
        confirmLabel="Supprimer"
        variant="destructive"
        onConfirm={() => void confirmDelete()}
        onCancel={() => setPackToDelete(null)}
      />
    </div>
  );
}
