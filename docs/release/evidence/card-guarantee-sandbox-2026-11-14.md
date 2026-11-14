# Empreinte bancaire — qualification Stripe sandbox (2026-11-14)

Script : `apps/api/scripts/qualify-card-guarantee-sandbox.ts`. Stripe **mode test**, compte
connecté de test dédié (acct_1UbIxeH…), base locale. Les vrais événements Stripe sont
passés par `handleReservationPaymentStripeEvent` (aiguillage de `/webhooks/stripe`) ; la
signature est couverte par les tests unitaires. La page Checkout hébergée est remplacée par un
SetupIntent identique (même client, mêmes métadonnées) faute de navigateur.
Limite : pour « Refus de la banque » et « 3DS exigée hors session », Stripe refuse de rattacher
ces cartes de test au client ; la carte est inscrite directement sur l’empreinte en base, puis
le prélèvement réel produit l’erreur Stripe. Le rattachement de la carte n’est pas couvert ici.

Résultat : **11/11** vérifications conformes (10 scénarios).

| Scénario                                   | Attendu                                                                             | Observé                                                                                         |     |
| ------------------------------------------ | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | --- |
| Page Stripe d’enregistrement               | session Checkout `setup`, ouverte, compte du restaurant                             | cs_test_c0hc… mode=setup statut=open url=checkout.stripe.com                                    | OK  |
| Carte enregistrée (setup_intent.succeeded) | empreinte AUTHORIZED, carte gardée, réservation CONFIRMED                           | AUTHORIZED, carte gardée, réservation CONFIRMED                                                 | OK  |
| Rejeu du même événement                    | reconnu comme doublon, aucun changement                                             | duplicate=true                                                                                  | OK  |
| Événement d’un autre compte                | refusé (acquitté), empreinte inchangée                                              | PAYMENT_PROVIDER_MISMATCH                                                                       | OK  |
| Prélèvement après absence (60 € sur 120 €) | PaymentIntent hors session réussi, empreinte CAPTURED 60 €                          | PENDING_CONFIRMATION, CAPTURED 60.00 €                                                          | OK  |
| Remboursement partiel (20 €)               | charge.refunded rattaché au PaymentIntent, PARTIALLY_REFUNDED 20 €                  | PARTIALLY_REFUNDED 20.00 €                                                                      | OK  |
| Refus de la banque                         | refus generic_decline, empreinte toujours AUTHORIZED, nouvel essai possible         | DECLINED generic_decline, AUTHORIZED (generic_decline), payment_failed appliqué                 | OK  |
| 3DS exigée hors session                    | refus authentication_required, empreinte toujours AUTHORIZED, nouvel essai possible | DECLINED authentication_required, AUTHORIZED (authentication_required), payment_failed appliqué | OK  |
| Litige ouvert par le client                | charge.dispute.created rattaché, statut CAPTURED inchangé, litige noté              | CAPTURED, litige needs_response                                                                 | OK  |
| Expiration sans carte                      | empreinte EXPIRED, réservation EXPIRED, session Stripe expirée                      | EXPIRED, réservation EXPIRED, session expired                                                   | OK  |
| Annulation dans le délai gratuit           | empreinte CANCELLED, prélèvement refusé                                             | CANCELLED                                                                                       | OK  |
