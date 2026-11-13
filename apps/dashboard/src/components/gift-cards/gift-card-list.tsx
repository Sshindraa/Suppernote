'use client';

import { format } from 'date-fns';
import { fr } from 'date-fns/locale';
import { Ban, Eye, Gift, Lock } from 'lucide-react';
import { formatEuro } from '@suppernote/shared';
import { useIsMobile } from '@/lib/useMediaQuery';
import MobileDataCard from '@/components/MobileDataCard';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import type { GiftCardListItem } from '@/lib/api/gift-cards';
import { giftCardPaymentLabel, giftCardStatusLabel } from './gift-card-labels';

const STATUS_VARIANT: Record<string, string> = {
  ACTIVE: 'border-success/30 bg-success/10 text-success',
  REDEEMED: 'border-brand/30 bg-brand/10 text-brand',
  EXPIRED: 'border-warning/30 bg-warning/10 text-warning',
  CANCELLED: 'border-destructive/30 bg-destructive/10 text-destructive',
  CLOSED: 'border-metal/30 bg-metal/10 text-metal',
};

function StatusBadge({ status }: { status: string }) {
  const variant = STATUS_VARIANT[status] ?? 'border-border bg-secondary text-muted-foreground';
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold transition-colors ${variant}`}
    >
      {giftCardStatusLabel(status)}
    </span>
  );
}

export type GiftCardListProps = {
  items: GiftCardListItem[];
  isCrowdfunding: boolean;
  onView?: (card: GiftCardListItem) => void;
  onCancel?: (card: GiftCardListItem) => void;
  onClose?: (card: GiftCardListItem) => void;
  closingId?: string | null;
  /** Une recherche ou un filtre est actif : une liste vide ne veut pas dire « aucune carte ». */
  filtered?: boolean;
  onClearFilters?: () => void;
};

export default function GiftCardList({
  items,
  isCrowdfunding,
  onView,
  onCancel,
  onClose,
  closingId,
  filtered = false,
  onClearFilters,
}: GiftCardListProps) {
  const isMobile = useIsMobile();

  if (items.length === 0) {
    return (
      <div className="suppernote-empty">
        <Gift size={40} className="opacity-30" />
        {filtered ? (
          <>
            <p className="text-sm">
              {isCrowdfunding
                ? 'Aucune cagnotte ne correspond à cette recherche'
                : 'Aucune carte ne correspond à cette recherche'}
            </p>
            {onClearFilters ? (
              <button
                type="button"
                onClick={onClearFilters}
                className="text-xs font-medium underline underline-offset-4 transition-all duration-200"
              >
                Effacer la recherche et les filtres
              </button>
            ) : null}
          </>
        ) : (
          <>
            <p className="text-sm">
              {isCrowdfunding
                ? 'Aucune cagnotte pour le moment'
                : 'Aucune carte cadeau pour le moment'}
            </p>
            <p className="text-xs opacity-60">
              {isCrowdfunding
                ? 'Les cagnottes créées via votre page de réservation apparaîtront ici.'
                : 'Les cartes cadeaux vendues ou créées manuellement apparaîtront ici.'}
            </p>
          </>
        )}
      </div>
    );
  }

  if (isMobile) {
    return (
      <div className="space-y-2.5">
        {items.map((card) => (
          <MobileDataCard
            key={card.id}
            title={
              card.type === 'CROWDFUNDED'
                ? (card.occasion ?? card.code)
                : (card.shortCode ?? card.code)
            }
            subtitle={
              card.type === 'CROWDFUNDED'
                ? `Cagnotte${card.recipientName ? ` — ${card.recipientName}` : ''}`
                : (card.packName ?? 'Montant libre')
            }
            badge={<StatusBadge status={card.status} />}
            accentClass={
              card.status === 'ACTIVE'
                ? 'border-l-success'
                : card.status === 'REDEEMED'
                  ? 'border-l-brand'
                  : card.status === 'CANCELLED'
                    ? 'border-l-destructive'
                    : card.status === 'CLOSED'
                      ? 'border-l-metal'
                      : 'border-l-warning'
            }
            actions={[
              ...(onView
                ? [
                    {
                      label: 'Voir',
                      icon: <Eye size={14} />,
                      colorClass: 'bg-brand',
                      onClick: (e: React.MouseEvent) => {
                        e.stopPropagation();
                        onView(card);
                      },
                    },
                  ]
                : []),
              ...(onClose &&
              card.type === 'CROWDFUNDED' &&
              !card.closedAt &&
              card.status === 'ACTIVE'
                ? [
                    {
                      label: closingId === card.id ? 'Clôture...' : 'Clôturer',
                      icon: <Lock size={14} />,
                      colorClass: 'bg-metal',
                      onClick: (e: React.MouseEvent) => {
                        e.stopPropagation();
                        onClose(card);
                      },
                    },
                  ]
                : []),
              ...(onCancel && card.status === 'ACTIVE'
                ? [
                    {
                      label: 'Annuler',
                      icon: <Ban size={14} />,
                      colorClass: 'bg-destructive',
                      onClick: (e: React.MouseEvent) => {
                        e.stopPropagation();
                        onCancel(card);
                      },
                    },
                  ]
                : []),
            ]}
            details={[
              { label: 'Montant', value: formatEuro(card.amount) },
              {
                label: 'Commission',
                value: card.suppernoteCommissionAmount
                  ? formatEuro(card.suppernoteCommissionAmount)
                  : '—',
              },
              { label: 'Solde', value: formatEuro(card.remainingAmount) },
              ...(card.type === 'CROWDFUNDED'
                ? [
                    {
                      label: 'Date butoir',
                      value: card.crowdfundedUntil
                        ? format(new Date(card.crowdfundedUntil), 'dd MMM yyyy', { locale: fr })
                        : '—',
                    },
                    {
                      label: 'Clôturée le',
                      value: card.closedAt
                        ? format(new Date(card.closedAt), 'dd MMM yyyy', { locale: fr })
                        : '—',
                    },
                  ]
                : []),
              {
                label: 'Paiement',
                value:
                  card.stripePaymentStatus === 'succeeded'
                    ? 'Payé'
                    : card.stripePaymentStatus === 'pending'
                      ? 'En attente'
                      : (card.stripePaymentStatus ?? '—'),
              },
              {
                label: 'Destinataire',
                value: card.recipientName ?? '—',
              },
              {
                label: 'Achetée le',
                value: format(new Date(card.purchasedAt), 'dd MMM yyyy', { locale: fr }),
              },
            ]}
          />
        ))}
      </div>
    );
  }

  return (
    <div className="suppernote-card overflow-hidden">
      <div className="mobile-table-wrapper">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Code</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Montant</TableHead>
              <TableHead>Commission</TableHead>
              <TableHead>Solde</TableHead>
              <TableHead>Destinataire</TableHead>
              <TableHead>Statut</TableHead>
              <TableHead>Paiement</TableHead>
              <TableHead>{isCrowdfunding ? 'Date butoir' : 'Achetée le'}</TableHead>
              <TableHead>{isCrowdfunding ? 'Clôturée le' : 'Expire le'}</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {items.map((card) => (
              <TableRow key={card.id} className="transition-all duration-200 hover:bg-accent">
                <TableCell className="font-mono text-xs">
                  {card.type === 'CROWDFUNDED' ? (
                    <span className="text-sm font-sans">{card.occasion ?? card.code}</span>
                  ) : card.shortCode ? (
                    <div className="flex flex-col gap-0.5">
                      <span className="text-sm font-bold tracking-wider">{card.shortCode}</span>
                      <span className="text-[10px] text-muted-foreground">{card.code}</span>
                    </div>
                  ) : (
                    card.code
                  )}
                </TableCell>
                <TableCell>
                  {card.type === 'CROWDFUNDED' ? (
                    <span className="text-sm text-metal">Cagnotte</span>
                  ) : card.packName ? (
                    <span className="text-sm">Pack : {card.packName}</span>
                  ) : (
                    <span className="text-sm text-muted-foreground">Montant libre</span>
                  )}
                </TableCell>
                <TableCell className="font-medium">{formatEuro(card.amount)}</TableCell>
                <TableCell className="text-muted-foreground text-sm">
                  {card.suppernoteCommissionAmount
                    ? formatEuro(card.suppernoteCommissionAmount)
                    : '—'}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {formatEuro(card.remainingAmount)}
                </TableCell>
                <TableCell>{card.recipientName ?? <span className="opacity-50">—</span>}</TableCell>
                <TableCell>
                  <StatusBadge status={card.status} />
                </TableCell>
                <TableCell>
                  {card.stripePaymentStatus ? (
                    <span
                      className={`text-xs font-medium ${
                        card.stripePaymentStatus === 'succeeded'
                          ? 'text-success'
                          : card.stripePaymentStatus === 'pending'
                            ? 'text-warning'
                            : 'text-destructive'
                      }`}
                    >
                      {giftCardPaymentLabel(card.stripePaymentStatus)}
                    </span>
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell className="text-muted-foreground text-sm">
                  {card.type === 'CROWDFUNDED' && card.crowdfundedUntil
                    ? format(new Date(card.crowdfundedUntil), 'dd MMM yyyy', { locale: fr })
                    : format(new Date(card.purchasedAt), 'dd MMM yyyy', { locale: fr })}
                </TableCell>
                <TableCell className="text-muted-foreground text-sm">
                  {card.type === 'CROWDFUNDED'
                    ? card.closedAt
                      ? format(new Date(card.closedAt), 'dd MMM yyyy', { locale: fr })
                      : '—'
                    : card.expiresAt
                      ? format(new Date(card.expiresAt), 'dd MMM yyyy', { locale: fr })
                      : '—'}
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex items-center justify-end gap-1">
                    {onView && (
                      <button
                        onClick={() => onView(card)}
                        className="p-2 text-muted-foreground hover:text-foreground rounded-lg hover:bg-accent transition-all duration-200"
                        title="Voir le détail"
                      >
                        <Eye size={16} />
                      </button>
                    )}
                    {onClose &&
                      card.type === 'CROWDFUNDED' &&
                      !card.closedAt &&
                      card.status === 'ACTIVE' && (
                        <button
                          onClick={() => onClose(card)}
                          disabled={closingId === card.id}
                          className="p-2 text-muted-foreground hover:text-foreground rounded-lg hover:bg-accent transition-all duration-200 disabled:opacity-50"
                          title="Clôturer la cagnotte"
                        >
                          <Lock size={16} />
                        </button>
                      )}
                    {onCancel && card.status === 'ACTIVE' && (
                      <button
                        onClick={() => onCancel(card)}
                        className="p-2 text-muted-foreground hover:text-destructive rounded-lg hover:bg-accent transition-all duration-200"
                        title="Annuler la carte"
                      >
                        <Ban size={16} />
                      </button>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
