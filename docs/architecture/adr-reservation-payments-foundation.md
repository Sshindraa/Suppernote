# ADR — Fondation de protection bancaire des réservations

Date : 2026-09-14
Statut : `PARTIEL LOCAL` — empreinte bancaire en cours (spec validée le 2026-11-13,
`docs/reservation-card-guarantee-spec.md`) ; adaptateur Stripe et webhook livrés en PR 1

## Contexte

Une empreinte bancaire, un acompte ou un prépaiement change l'état d'une réservation et expose le
restaurant à des remboursements, litiges et erreurs de capture. Le retour navigateur ne peut pas
être la source de vérité : seul un événement provider signé et vérifié peut faire progresser le
paiement. Le modèle marchand (compte Stripe du restaurant ou compte plateforme) et les règles
juridiques restent à décider avec le pilote.

## Décisions locales

### Policies immuables et snapshot

`ReservationPaymentPolicy` est versionnée par `restaurantId + version`. Elle encode le type
`CARD_GUARANTEE`, `DEPOSIT` ou `PREPAYMENT`, le montant `FIXED` ou `PER_PERSON`, le seuil de
couverts, le délai d'annulation et des règles JSON bornées. Une tentative conserve un snapshot de
la policy ; une modification commerciale crée donc une nouvelle version au lieu de réécrire un
ancien paiement.

### Tentative idempotente

`ReservationPayment` est scoped par restaurant et réservation. `idempotencyKey` est unique et le
service compare réservation, policy, montant et devise avant de réutiliser une ligne existante.
Une collision avec un autre périmètre retourne `409 PAYMENT_IDEMPOTENCY_CONFLICT`. Les statuts
possibles sont explicites : `REQUIRES_PAYMENT_METHOD`, `REQUIRES_ACTION`, `AUTHORIZED`, `CAPTURED`,
remboursements, échec, annulation et expiration.

### Transition et réservation

La machine d'états refuse toute transition non autorisée et accepte le rejeu du même état. Lors
d'un événement `AUTHORIZED` ou `CAPTURED`, la tentative et la confirmation d'une réservation
`PENDING` sont écrites dans une transaction PostgreSQL unique. Une réservation annulée ou `NO_SHOW`
ne peut pas recevoir une nouvelle préparation.

### Webhook sans donnée carte

Depuis le 2026-11-13, les événements arrivent par l'endpoint Connect partagé `POST /webhooks/stripe`
et sont aiguillés vers `reservation-payment.webhook.ts` avant les cartes cadeaux ; la route dédiée
`/webhooks/stripe/reservation-payments` a été retirée. Le webhook vérifie la signature sur le corps brut, exige les
métadonnées `restaurantId` et `reservationPaymentId`, puis vérifie montant et devise. Seuls
`providerEventId`, type, statut résultant, date et SHA-256 du corps sont persistés dans
`ReservationPaymentEvent`. Les cartes, secrets, payloads et erreurs détaillées ne sortent jamais
de l'adaptateur.

### Flags et capacités

La capability `reservations.payments` est réservée à Pro/Multi-site. Le flag
`RESERVATION_PAYMENTS_ENABLED` vaut `false` par défaut et protège les routes et le webhook ; le
socle peut donc être testé localement sans appeler Stripe. L'expiration opérateur renvoie seulement
un compte et doit être planifiée après qualification.

## Ce qui manque avant un pilote

1. choisir et documenter le modèle marchand, les responsabilités TVA/litige et les CGV ;
2. stocker une référence opaque vers le compte Stripe/secret manager et implémenter un adaptateur
   SetupIntent/PaymentIntent idempotent ;
3. brancher un hold de capacité qui reste protégé pendant `PENDING` et libère l'expiration ;
4. vérifier `account`, metadata, montant capturé et devise sur les événements Connect ;
5. implémenter capture après no-show, remboursement total/partiel, frais et rapprochement quotidien ;
6. exécuter les scénarios sandbox (3DS, rejeu, retard, expiration, chargeback) puis un pilote limité.

Avancement au 2026-11-13 (PR 1 de l'empreinte) : points 2, 4 et la partie capture/remboursement du
point 5 livrés en local (adaptateur `gift-cards/stripe.service.ts`, compte Connect déjà ouvert pour
les cartes cadeaux, aucune référence secrète nouvelle à stocker) ; hold = réservation `PENDING`,
libérée par le job `reservation-payment-expiry` (point 3). Restent : parcours client, écrans, frais
et rapprochement, scénarios sandbox.

## Preuves locales

- migration : `packages/database/prisma/migrations/20260914150000_reservation_payments_foundation/` ;
- service : `apps/api/src/modules/reservation-payments/reservation-payment.service.ts` ;
- routes : `apps/api/src/modules/reservation-payments/reservation-payment.routes.ts` ;
- tests : `apps/api/src/modules/reservation-payments/__tests__/` (10 tests ciblés) ;
- aucun appel provider n'est effectué pendant cette fondation.
