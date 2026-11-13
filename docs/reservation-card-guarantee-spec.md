# Empreinte bancaire de réservation — spec courte

Date : 2026-11-13 · Statut : **à valider par Hamza** (aucun code avant accord)
Socle existant : `apps/api/src/modules/reservation-payments/` (ADR
`docs/architecture/adr-reservation-payments-foundation.md`, fiche 7 de
`docs/architecture/fonctions-coupees-2026-10.md`).

But : réduire les absences sans prévenir sur les groupes et les dates chargées. Seul le type
`CARD_GUARANTEE` est livré ; `DEPOSIT` et `PREPAYMENT` restent dans le schéma, sans écran.

Chaque point ci-dessous porte une **proposition par défaut** ; les points marqués ❓ demandent
une décision explicite.

## 1. Modèle marchand

- **Proposition :** le restaurant est le marchand. On utilise le compte Stripe Connect qu'il a
  déjà ouvert pour les cartes cadeaux et les expériences (`Restaurant.giftCardStripeAccountId`,
  compte `dashboard: full`, `losses_collector: stripe`). Toutes les opérations sont des _direct
  charges_ (en-tête `stripeAccount`) : la carte, le client Stripe et l'éventuel prélèvement
  vivent sur le compte du restaurant. Suppernote ne détient jamais l'argent.
- Commission Suppernote sur un prélèvement : **aucune** (pas d'`application_fee_amount`).
- Prérequis pour activer l'empreinte : compte Connect avec `chargesEnabled`. Sinon le réglage
  renvoie vers l'ouverture du compte, comme pour les cartes cadeaux.
- Litiges : portés par le compte du restaurant, traités dans son tableau de bord Stripe. Suppernote
  affiche seulement « Litige ouvert » sur la fiche (voir §8).
- Capacité commerciale : `reservations.payments` (Pro / Multi-site), inchangée.

## 2. Quand une empreinte est demandée

- **Proposition :** deux déclencheurs, indépendants, réglés par le restaurant :
  1. **groupes** : à partir de N couverts (`minPartySize`, défaut proposé : 6), toute l'année ;
  2. **dates protégées** : une liste de dates choisies (Saint-Valentin, 31 décembre…), où
     l'empreinte vaut pour toutes les tailles de table (`rules.protectedDates`).
     L'empreinte est demandée si l'un des deux s'applique.
- Pas de règle par créneau ou par jour de la semaine en v1 (ajout possible dans `rules` plus tard).
- Les réservations créées par l'équipe (téléphone pris à la main, dashboard) ne sont **pas**
  soumises automatiquement : l'équipe peut cliquer « Demander une empreinte » (lien par SMS, §5).

## 3. Combien, et délai d'annulation

- **Proposition :** montant **par personne** fixé par le restaurant (défaut proposé : 20 €), borné
  1–200 € par personne. Le mode `FIXED` reste dans le schéma, sans écran.
- Délai d'annulation gratuite : `cancellationHours`, défaut 24 h, choix 0–72 h à l'écran.
- La policy est versionnée : modifier le réglage crée une nouvelle version, une réservation garde
  le montant et le délai qu'on lui a annoncés (`policySnapshot`, déjà en place).

## 4. Prélèvement

- **Jamais automatique.** Le parcours est : l'équipe marque la réservation `NO_SHOW` (existant),
  puis clique « Prélever », voit le montant maximal, peut le baisser, et confirme.
- Cas prélevables : absence sans prévenir, et annulation **après** la fin du délai gratuit.
  Une annulation dans le délai gratuit ferme l'empreinte (moyen de paiement détaché) : plus aucun
  prélèvement possible.
- ❓ Fenêtre pour prélever : **proposition 7 jours** après l'heure de la réservation, ensuite le
  bouton disparaît.
- Technique : `PaymentIntent` sur le compte connecté, `customer` + `payment_method` enregistrés,
  `off_session: true`, `confirm: true`, clé d'idempotence `reservation-guarantee-capture:<paymentId>`.
- Échec ou 3DS exigée par la banque : le statut reste `AUTHORIZED` avec `failureCode` ;
  la fiche affiche « La banque a refusé le prélèvement » et l'équipe peut réessayer. Pas de relance
  automatique, pas de lien d'authentification envoyé au client en v1.
- Reçu : `receipt_email` = e-mail du client s'il est connu (reçu Stripe au nom du restaurant).
- Remboursement total ou partiel depuis la fiche, via `createRefund` existant (compte connecté).

## 5. Canaux et cycle de vie

### Statuts

| Réservation (`state`) | Paiement                  | Signification                                 |
| --------------------- | ------------------------- | --------------------------------------------- |
| `PENDING`             | `REQUIRES_PAYMENT_METHOD` | en attente de carte ; **la place est tenue**  |
| `CONFIRMED`           | `AUTHORIZED`              | carte enregistrée                             |
| `EXPIRED`             | `EXPIRED`                 | carte pas enregistrée à temps ; place libérée |
| `NO_SHOW`/`CANCELLED` | `CAPTURED` / remboursé    | prélevée par l'équipe                         |

Le _hold_ de capacité est la réservation `PENDING` elle-même : `capacity.ts` compte déjà
`PENDING` comme actif. Pas de nouvelle table de hold.

### Connect et widget

1. Le client choisit son créneau ; si l'empreinte s'applique, l'écran l'annonce **avant** la saisie
   des coordonnées (montant, délai).
2. Création de la réservation en `PENDING` + `ReservationPayment` + **Stripe Checkout en mode
   `setup`** sur le compte connecté (page hébergée par Stripe : pas de champ carte chez nous, 3DS
   géré par Stripe, même page pour tous les canaux).
3. Retour sur une page Suppernote qui affiche l'état (« Réservation confirmée » ou « En attente »).
   La vérité vient seulement du webhook (`checkout.session.completed` / `setup_intent.succeeded`).
4. Expiration : **30 min** (minimum Stripe pour une session Checkout).

### Voix (Léa)

- Léa reste conversationnelle : pas de carte au téléphone. Quand l'empreinte s'applique, elle
  explique le principe et annonce un SMS ; la réservation est créée en `PENDING`.
- Le SMS contient un lien court Suppernote (`/garantie/<jeton>`) qui ouvre une session Checkout
  neuve à chaque clic tant que la réservation est tenue.
- ❓ Délai pour enregistrer la carte après un appel : **proposition 2 h** (la place est tenue
  pendant ce temps), puis expiration et SMS « réservation non confirmée ».
- Le prompt reçoit un principe, pas une phrase imposée (règle voix existante).

### MCP / assistants IA

- ❓ **Proposition v1 :** pas d'empreinte via MCP. Pour une réservation qui en demanderait une,
  l'outil répond qu'elle se fait sur la page de réservation du restaurant (lien). Ajout d'un champ
  `cardGuaranteeUrl` plus tard, de façon additive.

### Expiration

Worker existant à brancher (`expireReservationPayments`) : toutes les minutes, passe en `EXPIRED`
les paiements `REQUIRES_PAYMENT_METHOD` échus et la réservation `PENDING` associée, dans la même
transaction ; expire aussi la session Checkout ouverte.

## 6. Webhooks Stripe

- Un seul endpoint Stripe « Connect » reste déclaré : `POST /webhooks/stripe` (cartes cadeaux).
- **Proposition :** tout objet portant `metadata.type = 'reservation_guarantee'` est confié tout de
  suite au service `reservation-payments`, **avant** toute logique cartes cadeaux / expériences
  (même piège que #707). La route dédiée `/webhooks/stripe/reservation-payments` est supprimée
  (jamais déclarée chez Stripe ; à vérifier dans le tableau de bord avant suppression).
- Vérifications à chaque événement : signature, `event.account` = compte du restaurant enregistré
  sur le paiement, `metadata.restaurantId` + `metadata.reservationPaymentId`, montant et devise
  pour un PaymentIntent, rejeu idempotent sur `providerEventId` (déjà en place).
- Événements utilisés : `checkout.session.completed` / `.expired` (mode setup),
  `setup_intent.succeeded`, `payment_intent.succeeded` / `.payment_failed`, `charge.refunded`,
  `charge.dispute.created` / `.closed`.

## 7. Écrans dashboard

- **Réglages → Empreinte bancaire** : interrupteur, seuil de couverts, dates protégées, montant par
  personne, délai d'annulation gratuite ; aperçu du texte vu par le client. Bloqué tant que le compte
  Stripe n'est pas prêt, avec le lien d'ouverture existant.
- **Fiche réservation** : badge (« En attente de carte », « Carte enregistrée », « Prélevé 120 € »,
  « Remboursé », « Litige ouvert »), boutons « Prélever », « Rembourser », « Renvoyer le lien »,
  « Demander une empreinte » (réservation équipe). Confirmation obligatoire avant tout prélèvement.
- **Liste / plan de salle** : petite icône carte sur les réservations garanties.

## 8. Textes client et mentions

Avant la page Stripe et dans la confirmation (e-mail, SMS) :

> Pour confirmer votre réservation, {restaurant} demande l'enregistrement de votre carte bancaire.
> Aucun montant n'est débité aujourd'hui. Si vous annulez moins de {24} h avant, ou si vous ne
> venez pas sans prévenir, le restaurant pourra prélever jusqu'à {20} € par personne, soit
> {120} € pour {6} personnes. Vous pouvez annuler gratuitement jusqu'au {date heure}.

- Case à cocher « J'accepte ces conditions d'annulation » sur la page Suppernote avant Checkout.
- Checkout `custom_text` reprend la phrase courte ; le nom affiché est celui du restaurant.
- Mention dans les CGU Suppernote / annexe client : Suppernote est prestataire technique ; les
  conditions d'annulation et le prélèvement relèvent du restaurant. ❓ Relecture juridique à prévoir
  avant ouverture commerciale (pas bloquante pour la sandbox).
- Litige : le restaurant répond dans Stripe ; la fiche réservation lui donne les preuves utiles
  (heure de l'acceptation des conditions, statut `NO_SHOW` et qui l'a posé).

## 9. Schéma (additif, une migration)

Colonnes sur `ReservationPayment` : `stripeCustomerId`, `stripePaymentMethodId`,
`stripeCheckoutSessionId`, `capturedAmount`, `refundedAmount`, `termsAcceptedAt`,
`capturedByUserId`, `disputeStatus`. Aucune suppression, aucun renommage.

## 10. Découpage en PR (toutes `PR_NO_AUTO_MERGE=1`)

1. **Adaptateur + webhook** : migration additive, SetupIntent/Checkout setup, PaymentIntent off
   session, remboursement, aiguillage dans `/webhooks/stripe`, vérifications Connect, worker
   d'expiration ; tests (rejeu, mauvais compte, montant/devise, expiration).
2. **Parcours Connect/widget** : déclenchement, `PENDING`, page `/garantie/<jeton>`, textes.
3. **Dashboard** : réglages, fiche réservation, prélever/rembourser.
4. **Voix + SMS** : principe dans le prompt, envoi du lien, expiration 2 h.
5. **Qualification sandbox + retrait du drapeau** : 3DS (`4000002500003155`), refus
   (`4000000000009995`), rejeu, expiration, litige (`4000000000000259`) ; puis suppression de
   `RESERVATION_PAYMENTS_ENABLED` et mise à jour de `product-gates.json` (P5).

## Hors périmètre v1 (nommé, non fait)

Acompte et prépaiement, règles par créneau/jour, empreinte via MCP, lien 3DS après un refus,
commission Suppernote, rapprochement comptable quotidien, empreinte sur les expériences.
