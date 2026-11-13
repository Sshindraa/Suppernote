# Runbook — Stripe Billing (abonnements Sokar)

> **Grille des nouvelles souscriptions — 14 octobre 2026.**
> Essential 199 €/mois, Pro 299 €/mois, Multi-site 299 €/mois (premier établissement inclus)
>
> - 99 €/établissement supplémentaire ; remise annuelle de 10 %. Les anciens prix et
>   abonnements sont conservés sans migration. La configuration doit être vérifiée avant ouverture.

## Parcours

1. Le visiteur choisit une formule dans `/pricing`.
2. Clerk crée le compte et l'organisation restaurant.
3. Le dashboard appelle `POST /billing/checkout-session` avec `plan` (`essential`, `pro`, `multi-site`) et `billing` (`monthly`, `annual`). Pour un compte multi-site, seul `OWNER` peut lancer le Checkout.
4. L'API crée (ou réutilise) le client Stripe au niveau du compte et renvoie l'URL Checkout hébergée. L'adresse vérifiée du propriétaire Clerk sert d'adresse de facturation ; `managerEmail` reste le repli pour les comptes historiques sans adresse propriétaire vérifiée. Si elle change, le client Stripe est synchronisé et toute session Checkout ouverte avec l'ancienne adresse est expirée. Une clé `Idempotency-Key` client est acceptée ; à défaut, Sokar en génère une au niveau du compte/formule/cadence sur une fenêtre de 24 heures. Les tentatives sont conservées sur le site principal.
5. `checkout.session.completed` puis `customer.subscription.*` mettent à jour le plan, `RestaurantBilling` et la projection `RestaurantAccountBilling` (`siteCount`).
6. Le propriétaire peut appeler `POST /billing/portal-session` pour ouvrir le portail Stripe hébergé et gérer la formule, les factures ou la résiliation.
7. Le dashboard appelle `GET /billing/status` pour afficher l'état de l'abonnement, la cadence, la prochaine échéance et une éventuelle période de grâce ou résiliation programmée. La réponse ne contient aucun identifiant Stripe.
8. Les événements Stripe sont inscrits dans `StripeWebhookEvent` avant mutation ; un doublon traité est ignoré, un événement ancien est ignoré et un traitement concurrent provoque un retry Stripe.

Les événements `invoice.payment_failed`, `invoice.paid` et
`invoice.payment_succeeded` synchronisent aussi le statut d'abonnement. Un
échec passe le compte en `past_due` et conserve ses droits pendant la période
de grâce configurée dans Stripe ; un paiement ultérieur repasse le compte en
`active`. Une annulation demandée depuis le portail conserve
`cancel_at_period_end` et le plan jusqu'à la fin de la période : seul
`customer.subscription.deleted` rétrograde le compte vers Essential. Aucun
remboursement automatique n'est déclenché pour une annulation en milieu de
période.

La carte bancaire n'est jamais collectée par le dashboard Sokar. Les URLs de retour sont dérivées de `DASHBOARD_URL`.

## Essai gratuit et suspension

Décision du 16 octobre 2026 : un premier abonnement commence par **14 jours offerts, sans carte**
(`TRIAL_DAYS`, `packages/shared/src/plan.ts`).

- Checkout : `payment_method_collection: if_required`, `subscription_data.trial_period_days` et
  `trial_settings.end_behavior.missing_payment_method: cancel`. Un compte qui a déjà eu un abonnement
  (`stripeSubscriptionId` présent) paie dès le premier jour : un seul essai par compte.
- La session porte `metadata.trial=true` : le webhook `checkout.session.completed` enregistre
  `trialing`, pas `active`.
- Onboarding : un seul bouton, « Démarrer mon essai gratuit » (`POST /billing/trial`), démarre
  l'essai sur la formule choisie (formule, cadence, nombre d'établissements) sans passer par
  Checkout, puisqu'aucune carte n'est demandée (abonnement Stripe créé par l'API, mêmes réglages,
  metadata `source=onboarding`). Aucun compte n'utilise donc Sokar hors essai ou abonnement. 409 si
  un abonnement est en cours ou si l'essai a déjà servi.
- Pendant l'essai, le restaurateur ajoute sa carte depuis le portail (« Gérer l'abonnement »). Le
  dashboard affiche un bandeau les 5 derniers jours.
- Sans carte au jour 15, Stripe supprime l'abonnement (`customer.subscription.deleted`) : le compte
  passe `canceled`. **Suspension** : un compte dont l'abonnement a existé puis s'est terminé
  (`canceled`, `incomplete_expired`, `unpaid`) est suspendu. Aucune session vocale : la ligne du
  restaurant pouvant encore être renvoyée vers Suppernote, Suppernote décroche, lit « Bonjour, vous êtes bien
  chez … Nous ne pouvons pas prendre votre appel pour le moment… » puis raccroche
  (`voice/suspended-call.ts`). Le dashboard affiche « Réactiver mon assistant » ; e-mail de coupure,
  dashboard et réglages rappellent de désactiver le renvoi. `past_due` ne suspend pas : Stripe
  retente le paiement.
- Les comptes qui n'ont jamais eu d'abonnement (pilotes, Chez Suppernote, comptes antérieurs à l'essai
  direct) ne sont pas suspendus.
- Réactivation : un nouveau Checkout depuis `/pricing`, sans nouvel essai. Le webhook repasse le
  compte `active` et l'agent décroche à nouveau.
- Échec de lecture du statut : le service continue (fail-open), un appel n'est jamais coupé à cause
  d'une erreur de base de données.
- E-mails (file `billing-notifications`, une fois par abonnement et par type) :
  - **J-3** sur `customer.subscription.trial_will_end` : bilan de l'essai (appels décrochés,
    réservations, couverts) et lien « Ajouter ma carte ». Sans appel reçu, l'e-mail signale un renvoi
    de ligne probablement absent. Rien n'est envoyé si une carte est déjà enregistrée ou si l'essai
    est déjà converti.
  - **Coupure** sur `customer.subscription.deleted` : l'assistant ne répond plus, bilan, lien
    « Réactiver mon assistant » (`/pricing`). Rien n'est envoyé si le compte a été réactivé entre-temps.
  - Destinataire : `managerEmail`, sinon l'adresse du propriétaire du compte. Aucune adresse dans les
    journaux ; coût suivi en `billing_notification`.
  - Le point de réception Stripe de l'abonnement doit écouter `customer.subscription.trial_will_end`.

## Configuration

Créer les huit prix récurrents dans le compte Stripe correspondant à l'environnement (six prix de base et deux add-ons Multi-site), puis renseigner dans `apps/api/.env` :

```text
STRIPE_PRICE_ESSENTIAL_MONTHLY=price_...
STRIPE_PRICE_ESSENTIAL_ANNUAL=price_...
STRIPE_PRICE_PRO_MONTHLY=price_...
STRIPE_PRICE_PRO_ANNUAL=price_...
STRIPE_PRICE_MULTI_SITE_MONTHLY=price_...
STRIPE_PRICE_MULTI_SITE_ANNUAL=price_...
STRIPE_PRICE_MULTI_SITE_ADDON_MONTHLY=price_...
STRIPE_PRICE_MULTI_SITE_ADDON_ANNUAL=price_...
```

Les valeurs doivent être des identifiants Stripe `price_...`. Pour la migration cible, les montants
attendus sont :

| Prix                             | Mensuel HT | Annuel HT (-10 %) |
| -------------------------------- | ---------: | ----------------: |
| Essential                        |   199,00 € |        2 149,20 € |
| Pro                              |   299,00 € |        3 229,20 € |
| Multi-site (base)                |   299,00 € |        3 229,20 € |
| Multi-site (site supplémentaire) |    99,00 € |        1 069,20 € |

Les prix `MULTI_SITE` couvrent la base ; les prix `MULTI_SITE_ADDON` couvrent chaque établissement
supplémentaire. Le checkout reçoit `siteCount` (minimum 1, 2 par défaut, maximum 100) et ajoute une ligne
Stripe pour les établissements supplémentaires, quantité `siteCount - 1` (aucune ligne addon pour un seul établissement). Tant qu'une valeur manque, l'API renvoie
`503 BILLING_NOT_CONFIGURED` et aucune session n'est créée. La commande
`scripts/ops/sync-env.sh stripe-prices` ne crée pas ces prix ; elle contrôle le catalogue avant de publier les `priceId`.

Les identifiants de prix sont conservés comme variables GitHub Actions non secrètes (`STRIPE_STAGING_*` et `STRIPE_PRODUCTION_*`). Chaque déploiement les synchronise dans le fichier `.env` du VPS avant le build ; une variable manquante ou invalide bloque le déploiement au lieu de publier une API partiellement configurée. La clé Stripe (`STRIPE_SECRET_KEY`) reste, elle, un secret géré séparément.

### Contrôle automatique du catalogue

`scripts/ops/verify-stripe-catalog.mjs` lit chaque `price_...` côté Stripe et compare montant, devise,
cadence et état au catalogue partagé `packages/shared/src/pricing-catalog.cjs` (199/299/299 + 99 €, annuel −10 %). Il est en **lecture seule**
côté Stripe. `scripts/ops/sync-env.sh stripe-prices` vérifie toujours le catalogue (le checkout est ouvert en
permanence, le drapeau `BILLING_CHECKOUT_ENABLED` est retiré depuis le 23/10/2026) :
le script vérifie le catalogue dans un fichier temporaire et échoue avant toute publication si un `priceId` pointe vers
l'ancien tarif 149/249 €, si le script de contrôle est absent ou si Stripe est indisponible.

```zsh
node --env-file=apps/api/.env scripts/ops/verify-stripe-catalog.mjs
# → tableau des huit prix, puis « N prix non conformes » et code retour 1 en cas d'écart
```

Les montants annuels sont contrôlés eux aussi, sans surcharge de montant par environnement.
L’affichage public arrondit uniquement l’équivalent mensuel ; l’inscription et Checkout
présentent le montant exact. Pour N sites : 29900 + (N−1)×9900 centimes par mois,
322920 + (N−1)×106920 centimes par an. La version du catalogue entre dans la clé
Checkout pour qu’un nouveau parcours ne réutilise pas une session de l’ancienne grille.

### Provisionnement idempotent de la grille v3

Les prix Stripe étant immuables, `scripts/ops/provision-stripe-catalog.mjs` crée la grille v3 sur
les produits existants, avec une `lookup_key` stable, sans modifier ni archiver les anciens prix.
Les souscriptions historiques conservent donc leur prix ; seules les nouvelles souscriptions
utilisent les nouveaux `priceId` après synchronisation. La commande lit les huit
`STRIPE_PRICE_*` actuels pour retrouver les produits sources et exige des prix EUR, HT
(`tax_behavior=exclusive`) et récurrents à l'intervalle attendu.

```zsh
# Aperçu sans mutation (avec les priceId source dans l'environnement)
node --env-file=apps/api/.env scripts/ops/provision-stripe-catalog.mjs

# Compte test : réutilise les trois mensuels inchangés et crée ou retrouve les cinq nouveaux prix, puis affiche les variables à synchroniser
node --env-file=apps/api/.env scripts/ops/provision-stripe-catalog.mjs --apply --env
```

La création est protégée par `--apply`. Avec une clé `sk_live_`, elle exige en plus
`--allow-live` et `STRIPE_ALLOW_LIVE_CATALOG_MUTATION=CREATE_SOKAR_CATALOG_V3`; cette double
garde évite de créer un catalogue live par erreur. Reporter ensuite les huit valeurs dans les
variables GitHub de l'environnement concerné, lancer `verify-stripe-catalog.mjs`, puis seulement
déployer. Ne jamais archiver les prix historiques tant qu'une souscription peut encore les référencer.

## Catalogue Stripe test/live du 14 octobre 2026

Les huit prix de chaque environnement ont été relus côté Stripe : montants exacts, EUR,
HT, cadence, état actif, association à l’offre et même produit pour les deux cadences.
Les cinq prix de la nouvelle grille sont créés de manière additive ; les trois mensuels
inchangés gardent leur identifiant. Cinq Checkout annuels sandbox (Essential, Pro et
Multi-site 1/2/3 établissements) confirment les sous-totaux attendus ; ils ont été expirés
sans paiement ni création d’abonnement.

| Variable (suffixe STRIPE*PRICE*) | Test                             | Production                       |
| -------------------------------- | -------------------------------- | -------------------------------- |
| ESSENTIAL_MONTHLY                | `price_1UI9zCHCZZuqZF0hNqTNnY1v` | `price_1UICsZH4TS0ZYIJnPcPew0Co` |
| ESSENTIAL_ANNUAL                 | `price_1UQELbHCZZuqZF0hQD3CBkH3` | `price_1UQELvH4TS0ZYIJn1QbFxGef` |
| PRO_MONTHLY                      | `price_1UI9zEHCZZuqZF0hpNCsSA6e` | `price_1UICsbH4TS0ZYIJn3HyLxaul` |
| PRO_ANNUAL                       | `price_1UQELbHCZZuqZF0hAFXMqgaS` | `price_1UQELvH4TS0ZYIJnd1OyrkKZ` |
| MULTI_SITE_MONTHLY               | `price_1UQELcHCZZuqZF0h0g3J1et9` | `price_1UQELwH4TS0ZYIJnAfVOMIDv` |
| MULTI_SITE_ANNUAL                | `price_1UQELcHCZZuqZF0hodbuPFHe` | `price_1UQELwH4TS0ZYIJnpTL6GIVh` |
| MULTI_SITE_ADDON_MONTHLY         | `price_1UI9zGHCZZuqZF0hC3xNNmsW` | `price_1UICseH4TS0ZYIJn0z9WoP0d` |
| MULTI_SITE_ADDON_ANNUAL          | `price_1UQELdHCZZuqZF0hBBUgrRNS` | `price_1UQELxH4TS0ZYIJnof7S3O3p` |

### Contrôle du 16 octobre 2026

- `verify-stripe-catalog.mjs` exécuté sur le VPS avec le `.env` staging (`sk_test_`) puis prod
  (`sk_live_`, lecture seule) : 8/8 conformes dans chaque environnement. Les `priceId` déployés
  sont exactement ceux du tableau ci-dessus.
- Rejeu sandbox mensuel sur un client test jetable : Checkout et aperçu de facture
  (`invoices.createPreview`) donnent Essential 199,00 €, Pro 299,00 €, Multi-site 3 sites 497,00 €
  (299 + 2 × 99). Sessions expirées sans paiement, client supprimé, aucun abonnement créé.
- Portail, **compte test uniquement** (accord de Hamza : « Oui, active le changement de formule
  dans le portail client Stripe, en test d'abord. ») : la configuration par défaut
  `bpc_1UD3ilHCZZuqZF0hp2KK2EqF` a maintenant `subscription_update` activé avec
  `default_allowed_updates: ["price"]`, `proration_behavior: create_prorations` et les produits
  Essential et Pro (mensuel + annuel). Multi-site est exclu : un abonnement à deux lignes (base +
  addon) ne passe pas par le portail, et `siteCount` vient de la metadata Checkout ; pas de
  `quantity` pour la même raison. Retour arrière : `enabled: false`,
  `default_allowed_updates: []`, `proration_behavior: none`. Le live n'est pas modifié.
- Correctif requis avant toute ouverture en live : `handleSubscriptionEvent` donnait la priorité à
  `metadata.plan` (posée par Checkout) sur le prix. Un changement Essential → Pro dans le portail
  change le prix sans toucher la metadata, et le compte restait en Essential. Rejeu sandbox
  Essential → Pro sur un client jetable : l'événement réel `customer.subscription.updated` porte le
  prix Pro et `metadata.plan=essential` ; prochaine facture −199 € (prorata) + 299 € + 299 €.
  Rejoué contre le handler local : `STARTER` sans correctif, `PRO` avec. Le prix résolu passe
  désormais en premier, la metadata ne sert plus qu'aux prix historiques. Test unitaire ajouté.
  Client et abonnement de test supprimés. Le correctif doit être déployé en staging avant de
  rejouer le parcours depuis le dashboard, puis avant toute activation live.
- Portail **live** (accord de Hamza, après déploiement de #460 en staging et production sur
  `b73075bc`) : le compte live n'avait aucune configuration de portail. Configuration créée par
  appel Stripe et devenue la configuration par défaut du compte :
  `bpc_1URDivH4TS0ZYIJntZnMNCxw`, repérée par sa metadata `sokar_key` = `portal-v1`. Mêmes réglages qu'en test : changement de prix Essential et Pro (mensuel +
  annuel, `create_prorations`), Multi-site exclu, pas de `quantity` ; mise à jour carte et
  coordonnées, historique des factures, résiliation en fin de période avec motif. Retour arrière :
  `subscription_update.enabled: false` sur cette configuration. Aucun abonné live à ce jour : pas de
  rejeu de bout en bout en live.
- Contrôle live sans paiement (client jetable, `invoices.createPreview`, aucun moyen de paiement ni
  abonnement, client supprimé) : Essential 199,00 € / 2 149,20 €, Pro 299,00 € / 3 229,20 €,
  Multi-site 3 sites 497,00 € / 5 367,60 € (mensuel / annuel). Session de portail live créée sur
  `bpc_1URDivH4TS0ZYIJntZnMNCxw`. Aucune TVA n'est calculée, volontairement : Sokar est en franchise
  en base de TVA (décision du 16 octobre 2026). Les factures portent « TVA non applicable, art. 293 B
  du CGI » via `invoice_settings.footer` du client Stripe (`VAT_MENTION`, PR #462 ; clients
  existants mis à jour en live et en test). À revoir si le statut TVA change.
- Abonnés existants : aucune ligne `RestaurantBilling` de production n'a de
  `stripeSubscriptionId`. Aucun abonnement historique n'est à migrer ; la règle reste de ne jamais
  migrer ni archiver un ancien prix sans décision explicite.

### Rollback de cette grille

Le rollback applicatif ne restaure pas les variables Stripe. Avant de revenir à la release
précédente, remettre les cinq variables GitHub et `.env` ci-dessous, puis redémarrer l’API
avec les artefacts précédents suivant `rollback.md`. Les trois mensuels réutilisés restent
identiques. Ne jamais migrer les abonnements ni archiver les prix lors du rollback.

| Suffixe                 | Ancien test                      | Ancien production                |
| ----------------------- | -------------------------------- | -------------------------------- |
| ESSENTIAL_ANNUAL        | `price_1UI9zDHCZZuqZF0hes92HYpo` | `price_1UICsaH4TS0ZYIJnL3W0Dtvx` |
| PRO_ANNUAL              | `price_1UI9zEHCZZuqZF0hVpM3e17h` | `price_1UICscH4TS0ZYIJnAX8zHdza` |
| MULTI_SITE_MONTHLY      | `price_1UI9zFHCZZuqZF0hiCaVcLrY` | `price_1UICscH4TS0ZYIJnGUALBfl0` |
| MULTI_SITE_ANNUAL       | `price_1UI9zFHCZZuqZF0hWveFh12a` | `price_1UICsdH4TS0ZYIJnRMkPCYYz` |
| MULTI_SITE_ADDON_ANNUAL | `price_1UI9zHHCZZuqZF0h3AsrGxXZ` | `price_1UICseH4TS0ZYIJnZMkSr5b7` |

## Réconciliation du catalogue — porte P1_ESSENTIAL

**Livré le 22 septembre 2026.** Le catalogue live contient huit prix conformes
à la grille 199/299/249 + 99 €, avec cadence mensuelle et annuelle. La commande
de contrôle a retourné `8/8 conformes` avant l'ouverture du checkout.

Pour une nouvelle grille, conserver la séquence ci-dessous en lecture seule puis
mettre à jour la preuve de release ; ne jamais modifier un Price existant.

1. Réutiliser les prix mensuels Essential, Pro et addon inchangés. Créer dans Stripe (test puis live)
   le nouveau mensuel Multi-site et les quatre annuels aux montants du tableau ci-dessus, en EUR, intervalles `month`/`year` et `interval_count = 1`.
2. Renseigner les huit variables GitHub Actions (`STRIPE_STAGING_*`, `STRIPE_PRODUCTION_*`) avec les
   `priceId` obtenus — jamais la clé secrète.
3. Vérifier avant tout déploiement : `node --env-file=apps/api/.env scripts/ops/verify-stripe-catalog.mjs`.
4. Le déploiement refuse de synchroniser des prix non conformes, donc un catalogue à l'ancien tarif
   ne peut pas être activé par inadvertance.

## Rejeu du cycle complet en sandbox — porte P1_ESSENTIAL

**Livré le 21 septembre 2026.** Le rejeu sandbox complet est conservé dans
[`docs/audits/2026-09-21-billing-replay.md`](../audits/2026-09-21-billing-replay.md).
Le tableau reste la procédure de référence pour rejouer le parcours après une
modification Stripe ; conserver les preuves (captures, identifiants d'événements)
dans `docs/audits/`.

| Étape                      | Ce qui est vérifié                                                           | Preuve attendue                             |
| -------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------- |
| 1. Checkout Essential      | redirection, montant 199 €, client Stripe créé                               | capture + `checkout.session.completed`      |
| 2. Souscription active     | `GET /billing/status` renvoie `essential`, cadence et échéance               | réponse JSON                                |
| 3. Facture                 | facture au bon montant, `invoice.paid` traité                                | capture Stripe + ligne `StripeWebhookEvent` |
| 4. Portail                 | ouverture du portail, changement de formule                                  | capture                                     |
| 5. Échec de paiement       | `invoice.payment_failed` → `past_due`, droits conservés                      | réponse `/billing/status`                   |
| 6. Grâce puis recouvrement | paiement suivant → retour `active`                                           | captures                                    |
| 7. Annulation              | `cancel_at_period_end` puis `customer.subscription.deleted` → rétrogradation | réponses `/billing/status`                  |
| 8. Réactivation            | second Checkout possible après annulation                                    | capture                                     |

Le checkout est ouvert en production depuis le 22 septembre
2026 (drapeau `BILLING_CHECKOUT_ENABLED`, retiré depuis le 23/10/2026), après ces huit étapes et la vérification du catalogue.

Le dernier rejeu sandbox est archivé dans
[`docs/audits/2026-09-21-billing-replay.md`](../audits/2026-09-21-billing-replay.md), avec les
identifiants Stripe de test, les états `/billing/status` et le traitement du ledger webhook.

### Migration des abonnements historiques

Les abonnements restent sur leur `priceId` d'origine après une hausse de tarif : Stripe ne permet pas
de modifier un Price existant. La migration additive
`20260921164000_subscription_billing_interval` conserve donc leur cadence dans les projections
Sokar, au lieu de la déduire des seuls prix actuellement proposés. Après `prisma migrate deploy`,
exécuter le backfill en lecture seule puis avec `--apply` sur chaque environnement :

```zsh
pnpm --filter @suppernote/api ops:billing-interval-backfill
pnpm --filter @suppernote/api ops:billing-interval-backfill -- --apply
```

Le script lit les objets Price Stripe et ne modifie que les projections dont la cadence est absente.

### Événements webhook requis

L'endpoint Stripe de chaque environnement doit conserver les événements déjà utilisés par les cartes
cadeaux **et** recevoir `checkout.session.completed`, `customer.subscription.created|updated|deleted`,
`invoice.paid`, `invoice.payment_failed` et `invoice.payment_succeeded`. Sans les trois événements de
facture, Checkout peut réussir tandis qu'un échec ou un recouvrement ne met jamais à jour les droits.

```zsh
STRIPE_WEBHOOK_ENDPOINT_URL=https://api-staging.suppernote.com/webhooks/stripe \
  node --env-file=apps/api/.env scripts/ops/ensure-stripe-webhook-events.mjs

# Compte test : ajoute seulement les événements manquants, en préservant les autres.
STRIPE_WEBHOOK_ENDPOINT_URL=https://api-staging.suppernote.com/webhooks/stripe \
  node --env-file=apps/api/.env scripts/ops/ensure-stripe-webhook-events.mjs --apply
```

Pour le compte live, la même commande exige aussi `--allow-live` et
`STRIPE_ALLOW_LIVE_WEBHOOK_MUTATION=ENSURE_SOKAR_BILLING_EVENTS`.

### Ordre des événements et même seconde

Stripe ne garantit ni l'ordre de livraison ni un ordre chronologique des identifiants
d'événement, et plusieurs instantanés d'un même abonnement peuvent partager la même seconde
(`created`). La recette du 21 octobre 2026
([audit](../audits/2026-10-21-billing-trial-recipe.md)) l'a montré sur une fin d'essai
anticipée : activation, deux factures et rappel d'essai à la même seconde, le rappel l'emportant
par ordre alphabétique et laissant Sokar en `trialing`.

Règles appliquées par `billing.service.ts` :

- un événement plus ancien que le dernier appliqué (seconde `created` inférieure) est ignoré ;
- à seconde égale, aucun départage par identifiant : Sokar relit l'abonnement chez Stripe
  (`subscriptions.retrieve`) et projette son état actuel, pour les événements d'abonnement comme
  de facture. Si cette lecture échoue, le webhook échoue et Stripe le relivre ;
- `customer.subscription.trial_will_end` ne sert qu'au courriel de rappel (revérifié à l'envoi)
  et ne modifie jamais le statut, la formule ni le point de reprise.

### Réparer un dossier décalé

Un dossier traité avant ce correctif peut garder un statut différent de Stripe ; rejouer
l'événement ne suffit pas, car il est déjà marqué traité. Le script compare chaque dossier
facturé à l'abonnement Stripe et, avec `--apply` seulement, reprojette l'état Stripe sans
avancer le point de reprise des webhooks. Sa sortie ne contient que des identifiants et des
statuts.

```zsh
cd /opt/sokar/apps/api   # ou /opt/sokar-staging/apps/api
# 1. Lecture seule : liste les écarts.
./node_modules/.bin/tsx scripts/reconcile-stripe-billing.ts --dry-run
# 2. Un dossier précis, après contrôle de l'écart.
./node_modules/.bin/tsx scripts/reconcile-stripe-billing.ts --restaurant-id <id> --apply
```

Avant `--apply` en production : sauvegarder la base (`scripts/ops/db-backup.sh`), vérifier dans
le tableau de bord Stripe que l'abonnement listé est bien dans l'état annoncé, et réparer dossier
par dossier. La réparation met aussi à jour la formule du restaurant et du compte selon le prix
de l'abonnement (retour à `STARTER` si l'abonnement est annulé).

## Pilotes Essential — porte P1_ESSENTIAL

**Reste ouvert.** Deux restaurants, sept jours, avec au minimum : consentement
du restaurateur, captures des écrans clés, métriques (appels, réservations,
incidents, statut de paiement) et décision GO/NO-GO signée. La fiche de pilote
va dans `docs/audits/` et la porte `P1_ESSENTIAL` de
`docs/release/product-gates.json` ne passe à `CLOSED` qu'avec ces preuves.

Sur staging uniquement, le workflow injecte au build `NEXT_PUBLIC_DEMO_RESTAURANT_ID` (l'identifiant du restaurant de démonstration `chez-suppernote-demo`) et `NEXT_PUBLIC_DEMO_STAGING=1`. Le dashboard peut ainsi charger les données de démo sans session Clerk pendant les tests Checkout. Ces variables ne sont jamais injectées en production ; le dashboard de production reste toujours derrière l'authentification.

Le secret `STRIPE_WEBHOOK_SECRET` existant doit rester configuré sur le même endpoint `POST /webhooks/stripe`. Les événements d'abonnement à activer sont :

- `checkout.session.completed`
- `customer.subscription.created`
- `customer.subscription.updated`
- `customer.subscription.deleted`
- `invoice.paid`
- `invoice.payment_failed`
- `invoice.payment_succeeded` (compatibilité avec les anciennes versions de l'API Stripe)

La migration additive `20260907110000_harden_stripe_billing` ajoute les tentatives Checkout, les checkpoints de séquencement et le ledger des événements. Elle doit être appliquée avant de publier l'API qui utilise ces colonnes :

```bash
pnpm --filter @suppernote/database migrate:deploy
```

Le champ `Restaurant.plan` est une projection des événements Billing. Les routes restaurant ne l'acceptent plus en mutation ; un changement de formule doit venir de Stripe ou d'une opération Sokar explicitement autorisée.

Une signature absente ou invalide renvoie `400`. Une erreur après vérification de signature renvoie `500` afin que Stripe réessaie. Les événements inconnus sont acquittés après journalisation.

## Preuve staging du 7 septembre 2026

La release `main@d53916c` a été publiée après CI, smoke tests, rollback/restauration et E2E staging verts. Le dashboard staging a créé le site secondaire `Sokar Lyon Test`, conservé ce site dans le sélecteur et chargé ses paramètres après changement de contexte. Le portail Stripe sandbox ouvert depuis le secondaire a affiché la souscription Multi-site avec deux suppléments d'établissement (447 €/mois), la facture payée du 27 août et la carte de test `4242`. Aucun paiement ni résiliation n'a été déclenché pendant cette vérification.

Le backfill account/site staging a été exécuté après un dry-run : 10 candidats détectés, 10 restaurants migrés. Le script doit recevoir `DATABASE_URL` depuis `apps/api/.env` sur le VPS, car `packages/database/.env` n'y est pas présent :

```bash
cd /opt/sokar-staging
set -a
. apps/api/.env
set +a
pnpm --filter @suppernote/database backfill:restaurant-accounts
```

La commande reste en dry-run par défaut ; ajouter `-- --apply` uniquement après vérification du rapport et de la sauvegarde de release.

La vérification du webhook signé a ensuite utilisé un événement test `customer.subscription.updated` récupéré depuis Stripe : le payload signé a été envoyé deux fois à `POST /webhooks/stripe` et les deux appels ont répondu HTTP 200 avec `received=true` et sans erreur. Le même payload avec une signature `v1` invalide a répondu HTTP 400 `Webhook signature verification failed`. Aucun Checkout, paiement ou débit supplémentaire n'a été créé pendant ce test. Cette preuve valide la vérification HMAC et l'acquittement idempotent observables au niveau HTTP ; elle ne remplace pas encore la qualification des règles annuel, taxes, prorata, période de grâce et dépassement de quota.

Une lecture Stripe en mode read-only du 7 septembre 2026 confirme que les quatre prix annuels alors
actifs en production (mode live) et staging (mode test) restent ceux de l'ancien catalogue :
Essential 1 430,40 €/an, Pro 3 229,20 €/an, Multi-site 3 229,20 €/an et add-on Multi-site
1 069,20 €/an par établissement supplémentaire. Cette preuve historique ne valide pas la nouvelle
grille 199/299 ; elle doit être remplacée après création des nouveaux prix, synchronisation des
`priceId`, Checkout, facture, taxes, prorata, période de grâce et renouvellement en sandbox.
Remplacée par le contrôle du 16 octobre 2026 ci-dessus pour les prix, le Checkout et la facture.

## Test sans paiement

En local, utiliser des clés `sk_test_...` et les huit prix de test. Les tests automatisés couvrent la validation du parcours, la création de Checkout, les transitions d'abonnement et la reprise après échec de paiement. Ne jamais mettre une clé live ou un prix live dans le dépôt.
