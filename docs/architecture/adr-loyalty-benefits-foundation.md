# ADR — Fondation des avantages fidélité opérationnels

- **Date :** 2026-09-14
- **Statut :** version manuelle ouverte aux offres Pro et Multi-site
- **Décideurs :** produit Suppernote / équipe API

## Contexte

Le plan Pro à 299 € doit pouvoir transformer les données CRM en attentions exécutables par une
équipe de salle. Un programme de points complet introduirait immédiatement une comptabilité de
points, des règles de cumul, des remboursements et des risques d'abus. La première capacité utile
est plus petite : définir quelques avantages explicables, les émettre à un client éligible et
prouver leur consommation.

Cette capacité doit rester provider-neutral. Aucun SMS, email, WhatsApp, coupon externe, paiement ou
connecteur POS ne doit être déclenché par la fondation. Les coûts affichés sont des estimations
opérationnelles et ne constituent pas une promesse de marge.

## Décision

Nous introduisons deux modèles additifs :

- `LoyaltyBenefit` est le catalogue d'avantages d'un établissement. Il contient une clé stable,
  un nom, une règle unique, une valeur éventuelle, un coût estimé en centimes EUR, une validité et
  un nombre maximal d'utilisations par client ; son état peut être `ACTIVE` ou `INACTIVE`.
- `LoyaltyGrant` est l'émission d'un avantage pour un client. Il conserve l'établissement, le
  bénéfice, le client, une réservation optionnelle, son état (`ISSUED`, `REDEEMED`, `VOID`,
  `EXPIRED`) et les dates d'audit. Il ne conserve jamais le code en clair.

Les règles supportées sont volontairement limitées à `ANY`, `VIP`, `MIN_VISITS`,
`BIRTHDAY_MONTH` et `MIN_ESTIMATED_SPEND`. `MIN_VISITS` utilise les visites honorées projetées ;
`MIN_ESTIMATED_SPEND` compare la dépense estimée des 365 derniers jours en euros aux centimes
configurés. Une réservation fournie lors de l'émission doit appartenir au même établissement et
ne peut pas être annulée ou `NO_SHOW`.

## Codes, idempotence et concurrence

Lors d'une émission, le service génère un code aléatoire de 12 caractères hexadécimaux majuscules.
Le code brut est retourné uniquement dans la réponse de création ; la base conserve
`SHA-256("sokar:loyalty-code:" + code)`. La comparaison au redeem est à temps constant. Une
réponse de liste ne contient donc aucun secret réutilisable.

Les clés d'acteur et d'idempotence sont hashées avant persistance. Un rejeu avec la même clé
retourne le grant existant et `code: null`. La limite `maxUsesPerCustomer` est protégée dans une
transaction PostgreSQL par `pg_advisory_xact_lock` déterministe pour le couple établissement,
client, avantage ; le comptage ne considère que les grants `ISSUED` et `REDEEMED`.

Le redeem effectue une transition atomique `ISSUED → REDEEMED`. Un rejeu d'un grant déjà consommé
retourne son état sans appliquer une seconde consommation. Une course gagnée par une autre
transaction est relue comme un rejeu ; elle ne crée ni double coût ni double événement. Les grants
arrivés à échéance passent à `EXPIRED` avant tout redeem. Le void est réservé à un opérateur et
conserve une note bornée.

## API et contrôle d'accès

Les routes sont montées dans `apps/api/src/modules/loyalty/loyalty.routes.ts` :

- `GET/POST /loyalty/benefits` et `PATCH /loyalty/benefits/:id` pour le catalogue ;
- `GET/POST /loyalty/grants` pour l'audit et l'émission ;
- `POST /loyalty/grants/:id/redeem` et `/void` pour les transitions ;
- `POST /api/internal/loyalty/grants/expire` pour l'expiration opérée par le scheduler.

Les routes de gestion exigent `requireOrg`, la capability `reputation.loyalty` et un établissement actif. Owner et Manager administrent le catalogue et émettent ; Staff peut
consulter et consommer mais ne peut pas créer, modifier ou annuler un avantage. Les identifiants
restent tenant-scoped et le téléphone est limité à ses quatre derniers chiffres dans les listes.

La capability est incluse dans Pro et Multi-site, refusée par Essential. La version manuelle est ouverte.

## Expiration, audit et interface

Le worker BullMQ `loyalty-grant-expiry` traite au plus 1 000 grants toutes les 15 minutes avec une
mise à jour bornée sur `ISSUED` et `expiresAt`. L'opération est rejouable et ne contacte aucun
provider. La page `/dashboard/loyalty` présente le catalogue, les émissions, le coût estimé en
cours, la remise du code à l'opérateur et la consommation atomique. Les états chargement, vide,
erreur, verrouillage et mutations sont testés.

## Ce qui n'est pas livré par cet ADR

Cette fondation ne fournit pas encore :

- un portefeuille de points, des niveaux, du cumul ou une valeur monétaire remboursable ;
- l'envoi automatique de l'avantage par SMS/email/WhatsApp, ni les consentements et plafonds de
  fréquence associés ;
- une déduction sur un ticket POS, un moyen de paiement, une carte cadeau ou un menu prépayé ;
- la reconnaissance temps réel du client à l'accueil, un moteur de règles combinées ou des
  avantages multi-établissements ;
- une preuve de coût réel, un pilote terrain ou une promesse de revenu incrémental.

Les canaux et intégrations externes restent à qualifier séparément dans les portes P8 et P9.

## Migration, rollback et porte de sortie

La migration `20260914180000_loyalty_benefits_foundation` est additive : elle crée uniquement les
enums, tables, index et contraintes des avantages et grants. Un rollback applicatif revient à une
release antérieure ; aucune donnée de carte ou secret externe n'est à révoquer. Une restauration de
base suit le runbook de rollback et une sauvegarde horodatée.

Pour qualifier le parcours en salle et les futures extensions :

1. tester l'émission, l'expiration et le redeem avec des clients réels anonymisés ;
2. faire relire les règles et le coût estimé par un gérant et documenter la procédure en salle ;
3. vérifier les limites de fréquence, le consentement et l'export/effacement RGPD si un canal est
   ajouté ;
4. décider si les bénéfices restent manuels ou s'intègrent à un POS choisi ;
5. joindre les preuves de pilote au registre P8.

## Preuves locales

- migration : `packages/database/prisma/migrations/20260914180000_loyalty_benefits_foundation/` ;
- service : `apps/api/src/modules/loyalty/loyalty.service.ts` ;
- routes et worker : `apps/api/src/modules/loyalty/` ;
- dashboard : `apps/dashboard/src/app/dashboard/loyalty/` ;
- tests API ciblés : 22 ; tests dashboard ciblés : 5 ;
- aucun provider externe n'est appelé pendant cette fondation.
