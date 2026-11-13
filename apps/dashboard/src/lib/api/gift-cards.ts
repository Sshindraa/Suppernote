'use client';

import { useApi } from '../api';
import { useCallback } from 'react';

export type GiftCardListItem = {
  id: string;
  code: string;
  shortCode: string | null;
  amount: number;
  remainingAmount: number;
  status: string;
  packId: string | null;
  packName: string | null;
  recipientName: string | null;
  recipientEmail: string | null;
  recipientPhone: string | null;
  senderName: string | null;
  message: string | null;
  occasion: string | null;
  createdBy: string;
  purchasedAt: string;
  expiresAt: string | null;
  stripePaymentStatus: string | null;
  suppernoteCommissionAmount: number;
  type: string;
  targetAmount: number | null;
  crowdfundedUntil: string | null;
  closedAt: string | null;
};

export type GiftCardListResponse = {
  items: GiftCardListItem[];
  total: number;
  limit: number;
  offset: number;
};

export type GiftCardStats = {
  totalSoldAmount: number;
  totalRemainingAmount: number;
  redeemedCount: number;
  activeCount: number;
  totalCount: number;
  averageAmount: number;
  packCount: number;
  freeAmountCount: number;
};

export type GiftCardPack = {
  id: string;
  name: string;
  description: string | null;
  amount: number;
  minPartySize: number;
  maxPartySize: number;
  isActive: boolean;
  deletedAt: string | null;
};

export type CreateGiftCardInput = {
  amount?: number;
  packId?: string;
  recipientName?: string;
  recipientEmail?: string;
  recipientPhone?: string;
  senderName?: string;
  message?: string;
  occasion?: string;
  expiresAt?: string;
};

export type CreateGiftCardPackInput = {
  name: string;
  description?: string;
  amount: number;
  minPartySize?: number;
  maxPartySize?: number;
};

export type UpdateGiftCardPackInput = {
  name?: string;
  description?: string | null;
  amount?: number;
  minPartySize?: number;
  maxPartySize?: number;
};

export function useGiftCardApi() {
  const { get, post, patch, del, orgId } = useApi();

  const listGiftCards = useCallback(
    async (params?: {
      status?: string;
      type?: string;
      search?: string;
      limit?: number;
      offset?: number;
    }): Promise<GiftCardListResponse> => {
      if (!orgId) throw new Error('Organisation non chargée');
      const qs = new URLSearchParams();
      if (params?.status) qs.set('status', params.status);
      if (params?.type) qs.set('type', params.type);
      if (params?.search) qs.set('search', params.search);
      if (params?.limit) qs.set('limit', String(params.limit));
      if (params?.offset) qs.set('offset', String(params.offset));
      const query = qs.toString();
      return get<GiftCardListResponse>(
        `restaurants/${orgId}/gift-cards${query ? `?${query}` : ''}`,
      );
    },
    [get, orgId],
  );

  const createGiftCard = useCallback(
    async (input: CreateGiftCardInput): Promise<GiftCardListItem> => {
      if (!orgId) throw new Error('Organisation non chargée');
      return post<GiftCardListItem>(`restaurants/${orgId}/gift-cards`, input);
    },
    [orgId, post],
  );

  const cancelGiftCard = useCallback(
    async (giftCardId: string): Promise<GiftCardListItem> => {
      if (!orgId) throw new Error('Organisation non chargée');
      return post<GiftCardListItem>(`restaurants/${orgId}/gift-cards/${giftCardId}/cancel`);
    },
    [orgId, post],
  );

  const getGiftCardStats = useCallback(async (): Promise<GiftCardStats> => {
    if (!orgId) throw new Error('Organisation non chargée');
    return get<GiftCardStats>(`restaurants/${orgId}/gift-cards/stats`);
  }, [get, orgId]);

  const listGiftCardPacks = useCallback(async (): Promise<GiftCardPack[]> => {
    if (!orgId) throw new Error('Organisation non chargée');
    return get<GiftCardPack[]>(`restaurants/${orgId}/gift-card-packs`);
  }, [get, orgId]);

  const createGiftCardPack = useCallback(
    async (input: CreateGiftCardPackInput): Promise<GiftCardPack> => {
      if (!orgId) throw new Error('Organisation non chargée');
      return post<GiftCardPack>(`restaurants/${orgId}/gift-card-packs`, input);
    },
    [orgId, post],
  );

  const updateGiftCardPack = useCallback(
    async (packId: string, input: UpdateGiftCardPackInput): Promise<GiftCardPack> => {
      if (!orgId) throw new Error('Organisation non chargée');
      return patch<GiftCardPack>(`restaurants/${orgId}/gift-card-packs/${packId}`, input);
    },
    [orgId, patch],
  );

  const toggleGiftCardPack = useCallback(
    async (packId: string): Promise<GiftCardPack> => {
      if (!orgId) throw new Error('Organisation non chargée');
      return post<GiftCardPack>(`restaurants/${orgId}/gift-card-packs/${packId}/toggle`);
    },
    [orgId, post],
  );

  const deleteGiftCardPack = useCallback(
    async (packId: string): Promise<GiftCardPack> => {
      if (!orgId) throw new Error('Organisation non chargée');
      return del<GiftCardPack>(`restaurants/${orgId}/gift-card-packs/${packId}`);
    },
    [del, orgId],
  );

  const closeCrowdfunding = useCallback(
    async (giftCardId: string): Promise<GiftCardListItem> => {
      if (!orgId) throw new Error('Organisation non chargée');
      return post<GiftCardListItem>(`api/gift-cards/${giftCardId}/close?restaurantId=${orgId}`, {});
    },
    [orgId, post],
  );

  return {
    orgId,
    listGiftCards,
    createGiftCard,
    cancelGiftCard,
    closeCrowdfunding,
    getGiftCardStats,
    listGiftCardPacks,
    createGiftCardPack,
    updateGiftCardPack,
    toggleGiftCardPack,
    deleteGiftCardPack,
  };
}
