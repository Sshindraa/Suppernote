import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import Stripe from 'stripe';
import { getApp, closeApp } from '../../../test/helpers';
import { db } from '../../../shared/db/client';

vi.unmock('stripe');

const url = process.env.MANAGED_CONNECT_TEST_DATABASE_URL;
const secret = process.env.MANAGED_CONNECT_STRIPE_TEST_SECRET_KEY;
const publicKey = process.env.MANAGED_CONNECT_STRIPE_TEST_PUBLISHABLE_KEY;
if (url) {
  const target = new URL(url);
  if (
    !['localhost', '127.0.0.1'].includes(target.hostname) ||
    target.pathname !== '/sokar_stripe_managed_test'
  )
    throw new Error('Managed Connect tests require their dedicated local database');
}
if ((secret && !secret.startsWith('sk_test_')) || (publicKey && !publicKey.startsWith('pk_test_')))
  throw new Error('Managed Connect tests require Stripe test keys');

describe.skipIf(!url || !secret || !publicKey)(
  'managed Connect with PostgreSQL and Stripe sandbox',
  () => {
    const restaurantId = `managed-${randomUUID()}`;
    const opts = { apiVersion: '2026-08-26.dahlia' };
    let prisma: PrismaClient;
    let stripe: Stripe;

    beforeAll(async () => {
      process.env.STRIPE_SECRET_KEY = secret!;
      process.env.STRIPE_PUBLISHABLE_KEY = publicKey!;
      process.env.STRIPE_MANAGED_CONNECT_TEST_ENABLED = 'true';
      process.env.STRIPE_MANAGED_CONNECT_TEST_RESTAURANTS = restaurantId;
      stripe = new Stripe(secret!);
      const actual = await vi.importActual<typeof import('@prisma/client')>('@prisma/client');
      prisma = new actual.PrismaClient({ datasources: { db: { url: url! } } });
      await prisma.restaurant.create({
        data: {
          id: restaurantId,
          name: 'Test',
          managerPhone: '',
          managerEmail: '',
          phoneNumber: restaurantId,
          openingHours: {},
        },
      });
      vi.mocked(db.$transaction).mockImplementation(((
        fn: Parameters<PrismaClient['$transaction']>[0],
        options: object,
      ) => prisma.$transaction(fn as never, options)) as never);
    });

    afterAll(async () => {
      if (prisma) {
        const restaurant = await prisma.restaurant.findUnique({ where: { id: restaurantId } });
        const id =
          restaurant?.giftCardStripeAccountId ?? restaurant?.giftCardStripePendingAccountId;
        if (id) {
          const account = (await stripe.rawRequest(
            'GET',
            `/v2/core/accounts/${id}`,
            undefined,
            opts,
          )) as unknown as {
            livemode: boolean;
            metadata?: Record<string, string>;
            applied_configurations: string[];
          };
          if (
            account.livemode !== false ||
            account.metadata?.restaurantId !== restaurantId ||
            !['suppernote_managed_test', 'sokar_managed_test'].includes(
              account.metadata?.source ?? '',
            )
          )
            throw new Error('Refusing to close an unrelated account');
          await stripe.rawRequest(
            'POST',
            `/v2/core/accounts/${id}/close`,
            { applied_configurations: account.applied_configurations },
            opts,
          );
        }
        await prisma.restaurant.deleteMany({ where: { id: restaurantId } });
        await prisma.$disconnect();
      }
      await closeApp();
    });

    it('creates the account and embedded session, then resumes the same account', async () => {
      const token = (await new Stripe(publicKey!).rawRequest(
        'POST',
        '/v2/core/account_tokens',
        {
          identity: {
            attestations: { terms_of_service: { account: { shown_and_accepted: true } } },
          },
        },
        opts,
      )) as unknown as { id: string; livemode: boolean };
      expect(token.livemode).toBe(false);
      const app = await getApp();
      const request = () =>
        app.inject({
          method: 'POST',
          url: `/restaurants/${restaurantId}/gift-cards/stripe-connect/managed-test`,
          headers: { authorization: 'Bearer fake-token', 'x-test-restaurant-id': restaurantId },
          payload: { accountToken: token.id },
        });
      const first = await request();
      expect(first.statusCode).toBe(200);
      expect(first.json().clientSecret).toBeTruthy();
      const accountId = (await prisma.restaurant.findUniqueOrThrow({ where: { id: restaurantId } }))
        .giftCardStripeAccountId;
      expect(accountId).toBeTruthy();
      const second = await request();
      expect(second.statusCode).toBe(200);
      expect(
        (await prisma.restaurant.findUniqueOrThrow({ where: { id: restaurantId } }))
          .giftCardStripeAccountId,
      ).toBe(accountId);
    });
  },
);
