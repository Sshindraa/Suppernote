# Fonctions coupées en production : finir ou supprimer (octobre 2026)

Statut : proposition à trancher par Hamza. Rien n'est activé ni supprimé par ce document.
Date : 23 octobre 2026.

## Pourquoi ce document

Règle posée le 23/10/2026 : Suppernote est un SaaS qui doit tout activer ; une fonction coupée ne sert à rien,
autant l'enlever. Quatorze fonctions sont aujourd'hui coupées en production par un drapeau. Pour chacune,
il faut choisir entre **finir et activer** et **supprimer le code**. Ce document donne les faits pour
décider ; la dernière colonne de chaque fiche est une recommandation, pas une décision.

Méthode : lecture du code (modules API, pages du dashboard, Connect, schéma Prisma, workers), de
l'historique git, des ADR de `docs/architecture/`, de `docs/release/product-gates.json` et des runbooks.
Limite : aucun accès à la base de production. « Données en base » se vérifie donc par une requête de
comptage avant toute suppression de table (voir « Règles de suppression »). Les tailles sont des lignes
de TypeScript hors tests (`src`), les tests étant comptés en nombre de cas `it(...)`. Les durées « finir »
sont des estimations d'ordre de grandeur, pas des engagements.

## Résumé en une page

| Fonction                                     | Drapeau                            | Taille (code / tests API / tests dashboard)                    | Maturité                                                        | Bloquant principal                                                                | Recommandation                                                   |
| -------------------------------------------- | ---------------------------------- | -------------------------------------------------------------- | --------------------------------------------------------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Alerte VIP au gérant                         | `VIP_PUSH_ENABLED`                 | 10 lignes dans `telnyx.pipeline.ts` / 2 tests                  | Complète, sans doc dédiée                                       | Décision de coût (un SMS par appel VIP, limité à un par 15 min et par restaurant) | **Finir** : activer pour tous                                    |
| Alertes d'usage internes                     | `USAGE_ALERTS_ENABLED`             | 251 lignes / 8 tests                                           | Complète, silencieuse sans budget                               | Fixer `USAGE_ALERT_VOICE_BUDGET_MINUTES` et `USAGE_ALERT_SMS_BUDGET_SEGMENTS`     | **Finir** : activer et poser deux budgets                        |
| Anonymisation RGPD (2 ans)                   | `RGPD_ANONYMIZATION_ENABLED`       | 124 lignes + worker 40 / couverte par la suite RGPD (83 tests) | Complète pour les réservations                                  | Revue juridique du prédicat ; périmètre limité aux réservations                   | **Finir** : activer (aucune ligne n'a 2 ans avant mai 2028)      |
| Évaluation sémantique hebdomadaire           | `VOICE_SEMANTIC_AUTO_EVAL_ENABLED` | 339 lignes + worker 17 / 10 tests                              | Complète, mesure seulement                                      | Dépend de la décision Span-01 ; coût OpenRouter hebdomadaire                      | **Finir** si Span-01 est gardé, sinon **supprimer** avec lui     |
| Expériences (interne)                        | `EXPERIENCES_ENABLED`              | 2 529 lignes / 25 tests / 19 tests                             | Avancée : checkout Stripe Connect, page Connect                 | CGV, TVA, notifications, qualification staging                                    | **Finir** (le plus avancé des socles)                            |
| Réservation publique d'expériences           | `EXPERIENCE_BOOKING_ENABLED`       | inclus ci-dessus + Connect (523 lignes)                        | Prête à qualifier (`experience-booking-pilot.md`)               | Même qualification ; compte Stripe Connect du restaurant                          | **Finir**, juste après la ligne précédente                       |
| Paiement de réservation (empreinte, acompte) | `RESERVATION_PAYMENTS_ENABLED`     | 1 250 lignes / 10 tests / aucun écran                          | Partielle : webhook et machine d'états, pas d'adaptateur Stripe | Modèle marchand, TVA/litiges, adaptateur, capture après no-show                   | **Finir** si l'acompte est une promesse produit, sinon supprimer |
| Fidélité (avantages)                         | Aucun (Pro/Multi-site)             | 1 234 lignes / 23 tests / 10 tests                             | Locale, aucun point ni envoi                                    | Décider manuel ou POS ; revue gérant                                              | **Finir** en version manuelle, ou supprimer                      |
| Réputation (retours post-visite)             | Pro/Multi-site                     | 1 147 lignes / 16 tests / 8 tests                              | E-mail privé à J+1, plafond et désinscription                   | Qualification staging et configuration du secret                                  | **Finir**                                                        |
| Événements et billetterie                    | `EVENTS_ENABLED`                   | 2 322 lignes / 26 tests / 12 tests                             | Locale : aucune facture, aucun paiement                         | Paiement, facture fiscale, notifications, widget public                           | **Supprimer** (recouvre les expériences)                         |
| Canaux partenaires (distribution)            | `DISTRIBUTION_ENABLED`             | 1 795 lignes / 20 tests / 7 tests                              | Coquille : aucun fournisseur choisi                             | Fournisseur, contrat, OAuth, secret manager, adaptateur, worker                   | **Supprimer**                                                    |
| Connecteurs caisse (POS)                     | `POS_CONNECTORS_ENABLED`           | 1 153 lignes / 12 tests / aucun écran                          | Coquille : import local, aucun fournisseur                      | Fournisseur POS et contrat de données                                             | **Supprimer**                                                    |
| CRM groupe multi-site                        | `CUSTOMER_GROUPS_ENABLED`          | 706 lignes / 15 tests / aucun écran                            | Locale ; sortie en 5 conditions                                 | Deux sessions Clerk réelles, preuve d'effacement inter-sites, revue RGPD          | **Supprimer** (ou reporter jusqu'à un client Multi-site)         |
| Pré-réflexion du LLM                         | `SPECULATIVE_LLM_ENABLED`          | 0 ligne (code déjà supprimé en #395)                           | Sans objet                                                      | Aucun : il ne reste que des vestiges                                              | **Supprimer** les vestiges                                       |

## Constats qui valent pour toutes les fiches

- **Les socles viennent presque tous d'un seul commit** (`46f65ac1`, #171, 15/09/2026) : POS, paiements,
  groupes, réputation, fidélité, expériences, événements, distribution. Depuis, seules les expériences ont
  reçu du développement fonctionnel (paiement public le 06/10, #401). Les autres n'ont eu que de la
  maintenance : leur coût de suppression n'augmente pas, et leur valeur ne s'est pas construite.
- **Les modules sont isolés.** Chacun n'est importé que par `apps/api/src/main.ts` et, pour les files,
  par `apps/api/src/workers/index.ts` (les expériences partagent aussi le service Stripe des cartes cadeaux
  via `gift-cards/stripe.service`). Supprimer un module ne demande donc pas de toucher au reste de l'API.
- **Les capacités commerciales existent déjà.** `packages/config/src/entitlements.ts` déclare
  `pos.connect`, `reservations.payments`, `customers.group`, `reputation.feedback`, `reputation.loyalty`,
  `experiences.manage`, `events.manage` et `distribution.manage`, ouvertes selon la formule (Pro et
  Multi-site pour la plupart ; `customers.group` Multi-site seulement). Supprimer une fonction demande de
  retirer sa capacité, et de vérifier qu'aucune page de tarifs ou de contrat ne la promet (non vérifié ici
  pour les textes commerciaux hors dépôt).
- **Visible aujourd'hui côté restaurateur.** La barre latérale du dashboard affiche Fidélité, Réputation,
  Expériences, Événements et Distribution (`_layout-client.tsx`). Une fois la formule éligible, l'API répond
  `*_DISABLED` (503) et la page affiche « Cette fonctionnalité n'est pas encore ouverte sur votre compte. »
  (`apps/dashboard/src/lib/api-error.ts`). Garder ces entrées pour des fonctions coupées contredit la règle
  du jour : à finir ou à retirer de la navigation dans la même PR que la décision.
- **Le registre de portes** (`docs/release/product-gates.json`, `productionFreeze: true`) classe P5 à P9 en
  `LOCAL_ONLY` avec des bloquants externes explicites. Supprimer ou activer une fonction implique de mettre
  ce registre à jour, ainsi que `scripts/verify-product-gates.mjs` (liste `knownFeatureFlags`).
- **Aucun fournisseur externe n'a jamais été appelé** par ces socles (les ADR et les runbooks le répètent).
  Aucune route publique de ces modules n'est enregistrée chez un tiers à ma connaissance ; seule exception à
  vérifier : le webhook `POST /webhooks/stripe/reservation-payments` (paiements de réservation), à contrôler
  dans le tableau de bord Stripe avant toute suppression.

## Règles de suppression (valent pour toute fiche « supprimer »)

1. Supprimer d'abord le code (module, routes, workers, page dashboard, tests, capacité, drapeau, lignes du
   registre de portes). Les tables resteront en base : c'est inoffensif et réversible.
2. Ne supprimer les tables (`DROP TABLE`) que dans une PR séparée, après `SELECT count(*)` sur chaque table,
   sauvegarde vérifiée et confirmation explicite de Hamza (règle du dépôt : pas d'opération destructive sans
   confirmation ; vérifier avec `prisma migrate diff --from-url --to-schema-datamodel --script`).
3. Ne pas modifier `schema.prisma` dans la PR de retrait du code : un modèle Prisma orphelin ne coûte rien,
   un `DROP` oui.
4. Une migration déjà appliquée ne se réécrit pas : l'historique `packages/database/prisma/migrations/`
   reste intact.

---

## Fiches

### 1. Alerte VIP au gérant : `VIP_PUSH_ENABLED`

- **Ce que la fonction fait pour un restaurant.** Quand un client marqué VIP appelle, le gérant reçoit un
  SMS « ⭐ VIP en ligne : <nom> — appel entrant » sur `managerPhone`. Un SMS par restaurant et par fenêtre
  de 15 minutes (`SMS_RATE_LIMIT_SECONDS`, défaut 900).
- **Où elle vit.** `apps/api/src/modules/voice/telnyx.pipeline.ts` (lecture du drapeau et ajout du job
  `vip-alert` à la file `sms-manager`), `apps/api/src/shared/queue/workers/sms-confirmation.worker.ts`
  (worker `sms-manager`, partagé avec d'autres alertes gérant). Aucune table, aucune page dédiée ; le statut
  VIP vient de `Customer.isVip`.
- **Taille.** 10 lignes spécifiques. 2 tests (`telnyx.pipeline.test.ts`, cas activé et cas coupé).
- **Maturité.** Fonctionnelle de bout en bout, sans document d'architecture ni étape de sortie. Elle n'a
  jamais tourné en production.
- **Bloquant.** Seulement une décision : l'envoi réel d'un SMS (coût d'un segment) et le contenu (le nom du
  client est dans le SMS, destiné au gérant du même restaurant). Aucun fournisseur à ajouter (Telnyx est
  déjà utilisé pour les confirmations).
- **Suppression.** Quasi gratuite : 10 lignes et 2 tests ; aucune donnée en base.
- **Recommandation.** Finir : activer pour tous (le coût est borné par la limite de 15 minutes), après avoir
  confirmé que `managerPhone` est renseigné à l'onboarding ; sinon l'alerte échoue sans bruit.

### 2. Alertes d'usage internes : `USAGE_ALERTS_ENABLED`

- **Ce que la fonction fait.** Un worker horaire compare l'usage du mois (minutes de voix, segments SMS) à
  des budgets internes et envoie une alerte aux opérateurs Suppernote quand un seuil est franchi. Elle ne
  contacte jamais le restaurant et ne bloque jamais un appel (suivi des coûts, pas un quota client).
- **Où elle vit.** `apps/api/src/shared/queue/workers/usage-alerts.worker.ts`,
  `apps/api/src/modules/usage/usage-alerts.service.ts`, `usage-alert-budget.service.ts`, planification dans
  `schedulers.ts`. Elle s'appuie sur le registre d'usage (tables `UsageEvent`, `UsageMonthlyRollup`, déjà
  actives). Surface de suivi : `/admin/margin`.
- **Taille.** 251 lignes de code. 8 tests (service, budgets et worker).
- **Maturité.** Complète, ADR `adr-usage-ledger-and-costing.md` (statut « accepté, implémentation
  partielle » : c'est le travail de tarifs et d'ajustements, pas ce worker). Revendique un déploiement « en
  shadow ». Réclamation Redis `SET NX` contre les doublons, échec fermé si Redis tombe.
- **Bloquant.** Aucun technique. Sans budgets (`USAGE_ALERT_VOICE_BUDGET_MINUTES`,
  `USAGE_ALERT_SMS_BUDGET_SEGMENTS`) le worker reste silencieux : l'activer sans budget ne sert à rien, il
  faut donc choisir deux nombres.
- **Suppression.** Facile : un worker, un service, une planification, 8 tests ; aucune table propre.
- **Recommandation.** Finir : activer et fixer deux budgets à partir du coût réel du mois écoulé (le cockpit
  de marge donne les chiffres).

### 3. Anonymisation RGPD à deux ans : `RGPD_ANONYMIZATION_ENABLED`

- **Ce que la fonction fait.** Chaque nuit à 3 h, anonymise les réservations créées il y a plus de 730 jours
  dont le téléphone n'a pas réservé dans les 180 derniers jours : nom remplacé par `ANON`, téléphone,
  identifiant client et demandes spéciales effacés. C'est la mise en œuvre technique de la durée de
  conservation annoncée (`privacy-disclosures.md`, `retentionDays: 730`).
- **Où elle vit.** `apps/api/src/modules/rgpd/anonymization.service.ts`,
  `apps/api/src/shared/queue/workers/rgpd-anonymization.worker.ts`, planification dans `schedulers.ts`
  (« quotidienne à 3 h », déjà active : le worker lit le drapeau et sort). Table touchée : `Reservation`.
- **Taille.** 164 lignes (service et worker) ; le module RGPD complet fait 2 416 lignes et 83 tests (effacement, export,
  consentement), dont l'anonymisation ne représente qu'une petite part.
- **Maturité.** Code complet et testé, jamais exécuté en production. **Le dépôt date du 07/05/2026** : sauf
  import d'historique, aucune réservation n'a 730 jours avant mai 2028. L'activer maintenant ne détruit donc
  rien, et la première vraie exécution aura lieu dans 18 mois.
- **Bloquant.** Une revue juridique du prédicat (le commentaire du service parle de « stratégie MVP,
  volontairement conservatrice, à ajuster après le pilote »). Limite fonctionnelle à savoir : ne couvre que
  `Reservation`, pas les fiches `Customer`, les notes, les transcriptions d'appel ni les enregistrements (qui
  ont leur propre rétention de 30 jours).
- **Suppression.** Déconseillée : la durée de 730 jours est annoncée aux clients. La supprimer sans
  remplacement rend la promesse fausse.
- **Recommandation.** Finir : activer maintenant (sans effet avant 2028), puis étendre le périmètre aux fiches
  client avant la première exécution réelle.

### 4. Évaluation sémantique hebdomadaire : `VOICE_SEMANTIC_AUTO_EVAL_ENABLED`

- **Ce que la fonction fait.** Chaque lundi à 6 h, rejoue jusqu'à 300 tours récents (7 jours) des
  restaurants à transcription debug par Jev et par un modèle juge (OpenRouter) et publie précision et rappel
  en métriques Prometheus. C'est un outil de mesure de la qualité vocale : le restaurateur ne le voit pas.
- **Où elle vit.** `apps/api/src/modules/voice/stream/semantic-signals/auto-eval.ts`,
  `apps/api/src/shared/queue/workers/voice-semantic-auto-eval.worker.ts`, planification `schedulers.ts`.
  Lit `voice_debug_turns`, écrit des rapports dans `apps/api/scratch/semantic-auto-eval/`.
- **Taille.** 356 lignes. 10 tests (`auto-eval.test.ts`, `judge.test.ts`).
- **Maturité.** Livrée le 28/09 (#274), complète, mais dépend de Span-01 : les signaux sémantiques sont
  maintenant actifs pour tous (23/10) et la décision de phase 2 de Span-01 reste ouverte (TODO « Span-01 »
  dans `Context.md`).
- **Bloquant.** `OPENROUTER_API_KEY` (déjà présente, Luna passe par OpenRouter), 20 tours annotables au
  minimum, un coût hebdomadaire de juge (300 tours, quelques centimes à quelques euros selon le modèle ;
  non mesuré ici).
- **Suppression.** Facile (un worker, un fichier, des métriques) ; sans effet sur les appels.
- **Recommandation.** Dépend de Span-01 : **finir** (l'activer) si Span-01 est gardé, car il en mesure la
  qualité ; sinon **supprimer** avec lui. Ne pas la garder coupée.

### 5. Expériences (module interne) : `EXPERIENCES_ENABLED`

- **Ce que la fonction fait.** Le restaurateur crée des expériences payantes (dégustation, atelier, brunch),
  les planifie en sessions à jauge limitée, réserve des places à la main et annule avec remboursement. Les
  places sont réservées sous verrou PostgreSQL (pas de survente).
- **Où elle vit.** API : `apps/api/src/modules/experiences/` (`experience.service.ts` 1 015 lignes,
  `experience-payment.service.ts` 986, `experience.routes.ts` 495, worker d'expiration). Dashboard :
  `/dashboard/experiences` (1 297 lignes, 19 tests). Tables : `Experience`, `ExperienceSession`,
  `ExperienceReservation`, `ExperienceCheckout`, `ExperiencePaymentEvent` (migrations
  `20260914190000_experiences_foundation` et `20261002160000_experience_public_checkout`). Capacité
  `experiences.manage`.
- **Taille.** 2 529 lignes API, 25 tests API, 19 tests dashboard.
- **Maturité.** La plus avancée : développement fonctionnel encore le 06/10 (#401), paiement public
  Stripe Connect avec webhook signé, remboursement, expiration, idempotence. Runbook
  `experience-booking-pilot.md` : « code local prêt à qualifier ; aucune migration ni activation staging
  ou production ». TODO actif dans `Context.md` : qualification Stripe/CGV/TVA/notifications en staging.
- **Bloquant.** Migration `20261002160000` à appliquer et qualifier en staging ; conditions de vente et
  politique de remboursement visibles avant paiement ; TVA et justificatif ; e-mails de confirmation au
  client et notification au restaurateur ; procédure de support. Le compte Stripe Connect du restaurant est
  celui des cartes cadeaux (le chantier « finir le compte Stripe sandbox démo » du `Context.md` est donc un
  prérequis commun).
- **Suppression.** Coûteuse en travail et en valeur perdue : 3 000 lignes de code, une page Connect, 5
  tables, un lien avec le service Stripe des cartes cadeaux. Aucune donnée de production attendue.
- **Recommandation.** Finir : c'est le seul socle avec un parcours payant complet, et le seul à porter une
  demande produit visible (page publique Connect).

### 6. Réservation publique d'expériences : `EXPERIENCE_BOOKING_ENABLED`

- **Ce que la fonction fait.** Un client réserve et paie une expérience en ligne depuis la page Suppernote
  Connect du restaurant (`/restaurant/<slug>/experiences`), par Stripe Checkout sur le compte Connect du
  restaurant, avec commission Suppernote fixée par l'opérateur.
- **Où elle vit.** API : routes publiques `/public/r/:slug/experiences*`, route interne
  `/api/internal/experiences/payment-config`. Connect : `experience-booking.tsx` (374 lignes), page, client
  API (523 lignes au total). Webhook Connect sur `POST /webhooks/stripe`.
- **Maturité.** Code prêt à qualifier ; doit rester derrière `EXPERIENCES_ENABLED`.
- **Bloquant.** Les mêmes que la fiche 5, plus : destination Connect dédiée dans Stripe avec les cinq
  événements listés dans le runbook, taux de commission par restaurant, restaurant publié, charges et
  versements autorisés côté Stripe.
- **Suppression.** À ne pas séparer de la fiche 5.
- **Recommandation.** Finir juste après la fiche 5, au même moment (un seul chantier). Les routes publiques
  existent déjà dans le contrat Connect : ne pas les renommer (surface d'intégration).

### 7. Paiement de réservation (empreinte, acompte) : `RESERVATION_PAYMENTS_ENABLED`

- **Ce que la fonction fait.** Politique par restaurant (empreinte bancaire ou acompte), préparation d'un
  paiement pour une réservation, confirmation par webhook Stripe signé, expiration.
- **Où elle vit.** `apps/api/src/modules/reservation-payments/` (service et routes), tables
  `ReservationPaymentPolicy`, `ReservationPayment`, `ReservationPaymentEvent` (migration
  `20260914150000`). Capacité `reservations.payments`. Aucune page dashboard, aucune surface widget ni voix.
- **Taille.** 1 250 lignes, 10 tests. 4 commits dont le dernier le 22/09.
- **Maturité.** `PARTIEL LOCAL` (ADR). La machine d'états et le webhook existent ; **il n'y a pas
  d'adaptateur SetupIntent/PaymentIntent**, ni capture après no-show, ni remboursement, ni hold de
  capacité. Registre P5 : trois bloquants (modèle marchand et DPA, raccordement Stripe Connect en sandbox,
  scénarios de litige et pilote).
- **Bloquant.** Décisions juridiques et comptables (qui est le marchand ? TVA, litiges, CGV), puis
  implémentation de la moitié manquante et d'une interface restaurateur.
- **Suppression.** Moyenne : 1 250 lignes, 3 tables, un webhook Stripe `…/reservation-payments` à retirer
  du tableau de bord Stripe s'il y est enregistré (non vérifié).
- **Recommandation.** Finir **si** l'acompte anti no-show est une promesse produit (c'est l'argument
  commercial classique d'un logiciel de réservation) ; la moitié restante est la plus grosse de toute cette
  liste (estimation : plusieurs semaines). Sinon supprimer, mais c'est la suppression que je recommande le
  moins.

### 8. Fidélité (avantages) : version manuelle Pro/Multi-site

- **Ce que la fonction fait.** Le restaurateur définit des avantages (un verre offert, un dessert), les
  émet à un client éligible sous forme d'attribution à code haché, puis les marque utilisés ou annulés. Pas
  de points, pas d'envoi, pas de lien avec la caisse.
- **Où elle vit.** `apps/api/src/modules/loyalty/` (service, routes, worker d'expiration),
  `/dashboard/loyalty` (1 283 lignes, 10 tests), tables `LoyaltyBenefit` et `LoyaltyGrant`, capacité
  `reputation.loyalty`. Entrée « Fidélité » dans la barre latérale.
- **Taille.** 1 234 lignes API, 23 tests API, 10 tests dashboard.
- **Maturité.** Version manuelle ouverte aux offres Pro et Multi-site ; pas de points ni d'envoi.
- **Bloquant.** Aucun fournisseur. C'est une décision produit : la version manuelle est utilisable telle
  quelle ; l'intégration caisse est l'autre fiche (POS).
- **Suppression.** Moyenne (2 tables, une page, une entrée de menu, une capacité).
- **Décision.** Ouvrir la version manuelle aux offres Pro et Multi-site.

### 9. Réputation (retours après visite) : Pro/Multi-site

- **Ce que la fonction fait.** Après une visite honorée, crée une demande de retour (lien public à usage
  unique) ; un score faible ouvre une tâche de récupération pour l'équipe (`OPEN → IN_PROGRESS → RESOLVED`).
- **Où elle vit.** `apps/api/src/modules/reputation/` (service, routes, worker d'expiration),
  `/dashboard/reputation` (384 lignes, 8 tests), tables `ReputationFeedbackRequest`, `ReputationFeedback`,
  `ReputationRecoveryTask`, route publique `/reputation/feedback/submit`. Capacité `reputation.feedback`.
- **Taille.** 1 147 lignes API, 16 tests API, 8 tests dashboard.
- **Mise à jour 28 octobre 2026.** E-mail privé à J+1, désinscription, une demande par client et restaurant en 90 jours ; plafond de 10 tentatives quotidiennes pour la plateforme. Aucun lien vers une plateforme d'avis. Accès Pro/Multi-site.
- **Recommandation.** Finir et qualifier le parcours staging.

### 10. Événements et billetterie : `EVENTS_ENABLED`

- **Ce que la fonction fait.** Catalogue d'événements, sessions, tarifs, jauge transactionnelle, commandes,
  billets, contrôle d'entrée, liste d'attente, remboursement local.
- **Où elle vit.** `apps/api/src/modules/events/` (2 322 lignes, 26 tests, worker d'expiration),
  `/dashboard/events` (1 167 lignes, 12 tests), 6 tables (`Event`, `EventSession`, `EventTicketType`,
  `EventOrder`, `EventTicket`, `EventWaitlistEntry`), capacité `events.manage`.
- **Maturité.** Locale. L'ADR liste en « hors périmètre » : paiement, facture fiscale, widget public,
  QR code, notifications, reporting encaissé. Autrement dit : il ne se vend rien.
- **Bloquant.** Tout ce qui fait d'un événement un produit : paiement, facture fiscale, notifications,
  canal public. Registre P9 : quatre bloquants.
- **Suppression.** Moyenne : 3 500 lignes avec la page, 6 tables. Aucune donnée de production attendue.
- **Recommandation.** Supprimer : une session à jauge limitée avec un tarif est ce que font déjà les
  expériences, qui ont le paiement. Si des événements sont voulus plus tard, mieux vaut étendre les
  expériences que finir un second moteur de capacité.

### 11. Canaux partenaires (distribution) : `DISTRIBUTION_ENABLED`

- **Ce que la fonction fait.** Une connexion à un canal tiers, un instantané de disponibilité à publier, des
  exécutions de synchronisation, des liens réservation-canal et une boîte de réception de webhooks. Rien ne
  part chez un tiers.
- **Où elle vit.** `apps/api/src/modules/distribution/` (1 795 lignes, 20 tests), `/dashboard/distribution`
  (677 lignes, 7 tests), 5 tables (`DistributionConnection`, `DistributionSyncRun`,
  `DistributionAvailabilitySnapshot`, `DistributionReservationLink`, `DistributionWebhookEvent`), capacité
  `distribution.manage`, route publique `/distribution/webhooks`.
- **Maturité.** Coquille. L'ADR le dit : OAuth, compte marchand, secret manager, webhook public signé,
  worker et dead-letter sont hors périmètre. Aucun fournisseur choisi.
- **Bloquant.** Choix d'un fournisseur et contrat, secret manager, adaptateur, worker, webhooks publics,
  30 jours de pilote rapprochés (registre P9). Le travail restant est plus gros que le code existant.
- **Suppression.** Moyenne, sans dépendance externe : aucun tiers n'appelle les routes.
- **Recommandation.** Supprimer : on ne peut pas activer une coquille, et le fournisseur n'est pas choisi.

### 12. Connecteurs caisse (POS) : `POS_CONNECTORS_ENABLED`

- **Ce que la fonction fait.** Une connexion caisse sans fournisseur, un import de tickets, un rapprochement
  ticket-réservation pour mesurer la dépense réelle d'une table. Rien ne se connecte à une vraie caisse.
- **Où elle vit.** `apps/api/src/modules/pos/` (1 153 lignes, 12 tests), tables `PosConnection` et
  `PosCheck`, capacité `pos.connect`. Aucune page dashboard.
- **Maturité.** Coquille : une interface « provider-neutral » et un matcher, sans adaptateur. Registre P6 :
  choisir un fournisseur POS et son contrat, secret manager, adaptateur, sandbox, webhooks, 30 jours de
  tickets rapprochés.
- **Bloquant.** Le choix d'un fournisseur (Lightspeed, Zelty, L'Addition…) et l'accès à ses données, qui
  dépendent des restaurants clients.
- **Suppression.** La plus simple des coquilles : un module, 12 tests, 2 tables, aucune interface.
- **Recommandation.** Supprimer : revenir avec un fournisseur nommé et un restaurant pilote qui l'utilise.

### 13. CRM groupe multi-site : `CUSTOMER_GROUPS_ENABLED`

- **Ce que la fonction fait.** Pour un compte Multi-site, reconnaît le même client dans plusieurs
  établissements, sous consentement, sans exposer la note privée d'un site à un autre.
- **Où elle vit.** `apps/api/src/modules/customer-groups/` (706 lignes, 15 tests), tables
  `CustomerGroupProfile` et `CustomerGroupMembership`, capacité `customers.group` (Multi-site seulement).
  Aucune page dashboard.
- **Maturité.** Locale. L'ADR fixe cinq conditions de sortie : deux organisations et deux sessions Clerk
  réelles, preuve d'export et d'effacement sur toutes les projections, règle de rapprochement revue par un
  opérateur, pilote sandbox, revue RGPD.
- **Bloquant.** Risque d'accès inter-site et obligation d'effacement multi-sites : c'est la fonction la plus
  sensible de la liste, et seule la formule la plus chère (Multi-site) en bénéficierait.
- **Suppression.** Facile : un petit module, 2 tables, aucune interface.
- **Recommandation.** Supprimer : la valeur n'existe que pour des clients Multi-site, et le risque RGPD est
  plus élevé que le gain tant qu'aucun n'en fait la demande.

### 14. Pré-réflexion du LLM : `SPECULATIVE_LLM_ENABLED`

- **Ce que la fonction faisait.** Préparer une réponse du modèle avant la fin de la phrase de l'appelant,
  dans le mode à outils.
- **Où elle vit.** Nulle part : le code a été supprimé avec le mode à outils (#395). Il reste des vestiges :
  la constante `FLAGS.SPECULATIVE_LLM` (ConfigCat) et son entrée dans la liste de
  `apps/api/src/modules/admin/flags.routes.ts`, un test qui supprime la variable d'environnement
  (`stt-bridge.test.ts`), et une ligne de documentation dans `environment.md`.
- **Maturité et bloquants.** Sans objet. Le tour structuré a sa propre spéculation, qui est désormais
  toujours active (`VOICE_STRUCTURED_SPECULATION_ENABLED` retiré dans la même PR que ce document).
- **Suppression.** Quelques minutes, aucune donnée. `admin/flags.routes.ts` est une route d'administration :
  vérifier qu'aucun outil n'affiche cette clé avant de la retirer.
- **Recommandation.** Supprimer les vestiges (nettoyage sans risque).

---

## Les trois plus faciles à finir

1. **Alerte VIP** (`VIP_PUSH_ENABLED`) : 10 lignes déjà écrites et testées, un seul SMS par fenêtre de
   15 minutes, aucun fournisseur à ajouter. Il suffit de confirmer que le numéro du gérant est collecté.
2. **Alertes d'usage** (`USAGE_ALERTS_ENABLED`) : complètes et internes ; il faut choisir deux budgets.
3. **Anonymisation RGPD** (`RGPD_ANONYMIZATION_ENABLED`) : complète pour les réservations et sans effet
   avant mai 2028 ; le vrai travail (étendre aux fiches client) peut venir ensuite.

Mention : **Expériences** sont la seule grosse fonction que je recommande de finir, parce que c'est la seule
avec un parcours payant déjà écrit de bout en bout.

## Les trois plus faciles à supprimer

1. **Pré-réflexion du LLM** (`SPECULATIVE_LLM_ENABLED`) : le code est déjà parti, il reste des vestiges.
2. **Connecteurs caisse** (`POS_CONNECTORS_ENABLED`) : un module isolé, sans interface, sans fournisseur.
3. **CRM groupe multi-site** (`CUSTOMER_GROUPS_ENABLED`) : un petit module isolé, sans interface, et la
   seule fonction dont le risque (RGPD inter-sites) dépasse la valeur actuelle.

Viennent ensuite, un peu plus lourds mais sans enjeu externe : Canaux partenaires (distribution) et
Événements (moteur de jauge en doublon avec les expériences).

## Ce que je n'ai pas pu vérifier

- Les comptes de lignes dans les tables de ces fonctions en production (aucun accès à la base).
- Si le webhook `reservation-payments` ou la destination Connect des expériences est enregistré chez Stripe.
- Si une page de tarifs, un contrat ou un document commercial hors dépôt promet l'une de ces fonctions.
- Les durées de « finir » : ce sont des ordres de grandeur d'après la taille de ce qui manque.
