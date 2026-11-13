# Preuve — profil de release scoped `core-operator-foundations`

Date : 2026-09-15  
Profil : `core-operator-foundations`  
Manifest : [`../product-gates.json`](../product-gates.json)

## Décision

La production peut recevoir les fondations déjà livrées : réservations, plan de
salle, liste d'attente, fichier client opérationnel, espace opérateur Suppernote et
suivi interne des coûts par établissement. Le gel commercial 199/299 reste
actif pour les chantiers qui dépendent encore d'un fournisseur, d'un contrat ou
d'un pilote externe.

Cette décision ne change aucun statut de porte et ne transforme pas une preuve
locale en preuve terrain. Elle donne au déploiement un périmètre vérifiable et
réversible au lieu de bloquer les corrections et les fondations prêtes.

## Portes et flags

- Porte requise et fermée : `P0_USAGE`.
- Portes différées : `P1_ESSENTIAL`, `P2_CRM`, `P3_MARKETING`,
  `P4_ATTRIBUTION`, `P5_PAYMENTS`, `P6_POS`, `P7_CUSTOMER_GROUP`,
  `P8_REPUTATION`, `P9_ECOSYSTEM`, `PILOTS`.
- Flags forcés désactivés en production : checkout d'abonnement, CRM avancé,
  envois marketing, POS, paiements de réservation, CRM groupe, réputation,
  fidélité, expériences, événements et distribution. Le control plane Marketing
  Pro (règles, segments, brouillons et previews) est ouvert pour les restaurants
  Pro ; `MARKETING_SENDS_ENABLED` reste fermé, donc aucun fournisseur n'est
  appelé.

Le contrôle `scripts/verify-product-gates.mjs` vérifie la partition exacte des
portes, l'existence de cette preuve et, lorsqu'il est exécuté par
`deploy.sh --env prod`, lit `apps/api/.env` pour refuser tout flag différé à
`true`. Une variable absente conserve le défaut `false` de l'API.

## Expérience restaurateur

Le restaurateur continue de voir son dashboard de réservation et son fichier
client. Il ne voit jamais les coûts fournisseurs, les budgets 70/90/100 ou les
alertes internes : ces surfaces restent protégées dans `/admin` par
`SOKAR_OPERATOR_USER_IDS`. Les écrans Pro affichent leur état verrouillé tant
que le pilote et la configuration externe ne sont pas clos. Les restaurants Pro
peuvent préparer les segments et campagnes ; la programmation et l'envoi restent
bloqués tant que les fournisseurs et le pilote ne sont pas qualifiés.

Le checkout Stripe est également fermé par `BILLING_CHECKOUT_ENABLED=false`.
Le script de synchronisation des prix ignore les identifiants GitHub tant que
ce flag n'est pas explicitement ouvert, ce qui évite une souscription active par
accident pendant la qualification P1.

## Contrôles exécutés

À exécuter dans la release candidate :

```sh
node scripts/verify-product-gates.mjs
bash -n scripts/deploy.sh scripts/ops/sync-stripe-prices.sh
pnpm --filter @suppernote/api typecheck
pnpm --filter @suppernote/api exec vitest run
```

La promotion suit ensuite le chemin habituel : CI verte, déploiement staging,
smoke tests staging, promotion production, snapshot des artefacts et health
checks. En cas d'échec, le rollback applicatif reste disponible via le runbook
de rollback ; aucune migration irréversible n'est introduite par ce profil.

## Pour ouvrir les chantiers différés

Il faut créer une nouvelle preuve externe et modifier le profil dans le même
changement : fermer la porte correspondante, retirer son flag de
`disabledFeatureFlags`, configurer la valeur de production puis rejouer les
smoke tests du fournisseur et du pilote. Le profil complet ne sera activé
qu'après clôture de toutes les portes et suppression du gel.
