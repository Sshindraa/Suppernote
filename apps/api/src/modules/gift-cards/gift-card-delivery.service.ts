import type { Prisma, PrismaClient } from '@prisma/client';
import { enqueue } from '../../shared/outbox/outbox.service';
import {
  classifyNotificationError,
  getNotificationErrorProviderMessageId,
  normalizeNotificationSendResult,
} from '../../shared/queue/notification-idempotency';
import { lookupResendEmail } from '../../shared/email';
import { lookupTelnyxMessage, sendSms } from '../../shared/telnyx/client';
import {
  sendSenderReceipt,
  sendRecipientGiftCard,
  sendRestaurantSaleNotification,
  sendContributionConfirmation,
  sendCrowdfundingContributionNotification,
  sendCrowdfundingClosed,
  sendRefundNotificationSender,
  sendRefundNotificationRestaurant,
} from './gift-card-email.service';
import { sendRecipientWhatsApp } from './gift-card-whatsapp.service';

export type GiftCardDeliveryKind =
  | 'sender_email'
  | 'recipient_email'
  | 'restaurant_email'
  | 'recipient_whatsapp'
  | 'restaurant_sms'
  | 'contribution_email'
  | 'organizer_email'
  | 'closure_email'
  | 'refund_sender_email'
  | 'refund_restaurant_email';

export async function enqueueGiftCardDelivery(
  tx: Prisma.TransactionClient,
  input: {
    restaurantId: string;
    giftCardId: string;
    kind: GiftCardDeliveryKind;
    referenceId?: string;
    generation?: string;
  },
) {
  const key = `gift-card-delivery:${input.giftCardId}:${input.kind}:${input.referenceId ?? 'card'}:${input.generation ?? 'initial'}`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
  const existing = await tx.giftCardDelivery.findUnique({
    where: { idempotencyKey: key, restaurantId: input.restaurantId },
  });
  if (existing) return existing;
  const delivery = await tx.giftCardDelivery.create({
    data: {
      restaurantId: input.restaurantId,
      giftCardId: input.giftCardId,
      kind: input.kind,
      referenceId: input.referenceId,
      channel: input.kind.endsWith('_email')
        ? 'email'
        : input.kind.endsWith('_sms')
          ? 'sms'
          : 'whatsapp',
      idempotencyKey: key,
    },
  });
  await enqueue(tx, {
    restaurantId: input.restaurantId,
    topic: 'gift-card-delivery',
    aggregateType: 'gift-card',
    aggregateId: input.giftCardId,
    eventType: input.kind,
    payload: { deliveryId: delivery.id },
    idempotencyKey: key,
  });
  return delivery;
}

export async function processGiftCardDelivery(prisma: PrismaClient, deliveryId: string) {
  // tenant-scoping: global — Internal outbox ID bootstrap; card lookup and every later write use the persisted restaurant.
  const delivery = await prisma.giftCardDelivery.findUnique({ where: { id: deliveryId } });
  if (!delivery || !['PENDING', 'FAILED'].includes(delivery.status)) return;
  const card = await prisma.giftCard.findFirst({
    where: { id: delivery.giftCardId, restaurantId: delivery.restaurantId },
  });
  const restaurant =
    card &&
    (await prisma.restaurant.findUnique({
      where: { id: card.restaurantId },
      select: { name: true, managerEmail: true, managerPhone: true },
    }));
  const skip = async () => {
    await prisma.giftCardDelivery.updateMany({
      where: {
        id: delivery.id,
        restaurantId: delivery.restaurantId,
        status: { in: ['PENDING', 'FAILED'] },
      },
      data: { status: 'SKIPPED', lastErrorCode: 'NO_CONTACT_OR_UNAVAILABLE' },
    });
  };
  if (
    !card ||
    !restaurant ||
    (!delivery.kind.startsWith('refund_') &&
      ['CANCELLED', 'REFUND_PENDING', 'REFUND_FAILED', 'REFUND_REVIEW', 'PAYMENT_REVIEW'].includes(
        card.status,
      ))
  ) {
    await skip();
    return;
  }
  const publicCode = card.shortCode ?? card.code;
  const data = {
    giftCardId: card.id,
    restaurantId: card.restaurantId,
    code: card.code,
    shortCode: card.shortCode,
    amount: card.amount.toNumber(),
    restaurantName: restaurant.name,
    senderName: card.senderName,
    senderEmail: card.senderEmail,
    recipientName: card.recipientName,
    recipientEmail: card.recipientEmail,
    message: card.message,
    occasion: card.occasion,
    pdfUrl: `${process.env.API_URL ?? ''}/public/gift-cards/${publicCode}/pdf`,
  };
  let send: (() => ReturnType<typeof sendSenderReceipt>) | undefined;
  switch (delivery.kind) {
    case 'sender_email':
      if (card.senderEmail) send = () => sendSenderReceipt(data);
      break;
    case 'recipient_email':
      if (card.recipientEmail) send = () => sendRecipientGiftCard(data);
      break;
    case 'restaurant_email':
      if (restaurant.managerEmail)
        send = () =>
          sendRestaurantSaleNotification({
            ...data,
            restaurantEmail: restaurant.managerEmail,
            commissionAmount: card.suppernoteCommissionAmount?.toNumber() ?? 0,
          });
      break;
    case 'recipient_whatsapp':
      if (card.recipientPhone)
        send = () => sendRecipientWhatsApp({ ...data, to: card.recipientPhone!, code: publicCode });
      break;
    case 'restaurant_sms':
      if (restaurant.managerPhone)
        send = () =>
          sendSms(
            restaurant.managerPhone,
            `Nouvelle vente carte cadeau ${data.amount}€ chez ${restaurant.name}. Commission: ${card.suppernoteCommissionAmount?.toNumber() ?? 0}€.`,
            {
              restaurantId: card.restaurantId,
              sourceType: 'gift_card_sale_manager_sms',
              sourceId: card.id,
              metadata: { messageType: 'gift_card_sale_manager_sms' },
            },
          );
      break;
    case 'contribution_email':
    case 'organizer_email': {
      const contribution = await prisma.giftCardContribution.findFirst({
        where: { id: delivery.referenceId ?? '', giftCardId: card.id },
      });
      if (!contribution) break;
      const common = {
        restaurantId: card.restaurantId,
        giftCardId: card.id,
        amount: contribution.amount.toNumber(),
        title: card.occasion ?? 'Cagnotte',
        recipientName: card.recipientName ?? '',
        restaurantName: restaurant.name,
        code: publicCode,
      };
      if (delivery.kind === 'contribution_email' && contribution.contributorEmail)
        send = () =>
          sendContributionConfirmation({
            ...common,
            to: contribution.contributorEmail!,
            contributorName: contribution.contributorName ?? '',
          });
      if (delivery.kind === 'organizer_email' && card.senderEmail)
        send = () =>
          sendCrowdfundingContributionNotification({
            ...common,
            to: card.senderEmail!,
            creatorName: card.senderName ?? '',
            contributorName: contribution.isPublicName
              ? (contribution.contributorName ?? '')
              : 'Anonyme',
          });
      break;
    }
    case 'closure_email':
      if (card.closedAt && card.recipientEmail)
        send = () =>
          sendCrowdfundingClosed({
            ...data,
            to: card.recipientEmail!,
            recipientName: card.recipientName ?? '',
            title: card.occasion ?? 'Cagnotte',
            totalCollected: data.amount,
            finalAmount: data.amount,
            commissionAmount: card.suppernoteCommissionAmount?.toNumber() ?? 0,
          });
      break;
    case 'refund_sender_email': {
      const requests = await prisma.giftCardRefundRequest.findMany({
        where: { id: delivery.referenceId ?? '', giftCardId: card.id, status: 'succeeded' },
      });
      const request = requests[0];
      if (!request) break;
      const contribution = await prisma.giftCardContribution.findFirst({
        where: { giftCardId: card.id, stripePaymentIntentId: request.paymentIntentId },
      });
      const order =
        !contribution && request.reason === 'REJECTED_CONTRIBUTION'
          ? (
              await prisma.giftCardCheckout.findMany({
                where: {
                  stripePaymentIntentId: request.paymentIntentId,
                  restaurantId: card.restaurantId,
                  kind: 'CONTRIBUTION',
                },
                take: 1,
              })
            )[0]
          : null;
      const payload = order?.payload as
        | { contributorEmail?: string; contributorName?: string }
        | undefined;
      const email =
        contribution?.contributorEmail ??
        payload?.contributorEmail ??
        (card.stripePaymentIntentId === request.paymentIntentId ? card.senderEmail : null);
      if (email)
        send = () =>
          sendRefundNotificationSender(
            {
              ...data,
              senderName:
                contribution?.contributorName ?? payload?.contributorName ?? card.senderName,
              senderEmail: email,
              restaurantEmail: restaurant.managerEmail,
              refundAmount: request.amountCents / 100,
            },
            true,
          );
      break;
    }
    case 'refund_restaurant_email': {
      const requests = await prisma.giftCardRefundRequest.findMany({
        where: { giftCardId: card.id, reason: 'CANCELLATION' },
      });
      if (
        restaurant.managerEmail &&
        requests.length &&
        requests.every((r) => r.status === 'succeeded')
      )
        send = () =>
          sendRefundNotificationRestaurant(
            {
              ...data,
              restaurantEmail: restaurant.managerEmail,
              refundAmount: requests.reduce((sum, r) => sum + r.amountCents, 0) / 100,
            },
            true,
          );
      break;
    }
    default:
      throw new Error('UNSUPPORTED_GIFT_CARD_DELIVERY');
  }
  if (!send) {
    await skip();
    return;
  }
  const claimed = await prisma.giftCardDelivery.updateMany({
    where: {
      id: delivery.id,
      restaurantId: delivery.restaurantId,
      status: { in: ['PENDING', 'FAILED'] },
    },
    data: { status: 'IN_PROGRESS', startedAt: new Date(), attempts: { increment: 1 } },
  });
  if (!claimed.count) return;
  const channel =
    delivery.channel === 'email' ? 'email' : delivery.channel === 'sms' ? 'sms' : 'whatsapp';
  let providerMessageId: string | undefined;
  try {
    const result = normalizeNotificationSendResult(
      await send(),
      channel === 'email' ? 'resend' : 'telnyx',
      channel,
    );
    providerMessageId = result.providerMessageId;
    await prisma.giftCardDelivery.update({
      where: { id: delivery.id, restaurantId: delivery.restaurantId },
      data: {
        status:
          result.outcome === 'success'
            ? 'SENT'
            : result.outcome === 'failure_certain'
              ? 'FAILED'
              : 'UNKNOWN',
        providerMessageId,
        sentAt: result.outcome === 'success' ? new Date() : null,
        lastErrorCode: result.outcome === 'success' ? null : 'PROVIDER_RESULT',
      },
    });
    if (result.outcome === 'failure_certain')
      throw Object.assign(new Error('GIFT_CARD_DELIVERY_REJECTED'), {
        notificationResult: 'failure_certain',
      });
  } catch (error) {
    const outcome = classifyNotificationError(error);
    await prisma.giftCardDelivery.update({
      where: { id: delivery.id, restaurantId: delivery.restaurantId },
      data: {
        status: outcome === 'failure_certain' ? 'FAILED' : 'UNKNOWN',
        providerMessageId: providerMessageId ?? getNotificationErrorProviderMessageId(error),
        lastErrorCode: outcome === 'failure_certain' ? 'PROVIDER_REJECTED' : 'PROVIDER_UNCERTAIN',
      },
    });
    // BullMQ may retry a certain rejection. A lost response never triggers another send.
    if (outcome === 'failure_certain') throw new Error('GIFT_CARD_DELIVERY_FAILED');
  }
}

export async function reconcileGiftCardDelivery(
  prisma: PrismaClient,
  deliveryId: string,
  restaurantId: string,
) {
  const delivery = await prisma.giftCardDelivery.findFirst({
    where: { id: deliveryId, restaurantId },
  });
  if (!delivery) return null;
  if (delivery.status !== 'UNKNOWN' || !delivery.providerMessageId) return delivery;
  const outcome =
    delivery.channel === 'email'
      ? await lookupResendEmail(delivery.providerMessageId)
      : await lookupTelnyxMessage(delivery.providerMessageId);
  if (outcome !== 'unknown')
    await prisma.giftCardDelivery.updateMany({
      where: { id: delivery.id, restaurantId: delivery.restaurantId, status: 'UNKNOWN' },
      data: {
        status: outcome === 'success' ? 'SENT' : 'FAILED',
        lastErrorCode: outcome === 'success' ? null : 'PROVIDER_REJECTED',
        sentAt: outcome === 'success' ? new Date() : null,
      },
    });
  return prisma.giftCardDelivery.findFirst({ where: { id: deliveryId, restaurantId } });
}

export async function recoverGiftCardDeliveries(prisma: PrismaClient) {
  // A worker can die after sending but before recording acceptance. Never resend this state.
  // tenant-scoping: global — Privileged recovery scheduler marks interrupted attempts UNKNOWN across restaurants; sends nothing.
  await prisma.giftCardDelivery.updateMany({
    where: { status: 'IN_PROGRESS', startedAt: { lt: new Date(Date.now() - 15 * 60 * 1000) } },
    data: { status: 'UNKNOWN', lastErrorCode: 'WORKER_INTERRUPTED' },
  });

  const cutoff = new Date(Date.now() - 15 * 60 * 1000);
  // tenant-scoping: global — Privileged recovery scheduler selects stalled outbox records across restaurants; requeue is scoped per persisted row.
  const rows = await prisma.giftCardDelivery.findMany({
    where: { status: 'PENDING', updatedAt: { lt: cutoff } },
    orderBy: { updatedAt: 'asc' },
    take: 50,
  });
  for (const row of rows)
    await prisma.$transaction(async (tx) => {
      const changed = await tx.giftCardDelivery.updateMany({
        where: {
          id: row.id,
          restaurantId: row.restaurantId,
          status: 'PENDING',
          updatedAt: { lt: cutoff },
        },
        data: { updatedAt: new Date() },
      });
      if (!changed.count) return;
      await enqueue(tx, {
        restaurantId: row.restaurantId,
        topic: 'gift-card-delivery',
        aggregateType: 'gift-card',
        aggregateId: row.giftCardId,
        eventType: row.kind,
        payload: { deliveryId: row.id },
        idempotencyKey: `gift-card-recovery:${row.id}:${row.updatedAt.toISOString()}`,
      });
    });
}
