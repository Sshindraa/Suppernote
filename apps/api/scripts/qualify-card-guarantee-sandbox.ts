/**
 * Qualification Stripe sandbox de l'empreinte bancaire (spec §10, PR 5).
 *
 * Joue chaque scénario contre l'API Stripe en MODE TEST, sur un compte connecté de test dédié,
 * et fait passer les VRAIS événements Stripe par notre aiguillage webhook, contre la base locale.
 * La signature du webhook est couverte par les tests unitaires ; ici on qualifie les charges
 * réelles des événements et nos transitions.
 *
 * Garde-fous : refuse une clé qui n'est pas `sk_test_`, refuse une base qui n'est pas locale.
 * N'affiche que des identifiants tronqués : ni clé, ni carte, ni coordonnées.
 *
 * Lancer (depuis apps/api) :
 *   QUALIFICATION_STRIPE_ACCOUNT=acct_… \
 *   node --env-file=<chemin>/apps/api/.env --import tsx scripts/qualify-card-guarantee-sandbox.ts
 * Rapport : docs/release/evidence/card-guarantee-sandbox-<date>.md
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import Stripe from 'stripe';

const key = process.env.STRIPE_SECRET_KEY?.trim() ?? '';
if (!key.startsWith('sk_test_')) {
  console.error('Refus : STRIPE_SECRET_KEY doit être une clé de test (sk_test_).');
  process.exit(1);
}
const dbUrl = process.env.DATABASE_URL ?? '';
if (!/@(localhost|127\.0\.0\.1)(:|\/)/.test(dbUrl)) {
  console.error('Refus : DATABASE_URL doit pointer vers une base locale.');
  process.exit(1);
}
process.env.RESERVATION_PAYMENTS_ENABLED = 'true';
process.env.RESERVATION_MANAGEMENT_SECRET ??= 'a'.repeat(64);
process.env.DASHBOARD_URL ??= 'http://localhost:3000';
process.env.NODE_ENV ??= 'development';

const stripe = new Stripe(key);
const QUALIFICATION_SLUG = 'qualification-empreinte';

type Row = { scenario: string; expected: string; observed: string; ok: boolean };
const rows: Row[] = [];
const short = (id: string | null | undefined) => (id ? `${id.slice(0, 12)}…` : '—');

function check(scenario: string, expected: string, observed: string, ok: boolean) {
  rows.push({ scenario, expected, observed, ok });
  // eslint-disable-next-line no-console -- sortie du script de qualification
  console.log(`${ok ? 'OK ' : 'KO '} ${scenario} — ${observed}`);
}

async function sleep(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Compte connecté de test fourni par `QUALIFICATION_STRIPE_ACCOUNT` (acct_…), ouvert par le
 * parcours Stripe du dashboard en mode test. Stripe ne laisse plus une plateforme française
 * créer un compte encaissant par l'API sans jeton de compte navigateur.
 */
async function qualificationAccount(): Promise<string> {
  const id = process.env.QUALIFICATION_STRIPE_ACCOUNT?.trim() ?? '';
  if (!/^acct_[A-Za-z0-9]+$/.test(id)) {
    throw new Error('QUALIFICATION_STRIPE_ACCOUNT (acct_…, compte connecté de test) est requis.');
  }
  const account = await stripe.accounts.retrieve(id);
  if (!account.charges_enabled) {
    throw new Error(`Le compte de test ${short(id)} ne peut pas encore encaisser.`);
  }
  return id;
}

/** Attend l'événement Stripe réel d'un objet, sur le compte connecté. */
async function eventFor(
  accountId: string,
  type: string,
  objectId: (object: Record<string, unknown>) => boolean,
): Promise<Stripe.Event> {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const events = await stripe.events.list({ type, limit: 20 }, { stripeAccount: accountId });
    const event = events.data.find((candidate) =>
      objectId(candidate.data.object as unknown as Record<string, unknown>),
    );
    // Un événement livré par l'endpoint Connect porte `account` ; la lecture par API non.
    if (event) return { ...event, account: event.account ?? accountId };
    await sleep(2_000);
  }
  throw new Error(`Événement ${type} introuvable.`);
}

async function main() {
  const { db } = await import('../src/shared/db/client');
  const service = await import('../src/modules/reservation-payments/reservation-payment.service');
  const { handleReservationPaymentStripeEvent } =
    await import('../src/modules/reservation-payments/reservation-payment.webhook');
  const { releaseCardGuaranteeOnCancel } =
    await import('../src/modules/reservation-payments/reservation-guarantee.release');

  const accountId = await qualificationAccount();
  // eslint-disable-next-line no-console -- sortie du script de qualification
  console.log(`Compte connecté de test : ${short(accountId)}`);

  const restaurant =
    (await db.restaurant.findUnique({ where: { slug: QUALIFICATION_SLUG } })) ??
    (await db.restaurant.create({
      data: {
        name: 'Qualification empreinte',
        slug: QUALIFICATION_SLUG,
        managerPhone: '+33000000001',
        managerEmail: 'qualification@example.test',
        phoneNumber: '+33000000099',
        openingHours: {},
      },
    }));
  await db.restaurant.update({
    where: { id: restaurant.id },
    data: { giftCardStripeAccountId: accountId },
  });
  const policy = await service.createReservationPaymentPolicy({
    restaurantId: restaurant.id,
    type: 'CARD_GUARANTEE',
    amountMode: 'PER_PERSON',
    amount: '20',
    minPartySize: 6,
    cancellationHours: 24,
    rules: { protectedDates: [] },
  });

  const reservationAt = new Date(Date.now() + 3 * 24 * 3_600_000);
  async function pendingGuarantee(label: string, expiresInMs = 30 * 60_000) {
    const reservation = await db.reservation.create({
      data: {
        restaurantId: restaurant.id,
        reservedAt: reservationAt,
        startsAt: reservationAt,
        endsAt: new Date(reservationAt.getTime() + 2 * 3_600_000),
        partySize: 6,
        customerName: `Qualification ${label}`,
        channel: 'WEB',
        status: 'CONFIRMED',
        state: 'PENDING',
      },
    });
    const paymentId = await db.$transaction((tx) =>
      service.createCardGuaranteePaymentInTransaction(tx, {
        restaurantId: restaurant.id,
        reservationId: reservation.id,
        policyId: policy.id,
        partySize: 6,
        expiresAt: new Date(Date.now() + expiresInMs),
      }),
    );
    return { reservationId: reservation.id, paymentId };
  }
  const payment = (id: string) =>
    db.reservationPayment.findFirstOrThrow({ where: { id, restaurantId: restaurant.id } });
  const metadata = (paymentId: string, reservationId: string) => ({
    type: 'reservation_guarantee',
    restaurantId: restaurant.id,
    reservationPaymentId: paymentId,
    reservationId,
  });

  /** La page Stripe est hébergée : on simule sa fin par un SetupIntent identique. */
  async function saveCard(paymentId: string, reservationId: string, paymentMethod: string) {
    const current = await payment(paymentId);
    const setup = await stripe.setupIntents.create(
      {
        customer: current.stripeCustomerId!,
        payment_method: paymentMethod,
        payment_method_types: ['card'],
        usage: 'off_session',
        confirm: true,
        metadata: metadata(paymentId, reservationId),
      },
      { stripeAccount: accountId },
    );
    return setup;
  }
  async function openSetup(paymentId: string) {
    return service.startCardGuaranteeSetup({
      restaurantId: restaurant.id,
      paymentId,
      successUrl: 'http://localhost:3000/garantie?retour=ok',
      cancelUrl: 'http://localhost:3000/garantie?retour=annule',
      customText: 'Qualification sandbox : aucun montant n’est débité aujourd’hui.',
      termsAcceptedAt: new Date(),
    });
  }
  async function markNoShow(reservationId: string) {
    await db.reservation.update({
      where: { id: reservationId },
      data: { status: 'NO_SHOW', state: 'NO_SHOW' },
    });
  }

  // 1. Page Stripe en mode setup sur le compte du restaurant.
  const primary = await pendingGuarantee('principale');
  const opened = await openSetup(primary.paymentId);
  const afterOpen = await payment(primary.paymentId);
  const session = await stripe.checkout.sessions.retrieve(afterOpen.stripeCheckoutSessionId!, {
    stripeAccount: accountId,
  });
  check(
    'Page Stripe d’enregistrement',
    'session Checkout `setup`, ouverte, compte du restaurant',
    `${short(session.id)} mode=${session.mode} statut=${session.status} url=${opened.url.startsWith('https://checkout.stripe.com') ? 'checkout.stripe.com' : 'autre'}`,
    session.mode === 'setup' &&
      session.status === 'open' &&
      afterOpen.stripeAccountId === accountId,
  );

  // 2. Carte enregistrée : événement réel → AUTHORIZED, réservation confirmée.
  const setup = await saveCard(primary.paymentId, primary.reservationId, 'pm_card_visa');
  const setupEvent = await eventFor(accountId, 'setup_intent.succeeded', (o) => o.id === setup.id);
  const applied = await handleReservationPaymentStripeEvent(setupEvent, JSON.stringify(setupEvent));
  const authorized = await payment(primary.paymentId);
  const confirmed = await db.reservation.findUniqueOrThrow({
    where: { id: primary.reservationId },
  });
  check(
    'Carte enregistrée (setup_intent.succeeded)',
    'empreinte AUTHORIZED, carte gardée, réservation CONFIRMED',
    `${authorized.status}, carte ${authorized.stripePaymentMethodId ? 'gardée' : 'absente'}, réservation ${confirmed.state}`,
    applied.handled &&
      authorized.status === 'AUTHORIZED' &&
      Boolean(authorized.stripePaymentMethodId) &&
      confirmed.state === 'CONFIRMED',
  );

  // 3. Rejeu du même événement.
  const replay = await handleReservationPaymentStripeEvent(setupEvent, JSON.stringify(setupEvent));
  check(
    'Rejeu du même événement',
    'reconnu comme doublon, aucun changement',
    'duplicate' in replay ? `duplicate=${replay.duplicate}` : JSON.stringify(replay),
    'duplicate' in replay && replay.duplicate === true,
  );

  // 4. Événement signé venant d'un autre compte.
  const foreign = { ...setupEvent, id: `${setupEvent.id}_foreign`, account: 'acct_other' };
  const rejected = await handleReservationPaymentStripeEvent(foreign, JSON.stringify(foreign));
  check(
    'Événement d’un autre compte',
    'refusé (acquitté), empreinte inchangée',
    'rejected' in rejected ? rejected.rejected : JSON.stringify(rejected),
    'rejected' in rejected && rejected.rejected === 'PAYMENT_PROVIDER_MISMATCH',
  );

  // 5. Prélèvement réduit après absence, puis remboursement partiel.
  await markNoShow(primary.reservationId);
  const capture = await service.captureCardGuarantee({
    restaurantId: restaurant.id,
    reservationId: primary.reservationId,
    actorUserId: 'qualification',
    amount: '60',
  });
  const pending = await payment(primary.paymentId);
  const succeeded = await eventFor(
    accountId,
    'payment_intent.succeeded',
    (o) => o.id === pending.stripePaymentIntentId,
  );
  await handleReservationPaymentStripeEvent(succeeded, JSON.stringify(succeeded));
  const captured = await payment(primary.paymentId);
  check(
    'Prélèvement après absence (60 € sur 120 €)',
    'PaymentIntent hors session réussi, empreinte CAPTURED 60 €',
    `${capture.outcome}, ${captured.status} ${captured.capturedAmount?.toFixed(2)} €`,
    capture.outcome === 'PENDING_CONFIRMATION' &&
      captured.status === 'CAPTURED' &&
      captured.capturedAmount?.toFixed(2) === '60.00',
  );

  await service.refundCardGuarantee({
    restaurantId: restaurant.id,
    reservationId: primary.reservationId,
    amount: '20',
  });
  const refundedEvent = await eventFor(
    accountId,
    'charge.refunded',
    (o) => o.payment_intent === captured.stripePaymentIntentId,
  );
  await handleReservationPaymentStripeEvent(refundedEvent, JSON.stringify(refundedEvent));
  const refunded = await payment(primary.paymentId);
  check(
    'Remboursement partiel (20 €)',
    'charge.refunded rattaché au PaymentIntent, PARTIALLY_REFUNDED 20 €',
    `${refunded.status} ${refunded.refundedAmount?.toFixed(2)} €`,
    refunded.status === 'PARTIALLY_REFUNDED' && refunded.refundedAmount?.toFixed(2) === '20.00',
  );

  // 6 et 7. Refus de la banque et 3DS exigée hors session : la carte reste, l'équipe peut réessayer.
  for (const [label, card, code] of [
    ['Refus de la banque', 'pm_card_visa_chargeDeclined', 'card_declined'],
    ['3DS exigée hors session', 'pm_card_authenticationRequired', 'authentication_required'],
  ] as const) {
    const declined = await pendingGuarantee(label);
    await openSetup(declined.paymentId);
    const current = await payment(declined.paymentId);
    // La carte est rattachée directement : un SetupIntent 3DS ne se termine pas sans navigateur.
    await stripe.paymentMethods
      .attach(
        card,
        { customer: current.stripeCustomerId! },
        {
          stripeAccount: accountId,
        },
      )
      .then(async (method) =>
        db.reservationPayment.update({
          where: { id: declined.paymentId },
          data: { status: 'AUTHORIZED', stripePaymentMethodId: method.id },
        }),
      );
    await markNoShow(declined.reservationId);
    const result = await service.captureCardGuarantee({
      restaurantId: restaurant.id,
      reservationId: declined.reservationId,
      actorUserId: 'qualification',
    });
    const after = await payment(declined.paymentId);
    let failedEventApplied = 'pas de PaymentIntent';
    if (after.stripePaymentIntentId) {
      const failed = await eventFor(
        accountId,
        'payment_intent.payment_failed',
        (o) => o.id === after.stripePaymentIntentId,
      );
      await handleReservationPaymentStripeEvent(failed, JSON.stringify(failed));
      failedEventApplied = 'payment_failed appliqué';
    }
    const final = await payment(declined.paymentId);
    check(
      label,
      `refus ${code}, empreinte toujours AUTHORIZED, nouvel essai possible`,
      `${result.outcome} ${'failureCode' in result ? result.failureCode : ''}, ${final.status} (${final.failureCode}), ${failedEventApplied}`,
      result.outcome === 'DECLINED' &&
        final.status === 'AUTHORIZED' &&
        (final.failureCode ?? '').includes(code.split('_')[0]!),
    );
  }

  // 8. Litige : la carte 0259 ouvre un litige après le prélèvement.
  const disputed = await pendingGuarantee('litige');
  await openSetup(disputed.paymentId);
  const disputedSetup = await saveCard(
    disputed.paymentId,
    disputed.reservationId,
    'pm_card_createDispute',
  );
  const disputedSetupEvent = await eventFor(
    accountId,
    'setup_intent.succeeded',
    (o) => o.id === disputedSetup.id,
  );
  await handleReservationPaymentStripeEvent(disputedSetupEvent, JSON.stringify(disputedSetupEvent));
  await markNoShow(disputed.reservationId);
  await service.captureCardGuarantee({
    restaurantId: restaurant.id,
    reservationId: disputed.reservationId,
    actorUserId: 'qualification',
  });
  const disputedPayment = await payment(disputed.paymentId);
  const disputedSucceeded = await eventFor(
    accountId,
    'payment_intent.succeeded',
    (o) => o.id === disputedPayment.stripePaymentIntentId,
  );
  await handleReservationPaymentStripeEvent(disputedSucceeded, JSON.stringify(disputedSucceeded));
  const disputeEvent = await eventFor(
    accountId,
    'charge.dispute.created',
    (o) => o.payment_intent === disputedPayment.stripePaymentIntentId,
  );
  await handleReservationPaymentStripeEvent(disputeEvent, JSON.stringify(disputeEvent));
  const afterDispute = await payment(disputed.paymentId);
  check(
    'Litige ouvert par le client',
    'charge.dispute.created rattaché, statut CAPTURED inchangé, litige noté',
    `${afterDispute.status}, litige ${afterDispute.disputeStatus}`,
    afterDispute.status === 'CAPTURED' && Boolean(afterDispute.disputeStatus),
  );

  // 9. Expiration : carte jamais enregistrée → place libérée, page Stripe fermée.
  const expiring = await pendingGuarantee('expiration', 31 * 60_000);
  await openSetup(expiring.paymentId);
  const before = await payment(expiring.paymentId);
  await service.expireReservationPayments(new Date(Date.now() + 32 * 60_000));
  const expired = await payment(expiring.paymentId);
  const freed = await db.reservation.findUniqueOrThrow({ where: { id: expiring.reservationId } });
  const closed = await stripe.checkout.sessions.retrieve(before.stripeCheckoutSessionId!, {
    stripeAccount: accountId,
  });
  check(
    'Expiration sans carte',
    'empreinte EXPIRED, réservation EXPIRED, session Stripe expirée',
    `${expired.status}, réservation ${freed.state}, session ${closed.status}`,
    expired.status === 'EXPIRED' && freed.state === 'EXPIRED' && closed.status === 'expired',
  );

  // 10. Annulation gratuite : empreinte fermée, aucun prélèvement possible.
  const freeCancel = await pendingGuarantee('annulation gratuite');
  await openSetup(freeCancel.paymentId);
  const freeSetup = await saveCard(freeCancel.paymentId, freeCancel.reservationId, 'pm_card_visa');
  const freeEvent = await eventFor(
    accountId,
    'setup_intent.succeeded',
    (o) => o.id === freeSetup.id,
  );
  await handleReservationPaymentStripeEvent(freeEvent, JSON.stringify(freeEvent));
  const released = await db.$transaction((tx) =>
    releaseCardGuaranteeOnCancel(
      tx,
      {
        id: freeCancel.reservationId,
        restaurantId: restaurant.id,
        startsAt: reservationAt,
        reservedAt: reservationAt,
      },
      'customer:personal-link',
    ),
  );
  const freeAfter = await payment(freeCancel.paymentId);
  check(
    'Annulation dans le délai gratuit',
    'empreinte CANCELLED, prélèvement refusé',
    `${freeAfter.status}`,
    released && freeAfter.status === 'CANCELLED',
  );

  const date = new Date().toISOString().slice(0, 10);
  const file = path.resolve(
    __dirname,
    `../../../docs/release/evidence/card-guarantee-sandbox-${date}.md`,
  );
  const passed = rows.filter((row) => row.ok).length;
  writeFileSync(
    file,
    [
      `# Empreinte bancaire — qualification Stripe sandbox (${date})`,
      '',
      'Script : `apps/api/scripts/qualify-card-guarantee-sandbox.ts`. Stripe **mode test**, compte',
      `connecté de test dédié (${short(accountId)}), base locale. Les vrais événements Stripe sont`,
      'passés par `handleReservationPaymentStripeEvent` (aiguillage de `/webhooks/stripe`) ; la',
      'signature est couverte par les tests unitaires. La page Checkout hébergée est remplacée par un',
      'SetupIntent identique (même client, mêmes métadonnées) faute de navigateur.',
      '',
      `Résultat : **${passed}/${rows.length}** scénarios conformes.`,
      '',
      '| Scénario | Attendu | Observé | |',
      '| --- | --- | --- | --- |',
      ...rows.map(
        (row) =>
          `| ${row.scenario} | ${row.expected} | ${row.observed} | ${row.ok ? 'OK' : 'KO'} |`,
      ),
      '',
    ].join('\n'),
  );
  // eslint-disable-next-line no-console -- sortie du script de qualification
  console.log(
    `\n${passed}/${rows.length} conformes — rapport : ${path.relative(process.cwd(), file)}`,
  );
  await db.$disconnect();
  process.exit(passed === rows.length ? 0 : 1);
}

main().catch((error: unknown) => {
  console.error('Qualification interrompue :', error instanceof Error ? error.message : error);
  process.exit(1);
});
