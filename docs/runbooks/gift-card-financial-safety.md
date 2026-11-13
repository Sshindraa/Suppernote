# Cartes cadeaux — activation du lot A

## Décisions adoptées

Le restaurant encaisse sur son compte Stripe Connect ; Suppernote prélève une commission
avec `application_fee_amount`. La réservation associe une carte sans consommer son
solde. Seul un appel authentifié par le restaurant débite le montant réel de l'addition.
Le bénéficiaire consulte son solde sur `/gift-card/:code`, avec lien depuis les emails et le PDF, et réserve avec son code prérempli. La valeur offerte reste le montant payé : la commission est supportée par le restaurant.

## Configuration intégrée Stripe Connect

Le dashboard utilise `POST /restaurants/:id/gift-cards/stripe-connect/session` pour afficher
le composant officiel `account_onboarding` dans Suppernote, en français. Cette route exige le
propriétaire du restaurant ciblé ; la session ne donne accès qu’à l’onboarding. La route
historique `/onboarding` reste disponible pour compatibilité.

L’API nécessite `STRIPE_SECRET_KEY` et `STRIPE_PUBLISHABLE_KEY` du même environnement Stripe.
Seules la clé publique et la session temporaire sont transmises au navigateur. Ne jamais
enregistrer ni journaliser le `clientSecret`. Connect.js renouvelle la session à expiration.
Fermer puis reprendre réutilise le compte déjà associé ; quitter le formulaire ne prouve pas
l’activation des encaissements. Le statut est relu auprès de Stripe. Une fenêtre d’authentification
Stripe peut être nécessaire, même avec le formulaire intégré.

Lot 1 vérifié sur localhost en sandbox le 01/10/2026 ; commit/push différés sur demande utilisateur.

## Statut du compte dans Suppernote

La lecture `/stripe-connect` conserve les booléens d’encaissement et versement et ajoute
`onboardingState`, `actionItems`, `deadline` et `detailsSubmitted`. Les demandes sont des catégories
françaises, sans identifiants de personne ni texte libre d’erreur Stripe. Les demandes corrigeables
priment sur la vérification ; un document déjà en `pending_verification` n’est pas redemandé.
Le statut prêt exige les deux autorisations Stripe. Des demandes peuvent subsister même quand
les paiements fonctionnent : la reprise du formulaire reste alors accessible au propriétaire.

Le dashboard relit le statut après fermeture, au retour dans l’onglet et toutes les 30 secondes
si la page est visible. En cas d’erreur, le dernier état connu est marqué comme restant à confirmer.
Ces états sont lus directement chez Stripe, sans stockage supplémentaire ni migration.

## Création des comptes Stripe Connect

Suppernote crée les nouveaux comptes via `POST /v2/core/accounts`, version de requête
`2026-08-26.dahlia`. Le SDK Stripe existant fournit `rawRequest` et encode les requêtes
v2 en JSON ; la version des API de paiement et de facturation reste inchangée.
Le compte français demande la configuration merchant et card_payments, le dashboard
full et les responsabilités fees_collector/losses_collector à stripe. La commission
Suppernote reste celle du PaymentIntent direct.

Les données personnelles ne sont pas préremplies : Stripe les recueille dans son
onboarding hébergé. En France, leur préremplissage via Accounts v2 exige un account_token.
Les comptes déjà associés sont conservés. Leur identifiant reste compatible avec
Account Links v1, la lecture de readiness et les PaymentIntents existants.
La clé `gift-card-connect-v2:<restaurantId>:hosted` rend la création rejouable sans doublon.
Aucun support Accounts v1 supplémentaire n’est à activer pour créer un nouveau compte.

Références : [Accounts v2](https://docs.stripe.com/connect/accounts-v2),
[création](https://docs.stripe.com/api/v2/core/accounts/create).

## Configuration et mise en service

1. Déployer la migration additive `20260930170000_gift_card_financial_safety` avant
   l'API et son worker. Elle ajoute trois tables financières et deux colonnes ;
   aucune suppression ou modification de soldes historiques.
2. Déployer API, workers, Connect et dashboard ensemble : les nouveaux paiements
   Connect utilisent un `checkoutId` et un `accessToken` opaque. Les anciens paiements
   sur le compte plateforme gardent leur chemin de finalisation.
3. Configurer `STRIPE_SECRET_KEY` (API), `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` (Connect),
   `DASHBOARD_URL` (origine HTTPS du dashboard), `CONNECT_URL` (origine publique de Connect).
   Les clés restent dans l'environnement, jamais dans le dépôt.
4. Dans Stripe, activer Connect et enregistrer un endpoint **événements des comptes
   connectés** vers `POST /webhooks/stripe`. Inclure : `payment_intent.succeeded`,
   `payment_intent.payment_failed`, `charge.refunded`, `refund.created`, `refund.updated`,
   `refund.failed`, `charge.dispute.created`, `charge.dispute.closed`.
   Ajouter son secret à `STRIPE_WEBHOOK_SECRET` (liste séparée par des virgules,
   compatible avec l'endpoint billing existant). Contrôler les signatures et `event.account`.
5. Le propriétaire clique « Connecter Stripe » dans le dashboard cartes cadeaux.
   La vente reste bloquée tant que les encaissements ET les versements ne sont pas activés.
6. Facultatif : `GIFT_CARD_IMAGE_ORIGINS` contient uniquement les origines HTTPS de
   CDN maîtrisés, séparées par des virgules. Vide : les images personnalisées sont
   ignorées dans les PDF. Redirections interdites, téléchargement limité à 4 Mio.
7. Vérifier le worker `gift-card-finance` et sa planification toutes les cinq minutes.

## Qualification Stripe avant ouverture des ventes

En mode test, avec un restaurant pilote : onboarding, achat libre et pack, livraison,
rechargement du navigateur après paiement, webhook avant/après retour client,
rejeu simultané, réservation sans débit, débit réel partiel puis solde intégral,
annulation et remboursement partiel externe. Vérifier dans Stripe : compte marchand,
montant capturé, commission réellement prélevée, remboursement de commission,
versement et corrélation avec le registre Suppernote. Tester une contribution arrivant après
clôture : aucune valeur créditée, demande de remboursement persistée.

La qualification locale utilise PostgreSQL réel mais Stripe simulé ; elle ne prouve
pas l'onboarding, le virement bancaire ou les notifications réelles.

## Réconciliation et support

- `GiftCardCheckout` fige montant, pack, destinataire et message avant encaissement.
  Stripe ne reçoit que les références opaques. `accessToken` est stocké sous forme de hash.
- `GiftCardPaymentEntry.paymentIntentId` est unique pour achat ET contribution.
  Le verrou transactionnel sur ce paiement empêche le double crédit et la réutilisation
  entre les deux circuits ; les lignes historiques sont aussi vérifiées.
- `GiftCardRefundRequest` est persistée avant l'appel Stripe et porte une clé
  d'idempotence stable. La carte passe à `REFUND_PENDING` avant toute requête distante.
  Un succès confirmé annule le solde ; un échec la laisse bloquée (`REFUND_FAILED`).
- Les événements de remboursement lisent l'état Stripe actuel et appliquent seulement
  l'écart cumulé. Un remboursement externe en attente bloque la carte (`REFUND_REVIEW`) ;
  un litige la bloque en `PAYMENT_REVIEW`. La levée d'un litige nécessite le support.
- La réconciliation reprend les checkouts OPEN et les remboursements en attente,
  par lots de 50 avec rotation sur `updatedAt`. Un échec n'empêche pas les autres
  éléments du lot d'être examinés. Les erreurs remontent dans la queue et les logs
  ne contiennent que des identifiants techniques.
- `RECOVERY_REQUIRED` : création Stripe possiblement acceptée mais référence non
  enregistrée depuis plus de 23 heures. Vérifier Stripe avec la référence checkout,
  rattacher le paiement existant via une procédure de support revue ; ne pas recréer
  une charge après expiration de la garantie d'idempotence Stripe.
  Le même statut est posé quand Stripe répond `account_invalid` (compte connecté inaccessible
  pour la clé courante) : sans cela, le checkout restait OPEN et échouait à chaque scan.
- Une cagnotte déjà partiellement consommée exige un remboursement contrôlé : le lot A
  ne choisit pas arbitrairement quels contributeurs rembourser.
- Les notifications sont persistées dans la transaction financière et traitées via outbox.
  Voir `gift-card-delivery.md` pour l’activation coordonnée des workers et la résolution
  des résultats incertains. La caisse et l’export sont décrits dans `gift-card-operations.md`.
  La qualification providers/Stripe et le rapprochement financier restent à effectuer.

## Test local isolé

Créer une base PostgreSQL nommée `sokar_gift_card_finance` sur localhost,
appliquer le schéma de référence puis la migration et lancer :

```sh
GIFT_CARD_FINANCE_TEST_DATABASE_URL=postgresql://sokar_test@127.0.0.1:55439/sokar_gift_card_finance \
  pnpm --filter @suppernote/api exec vitest run src/modules/gift-cards
```

La suite transactionnelle refuse tout autre hôte/nom de base. Sans cette variable,
elle est ignorée ; les tests unitaires continuent de s'exécuter.

## Retour arrière

Utiliser le rollback des artefacts décrit dans `rollback.md`. Garder les tables
financières et arrêter les nouvelles ventes avant de revenir à une version qui ignore
les soldes bloqués et Stripe Connect. Ne pas supprimer le registre ni restaurer une DB
ancienne après encaissements sans rapprochement Stripe : les paiements réels persistent
chez le fournisseur. Les cartes historiques débitées à la réservation ne sont pas
recréditées automatiquement ; les corriger seulement après examen de leurs redemptions.

## Démonstration locale : propriétaire, client, bénéficiaire et restaurant

Les API et dashboard doivent tourner sur localhost:4000 et localhost:3000. Pour ouvrir le parcours public avec les mêmes clés **de test** que l’API, lancer depuis la racine :

```sh
node scripts/dev/gift-card-connect-test.cjs
```

Ce lanceur lit les clés depuis `apps/api/.env` sans les afficher ni les enregistrer ailleurs. Il refuse une base distante, des clés live, un restaurant de démonstration absent ou un environnement de production. Connect tourne sur localhost:4002 ; le lancement ordinaire de Connect n’impose pas ces paramètres.

Le panneau de démonstration sur `/dashboard/gift-cards` n’est exposé qu’en développement, pour `DEMO_RESTAURANT_ID`, avec une base loopback et les deux clés Stripe de test. Son API est réservée au propriétaire et ne renvoie aucune clé. Le mode test public est indiqué à l’achat, à la confirmation et sur la vue bénéficiaire selon la clé publique utilisée pour payer.

1. Compléter la configuration Stripe intégrée comme propriétaire ; attendre l’activation des encaissements. Le formulaire non soumis ne constitue pas un compte prêt.
2. Ouvrir le lien d’achat depuis le panneau, choisir une **carte classique** de 100 €, puis payer avec les données de test Stripe. Ne pas utiliser de carte bancaire réelle.
3. Suivre le lien bénéficiaire après l’achat ou renseigner le code dans le panneau ; vérifier le solde de 100 €.
4. Dans le dashboard, renseigner « Code de la carte présentée en salle », débiter une addition de 40 € avec une référence de ticket unique. Vérifier un solde de 60 € et le débit dans l’historique. Actualiser aussi la vue bénéficiaire.
5. Dans l’onglet Cartes cadeaux, annuler cette carte pour rembourser le solde inutilisé. Vérifier le remboursement Stripe et son état final dans les opérations ; un état pending n’est pas une réussite. Une cagnotte déjà utilisée nécessite le support et ne correspond pas à ce scénario.

### Notifications : qualification distincte

Les clés Stripe de test ne simulent pas Resend ni Telnyx. Le panneau indique seulement si leurs variables sont présentes, jamais une preuve de livraison. Vérifier séparément l’outbox dans le détail de la carte, ses erreurs, les reçus fournisseur puis la réception effective sur des coordonnées de test maîtrisées. Les e-mails, SMS et WhatsApp restent non qualifiés tant que les fournisseurs et destinataires ne sont pas configurés. Ne pas confondre configuration locale et staging.

Au 01/10/2026 : achat public accessible localement, restaurant de démonstration existant activé pour les cartes cadeaux, Stripe encore à configurer par le propriétaire ; aucun achat/remboursement réel sandbox ni notification transmis pour ce lot. Aucun jeu de cartes gratuites ne contourne cette qualification.
