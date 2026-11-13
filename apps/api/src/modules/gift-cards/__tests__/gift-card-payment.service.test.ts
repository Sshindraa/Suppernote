/**
 * Tests for the gift-card payment service.
 *
 * Le service orchestre : vérification Stripe → chargement restaurant →
 * calcul commission → création carte → notifications (email/WhatsApp/SMS).
 *
 * Les dépendances externes (Stripe, email, WhatsApp, SMS, Prisma) sont
 * mockées globalement par setup.ts. On surcharge les valeurs de retour
 * Prisma/Stripe au cas par cas via vi.mocked().
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { Prisma } from '@prisma/client';
import '../../../test/helpers.js';
import { db } from '../../../shared/db/client.js';
import { retrievePaymentIntent } from '../stripe.service.js';
import {
  GiftCardPaymentConflictError,
  GiftCardPaymentService,
  GiftCardPaymentError,
} from '../gift-card-payment.service.js';
import { logger } from '../../../shared/logger/pino.js';

// setup.ts mocke le client Telnyx avec un chemin relatif incorrect (../../ au
// lieu de ../) ; on re-mocke ici avec le bon chemin pour que sendSms soit un spy.
vi.mock('../../../shared/telnyx/client', () => ({
  default: { messages: { create: vi.fn().mockResolvedValue({}) } },
  sendSms: vi.fn().mockResolvedValue(undefined),
  sendWhatsApp: vi.fn().mockResolvedValue(undefined),
}));

import { sendSms } from '../../../shared/telnyx/client.js';

const RESTAURANT_ID = 'rest-pay-1';

function d(value: number) {
  return new Prisma.Decimal(value);
}

const service = new GiftCardPaymentService(db);

describe('GiftCardPaymentService', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    // Valeurs par défaut — surchargeables dans chaque test
    vi.mocked(retrievePaymentIntent).mockResolvedValue({
      id: 'pi_test',
      status: 'succeeded',
      amount: 10000,
      amountReceived: 10000,
      currency: 'eur',
      metadata: { restaurantId: RESTAURANT_ID, amount: '100', packId: '' },
    });
    vi.mocked(db.giftCard.findFirst).mockReset();
    vi.mocked(db.giftCard.findFirst).mockResolvedValue(null);
    vi.mocked(db.restaurant.findUnique).mockResolvedValue({
      id: RESTAURANT_ID,
      name: 'Chez Suppernote',
      giftCardCommissionRate: d(0.05),
      giftCardMinimumAmount: 10,
      managerEmail: 'manager@example.invalid',
      managerPhone: null,
    } as unknown as Awaited<ReturnType<typeof db.restaurant.findUnique>>);
    vi.mocked(db.giftCard.create).mockResolvedValue({
      id: 'gc-1',
      restaurantId: RESTAURANT_ID,
      code: 'abc-1234-5678-9012',
      shortCode: 'SKR-TEST-01',
      amount: d(100),
      remainingAmount: d(100),
      status: 'ACTIVE',
    } as unknown as Awaited<ReturnType<typeof db.giftCard.create>>);
  });

  describe('purchaseWithPayment', () => {
    it('crée une carte cadeau après paiement réussi', async () => {
      const card = await service.purchaseWithPayment({
        restaurantId: RESTAURANT_ID,
        paymentIntentId: 'pi_test',
        amount: 100,
        senderName: 'Bob',
        senderEmail: 'bob@example.com',
        recipientName: 'Alice',
        recipientEmail: 'alice@example.com',
      });

      expect(card.id).toBe('gc-1');
      expect(db.giftCard.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            restaurantId: RESTAURANT_ID,
            amount: expect.anything(),
            stripePaymentIntentId: 'pi_test',
            stripePaymentStatus: 'succeeded',
            sokarCommissionAmount: 5,
            createdBy: 'CLIENT',
          }),
        }),
      );
    });

    it("retourne erreur si le paiement n'est pas confirmé", async () => {
      vi.mocked(retrievePaymentIntent).mockResolvedValue({
        id: 'pi_test',
        status: 'requires_payment_method',
        amount: 10000,
        amountReceived: 0,
        currency: 'eur',
        metadata: { restaurantId: RESTAURANT_ID, amount: '100', packId: '' },
      });

      await expect(
        service.purchaseWithPayment({
          restaurantId: RESTAURANT_ID,
          paymentIntentId: 'pi_test',
          amount: 100,
        }),
      ).rejects.toThrow(GiftCardPaymentError);
    });

    it('retourne erreur si le restaurant est introuvable', async () => {
      vi.mocked(retrievePaymentIntent).mockResolvedValue({
        id: 'pi_test',
        status: 'succeeded',
        amount: 10000,
        amountReceived: 10000,
        currency: 'eur',
        metadata: { restaurantId: 'inexistant', amount: '100', packId: '' },
      });
      vi.mocked(db.restaurant.findUnique).mockResolvedValue(
        null as unknown as Awaited<ReturnType<typeof db.restaurant.findUnique>>,
      );

      await expect(
        service.purchaseWithPayment({
          restaurantId: 'inexistant',
          paymentIntentId: 'pi_test',
          amount: 100,
        }),
      ).rejects.toThrow('Restaurant introuvable');
    });

    it('retourne erreur si les metadata du montant sont manquantes', async () => {
      vi.mocked(retrievePaymentIntent).mockResolvedValue({
        id: 'pi_test',
        status: 'succeeded',
        amount: 10000,
        amountReceived: 10000,
        currency: 'eur',
        metadata: { restaurantId: RESTAURANT_ID, packId: '' },
      });
      await expect(
        service.purchaseWithPayment({
          restaurantId: RESTAURANT_ID,
          paymentIntentId: 'pi_test',
        }),
      ).rejects.toThrow('informations du montant');
    });

    it('retourne erreur si le montant est inférieur au minimum', async () => {
      vi.mocked(retrievePaymentIntent).mockResolvedValue({
        id: 'pi_test',
        status: 'succeeded',
        amount: 500,
        amountReceived: 500,
        currency: 'eur',
        metadata: { restaurantId: RESTAURANT_ID, amount: '5', packId: '' },
      });
      await expect(
        service.purchaseWithPayment({
          restaurantId: RESTAURANT_ID,
          paymentIntentId: 'pi_test',
          amount: 5,
        }),
      ).rejects.toThrow('Le montant minimum est de 10€');
    });

    it('utilise le montant du pack quand packId est fourni', async () => {
      vi.mocked(retrievePaymentIntent).mockResolvedValue({
        id: 'pi_test',
        status: 'succeeded',
        amount: 15000,
        amountReceived: 15000,
        currency: 'eur',
        metadata: { restaurantId: RESTAURANT_ID, amount: '', packId: 'pack-1' },
      });
      vi.mocked(db.giftCardPack.findFirst).mockResolvedValue({
        id: 'pack-1',
        restaurantId: RESTAURANT_ID,
        amount: d(150),
      } as unknown as Awaited<ReturnType<typeof db.giftCardPack.findFirst>>);

      const card = await service.purchaseWithPayment({
        restaurantId: RESTAURANT_ID,
        paymentIntentId: 'pi_test',
        packId: 'pack-1',
      });

      expect(card.id).toBe('gc-1');
      // commission = 150 * 0.05 = 7.5
      expect(db.giftCard.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            sokarCommissionAmount: 7.5,
            packId: 'pack-1',
          }),
        }),
      );
    });

    it('retourne erreur si le pack est introuvable', async () => {
      vi.mocked(retrievePaymentIntent).mockResolvedValue({
        id: 'pi_test',
        status: 'succeeded',
        amount: 15000,
        amountReceived: 15000,
        currency: 'eur',
        metadata: { restaurantId: RESTAURANT_ID, amount: '', packId: 'pack-inexistant' },
      });
      vi.mocked(db.giftCardPack.findFirst).mockResolvedValue(
        null as unknown as Awaited<ReturnType<typeof db.giftCardPack.findFirst>>,
      );

      await expect(
        service.purchaseWithPayment({
          restaurantId: RESTAURANT_ID,
          paymentIntentId: 'pi_test',
          packId: 'pack-inexistant',
        }),
      ).rejects.toThrow('Pack cadeau introuvable');
    });

    it('utilise le taux de commission par défaut (5%) si non défini', async () => {
      vi.mocked(db.restaurant.findUnique).mockResolvedValue({
        id: RESTAURANT_ID,
        name: 'Chez Suppernote',
        giftCardCommissionRate: null,
        giftCardMinimumAmount: 10,
        managerEmail: null,
        managerPhone: null,
      } as unknown as Awaited<ReturnType<typeof db.restaurant.findUnique>>);

      await service.purchaseWithPayment({
        restaurantId: RESTAURANT_ID,
        paymentIntentId: 'pi_test',
        amount: 100,
      });

      // commission = 100 * 0.05 (défaut) = 5
      expect(db.giftCard.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            sokarCommissionAmount: 5,
          }),
        }),
      );
    });

    it('persiste le SMS dans l’outbox au lieu de l’envoyer pendant le paiement', async () => {
      vi.mocked(db.restaurant.findUnique).mockResolvedValue({
        id: RESTAURANT_ID,
        name: 'Chez Suppernote',
        giftCardCommissionRate: d(0.05),
        giftCardMinimumAmount: 10,
        managerEmail: 'manager@example.invalid',
        managerPhone: '+33100000000',
      } as unknown as Awaited<ReturnType<typeof db.restaurant.findUnique>>);

      await service.purchaseWithPayment({
        restaurantId: RESTAURANT_ID,
        paymentIntentId: 'pi_test',
        amount: 100,
      });

      expect(sendSms).not.toHaveBeenCalled();
      expect(db.giftCardDelivery.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            kind: 'restaurant_sms',
            giftCardId: 'gc-1',
            restaurantId: RESTAURANT_ID,
          }),
        }),
      );
      expect(db.outboxEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            topic: 'gift-card-delivery',
            payload: { deliveryId: 'delivery-test' },
          }),
        }),
      );
    });

    it("n'envoie pas de SMS si managerPhone est null", async () => {
      await service.purchaseWithPayment({
        restaurantId: RESTAURANT_ID,
        paymentIntentId: 'pi_test',
        amount: 100,
      });

      expect(vi.mocked(sendSms)).not.toHaveBeenCalled();
    });

    it('refuse un montant différent de celui des metadata Stripe', async () => {
      await expect(
        service.purchaseWithPayment({
          restaurantId: RESTAURANT_ID,
          paymentIntentId: 'pi_test',
          amount: 101,
        }),
      ).rejects.toThrow('montant ne correspond pas');
      expect(db.giftCard.create).not.toHaveBeenCalled();
    });

    it('refuse un restaurant différent de celui des metadata Stripe', async () => {
      await expect(
        service.purchaseWithPayment({
          restaurantId: 'other-restaurant',
          paymentIntentId: 'pi_test',
          amount: 100,
        }),
      ).rejects.toThrow('restaurant ne correspond pas');
      expect(db.giftCard.create).not.toHaveBeenCalled();
    });

    it('refuse une devise autre que EUR', async () => {
      vi.mocked(retrievePaymentIntent).mockResolvedValue({
        id: 'pi_test',
        status: 'succeeded',
        amount: 10000,
        amountReceived: 10000,
        currency: 'usd',
        metadata: { restaurantId: RESTAURANT_ID, amount: '100', packId: '' },
      });

      await expect(
        service.purchaseWithPayment({
          restaurantId: RESTAURANT_ID,
          paymentIntentId: 'pi_test',
          amount: 100,
        }),
      ).rejects.toThrow('devise');
    });

    it('refuse un paiement reçu inférieur au montant Stripe', async () => {
      vi.mocked(retrievePaymentIntent).mockResolvedValue({
        id: 'pi_test',
        status: 'succeeded',
        amount: 10000,
        amountReceived: 9900,
        currency: 'eur',
        metadata: { restaurantId: RESTAURANT_ID, amount: '100', packId: '' },
      });

      await expect(
        service.purchaseWithPayment({
          restaurantId: RESTAURANT_ID,
          paymentIntentId: 'pi_test',
          amount: 100,
        }),
      ).rejects.toThrow('montant du paiement');
    });

    it('refuse le rejeu séquentiel du même PaymentIntent', async () => {
      vi.mocked(db.giftCard.findFirst).mockResolvedValue({
        id: 'gc-existing',
      } as unknown as Awaited<ReturnType<typeof db.giftCard.findFirst>>);

      await expect(
        service.purchaseWithPayment({
          restaurantId: RESTAURANT_ID,
          paymentIntentId: 'pi_test',
          amount: 100,
        }),
      ).rejects.toBeInstanceOf(GiftCardPaymentConflictError);
      expect(db.giftCard.create).not.toHaveBeenCalled();
    });
  });

  describe('handleStripeWebhook', () => {
    it('retourne la carte existante si déjà créée (idempotent)', async () => {
      vi.mocked(db.giftCard.findFirst).mockResolvedValue({
        id: 'gc-existing',
        stripePaymentIntentId: 'pi_test',
      } as unknown as Awaited<ReturnType<typeof db.giftCard.findFirst>>);

      const result = await service.handleStripeWebhook('pi_test', { restaurantId: RESTAURANT_ID });

      expect(result).not.toBeNull();
      expect(result?.id).toBe('gc-existing');
    });

    it('retourne null si les metadata ne contiennent pas restaurantId', async () => {
      vi.mocked(db.giftCard.findFirst).mockResolvedValue(
        null as unknown as Awaited<ReturnType<typeof db.giftCard.findFirst>>,
      );

      const result = await service.handleStripeWebhook('pi_test', {});

      expect(result).toBeNull();
    });

    it('retourne null si ni amount ni packId dans les metadata', async () => {
      vi.mocked(db.giftCard.findFirst).mockResolvedValue(
        null as unknown as Awaited<ReturnType<typeof db.giftCard.findFirst>>,
      );

      const result = await service.handleStripeWebhook('pi_test', { restaurantId: RESTAURANT_ID });

      expect(result).toBeNull();
    });

    it("reconstruit l'achat depuis les metadata et crée la carte", async () => {
      vi.mocked(db.giftCard.findFirst).mockResolvedValue(
        null as unknown as Awaited<ReturnType<typeof db.giftCard.findFirst>>,
      );

      const result = await service.handleStripeWebhook('pi_test', {
        restaurantId: RESTAURANT_ID,
        amount: '100',
        senderName: 'Bob',
        recipientName: 'Alice',
      });

      expect(result).not.toBeNull();
      expect(result?.id).toBe('gc-1');
      expect(db.giftCard.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            restaurantId: RESTAURANT_ID,
            senderName: 'Bob',
            recipientName: 'Alice',
          }),
        }),
      );
    });
  });

  describe('handlePaymentFailed', () => {
    it("met à jour le statut Stripe d'une carte existante en 'failed'", async () => {
      vi.mocked(db.giftCard.findFirst).mockResolvedValue({
        id: 'gc-failed',
        stripePaymentIntentId: 'pi_failed',
        stripePaymentStatus: 'pending',
        status: 'ACTIVE',
      } as unknown as Awaited<ReturnType<typeof db.giftCard.findFirst>>);
      vi.mocked(db.giftCard.update).mockResolvedValue({
        id: 'gc-failed',
        stripePaymentStatus: 'failed',
      } as unknown as Awaited<ReturnType<typeof db.giftCard.update>>);

      await service.handlePaymentFailed('pi_failed', { restaurantId: RESTAURANT_ID });

      expect(db.giftCard.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'gc-failed' },
          data: { stripePaymentStatus: 'failed' },
        }),
      );
    });

    it("ne fait rien si aucune carte n'existe pour ce PaymentIntent", async () => {
      vi.mocked(db.giftCard.findFirst).mockResolvedValue(
        null as unknown as Awaited<ReturnType<typeof db.giftCard.findFirst>>,
      );

      await service.handlePaymentFailed('pi_unknown', { restaurantId: RESTAURANT_ID });

      expect(db.giftCard.update).not.toHaveBeenCalled();
    });

    it('ne met pas à jour une carte déjà dans un statut Stripe terminal', async () => {
      vi.mocked(db.giftCard.findFirst).mockResolvedValue({
        id: 'gc-terminal',
        stripePaymentIntentId: 'pi_failed',
        stripePaymentStatus: 'succeeded',
        status: 'ACTIVE',
      } as unknown as Awaited<ReturnType<typeof db.giftCard.findFirst>>);

      await service.handlePaymentFailed('pi_failed');

      expect(db.giftCard.update).not.toHaveBeenCalled();
    });

    it('masque les métadonnées PII mais conserve les autres clés dans les logs', async () => {
      const infoSpy = vi.spyOn(logger, 'info');
      vi.mocked(db.giftCard.findFirst).mockResolvedValue(
        null as unknown as Awaited<ReturnType<typeof db.giftCard.findFirst>>,
      );

      await service.handlePaymentFailed('pi_pii', {
        restaurantId: RESTAURANT_ID,
        senderEmail: 'bob@example.com',
        recipientEmail: 'alice@example.com',
        senderPhone: '+33600000000',
        senderName: 'Bob',
        extraKey: 'should be preserved',
      });

      expect(infoSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: expect.objectContaining({
            senderEmail: '[REDACTED]',
            recipientEmail: '[REDACTED]',
            senderPhone: '[REDACTED]',
            senderName: '[REDACTED]',
            extraKey: 'should be preserved',
            restaurantId: RESTAURANT_ID,
          }),
          metadataKeys: expect.arrayContaining([
            'senderEmail',
            'recipientEmail',
            'senderPhone',
            'senderName',
            'extraKey',
            'restaurantId',
          ]),
        }),
        '[gift-card-payment] Payment failed webhook received',
      );

      infoSpy.mockRestore();
    });
  });
});
