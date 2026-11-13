import type { Prisma, GiftCard, GiftCardPack } from '@prisma/client';

export type GiftCardStatus = 'ACTIVE' | 'REDEEMED' | 'EXPIRED' | 'CANCELLED' | 'CLOSED';

export type GiftCardType = 'SINGLE' | 'CROWDFUNDED';

export type GiftCardCreatedBy = 'CLIENT' | 'DASHBOARD' | 'VOICE';

export type CreateGiftCardInput = {
  restaurantId: string;
  amount?: number;
  currency?: string;
  expiresAt?: Date;
  validityMonths?: number;
  packId?: string;
  verifiedAmount?: number;
  packSnapshot?: Prisma.InputJsonValue;
  preferredDate?: Date;
  preferredTime?: string;
  preferredPartySize?: number;
  senderName?: string;
  senderEmail?: string;
  senderPhone?: string;
  recipientName?: string;
  recipientEmail?: string;
  recipientPhone?: string;
  message?: string;
  occasion?: string;
  customerId?: string;
  createdBy?: GiftCardCreatedBy;
  purchaseReference?: string;
  // P2 — Stripe + personnalisation + commission
  stripePaymentIntentId?: string;
  stripePaymentStatus?: string;
  templateId?: string;
  customImageUrl?: string;
  suppernoteCommissionAmount?: number;
  // P3 — Crowdfunding
  type?: GiftCardType;
  targetAmount?: number;
  crowdfundedUntil?: Date;
};

export type GiftCardValidationResult =
  | { valid: true; giftCard: GiftCard }
  | { valid: false; reason: GiftCardValidationError };

export type GiftCardValidationError =
  | 'NOT_FOUND'
  | 'EXPIRED'
  | 'CANCELLED'
  | 'FULLY_REDEEMED'
  | 'WRONG_RESTAURANT';

export type ApplyGiftCardInput = {
  code: string;
  restaurantId: string;
  reservationId: string;
  reservationAmount: number;
  actor?: string;
};

export type GiftCardApplicationPaymentStatus =
  | 'FULLY_COVERED'
  | 'PARTIAL'
  | 'COMPLEMENT_REQUIRED'
  | 'ASSOCIATED';

export type GiftCardApplicationResult = {
  reservationId: string;
  giftCardId: string;
  appliedAmount: number;
  remainingAmount: number;
  paymentStatus: GiftCardApplicationPaymentStatus;
  complementAmount: number;
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

export type GiftCardRecommendation = {
  amount: number;
  messageSuggestion: string;
  reason: string;
};

export type CreateGiftCardPackInput = {
  restaurantId: string;
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

export type GiftCardSlot = {
  date: string;
  time: string;
  tableId?: string;
};

export type BookGiftCardSlotInput = {
  code: string;
  slotIndex: number;
  customer: {
    firstName: string;
    lastName?: string;
    phone: string;
    email?: string;
  };
};

export type GiftCardWithPack = GiftCard & { pack: GiftCardPack | null };

export type GiftCardBookResult = {
  reservationId: string;
  state: string;
  giftCardApplication?: GiftCardApplicationResult;
};

// ─── P3 — Crowdfunding ─────────────────────────────────────────────

export type CreateCrowdfundingInput = {
  restaurantId: string;
  title: string;
  occasion?: string;
  recipientName: string;
  recipientEmail?: string;
  recipientPhone?: string;
  creatorName: string;
  creatorEmail: string;
  targetAmount?: number;
  crowdfundedUntil: Date;
  templateId?: string;
  message?: string;
};

export type ContributeInput = {
  code: string;
  contributorName: string;
  contributorEmail?: string;
  amount: number;
  isPublicName: boolean;
  message?: string;
};

export type PublicContribution = {
  id: string;
  contributorName: string | null;
  amount: number;
  message: string | null;
  contributedAt: string;
};

export type PublicCrowdfundingStatus = {
  code: string;
  shortCode: string | null;
  title: string;
  occasion: string | null;
  recipientName: string;
  restaurantName: string;
  collectedAmount: number;
  targetAmount: number | null;
  contributionsCount: number;
  crowdfundedUntil: string | null;
  status: GiftCardStatus;
  contributions: PublicContribution[];
  creatorName: string;
  message: string | null;
};
