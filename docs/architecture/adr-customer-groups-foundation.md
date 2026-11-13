# ADR — Socle CRM groupe et identité multi-site

- **Date :** 2026-09-14
- **Statut :** livré localement, activation bloquée
- **Décideurs :** produit Suppernote / équipe API

## Contexte

Le plan Multi-site doit pouvoir reconnaître un même client dans plusieurs établissements sans
déplacer les projections CRM historiques ni exposer une note privée d'un site à un autre. La donnée
partagée est sensible : un rapprochement implicite ou une activation fournisseur prématurée créerait
un risque RGPD et un risque d'accès inter-tenant.

## Décision

Le socle introduit deux modèles additifs :

- `CustomerGroupProfile` porte l'identité nommée au niveau `RestaurantAccount`, son état de
  consentement (`UNKNOWN`, `OPTED_IN`, `OPTED_OUT`) et un hash de l'acteur créateur ;
- `CustomerGroupMembership` relie explicitement un `Customer` à un groupe, en conservant
  `accountId`, `restaurantId`, la source et une confiance bornée.

`Customer.restaurantId` ne change jamais. La clé primaire composite du membership est
`(groupProfileId, restaurantId, customerId)` et un index unique `(accountId, customerId)` interdit
qu'un client soit simultanément rattaché à deux groupes du même compte. L'identifiant retourné par
l'API est un hash stable de cette clé composite, car le modèle ne possède pas de clé `id` distincte.

Le service vérifie le compte et le site actif avant chaque lecture ou écriture. Un lien n'est accepté
qu'après un consentement `OPTED_IN`; la confiance et la source sont normalisées et bornées. Un
`OPTED_OUT` supprime tous les memberships du groupe dans la même transaction que la mise à jour du
consentement. Une collision d'insertion concurrente est relue sur l'index unique pour rester
idempotente dans le même groupe ou retourner un conflit dans un autre.

Les routes `/customer-groups*` exigent `requireOrg`, `customers.group` (Multi-site uniquement), un
rôle Owner/Manager et `CUSTOMER_GROUPS_ENABLED=true`. Le changement de consentement est Owner-only.
Les vues de détail ne retournent que les quatre derniers chiffres du téléphone ; aucun payload brut,
secret ou copie de téléphone n'est écrit au niveau groupe.

## Conséquences

- Les projections par établissement restent compatibles avec les routes CRM existantes.
- Les erreurs de compte, de site, de consentement et de conflit sont explicites et testables.
- Le socle peut être activé par pilote sans appeler un fournisseur externe.
- Un rapprochement automatique, les identités Clerk réelles, les campagnes consolidées et le
  parcours export/effacement multi-sites restent volontairement hors périmètre.

## Porte de sortie avant activation

1. tester deux organisations et deux identités Clerk réelles, avec membre limité à un site ;
2. prouver l'export et l'effacement de toutes les projections liées ;
3. documenter une règle de rapprochement revue par un opérateur et un mécanisme de dissociation ;
4. mesurer les doublons, l'accès inter-site et les suppressions dans un pilote sandbox ;
5. ouvrir le flag uniquement après revue RGPD et mise à jour du registre de gates.
