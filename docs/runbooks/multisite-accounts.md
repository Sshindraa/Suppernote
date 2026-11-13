# Runbook — backfill des comptes multi-site

> **Statut : PARTIEL — audité le 12 septembre 2026.** Modèle compte/site, backfill, sélecteur,
> provisioning et quotas Stripe sont présents. La preuve d'isolation avec deux sessions Clerk et
> un membre limité à un site reste ouverte. Le socle CRM groupe est livré localement mais reste
> fermé par `CUSTOMER_GROUPS_ENABLED=false`. Voir
> [`../DOCUMENTATION_STATUS.md`](../DOCUMENTATION_STATUS.md).

Ce runbook prépare les restaurants historiques à la relation compte → établissement après application de la migration `20260907140000_add_restaurant_accounts`.

Le script ne modifie rien par défaut. Il utilise l'identifiant historique du restaurant comme `clerkOrganizationId`, conserve l'ID du restaurant et marque ce restaurant comme établissement principal.

## Préparation

1. Vérifier le backup PostgreSQL et la possibilité de restauration sur staging.
2. Vérifier que la migration multi-site est appliquée et que `prisma validate` passe.
3. Exécuter la simulation sur l'environnement ciblé :

```sh
pnpm --filter @suppernote/database backfill:restaurant-accounts
```

Pour limiter la simulation à quelques lignes :

```sh
pnpm --filter @suppernote/database backfill:restaurant-accounts -- --limit=2
```

## Application

L'application est une action séparée, effectuée après revue du nombre de candidats :

```sh
pnpm --filter @suppernote/database backfill:restaurant-accounts -- --apply
```

Le script traite chaque restaurant dans une transaction et affiche uniquement le mode, le nombre de candidats et le nombre migré. Il est relançable : les restaurants déjà rattachés sont ignorés.

## Parcours dashboard et API

- `GET /restaurants/sites` retourne uniquement les établissements accessibles au membre courant et le site actif recommandé ; le dashboard conserve ce choix dans un stockage local par organisation.
- Le proxy dashboard transmet `X-Sokar-Site-ID` à chaque requête API. Le serveur résout toujours le compte, le site et le rôle avant d'exécuter une route.
- Un membre `READ_ONLY` peut consulter son périmètre mais reçoit `READ_ONLY_ACCESS` sur toute mutation HTTP ; les opérations de cycle de vie restent réservées à `OWNER`.
- Le propriétaire peut ajouter un site via `POST /restaurants/sites`, modifier son nom ou son statut via `PATCH /restaurants/sites/:id`, et gérer un membre via `/restaurants/sites/:id/members`.
- L’ajout d’un membre vérifie côté serveur `getOrganizationMembershipList` avec l’organisation Clerk de la session. Un utilisateur absent reçoit `CLERK_MEMBER_REQUIRED` (HTTP 422), Clerk indisponible reçoit `CLERK_MEMBERSHIP_UNAVAILABLE` (HTTP 503), et aucune ligne `RestaurantAccountMembership` n’est écrite dans ces deux cas.
- Le Checkout de souscription est réservé au rôle `OWNER`. Depuis un site secondaire, il réutilise le client Stripe et la clé d'idempotence du compte, enregistre le site courant dans les métadonnées et conserve les tentatives sur le site principal.
- Le bouton de paramètres appelle `POST /billing/portal-session` pour ouvrir le portail Stripe hébergé ; il permet de changer de formule, consulter les factures ou résilier sans exposer de données de paiement au dashboard.
- Un ajout est refusé avec `MULTI_SITE_SUBSCRIPTION_REQUIRED` lorsque le quota `RestaurantAccountBilling.entitledSiteCount` est atteint. Les webhooks Stripe projettent le `siteCount` au niveau du compte ; staging a créé un troisième site puis refusé le quatrième hors quota.
- Le site principal ne peut pas être suspendu ou archivé s'il est le dernier établissement actif. S'il existe un autre site actif, la route transfère `isPrimary` au plus ancien site actif dans la même transaction avant de changer le statut. Une suspension/archivage n'efface aucune donnée et les requêtes d'un site indisponible sont refusées par le resolver.

## CRM groupe en qualification

Le capability `customers.group` est réservé au plan Multi-site. Les routes
`/customer-groups*` utilisent le compte et le site résolus par Clerk : elles créent une identité de
groupe, enregistrent un consentement Owner-only et permettent à un Owner/Manager de rattacher une
projection client du site actif. Un client ne peut appartenir qu'à un seul groupe par compte ; une
course d'insertion est idempotente et le retrait de consentement supprime les liens dans la même
transaction. Les réponses de détail ne renvoient que les quatre derniers chiffres du téléphone.

Avant d'ouvrir le flag, exécuter deux sessions Clerk sur deux organisations, vérifier qu'un membre
limité à un site ne lit ni n'écrit l'autre site, puis couvrir l'export et l'effacement de chaque
projection liée. Aucun rapprochement automatique ni campagne consolidée ne doit être activé en
parallèle.

## Contrôles après application

- vérifier que le nombre de restaurants avec `account_id IS NULL` est nul ou documenté ;
- vérifier qu'un compte possède exactement un établissement principal pendant la transition ;
- appeler `GET /restaurants/sites` avec deux organisations Clerk de test ;
- Le préflight Clerk du 8 septembre 2026 confirme deux identités `Admin` dans deux organisations distinctes (`Microsoft` et `Ismail Harrak's Restaurant`) sans invitation croisée. Cette vérification ne remplace pas l’ouverture de deux sessions Suppernote ni le test négatif avec `X-Sokar-Site-ID` ; aucun écrit Clerk n’est requis pour ce préflight.
- L’action Clerk `Impersonate user` a généré un ticket pour la première identité, mais l’ouverture de l’ancien domaine Clerk a été bloquée par la revue de sécurité du navigateur. Ne pas contourner ce blocage : demander deux sessions staging ouvertes manuellement dans des profils séparés, puis reprendre les contrôles ci-dessous.
- Le staging courant n’est pas un environnement de preuve d’isolation : `deploy-staging.yml` injecte `NEXT_PUBLIC_DEMO_STAGING=1` et l’API force alors le restaurant démo. Une tentative transitoire sans démo a été rollbackée ; elle a révélé des `CLERK_SECRET_KEY` API/dashboard différents et un cookie de handshake invalide dans les profils navigateur. Le proxy dashboard prépare désormais un Bearer serveur ; aligner les secrets, ouvrir un dispatch sans démo avec garde-fou anti-promotion, utiliser deux profils frais et supprimer les fixtures après le test.
- appeler `POST /restaurants/sites/:id/members` avec une identité membre réelle de l’organisation puis avec une identité externe ; vérifier la création dans le premier cas et l’absence d’écriture dans le second ;
- vérifier qu'une requête avec `X-Sokar-Site-ID` vers un site non attribué est refusée ;
- vérifier qu'un site suspendu est absent du sélecteur puis réapparaît après réactivation ;
- désactiver le site principal avec un site secondaire actif et vérifier que le secondaire devient principal ; rejouer le cas sans remplacement et vérifier `PRIMARY_SITE_REQUIRED` ;
- conserver le backup et le rapport de migration dans la release ;
- ne pas activer la facturation multi-site sans preuve d'entitlement Stripe, provisioning de deux sites et test d'un membre Clerk limité à un site ; les deux premiers sont maintenant validés sur staging.
