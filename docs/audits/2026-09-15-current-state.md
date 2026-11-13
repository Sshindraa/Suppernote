# Réconciliation des audits Suppernote — état courant

Date de contrôle : **15 septembre 2026**
Référence dépôt suivie : `origin/main@a335be63`
Référence du checkout local au moment du contrôle : `main@510d54b5`
Référence de la dernière promotion production explicitement prouvée : `35e22281` (PR #176)

## Pourquoi ce document existe

Les audits du 6 et du 7 septembre sont des instantanés utiles, mais leurs
conclusions ne doivent plus être lues comme un tableau de bord actuel. Ce
document est la référence pour décider ce qui est livré, ce qui est visible en
production et ce qui reste nécessaire avant l'ouverture commerciale complète
des offres Essential 199 € / Pro 299 €.

Les fichiers de preuve JSON et le fichier de reproductions du dossier
`2026-09-06-evidence/` restent volontairement inchangés : ils décrivent les
faits observés à leur date et constituent des pièces d'audit immuables.

## État de livraison et de production

| Surface                         | État au 15/09/2026                                      | Preuve ou limite                                                                                                                                                                                                                                                    |
| ------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Production Suppernote           | **Profil scoped déployé** : `core-operator-foundations` | La promotion `ce651dc9` / run `34958124438` a passé les contrôles ; la correction d'entrypoint `35e22281` / run `34964634507` a ensuite été vérifiée par smoke tests. `/health` et `/livez` répondent 200.                                                          |
| Gel commercial 199/299          | **Actif**                                               | `productionFreeze=true`. Le profil scoped permet les fondations déjà sûres, mais ne clôt pas les portes P1 à P9 ni `PILOTS`.                                                                                                                                        |
| Référence du dépôt              | **Plus récente que le checkout local au départ**        | `origin/main` contient ensuite `a335be63` (préparation du control plane Marketing Pro). Les fichiers propres des trois commits ont été réalignés localement sans commit ; les changements d'audit restent dans le worktree et ne sont pas une preuve de production. |
| Espace opérateur                | **Livré et séparé** sous `/admin`                       | Coûts, marge, santé et provisioning sont réservés à l'équipe Suppernote. Les anciennes URL `/dashboard/admin/*` redirigent ; un compte restaurant n'obtient pas ces données.                                                                                        |
| Dashboard restaurateur          | **Disponible sans coûts ni quotas**                     | Les alertes 70/90/100, les factures fournisseurs et la marge restent internes. Les fonctionnalités Pro non qualifiées affichent un état verrouillé explicable.                                                                                                      |
| Démo locale « Chez Suppernote » | **Plan local `PRO` uniquement**                         | La base de prévisualisation a été positionnée en Pro pour tester l'interface. Aucun abonnement Stripe ni débit n'a été créé par cette action locale.                                                                                                                |

## Prix et droits : une seule lecture

Le catalogue applicatif est maintenant :

- **Essential : 199 € / mois / établissement** ;
- **Pro : 299 € / mois / établissement** ;
- **Multi-site : 249 € de base + 99 € par établissement supplémentaire**,
  jusqu'à décision de packaging groupe.

> Mise à jour du 16 octobre 2026 : grille du 14 octobre en vigueur, Multi-site 299 € de base
> (premier établissement inclus) + 99 € par établissement supplémentaire, remise annuelle 10 %.
> Stripe test et live sont réconciliés (8/8 prix conformes) : voir
> [`runbooks/stripe-billing.md`](../runbooks/stripe-billing.md). Les phrases suivantes sur le
> catalogue Stripe non réconcilié sont historiques.

Les constantes partagées, les pages tarifaires et le calcul ROI utilisent ces
montants. Le catalogue Stripe externe n'est pas encore réconcilié avec 199/299
et le checkout de production reste fermé par
`BILLING_CHECKOUT_ENABLED=false`. Les montants Stripe historiques de 149/249
et leurs prix annuels sont donc une **preuve historique**, pas le prix à
annoncer aujourd'hui. Avant d'ouvrir la facturation, il faut créer/synchroniser
les nouveaux `price_id`, rejouer Checkout, facture, portail, annulation,
échec de paiement et période de grâce dans le même environnement.

## Portes de release réconciliées

Les statuts ci-dessous correspondent au manifest
[`docs/release/product-gates.json`](../release/product-gates.json). `CLOSED`
signifie que la fonctionnalité concernée peut faire partie du profil scoped ;
il ne signifie pas que toute l'offre 199/299 est ouverte. `LOCAL_ONLY` signifie
que le code et les tests locaux existent, mais qu'une preuve fournisseur,
identité réelle, contrat ou pilote manque encore.

| Porte               | Statut courant | Ce qui est réellement disponible                                                                                                                         | Ce qui reste avant activation commerciale                                                                                                                                                                                             |
| ------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `P0_USAGE`          | **CLOSED**     | Ledger idempotent, suivi interne par établissement, marge et export interne dans `/admin/margin`. Les alertes de budget sont internes et non bloquantes. | Import comptable aval et rattachement/conversion du trafic Telnyx non nul de mai ; ces deux suivis ne bloquent ni le restaurateur ni le profil scoped.                                                                                |
| `P1_ESSENTIAL`      | **OPEN**       | Entitlements et catalogue local 199 € ; guards serveur et tests de Billing présents.                                                                     | Prix Stripe 199 €, cycle Checkout/webhook/facture/portail en sandbox, puis deux restaurants Essential observés sept jours.                                                                                                            |
| `P2_CRM`            | **LOCAL_ONLY** | CRM clients, fusion/projections, segmentation de base et export/effacement codés et testés localement.                                                   | PostgreSQL concurrent réel, deux identités Clerk, export/effacement et pilote avec données réelles.                                                                                                                                   |
| `P3_MARKETING`      | **LOCAL_ONLY** | Routes marketing chargées et control plane Pro préparé dans `origin/main` : règles, segments, brouillons et previews.                                    | Prouver la configuration de production ; `MARKETING_SENDS_ENABLED` reste fermé, donc aucun SMS/email/WhatsApp fournisseur n'est envoyé. Il faut ensuite consentement, désinscription, templates, callbacks, coûts délivrés et pilote. |
| `P4_ATTRIBUTION`    | **LOCAL_ONLY** | Liens HMAC, clic, réservation et conversion `HONORED` idempotents en local.                                                                              | Parcours pilote complet et comparaison au revenu encaissé, sans présenter une corrélation comme une causalité.                                                                                                                        |
| `P5_PAYMENTS`       | **LOCAL_ONLY** | Policies, tentative idempotente, transitions et webhook hashé pour la protection bancaire.                                                               | Modèle marchand, DPA, Stripe Connect, holds/captures/remboursements, 3DS/chargebacks et pilote.                                                                                                                                       |
| `P6_POS`            | **LOCAL_ONLY** | Connexion provider-neutral, import/matching et traces d'exception.                                                                                       | Choisir une caisse, secret manager, adaptateur/webhooks/worker/DLQ et rapprochement de 30 jours.                                                                                                                                      |
| `P7_CUSTOMER_GROUP` | **LOCAL_ONLY** | Fondations account/site, consentement et membership isolé.                                                                                               | Deux sessions Clerk, rôles site, export/effacement multi-sites et campagne consolidée sans fuite.                                                                                                                                     |
| `P8_REPUTATION`     | **LOCAL_ONLY** | Feedback tokenisé, score borné, récupération et avantages fidélité simples en local.                                                                     | Plateformes/canal, fréquence/coût, éventuelle intégration POS et pilote feedback/récupération.                                                                                                                                        |
| `P9_ECOSYSTEM`      | **LOCAL_ONLY** | Fondations expériences, événements et distribution avec capacité, tickets et idempotence locales.                                                        | Paiement/facture/notifications, partenaire DPA/OAuth, adaptateur, worker, webhooks publics, réconciliation et pilote.                                                                                                                 |
| `PILOTS`            | **OPEN**       | Aucun restaurant pilote n'est encore enregistré comme preuve de clôture dans le dépôt.                                                                   | Restaurants, consentements, captures, métriques, incidents, décisions GO/NO-GO et checklists signées.                                                                                                                                 |

## Ce qui a changé depuis les audits historiques

| Constat des fichiers du 06–07/09                     | État maintenant                                                     | Comment le lire                                                                                                                                                           |
| ---------------------------------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Défauts P0 d'isolation et de rejeu démontrés         | **Corrigés dans le socle promu et protégés par des guards serveur** | Les six reproductions de `test-summary.json` restent des démonstrations positives du défaut sur le commit `b7d14da`; elles ne décrivent pas le code actuel.               |
| Client capable de modifier son plan                  | **Mutation retirée ; droits projetés côté serveur**                 | La porte Essential reste ouverte pour le cycle Stripe et le pilote, pas parce que cette mutation historique est encore acceptée.                                          |
| Production décrite comme « non déployée »            | **Obsolète**                                                        | Un profil scoped a été déployé et vérifié. Le gel de l'offre complète reste volontairement actif.                                                                         |
| API marketing décrite comme 404                      | **Entrypoint corrigé**                                              | Depuis `35e22281`, le smoke sans session renvoie 401 `Organization required`, preuve que la route est chargée. L'envoi fournisseur reste fermé.                           |
| Prix 149/249 dans les anciens registres              | **Historique Stripe**                                               | Le prix produit à retenir est 199/299 ; la migration des `price_id` Stripe est encore une condition P1.                                                                   |
| P0 présenté comme dépendant d'un logiciel comptable  | **Produit fermé, suivi comptable interne**                          | Le cockpit `/admin/margin` et l'export interne suffisent pour le suivi Suppernote. Aucun outil comptable externe n'est requis pour le dashboard restaurateur.             |
| Alertes 70/90/100 présentées comme une limite client | **Signal interne uniquement**                                       | Elles servent à surveiller le coût par restaurant pour l'équipe Suppernote. Elles ne bloquent ni appels, ni SMS, ni réservations et ne sont pas visibles du restaurateur. |

## Documents d'audit et règle de lecture

| Fichier                                                    | Statut après réconciliation                      | Règle                                                                                                                                                    |
| ---------------------------------------------------------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `2026-09-06-launch-readiness.md`                           | **HISTORIQUE — snapshot de préparation**         | Les défauts, compteurs et liens de commit décrivent le 06/09. Utiliser ce document pour la preuve d'origine, puis ce fichier pour le statut actuel.      |
| `2026-09-06-launch-plan.md`                                | **HISTORIQUE — plan initial**                    | Les phases et durées restent des décisions de cadrage ; les phrases « aucun déploiement » et les prix doivent être lues avec la présente réconciliation. |
| `2026-09-07-phase-0-backlog.md`                            | **RÉCONCILIÉ — backlog de référence historique** | Les tickets restent utiles pour l'intention et les preuves attendues. Les statuts courants sont ceux du manifest et de la table ci-dessus.               |
| `2026-09-07-phase-0-commercial-register.md`                | **RÉCONCILIÉ — registre commercial**             | Les prix actifs sont 199/299 ; toute ligne Stripe 149/249 est une trace historique ou un blocker de migration.                                           |
| `2026-09-07-multisite-gap-matrix.md`                       | **RÉCONCILIÉ — fondation locale**                | La base multi-site existe ; les preuves Clerk réelles, le membre limité et le cycle financier restent ouverts.                                           |
| `2026-09-06-evidence/*.json` et `launch-audit.test.ts.txt` | **HISTORIQUE — preuves immuables**               | Ne pas modifier les valeurs observées ; ajouter une nouvelle preuve datée lorsqu'un contrôle est rejoué.                                                 |

## Prochain ordre d'exécution

1. **P1 Essential :** synchroniser le catalogue Stripe 199/299, terminer le
   cycle sandbox et enregistrer deux pilotes Essential pendant sept jours.
2. **P2/P3 :** rejouer les scénarios PostgreSQL/Clerk, ouvrir le control plane
   marketing Pro avec une preuve de configuration, puis qualifier un premier
   fournisseur avant tout envoi.
3. **P4 à P8 :** fermer attribution, paiement, POS, groupe, réputation et
   fidélité dans l'ordre des pilotes, en conservant une preuve externe par
   intégration.
4. **P9 et lancement complet :** n'activer expériences, événements et
   distribution qu'avec paiement, notifications, partenaire et réconciliation
   démontrés ; retirer ensuite le gel uniquement dans une release dédiée.

Tant que cette liste n'est pas signée, le profil scoped reste la seule forme de
promotion autorisée. Aucun changement local non commité, aperçu de navigateur
ou test avec des mocks ne vaut activation commerciale.

## Contrôles exécutés pour cette réconciliation

- lecture de `origin/main`, du manifest de portes et des preuves de release ;
- comparaison du catalogue produit dans `packages/config` et `packages/shared`
  avec les registres commerciaux ;
- vérification de `node scripts/verify-product-gates.mjs` : profil scoped
  accepté, gel complet toujours signalé ;
- contrôle de l'état Git local : réconciliation et fichiers propres réalignés
  conservés dans le worktree, aucun commit, push, staging ou production déclenché
  pendant cette mise à jour.
