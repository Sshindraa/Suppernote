import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ReservationPaymentStatus, ReservationPaymentType } from '@prisma/client';
import { db } from '../../shared/db/client';
import { requireOrg, requireSokarOperator } from '../../plugins/clerk';
import { requireCapability } from '../entitlements/entitlement.guard';
import {
  PAYMENT_AMOUNT_MODES,
  ReservationPaymentInputError,
  ReservationPaymentNotFoundError,
  ReservationPaymentPolicyNotFoundError,
  ReservationPaymentReservationNotFoundError,
  ReservationPaymentStateError,
  captureCardGuarantee,
  createReservationPaymentPolicy,
  expireReservationPayments,
  getReservationPayment,
  listReservationPaymentPolicies,
  prepareReservationPayment,
  refundCardGuarantee,
  transitionReservationPayment,
} from './reservation-payment.service';

const PolicyBodySchema = z.object({
  type: z.nativeEnum(ReservationPaymentType),
  amountMode: z.enum(PAYMENT_AMOUNT_MODES),
  amount: z.union([z.string().trim(), z.number().finite()]),
  minPartySize: z.number().int().min(1).max(100).nullable().optional(),
  cancellationHours: z.number().int().min(0).max(720).optional(),
  rules: z.record(z.string(), z.unknown()).optional(),
  activeFrom: z.coerce.date().optional(),
  activeUntil: z.coerce.date().nullable().optional(),
  version: z.number().int().min(1).max(10_000).optional(),
});

const PrepareBodySchema = z.object({
  policyId: z.string().trim().min(1).max(128).optional(),
  idempotencyKey: z.string().trim().min(8).max(200),
  currency: z.string().trim().length(3).optional(),
  expiresAt: z.coerce.date().optional(),
  dryRun: z.boolean().default(true),
});

const ReservationParamsSchema = z.object({
  id: z.string().trim().min(1).max(128),
});

const PaymentParamsSchema = z.object({
  paymentId: z.string().trim().min(1).max(128),
});

const MoneyBodySchema = z.object({
  amount: z.union([z.string().trim(), z.number().finite()]).optional(),
});

function reservationPaymentsEnabled(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environment.RESERVATION_PAYMENTS_ENABLED === 'true';
}

async function requireReservationPaymentFeature(
  _request: FastifyRequest,
  reply: FastifyReply,
): Promise<void | FastifyReply> {
  if (reservationPaymentsEnabled()) return;
  return reply.status(503).send({
    error: 'RESERVATION_PAYMENTS_DISABLED',
    message: 'La protection bancaire reste désactivée jusqu’à la validation du pilote.',
  });
}

async function requirePaymentReadRole(
  request: { siteRole?: string },
  reply: FastifyReply,
): Promise<void | FastifyReply> {
  if (
    request.siteRole === 'OWNER' ||
    request.siteRole === 'MANAGER' ||
    request.siteRole === 'STAFF'
  ) {
    return;
  }
  return reply.status(403).send({
    error: 'PAYMENT_ROLE_REQUIRED',
    message: 'La lecture de l’état de paiement est réservée à l’équipe du site.',
  });
}

async function requirePaymentWriteRole(
  request: { siteRole?: string },
  reply: FastifyReply,
): Promise<void | FastifyReply> {
  if (request.siteRole === 'OWNER' || request.siteRole === 'MANAGER') return;
  return reply.status(403).send({
    error: 'PAYMENT_ROLE_REQUIRED',
    message: 'La configuration des paiements est réservée aux responsables.',
  });
}

function sendPaymentError(error: unknown, reply: FastifyReply): FastifyReply | undefined {
  if (
    error instanceof ReservationPaymentPolicyNotFoundError ||
    error instanceof ReservationPaymentReservationNotFoundError ||
    error instanceof ReservationPaymentNotFoundError
  ) {
    return reply.status(404).send({ error: error.code });
  }
  if (error instanceof ReservationPaymentStateError) {
    return reply.status(409).send({ error: error.code, message: error.message });
  }
  if (error instanceof ReservationPaymentInputError) {
    return reply.status(400).send({ error: error.code, message: error.message });
  }
  return undefined;
}

/** Routes de l'empreinte bancaire. Les événements Stripe arrivent par `/webhooks/stripe`
 * (voir `reservation-payment.webhook.ts`) ; prélever et rembourser restent des gestes de
 * responsable, confirmés ensuite par le webhook. */
export async function reservationPaymentRoutes(app: FastifyInstance): Promise<void> {
  const paymentRead = [
    requireOrg(),
    requireCapability('reservations.payments'),
    requirePaymentReadRole,
    requireReservationPaymentFeature,
  ];
  const paymentWrite = [
    requireOrg(),
    requireCapability('reservations.payments'),
    requirePaymentWriteRole,
    requireReservationPaymentFeature,
  ];

  app.get('/reservation-payment-policies', { preHandler: paymentRead }, async (request, reply) => {
    return reply.send({ data: await listReservationPaymentPolicies(request.restaurantId) });
  });

  app.post(
    '/reservation-payment-policies',
    { preHandler: paymentWrite },
    async (request, reply) => {
      const body = PolicyBodySchema.parse(request.body);
      try {
        const policy = await createReservationPaymentPolicy({
          restaurantId: request.restaurantId,
          ...body,
        });
        return reply.status(201).send({ data: policy });
      } catch (error) {
        return sendPaymentError(error, reply) ?? Promise.reject(error);
      }
    },
  );

  app.get('/reservations/:id/payment', { preHandler: paymentRead }, async (request, reply) => {
    const { id } = ReservationParamsSchema.parse(request.params);
    return reply.send({
      data: await getReservationPayment(request.restaurantId, id),
    });
  });

  app.post(
    '/reservations/:id/payment/prepare',
    { preHandler: paymentWrite },
    async (request, reply) => {
      const { id } = ReservationParamsSchema.parse(request.params);
      const body = PrepareBodySchema.parse(request.body);
      try {
        const result = await prepareReservationPayment({
          restaurantId: request.restaurantId,
          reservationId: id,
          ...body,
        });
        return reply.status(body.dryRun ? 200 : 201).send({ data: result });
      } catch (error) {
        return sendPaymentError(error, reply) ?? Promise.reject(error);
      }
    },
  );

  app.post(
    '/reservations/:id/payment/expire',
    { preHandler: paymentWrite },
    async (request, reply) => {
      const { id } = ReservationParamsSchema.parse(request.params);
      try {
        const current = await getReservationPayment(request.restaurantId, id);
        if (!current) throw new ReservationPaymentNotFoundError();
        const result = await transitionReservationPayment({
          restaurantId: request.restaurantId,
          paymentId: current.id,
          to: ReservationPaymentStatus.EXPIRED,
        });
        return reply.send({ data: result });
      } catch (error) {
        return sendPaymentError(error, reply) ?? Promise.reject(error);
      }
    },
  );

  /** Operator-only maintenance endpoint used by the scheduled cleanup job.
   * It is intentionally tenant-agnostic and returns only a count. */
  app.post(
    '/api/internal/reservation-payments/expire',
    { preHandler: requireSokarOperator() },
    async (_request, reply) => {
      if (!reservationPaymentsEnabled()) {
        return reply.status(503).send({ error: 'RESERVATION_PAYMENTS_DISABLED' });
      }
      return reply.send({ expiredCount: await expireReservationPayments() });
    },
  );

  app.post(
    '/reservations/:id/payment/capture',
    { preHandler: paymentWrite },
    async (request, reply) => {
      const { id } = ReservationParamsSchema.parse(request.params);
      const body = MoneyBodySchema.parse(request.body ?? {});
      try {
        const result = await captureCardGuarantee({
          restaurantId: request.restaurantId,
          reservationId: id,
          actorUserId: request.userId ?? 'unknown',
          ...(body.amount !== undefined ? { amount: body.amount } : {}),
        });
        return reply.status(result.outcome === 'DECLINED' ? 402 : 202).send({ data: result });
      } catch (error) {
        return sendPaymentError(error, reply) ?? Promise.reject(error);
      }
    },
  );

  app.post(
    '/reservations/:id/payment/refund',
    { preHandler: paymentWrite },
    async (request, reply) => {
      const { id } = ReservationParamsSchema.parse(request.params);
      const body = MoneyBodySchema.parse(request.body ?? {});
      try {
        const result = await refundCardGuarantee({
          restaurantId: request.restaurantId,
          reservationId: id,
          ...(body.amount !== undefined ? { amount: body.amount } : {}),
        });
        return reply.status(202).send({ data: result });
      } catch (error) {
        return sendPaymentError(error, reply) ?? Promise.reject(error);
      }
    },
  );

  app.get(
    '/reservation-payments/:paymentId',
    { preHandler: paymentRead },
    async (request, reply) => {
      const { paymentId } = PaymentParamsSchema.parse(request.params);
      try {
        const payment = await db.reservationPayment.findFirst({
          where: { id: paymentId, restaurantId: request.restaurantId },
          select: { id: true, reservationId: true },
        });
        if (!payment) throw new ReservationPaymentNotFoundError();
        const result = await getReservationPayment(request.restaurantId, payment.reservationId);
        return reply.send({ data: result });
      } catch (error) {
        return sendPaymentError(error, reply) ?? Promise.reject(error);
      }
    },
  );
}

export { reservationPaymentsEnabled };
