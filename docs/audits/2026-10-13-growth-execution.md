# Exécution croissance et acquisition — état courant au 15 octobre 2026

Plan suivi : [seo-acquisition-execution-plan.md](../runbooks/seo-acquisition-execution-plan.md).
La section 2 est la référence des statuts actuels. Les sections 3 à 10 conservent les observations
historiques datées ; un constat antérieur ne remet pas en TODO une livraison ultérieure.
La section 10.21 consigne la correction des dépendances décidée par Hamza ; contrôles datés du 14 octobre.
La section 10.22 documente le lot local du 15 octobre : préparé et vérifié localement, non commité, non déployé.

## 1. Résultat obtenu et périmètre traité

Vitrine, grille tarifaire v3, demande de démo et administration livrées. Réception Gmail et clôture
opérateur qualifiées (§10.19). Search Console accessible via le compte personnel existant, sitemap
renvoyé, accueil sur Google et test direct réussi. Le rapport global d'indexation reste daté du 9 octobre.

#436 et #437 sont fusionnées ; la source `7578dd78` a une CI main, un staging et une production
réussis (runs `38608402004`, `38609413906`, `38610012139`). Au contrôle en lecture seule du
14 octobre, les deux API répondent 200/ok. Telnyx staging est configuré et `VOICE_DISABLED=false`.
Ces contrôles remplacent les anciennes indications « configuration absente » et « voix désactivée ».

Deux appels du restaurant démo sont présents le 14 octobre : staging, 23 secondes, puis production
à 21 h 30, 14 secondes. Tous deux ont `outcome=NO_ACTION` et aucune réservation associée. Ils prouvent
l'exécution du pipeline, pas la réussite d'un scénario métier complet. Aucune nouvelle conversation,
mutation, clé ou modification de routage n'a été effectuée pour cette relecture.

Décision du 15 octobre : concentrer l’acquisition sur l’accueil `sokar.tech`, sans refonte UI.
La landing dédiée est retirée du lot ; sa route devient une redirection permanente vers `/` en
local et reste hors sitemap. Les précisions utiles rejoignent les sept réponses de la FAQ existante.
Le hero, les sections, polices, couleurs, animations, tarifs et CTA de l’accueil sont conservés.
Préparé localement, non commité, non déployé ; production inchangée par cette décision.

## 2. Tickets — référence actuelle

« Qualifié » précise son périmètre. La livraison de code, une simulation, un appel interrompu et
un résultat client réel restent des niveaux de preuve différents. Pour les entretiens, pilotes
et renouvellements, une preuve non archivée reste inconnue.

| ID         | État courant                                           | Preuve ou périmètre                                                                           | Prochaine action                                                                                 |
| ---------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| BASE-01    | Inventaire livré et actualisé                          | §10.18–10.21 ; contrôles publics et source déployée                                           | Reprendre les inconnues utiles, sans refaire l'inventaire complet                                |
| TRUST-01   | Corrections vitrine livrées                            | §10.12 et §10.18 ; simulations identifiées                                                    | Contrôler l'exemple public dans DEMO-SIM                                                         |
| COPY-01    | Textes et tarifs livrés ; formulations à valider       | #427–#429 ; Essential 199, Pro 299, Multi-site 299 + 99 par site supplémentaire, annuel −10 % | Vérifier les promesses support/données ; supprimer ou ajuster celles non étayées                 |
| DEMO-SIM   | Qualifié localement (§10.22)                           | Décision du 14/10 : exemple public simulé, sans action client                                 | Recontrôler après livraison groupée ; animation sans effet métier                                |
| VOICE-01   | Recette interne incomplète, P0 avant activation client | #436–#437 ; configuration présente ; appels NO_ACTION, aucune réservation liée                | Qualifier les scénarios internes sur données de test ; distinguer pipelines staging/production   |
| OPS-01     | Installation client à qualifier                        | Onboarding/provisioning livrés partiellement ; intégration locale à préserver                 | Vérifier le parcours réellement déployé, numéro/renvoi et secours du candidat                    |
| DEMO-01    | Qualifié en production                                 | Demande persistée avec source, notification effectivement reçue (§10.19)                      | Garder la recette ciblée après une modification de ce parcours                                   |
| DEMO-02    | Réception et traitement technique qualifiés            | Administration accessible, test clôturé après rechargement et relu en base (§10.19)           | Définir l'organisation commerciale et le délai interne ; aucune promesse publique de délai       |
| METRIC-01  | Suivi minimal prêt localement (§10.23)                 | Horodatages persistés ; essais exclus des résultats commerciaux                               | Tenir le relevé restreint ; premier rapprochement réel à vérifier avant bilan                    |
| BILL-01    | Grille v3 livrée ; exploitation pilote à qualifier     | #429–#430, catalogue/runbook actif ; aucune nouvelle preuve client dans ce lot                | Vérifier paiement, plan et droits du candidat ; observer le renouvellement à son échéance        |
| SEO-01     | Diagnostic et accès GSC acquis ; inconnues bornées     | §10.19 ; anciens 403 inexpliqués                                                              | Observer les nouveaux rapports et retraits d'URL ; pas de modification réseau sans cause établie |
| SEO-02     | Socle technique livré et contrôlé                      | Pages B2B accessibles ; pages fictives noindex/hors sitemap                                   | Distinguer indexabilité et indexation effective ; consolidation accueil dans LAND-01             |
| ICP-01     | Supports finalisés localement (§10.23)                 | Guide d'entretien et runbook pilote                                                           | Hamza sélectionne les contacts et autorise explicitement tout envoi                              |
| ICP-02     | Preuves terrain à documenter                           | Aucun entretien archivé dans ce rapport                                                       | Recueillir les retours ; 8 à 12 est un repère, pas une barrière au premier pilote                |
| PILOT-01   | À démarrer sous conditions par candidat                | Runbook limité à deux pilotes initiaux ; aucune fiche complète archivée                       | Premier démarrage indépendant du second ; revue opérationnelle après sept jours                  |
| ECON-01    | Observation ultérieure                                 | Aucune preuve d'adoption durable ou de renouvellement archivée                                | Mesurer usage, coûts, support et paiement pendant une durée suffisante                           |
| LAND-01    | Accueil préparé et vérifié localement (§10.27)         | UI conservée ; ancienne route redirigée, aucun ajout sitemap                                  | Livraison groupée sur instruction Hamza ; recette locale actualisée                              |
| CONNECT-01 | P2 conditionnel                                        | Fiches fictives exclues ; inventaire partenaire à qualifier                                   | Avancer avec des établissements réels et leurs accords                                           |
| SCALE-01   | P2 conditionnel                                        | Pas de validation commerciale à grande échelle                                                | Étendre selon les résultats et les coûts observés                                                |

## Lecture des observations historiques

Les sections suivantes décrivent l'état à leur date de rédaction. Prix, accès, déploiements et
conditions de publication anciens sont remplacés pour l'exécution courante par les sections 1–2
et par le plan révisé, sans effacer les preuves d'origine.

## 3. Observations (BASE-01 et SEO-01)

Mesures en lecture seule (requêtes GET simples), faites le 13/10/2026 vers 16:35 UTC. Aucune protection
n'a été contournée.

| Surface                                      | Constat avant correction                                                                                                                                                                  | Source                               |
| -------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| `https://sokar.tech/sitemap.xml`             | 200, 3 URL : accueil, `/assistant` et `/restaurant/chez-sokar-demo`                                                                                                                       | HTTP                                 |
| `https://api.sokar.tech/public/sitemap-data` | 200, 1 fiche publiée (`chez-sokar-demo`)                                                                                                                                                  | HTTP, comptage uniquement            |
| `https://api.sokar.tech/public/cities`       | 200, 0 ville                                                                                                                                                                              | HTTP                                 |
| `/pricing` dans le sitemap                   | Absent                                                                                                                                                                                    | HTTP                                 |
| `/`, `/pricing`, `/login`, `/register`       | Titre « Suppernote — Restaurant Management », description générique en anglais, aucun canonical, aucun Open Graph ; `robots` absent                                                       | HTTP, HTML                           |
| `/privacy`                                   | `robots: index, follow` et `og:locale fr_FR` (modèle de référence)                                                                                                                        | HTTP                                 |
| Code `fetchPublishedSlugs` et `fetchCities`  | Retournent `[]` en cas d'erreur ; le sitemap ISR (5 min) la met en cache                                                                                                                  | `apps/connect/src/lib/api-client.ts` |
| Routage Nginx                                | `/sitemap.xml` et `/robots.txt` vers Connect ; `/`, `/pricing`, `/login`, `/register` et `/widget/*` vers le dashboard ; `/widget/*/gift-card` vers Connect ; `/book/*` vers le dashboard | `infra/nginx/sokar.conf`             |

**Diagnostic** : le 403 signalé dans le brief n'a pas été reproduit avec des requêtes simples. La liste
tronquée observée précédemment reste inexpliquée : le mécanisme (erreur réseau ou API transitoirement
indisponible, remplacée par `[]` puis mise en cache) est confirmé dans le code, sa cause précise ne
l'est pas. **Inconnues** : nombre d'établissements répondant à `PUBLIC_CONNECT_WHERE` en base (accès
production non disponible) ; indexation réelle (Search Console non accessible) ; comportement de Next
et Nginx pendant une panne (à tester en staging).

**Point à décider** : la fiche `chez-sokar-demo` est publiée, indexée dans le sitemap, et contient des
données de démonstration. Hamza doit confirmer si elle est voulue (démo publique) ou à dépublier.

**Décision technique hors périmètre** : le layout racine lit les cookies (`cookies()`), donc toutes les
pages du dashboard sont rendues à chaque requête (`ƒ` au build). Ce n'est pas un effet de cette branche.
Il limitera le rendu statique de la future landing (LAND-01) ; à traiter avant cette landing.

## 4. Démonstration vocale : niveaux de preuve (VOICE-01, lecture du code)

| Dispositif                                                                                 | Ce qu'il prouve                                                                                           | Ce qu'il ne prouve pas                                                                        |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Animation et maquettes (`DemoSection`, `ScrollStoryboardSection`)                          | Présentation visuelle, désormais signalée comme simulée                                                   | Aucun appel, aucune réservation, aucune voix                                                  |
| Démonstration en direct pendant l'onboarding (`voice/demo/live-demo.ts`, `demo-stream.ts`) | Même pipeline STT → dialogue → TTS que la production, sur un transport navigateur, session marquée `demo` | Écritures de réservation simulées ; qualité réelle non mesurée ici ; aucun appel téléphonique |
| Lecture TTS d'un script                                                                    | Non vérifié dans cette session                                                                            | —                                                                                             |

Aucun appel n'a été passé. Les scénarios du brief (demande simple, changement en cours d'appel, complet,
nom ambigu, question pratique, reprise, dégradation) restent à qualifier avec les fournisseurs réels.

## 5. Fichiers et comportements modifiés

**Vitrine (dashboard)**

- `apps/dashboard/src/app/DemoSection.tsx` et `DemoSection.test.tsx` : mention de simulation, sans revenu
  ni « temps réel ».
- `apps/dashboard/src/app/ScrollStoryboardSection.tsx` : titres et maquette corrigés.
- `apps/dashboard/src/app/page.tsx` : métadonnées, hero, CTA, compteur retiré.
- `apps/dashboard/src/app/layout.tsx` : `metadataBase` (base absolue pour canonical et Open Graph).
- `apps/dashboard/src/app/pricing/page.tsx`, `PricingPlans.tsx`, `PricingSection.test.tsx` : prix HT,
  mention « Facturation annuelle, engagement de 12 mois ».
- `apps/dashboard/src/app/constants.ts` : fonctionnalités et FAQ.
- `apps/dashboard/src/app/marketing-metadata.ts` et son test : métadonnées de l'accueil, des tarifs et de la démo ; les prix de la description viennent du catalogue partagé `PLAN_PRICES_EUR`.
- `apps/dashboard/src/app/demo/` (page, formulaire, test) : demande de démonstration.
- `apps/dashboard/src/app/dashboard/admin/demo-requests/` (page, test) : suivi opérateur.
- `apps/dashboard/src/app/login/layout.tsx`, `register/layout.tsx`, `widget/[restaurantId]/layout.tsx`, `transactional-pages.test.ts` : `noindex`.

**API**

- `apps/api/src/modules/demo-requests/` : service, routes et tests (13).
- `apps/api/src/main.ts` : enregistrement de `demoRequestRoutes`.
- `apps/api/src/test/setup.ts` et `helpers.ts` : délégué `demoRequest` dans les mocks Prisma.
- `apps/api/.env.example` : `DEMO_REQUEST_NOTIFY_TO` documentée.

**Base de données**

- `packages/database/prisma/schema.prisma` : enum `DemoRequestStatus`, modèle `DemoRequest` (table `demo_requests`).
- `packages/database/prisma/migrations/20261013120000_demo_requests/migration.sql` : `CREATE TYPE`, `CREATE TABLE`, deux index. Aucun `DROP` ni `TRUNCATE`. Non appliquée.

**Connect**

- `apps/connect/src/app/sitemap.ts` et `sitemap.test.ts` : sitemap.
- `apps/connect/src/lib/api-client.ts` : `fetchSitemapSources` (erreur explicite, délai de 5 s).
- `apps/connect/src/app/widget/[slug]/gift-card/page.tsx` et `page.metadata.test.ts` : `noindex`.

**Documentation**

- `docs/audits/2026-10-13-growth-execution.md` : ce rapport.
- `docs/runbooks/restaurant-discovery-interview.md` : support d'entretien et de pilote.
- `docs/runbooks/seo-acquisition-execution-plan.md` : brief, reformaté par Prettier (forme seulement).
- `docs/runbooks/environment.md` : section « Demandes de démonstration ».
- `docs/obsidian/Context.md` : trois lignes de TODO. `docs/obsidian/Journal.md` : une entrée.

**Comportements visibles après déploiement**

- Accueil et tarifs : nouveaux titres, descriptions et canonical ; prix « HT ».
- `/demo` : formulaire sans compte, confirmation sans délai promis.
- `/login`, `/register`, `/widget/*` : `noindex, nofollow`.
- `/sitemap.xml` : `/pricing` ajouté ; une panne de l'API renvoie une erreur au lieu d'une liste partielle.

**Décisions prises** (chacune a un coût si elle est fausse)

1. **Isolation** : worktree créé à la main, pas l'outil natif `EnterWorktree` (qui exige le mot « worktree » explicitement). Le brief demande une branche `codex/` et l'isolation du chantier, et le checkout principal porte du travail non commité. _Coût si faux_ : un worktree à supprimer (`git worktree remove`). Cela va à l'encontre de la préférence mémorisée « pas de worktree sans demande explicite » : à confirmer.
2. **Brief** : le fichier `seo-acquisition-execution-plan.md`, non suivi dans `main`, est committé avec le chantier et reformaté par Prettier (forme seulement). _Coût_ : un fichier de plus dans la PR.
3. **Un seul rapport** : les fichiers de baseline, de backlog et de phase 4, 5 et 7 du runbook ne sont pas créés ; leur contenu est dans ce rapport. Le guide d'entretien est un support, pas un rapport. _Coût_ : les noms prévus par le runbook n'existent pas encore.
4. **Demande de démonstration** : enregistrée avant toute notification ; aucun e-mail tant que `DEMO_REQUEST_NOTIFY_TO` n'est pas défini ; aucun compte Clerk ; aucun délai de réponse promis. _Coût_ : aucune alerte commerciale tant que la variable n'est pas définie.
5. **Accès opérateur** : `requireSokarOperator` (liste `SOKAR_OPERATOR_USER_IDS`). Le lien de navigation n'est pas ajouté, car le layout admin a des modifications non commitées dans le checkout principal. _Coût_ : l'URL doit être saisie à la main.
6. **Prix HT** : affichés hors taxes, comme le runbook Stripe. _Coût si le catalogue actif est TTC_ : les libellés sont faux ; à confirmer (BILL-01).
7. **Affirmations retirées sans preuve** : revenu récupéré, « répond à chaque appel », « arriveront progressivement » (intégrations), « conforme au RGPD », « hébergées en Europe », « jamais partagées avec des tiers », « chiffrées au repos et en transit », « en temps réel », « instantanément », « zéro » et garanties similaires. _Coût_ : des formulations moins fortes ; réintroduction possible après validation.
8. **Affirmations conservées et signalées** : « Support prioritaire 7j/7 », « Tout l'Essential, sans limite », « Vos clients reconnus à chaque appel », « Toujours disponible », « Tous. Des bistrots… », « Taux de réponse 98 % » (sous mention de simulation). _Coût_ : ces formulations restent publiques jusqu'à validation.
9. **Sitemap** : rendu à la requête (`force-dynamic`), donc le build ne dépend plus de l'API (la CI n'en a pas). Une panne de l'API lève une erreur (pas de liste tronquée). _Coût_ : pendant une panne, Google reçoit une erreur au lieu d'une liste partielle ; le comportement du cache Next est à vérifier en staging.
10. **`noindex`** sur `/login`, `/register`, `/widget/[restaurantId]` et `/widget/[slug]/gift-card`, sans `Disallow` (le robot doit lire la directive). _Coût_ : aucune indexation de ces pages, voulu.
11. **Migration** : additive, non appliquée. _Coût si elle n'est pas appliquée au déploiement_ : `POST /public/demo-requests` répond 503 (erreur propre, aucune demande perdue).
12. **Tests** : pour les assertions HT et métadonnées, le code a été écrit avant les assertions (ordre inversé). Le rouge a été observé pour la mention de simulation, les métadonnées, l'API, le formulaire, le sitemap et le `noindex`, pas pour les assertions HT. _Coût_ : preuve plus faible pour ces assertions.
13. **Mocks partagés** : `setup.ts` et `helpers.ts` ont reçu un délégué `demoRequest`. _Coût_ : conflit possible avec le travail non commité qui touche ces fichiers.
14. **Hors périmètre volontaire** : aucun message envoyé, aucun appel téléphonique, aucune modification Stripe, aucune landing publiée, aucune requête à Search Console.

## 6. Vérifications exécutées

| Vérification                                                       | Commande ou méthode                                                                            | Résultat                                                                                          |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Version Node                                                       | `pnpm node:check`                                                                              | OK (Node 22.23.2)                                                                                 |
| Installation                                                       | `pnpm install --frozen-lockfile`                                                               | OK                                                                                                |
| Build des paquets                                                  | `pnpm --filter "./packages/*" run build`                                                       | OK                                                                                                |
| Schéma Prisma                                                      | `prisma validate` (URL factice) ; `prisma generate` ; `prisma migrate diff --script` hors base | OK ; SQL limité à `CREATE`                                                                        |
| Sécurité des migrations                                            | `scripts/quality/check-migration-safety.mjs`                                                   | OK (1 migration ajoutée, aucune destructive)                                                      |
| Scoping tenant                                                     | `scripts/quality/check-tenant-scoping.mjs`                                                     | OK (avertissements de baisse de baseline, informatifs)                                            |
| Taille du vault                                                    | `scripts/quality/check-vault-size.sh`                                                          | OK (Context.md à 7 755 octets)                                                                    |
| Tests API complets                                                 | `pnpm --filter @suppernote/api test`                                                           | 354 fichiers OK, 5 ignorés ; 3 779 tests OK, 54 ignorés                                           |
| Tests dashboard complets                                           | `pnpm --filter @suppernote/dashboard test`                                                     | 77 fichiers, 584 tests OK                                                                         |
| Tests connect complets                                             | `pnpm --filter @suppernote/connect test`                                                       | 20 fichiers, 136 tests OK                                                                         |
| Typecheck                                                          | `tsc` API, dashboard, connect                                                                  | OK, 0 erreur                                                                                      |
| Lint                                                               | `eslint` (API) ; `next lint` (dashboard, connect) sur les fichiers modifiés                    | OK, 0 avertissement                                                                               |
| Format                                                             | `prettier --check` sur les fichiers modifiés                                                   | OK                                                                                                |
| Build dashboard                                                    | `next build`                                                                                   | OK ; routes `/`, `/pricing`, `/demo` en `ƒ` (voir section 3)                                      |
| HTML servi (serveur local, valeurs factices de Clerk, non réelles) | `curl` sur `/`, `/pricing`, `/demo`, `/login`, `/register`                                     | Titres, descriptions, canonical et `robots` conformes ; mention de simulation et prix HT présents |
| Parcours navigateur                                                | Accueil et `/demo` en mobile (375 px) ; section démo en desktop                                | Lisible, CTA empilés ; erreur d'envoi affichée, saisie conservée                                  |
| Sitemap et métadonnées de production                               | `curl` GET (avant déploiement)                                                                 | Voir section 3                                                                                    |

**Non vérifié** :

- déploiement, staging et production : rien n'est déployé ;
- parcours de succès `/demo` jusqu'à la base : API et PostgreSQL locaux non démarrés ;
- envoi réel d'e-mail : aucun destinataire configuré ;
- mise en page sur iPad (768 px) : non vérifiée ;
- Search Console, Stripe en production, appels vocaux : aucun accès.

## 7. Dépendances restantes

| Dépendance                    | Responsable                   | Action précise                                                                                 | Conséquence si elle manque                                |
| ----------------------------- | ----------------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| Destinataires de notification | Hamza                         | Choisir les adresses et définir `DEMO_REQUEST_NOTIFY_TO` en staging puis en production         | Les demandes sont enregistrées mais personne n'est alerté |
| Délai de réponse              | Hamza                         | Fixer le délai réel, puis l'afficher si on le tient                                            | Aucun délai n'est promis ; le délai reste à définir       |
| Migration `demo_requests`     | Équipe technique              | Appliquer en staging avant la production, vérifier la table                                    | `/public/demo-requests` répond 503                        |
| Relecture juridique           | Hamza ou conseil juridique    | Valider la FAQ données (hébergement, sous-traitants voix, RGPD) et « Support 7j/7 »            | Affirmations retirées ou signalées restent à trancher     |
| Fiche `chez-sokar-demo`       | Hamza                         | Confirmer la publication ou la dépublier                                                       | Fiche démo indexable                                      |
| Catalogue Stripe              | Opérateur avec accès Stripe   | `scripts/ops/verify-stripe-catalog.mjs` en lecture seule ; confirmer quotas et « sans limite » | Prix HT et périmètre non confirmés                        |
| Search Console                | Hamza                         | Donner l'accès à la propriété `sokar.tech`                                                     | Indexation réelle inconnue (UNKNOWN)                      |
| Base production               | Équipe technique              | Compter les établissements publiables selon `PUBLIC_CONNECT_WHERE` (sans coordonnées)          | Nombre de fiches publiables inconnu                       |
| Qualification vocale          | Hamza ou équipe technique     | Passer les scénarios du brief avec les fournisseurs réels, en staging                          | Pas de démonstration vocale qualifiée ; landing bloquée   |
| Onboarding v2                 | Auteur du travail non commité | Intégrer dans `main`                                                                           | OPS-01 et PILOT-01 bloqués                                |
| Entretiens et pilotes         | Hamza                         | Choisir 8 à 12 établissements, mener les entretiens selon le guide                             | Aucune décision commerciale possible                      |
| Navigation admin              | Auteur du chantier admin      | Ajouter le lien vers `/dashboard/admin/demo-requests`                                          | Accès par URL uniquement                                  |

**Points à reporter dans la PR et la décision de mise en production** : nouvelle table (migration),
routes publiques ajoutées (additives), changement de sitemap et de métadonnées, copie publique modifiée.

## 8. Décision proposée

1. **Relire la PR puis la faire passer en staging** : appliquer la migration, envoyer une demande de test
   (avec un destinataire de test), vérifier `/`, `/pricing`, `/demo`, `/sitemap.xml`, `/login` et le
   suivi opérateur. Puis promouvoir selon le runbook de déploiement, avec snapshot et rollback prêts.
2. **Ne pas publier de landing** tant que la démonstration vocale n'est pas qualifiée (VOICE-01) et que
   l'accès à Search Console n'est pas obtenu.
3. **Ne lancer aucun pilote** avant trois conditions : onboarding v2 intégré (OPS-01), catalogue Stripe
   confirmé (BILL-01), et au moins un entretien mené (ICP-02). Aucune offre ne doit être faite avant la
   confirmation du prix HT.
4. **Mesurer la demande réelle** pendant deux semaines après ouverture de `/demo` : nombre de demandes,
   délai de réponse tenu, taux de demandes notifiées. Décider ensuite de la suite selon ces chiffres.
5. **Réviser les textes signalés** avant la prochaine mise en production publique.

## 10. Qualification après fusion (13/10/2026, soir)

Brief de qualification : PR #417 fusionnée à 17:18:47 UTC (merge `298fd1ac`). Les preuves ci-dessous
proviennent des journaux GitHub Actions, de contrôles HTTP en lecture seule, de tests locaux et de
navigations sur la production. Les demandes de test sur staging ont été faites avec des données
fictives.

### 10.1 Déploiement vérifié (journaux GitHub Actions)

| Environnement | Run                            | Migration `20261013120000_demo_requests`                                                             | Résultat                                                                                  |
| ------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Staging       | 38438346093, 17:24 à 17:27 UTC | Appliquée à 17:26:57 UTC (« All migrations have been successfully applied »)                         | Smoke tests : succès                                                                      |
| Production    | 38439002920, 17:29 à 17:32 UTC | Appliquée à 17:31:43 UTC, après sauvegarde `sokar-20261013T173139Z.dump` et restauration de contrôle | Health : API `/health` et `/livez` 200, dashboard 200, Connect 200 ; smoke tests : succès |

La promotion en production a été automatique, comme le prévoit `AGENTS.md`, une fois CI et staging verts.
Rollback disponible : snapshot pré-build et sauvegarde datée (`/var/backups/sokar/`).

### 10.2 Demande de démonstration sur staging

- Envoi de test par le formulaire de staging, avec des données fictives (établissement « QA test Suppernote
  13-10-2026 (à supprimer) », e-mail `qa.sokar.test@example.com`). Requête réseau :
  `POST /api/proxy/public/demo-requests` → **201**. Le message « Demande bien enregistrée » est affiché.
  La demande est donc persistée et la table existe.
- **Visible dans l'administration : non vérifié.** Staging tourne en mode démo : une requête anonyme est
  traitée comme `demo-user`, et `GET /admin/demo-requests` répond 403 (« Suppernote operator access required »).
  Il faut un compte opérateur connecté pour voir la liste. Cette demande de test doit être clôturée
  par l'opérateur après contrôle.
- **Notification reçue : non, et non configurable en l'état.** Constat : les workflows de déploiement
  ne transmettaient pas `DEMO_REQUEST_NOTIFY_TO` au `.env` de l'API. Aucune notification n'a donc pu partir,
  ni en staging ni en production. Correctif dans la PR #418 (secret GitHub + script de synchronisation).
  Reste à fournir le destinataire de test autorisé et à créer le secret.

### 10.3 Sitemap : disponibilité de l'API et comportement réel du cache

Test local : build de production de Connect (`output: standalone`, Next 15.5), API simulée sur un port
local, deux instances. Les réponses ci-dessous viennent de `curl` sur le serveur réel.

| Étape | API                                            | Réponse             | Entrées | Lecture                                         |
| ----- | ---------------------------------------------- | ------------------- | ------- | ----------------------------------------------- |
| A1    | disponible, v1                                 | 200                 | 5       | Données fraîches                                |
| A2    | disponible, v2 (3 fiches), cache encore valide | 200                 | 5       | Cache : aucune nouvelle requête à l'API         |
| A3    | indisponible (503), cache encore valide        | 200                 | 5       | Cache : la panne est invisible                  |
| A4    | indisponible, après 310 s                      | 200                 | 5       | Données périmées servies, pas de liste tronquée |
| A5    | revenue, v2                                    | 200                 | 5       | Revalidation lancée en arrière-plan             |
| A6    | revenue, v2                                    | 200                 | 6       | Données à jour                                  |
| B1    | serveur froid (aucun cache), indisponible      | **500**, corps vide | 0       | Pas de liste tronquée                           |
| B2    | serveur froid, revenue                         | 200                 | 5       | Liste complète                                  |

Conclusions : le sitemap ne publie jamais une liste partielle. Une panne de l'API est absorbée par le
cache de données pendant 5 min, puis par la donnée périmée. Au démarrage à froid, elle produit une erreur.
En production, `cf-cache-status: DYNAMIC` : Cloudflare ne met pas le sitemap en cache. **Non testé** :
le comportement de Nginx en amont et les effets de purge au déploiement.

### 10.4 Pages modifiées sur mobile, iPad et desktop (production)

| Page             | 375 px                                     | 768 px | 1024 px | Constat                                                             |
| ---------------- | ------------------------------------------ | ------ | ------- | ------------------------------------------------------------------- |
| `/` hero         | OK                                         | OK     | OK      | CTA empilés en mobile, sans débordement                             |
| `/` section démo | OK (grille 2 colonnes puis pleine largeur) | OK     | OK      | Mention de simulation visible                                       |
| `/pricing`       | **Illisible**                              | —      | —       | Thème clair stocké : fond clair, texte blanc. **Corrigé dans #418** |
| `/demo`          | OK                                         | OK     | OK      | Lisible en thème clair comme en sombre                              |

Constats hors périmètre, non corrigés : en-tête « Cas d'usage » sur deux lignes à 768 px (en-tête
partagé, non modifié par cette branche) ; étiquettes décoratives « METRIC_CARD » et « 01_HMI_TUNER »
dans les maquettes (pré-existantes, à trancher par Hamza).

### 10.5 Défauts constatés et corrigés (PR #418)

| Défaut                                                         | Correction                                                                                     | Preuve                                                                                                            |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `/pricing` illisible quand le visiteur a choisi le thème clair | Liste des pages de vitrine étendue à `/pricing` ; script extrait dans `theme-bootstrap.ts`     | Test du script réel dans un contexte isolé (RED puis GREEN, 3/3) ; à vérifier sur la production après déploiement |
| `/demo` absente du sitemap                                     | Ajoutée aux pages statiques, avec son test                                                     | Sitemap test RED puis GREEN (5/5)                                                                                 |
| Notification de démo jamais transmise à l'API                  | Secret `DEMO_REQUEST_NOTIFY_TO` dans les deux workflows ; script `sync-demo-request-config.sh` | Script testé : remplacement sans doublon, valeur invalide refusée, secret absent sans effet, mode 600             |
| Sitemap échouant au build (`ECONNREFUSED`, CI)                 | Déjà corrigé dans la branche précédente (`aebedf2d`)                                           | Build local reproduit puis vert                                                                                   |

### 10.6 Public après promotion (13/10/2026, 17:35 UTC)

- `https://sokar.tech/sitemap.xml` : 200, 4 URL (accueil, `/assistant`, `/pricing`, fiche de démonstration).
  `/demo` absente : corrigée dans #418.
- Métadonnées : `/`, `/pricing`, `/demo` en `index, follow` avec titres propres ; `/login` et `/register`
  en `noindex, nofollow`.
- En-têtes du sitemap : `cache-control: public, max-age=0, must-revalidate`, `cf-cache-status: DYNAMIC`.

### 10.7 VOICE-01 : état et dépendances réelles

- Aucun appel n'a été passé dans cette session. Les dispositifs et leurs niveaux de preuve sont décrits en section 4.
- **Dépendance réelle 1** : des appels réels avec les fournisseurs réels, depuis un numéro de test, par
  une personne disposant de l'accès (Hamza ou l'équipe technique). Aucun identifiant de téléphonie n'est
  accessible ici.
- **Dépendance réelle 2** : la démonstration en direct de l'onboarding exige un compte restaurateur
  authentifié (émission d'un ticket soumise à Clerk). Un compte de test doit être créé par Hamza.
- Scénarios à qualifier (brief, section 7) : demande simple ; changement pendant la conversation ;
  restaurant complet ; nom ou heure ambigus ; question pratique ; reprise ou répétition ; service dégradé.
- Preuve attendue : date, environnement, version et commit, transcription expurgée, résultat métier
  vérifié dans le dashboard autorisé, taux de réussite avec son dénominateur (échecs inclus).
- Search Console n'est pas une dépendance de VOICE-01.

### 10.8 LAND-01 : préparation et dépendances réelles

**Étude de demande, sans Search Console ni Keyword Planner** (recherche web publique, 13/10/2026). Aucun
volume ni difficulté n'est donné : ils restent **UNKNOWN**.

Expressions candidates, classées par intention :

| #   | Expression                                        | Intention                 |
| --- | ------------------------------------------------- | ------------------------- |
| 1   | assistant téléphonique restaurant                 | Restaurateur (solution)   |
| 2   | standard téléphonique restaurant                  | Restaurateur              |
| 3   | standard téléphonique IA restaurant               | Restaurateur              |
| 4   | assistant vocal restaurant                        | Restaurateur              |
| 5   | assistant téléphonique IA restaurant              | Restaurateur              |
| 6   | prise de réservation téléphone restaurant         | Restaurateur              |
| 7   | réservation téléphonique restaurant logiciel      | Restaurateur (comparatif) |
| 8   | logiciel réservation restaurant téléphone         | Restaurateur (comparatif) |
| 9   | gestion des appels restaurant                     | Restaurateur (problème)   |
| 10  | appels manqués restaurant                         | Restaurateur (problème)   |
| 11  | répondre aux appels pendant le service restaurant | Restaurateur (problème)   |
| 12  | répondeur restaurant réservation                  | Restaurateur              |
| 13  | répondeur automatique restaurant                  | Restaurateur              |
| 14  | agent IA restaurant réservation                   | Restaurateur              |
| 15  | logiciel restaurant réservations téléphone        | Restaurateur              |
| 16  | réservation par téléphone restaurant              | Mixte                     |
| 17  | réserver une table par téléphone                  | Consommateur              |
| 18  | appeler un restaurant pour réserver               | Consommateur              |

**Paysage concurrentiel observé** (éditeurs et articles, données non vérifiées) : Allo (withallo.com),
Famulor (famulor.io), Bookler de Formitable (formitable.com), Assistent.ai, Ainora (ainora.lt), Anolla
(anolla.com), ClickTable, DineTime, BiteBuddy, aleno, Loman (loman.ai), CloudTalk, Jotform, et l'aide
Zenchef sur son assistant IA. Les éditeurs annoncent des taux (98 %, 100 %, 59,3 %, 80 à 90 %) ou des délais
de réponse qui ne sont pas vérifiables : **nous ne les reprenons pas**.

**Dépendances réellement manquantes pour publier la landing** :

- **Preuve de démonstration** : VOICE-01 (ci-dessus). C'est la seule dépendance bloquante.
- **Promesse** : déjà exacte dans la vitrine (répond aux appels transférés, consulte les disponibilités,
  enregistre les réservations). Aucune garantie chiffrée, aucune parité avec un concurrent.
- **Conversion** : `/demo` est en production. Le suivi opérateur existe, reste à le faire tenir (délai de
  réponse à définir par Hamza).
- **Technique** : route `/solutions/assistant-telephonique-restaurant` à créer après VOICE-01, avec
  métadonnées propres, canonical, entrée au sitemap, et maillage depuis l'accueil.

**Non bloquants** : Search Console (la landing peut être publiée sans elle ; l'indexation réelle reste
UNKNOWN) ; volumes de recherche ; témoignages et gains chiffrés (exclus de la landing tant qu'ils n'ont
pas leurs preuves).

**Plan proposé de la landing** (à publier après VOICE-01) : cible et problème concret ; fonctionnement
(répondre, consulter, enregistrer) ; démonstration avec transcription accessible et mention de simulation si
besoin ; configuration et secours ; limites (pas de synchronisation avec un autre logiciel, pas de gain
garanti) ; prix HT et engagement ; questions pratiques (FAQ) ; CTA vers `/demo`.

**Sources consultées** (13/10/2026) : [famulor.io/fr/industries/restaurants](https://www.famulor.io/fr/industries/restaurants),
[withallo.com/fr/industries/restaurants](https://www.withallo.com/fr/industries/restaurants),
[formitable.com/integrations/bookler](https://formitable.com/integrations/bookler),
[help.zenchef.com (Assistent AI)](https://help.zenchef.com/hc/en-gb/articles/17866645446301-Assistent-ai),
[ainora.lt/fr/standard-telephonique-restaurants](https://ainora.lt/fr/standard-telephonique-restaurants),
[appvizer.fr (logiciels de réservation)](https://www.appvizer.fr/magazine/relation-client/reservation/logiciel-de-reservation-restaurant),
[anolla.com/fr/logiciel-de-restaurant](https://anolla.com/fr/logiciel-de-restaurant),
[cloudtalk.io (réceptionniste IA)](https://www.cloudtalk.io/video/automate-restaurant-front-desk-with-ai-receptionist/).

### 10.9 Dépendances restantes (après qualification)

| Dépendance                                                                                        | Responsable               | Action précise                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Adresse de test autorisée pour la notification de staging, puis adresse commerciale en production | Hamza                     | Indiquer les deux adresses et autoriser la création du secret GitHub `DEMO_REQUEST_NOTIFY_TO` : au niveau dépôt (adresse de test, lue par staging) et dans l'environnement `production` (adresse commerciale, prioritaire en production)         |
| Vérification de la liste opérateur                                                                | Hamza                     | Accès manquant : aucune session opérateur dans le navigateur intégré. Se connecter en compte opérateur sur staging, ouvrir `/dashboard/admin/demo-requests`, vérifier la ligne « QA test Suppernote 13-10-2026 », puis la passer en « Clôturée » |
| Qualification vocale                                                                              | Hamza ou équipe technique | Passer les sept scénarios de la [fiche de qualification](2026-10-13-commercial-demo-validation.md) avec un restaurant de test et un numéro de test, archiver les preuves expurgées                                                               |
| Compte restaurateur de test                                                                       | Hamza                     | Créer un compte de test pour la démonstration en direct de l'onboarding                                                                                                                                                                          |
| Suivi des demandes                                                                                | Hamza                     | Désigner le responsable et fixer le délai de réponse à afficher, ou ne rien afficher                                                                                                                                                             |
| Search Console                                                                                    | Hamza                     | Donner l'accès à la propriété `sokar.tech` (non bloquant pour la landing)                                                                                                                                                                        |
| Lien de navigation admin                                                                          | Auteur du chantier admin  | Ajouter le lien vers `/dashboard/admin/demo-requests`                                                                                                                                                                                            |

### 10.10 Après fusion de #418 (13/10/2026, 18:33 UTC)

- **Fusion** : #418 fusionnée à 18:27:05 UTC, commit `a40edf98` sur `main`. Son arbre est identique à la branche relue (`git diff` vide).
- **CI et déploiements** : la CI de `main` (run 38446846772) tourne encore à 18:33 UTC. Deploy Staging puis Deploy Production s'enchaînent après elle. Leur résultat, la trace du passage de `sync-demo-request-config.sh` dans leurs journaux, et les vérifications de `/pricing` (thème clair mémorisé) et de `/sitemap.xml` (présence de `/demo`) restent à consigner dans cette section.
- **Secret `DEMO_REQUEST_NOTIFY_TO`** : absent du dépôt et de l'environnement `production` (`gh secret list`, 18:28 UTC). Les deux workflows n'appellent pas le script de synchronisation tant que la valeur est vide (garde `-n`) : la configuration existante reste en place. **Aucune notification ne partira tant que le secret n'existe pas.**
- **Accès opérateur** : aucune session opérateur dans le navigateur intégré. `https://staging.sokar.tech/dashboard/admin/demo-requests` affiche « Vérification des accès… », puis redirige vers `/dashboard`. Accès manquant : une connexion en compte opérateur sur staging, dans le navigateur intégré.
- **Workflows Dependabot** : deux runs `Dependabot Updates` (npm_and_yarn à la racine) en échec sur `main` à 18:27 UTC (runs 38446873602 et 38446873630). Ils ne concernent pas #418 et ne sont pas traités ici.
- **VOICE-01** : 0 appel passé. Protocole, scénarios et journal d'essais dans la [fiche de qualification](2026-10-13-commercial-demo-validation.md). Dépendances réelles : un restaurant de test et un numéro de test routé vers lui, et un appelant disposant de ce numéro. Les rejeux LLM ne remplacent pas cette qualification : ils ne couvrent ni la téléphonie, ni le STT, ni le TTS, et l'outil documenté utilise la clé Cerebras de production (en-tête de `apps/api/scripts/voice-behavior-replay.mjs`).
- **LAND-01** : non publiée. Le plan conditionne la publication à la preuve VOICE-01 (backlog, section 17). Search Console ne bloque pas.

### 10.11 Contrôles après déploiement de #418 (13/10/2026, après le run de production du 18:49 UTC)

**Déploiements** (journaux GitHub Actions ; jobs « VPS » et « smoke tests » verts pour les quatre runs) :

| Run         | Workflow          | Déclenché par            | Heure (UTC) |
| ----------- | ----------------- | ------------------------ | ----------- |
| 38447714633 | Deploy Staging    | CI de #418               | 18:33:29    |
| 38448276498 | Deploy Production | Staging vert (#418)      | 18:37:39    |
| 38449590156 | Deploy Staging    | CI de #419 (38448663489) | 18:47:20    |
| 38449918493 | Deploy Production | Staging vert (#419)      | 18:49:48    |

Le texte de `scripts/ops/sync-demo-request-config.sh` apparaît dans les journaux du run 38449918493 (lignes 78 et 244), affiché par l'action SSH. Aucun message d'exécution du script n'apparaît : cohérent avec la garde `-n` sur un secret vide. La preuve d'exécution (« Destinataires … synchronisés ») viendra avec le premier déploiement disposant du secret.

**`/pricing` en production, thème clair mémorisé** (`sokar-dashboard-theme=light`, navigateur intégré) :

- À 375 px : classe `light` absente de `<html>`, fond `rgb(10, 10, 10)`, texte `rgb(240, 240, 240)`, titre « Tarifs » en dégradé découpé sur le texte, visible sur la capture, sans défilement horizontal.
- Largeur par défaut du panneau : la capture montre la page lisible (cartes et prix HT).
- Référence avant #418 (production, #417) : classe `light`, fond `rgb(245, 245, 242)`, titre à couleur transparente sur fond clair : défaut confirmé.
- Le code vérifié est celui de #418 : #419 ne modifie que la documentation.
- Staging non contrôlé dans le navigateur (même code déployé).

**Sitemap** (`curl`, après le run du 18:49 UTC) : `https://sokar.tech/sitemap.xml` et `https://staging.sokar.tech/sitemap.xml` contiennent `/assistant`, `/demo` et `/pricing`.

**Demande de démonstration** : enregistrement vérifié sur staging avant ce contrôle (201, section 10.2). Visibilité opérateur, notification et traitement non vérifiés : accès opérateur et destinataires manquants.

**Qualification vocale** : aucun essai. Le provisioning déclenche un appel Telnyx réel (`POST /api/admin/provisioning/:restaurantId/test-call`), puis exige une confirmation humaine (`validate-test-call`, appel « reçu et entendu »). Ces routes sont réservées à l'opérateur. Prérequis : session opérateur sur staging, restaurant de test provisionné (numéro attribué, webhook vérifié), une personne pour passer l'appel, un accès en lecture au dashboard du restaurant de test.

**LAND-01** : non publiée. Critères du backlog (section 17) : COPY-01, VOICE-01, DEMO-01/02.

- DEMO-01 : enregistrement vérifié ; notification et traitement à vérifier.
- DEMO-02 : responsable désigné, délai de réponse défini, accès opérateur vérifié.
- COPY-01 : affirmations signalées validées (« Support 7j/7 », « sans limite » pour Pro, « Vos clients reconnus à chaque appel », « Toujours disponible », FAQ données et RGPD).
- VOICE-01 : aucune preuve.
- Search Console : non bloquant.

**Dépendances restantes** :

| Débloque                              | Entrée attendue                                                                                                                  | Responsable                                                  |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------- |
| Notifications staging puis production | Adresse de test, adresse commerciale                                                                                             | Hamza                                                        |
| Visibilité, traitement, DEMO-02       | Connexion opérateur sur staging dans le navigateur intégré ; nom du responsable ; délai de réponse                               | Hamza                                                        |
| VOICE-01                              | Restaurant de test provisionné sur staging, numéro et webhook vérifiés, personne pour l'appel, confirmation `validate-test-call` | Hamza ou équipe technique                                    |
| COPY-01                               | Validation des affirmations signalées                                                                                            | Hamza                                                        |
| LAND-01                               | Accueil préparé et vérifié localement (§10.27)                                                                                   | UI conservée ; ancienne route redirigée, aucun ajout sitemap | Livraison groupée sur instruction Hamza ; recette locale actualisée |

### 10.12 Livraison : affirmations retirées, demande traitable, VOICE-01 et LAND-01

**Affirmations retirées ou reformulées.** La garde `apps/dashboard/src/app/marketing-claims.test.ts` liste les formulations sans preuve. Elle a échoué sur sept pages avant les corrections (sept cas rouges) et passe après. Chaque retrait est listé ci-dessous.

| Page                         | Affirmation                                                                                                                               | Action                                                  | Motif                                                                                       |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Inscription et connexion     | Témoignage « Chef Matthieu, Bistrot L’Ardoise — 2 étoiles Michelin », « Suppernote gère 100 % des appels », badge « Partenaire Certifié » | Retiré                                                  | Aucune source dans le dépôt ; le plan réserve les témoignages à leurs propres preuves       |
| Inscription et connexion     | « 98,4 % » « Taux de réponse garanti », « +18,4 % », « 412 » « Appels traités ce mois »                                                   | Retiré                                                  | Valeurs codées en dur, sans source, présentées hors de tout libellé de simulation           |
| Inscription et connexion     | Badge « Simulation temps réel »                                                                                                           | Remplacé par « Exemple illustratif — données simulées » | Même libellé que la démonstration de l’accueil                                              |
| Offres, Essential            | « Répond aux appels transférés, 24h/24 »                                                                                                  | « Répond aux appels transférés »                        | Disponibilité 24 h/24 non démontrée                                                         |
| Offres, Pro                  | « Tout l’Essential, sans limite »                                                                                                         | « Tout l’Essential »                                    | Aucune limite de volume démontrée                                                           |
| Offres, Pro                  | « Vos clients reconnus à chaque appel »                                                                                                   | Retiré                                                  | Reconnaissance des appelants non démontrée dans le parcours vocal                           |
| Offres, Pro                  | « Réservable depuis ChatGPT et Claude »                                                                                                   | Retiré                                                  | MCP peut rester en observation (voir docs/architecture/reservation-commercial-readiness.md) |
| Offres, Pro                  | « Support prioritaire 7j/7 »                                                                                                              | Retiré                                                  | Engagement de support non démontré                                                          |
| Accueil                      | « Toujours disponible » (carte flottante)                                                                                                 | « Répond aux appels transférés »                        | Garantie de disponibilité non démontrée                                                     |
| Illustration du parcours     | « client reconnu »                                                                                                                        | « fiche client »                                        | Reconnaissance non démontrée                                                                |
| Page MCP                     | « Trois scopes, zéro débordement »                                                                                                        | « Trois scopes distincts »                              | Garantie absolue non démontrée                                                              |
| Politique de confidentialité | « Sokar est conforme au RGPD. »                                                                                                           | Retiré                                                  | Affirmation juridique, à valider (dépendance juridique)                                     |

**Restent à confirmer, non modifiés :**

- Hébergement « à Francfort, en Allemagne » (politique de confidentialité) : aucun élément du dépôt ne prouve la région du fournisseur. À confirmer par Hamza, ou à retirer.
- « Ton adapté à votre établissement » : le réglage de style est soumis à des indicateurs de déploiement ciblé (`VOICE_PERSONALITY_STYLE_RESTAURANT_IDS`). À confirmer avant publication.
- « Rapport quotidien de vos appels » : un job de rapport quotidien existe dans l'API. Son contenu reste à vérifier sur un exemple réel.
- Les chiffres de la démonstration de l'accueil (412, 189, 98 %) restent dans des blocs étiquetés « Exemple illustratif — données simulées ».

**Demande de démo traitable.** La page `/admin/demo-requests` est reliée à l'accueil admin et à la navigation admin, avec un réexport de `dashboard/admin/demo-requests`. L'accès reste réservé à l'opérateur côté API (`requireSokarOperator`). Test `admin/page.test.tsx` : rouge sans le lien, vert avec. Restent à vérifier en staging : visibilité, notification et traitement, qui exigent une session opérateur et des destinataires.

**VOICE-01.** La fiche `docs/audits/2026-10-13-commercial-demo-validation.md` distingue deux niveaux : la validation du provisioning (routage, webhook, renvoi, appel de test validé) et la qualification conversationnelle. Elle impose un premier appel de réservation exact dans le dashboard avant les sept scénarios. Statut : non exécutée. Le restaurant de test, le numéro de test et la personne disponible n'ont pas été renseignés.

**LAND-01 : contenu et structure (non publié).**

- Route : `/solutions/assistant-telephonique-restaurant`, créée à la publication seulement. Titre, description et canonical via `pageMetadata`. Sitemap et maillage depuis l'accueil et les offres seulement à la publication.
- Cible : restaurateurs indépendants qui ne peuvent pas décrocher pendant le service.
- Structure, dans l'ordre :
  1. H1 : « Un assistant téléphonique pour votre restaurant ».
  2. Problème : les appels pendant le service et les réservations qui ne sont pas prises. Aucun chiffre sans source.
  3. Fonctionnement : le renvoi transfère l'appel, l'assistant répond, propose un créneau et confirme la réservation.
  4. Démonstration : emplacement réservé à la preuve vocale (audio contrôlé par le visiteur, transcription accessible). Vide tant que VOICE-01 n'est pas qualifiée.
  5. Résultat métier : vide avant preuve. Aucun gain chiffré.
  6. Configuration et secours : numéro dédié inclus, renvoi, prise de relais humaine. Les limites réelles seront écrites d'après les scénarios 3, 4 et 5.
  7. Limites : ce que l'assistant ne fait pas, établi par les essais.
  8. Installation : numéro, renvoi, appel de test, les mêmes étapes que l'onboarding.
  9. Prix : Essential, 199 € HT/mois, ou 159,20 € HT/mois en facturation annuelle (1 910,40 € HT/an, engagement de 12 mois). Montants issus de `PLAN_PRICES_EUR`.
  10. Questions pratiques : quatre ou cinq questions couvertes par des faits (que se passe-t-il si l'assistant ne sait pas répondre, peut-on reprendre la main, le numéro change-t-il, quelles données sont enregistrées — lien vers la confidentialité).
  11. Appel à l'action : « Demander une démonstration », vers `/demo`.
- Conversion : demandes de démo (DEMO-01), source et version de page traçables sans donnée personnelle (METRIC-01).
- Recette à la publication : HTML statique, statut 200, title et H1, canonical, sitemap, responsive, transcription disponible.
- Conditions de publication, toutes requises :
  1. Niveau 1 et niveau 2 de VOICE-01 validés, preuves archivées.
  2. Demande de démo traitable de bout en bout : enregistrée, visible, notifiée, traitée.
  3. Responsable désigné et délai de réponse décidé (aucun délai affiché pour l'instant).
  4. Affirmations restantes validées (section ci-dessus).

Search Console n'est pas une condition.

**Dépendances restantes**

| Débloque                               | Entrée attendue                                                                                                    | Responsable                                                  |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------ | ------------------------------------------------------------------- |
| Notifications, staging puis production | Adresse de test autorisée et adresse commerciale : non fournies (gabarits)                                         | Hamza                                                        |
| Visibilité et traitement en staging    | Session opérateur sur staging : à organiser                                                                        | Hamza                                                        |
| DEMO-02                                | Responsable des demandes : non fourni (gabarit). Délai affiché : aucun, décision enregistrée                       | Hamza                                                        |
| VOICE-01, niveau 1                     | Restaurant de test (référence non fournie), numéro de test et personne disponible (non fournis), session opérateur | Hamza ou équipe technique                                    |
| VOICE-01, niveau 2                     | Premier appel de réservation exact, puis sept scénarios                                                            | Hamza ou équipe technique                                    |
| Affirmations restantes                 | Validation de l'hébergement, du ton, du rapport quotidien                                                          | Hamza                                                        |
| LAND-01                                | Accueil préparé et vérifié localement (§10.27)                                                                     | UI conservée ; ancienne route redirigée, aucun ajout sitemap | Livraison groupée sur instruction Hamza ; recette locale actualisée |

### 10.13 Notifications, téléphonie staging et landing : diagnostic et préparation (13/10/2026)

**Notifications des démos.** Destinataire : `hamza@sokar.tech`. Responsable du suivi : Hamza. Délai affiché : aucun. Le secret `DEMO_REQUEST_NOTIFY_TO` existe au niveau dépôt, lu par staging, et dans l'environnement `production`, lu par la production. Le prochain déploiement l'écrit dans les `.env` via `sync-demo-request-config.sh` : la trace d'exécution reste à consigner.

**Diagnostic des fournisseurs.** `GET /health` :

- staging : `status: degraded`. `telnyx` en erreur, « TELNYX_API_KEY not configured ». `db`, `redis`, `queues` et `cartesia` sont `ok` ;
- production : `status: ok`, `telnyx: ok` (462 ms).

Le runbook staging prévoit `VOICE_DISABLED=true`, `RESEND_API_KEY` vide, et aucun appel réel sans configuration Telnyx complète. Dans le code, sans `RESEND_API_KEY`, l'envoi lève « RESEND_API_KEY is not set » : **une notification de démo ne peut pas partir de staging en l'état**.

**Restaurant de test.** La fiche `chez-sokar-demo` existe sur staging, publiée sous le nom « Chez Suppernote ». Son numéro affiché est le numéro public de démonstration : il n'est pas opérationnel et ne sert pas aux essais.

**Affectation Telnyx.** Non vérifiable depuis ce poste : la clé Telnyx du `.env` de développement est vide. Le contrôle en lecture seule revient à Hamza (section « Ce qui bloque »).

**Préparation livrée.**

- Script `scripts/ops/sync-staging-provider-config.sh`. Il lit les secrets `*_STAGING` du seul workflow de staging. Sans secret, il ne modifie rien.
- Tests manuels sur un `.env` factice : remplacement sans doublon, clé vide sans effet, antislash conservé, commentaire intact, aucune valeur affichée, valeur contenant un espace refusée, fichier absent refusé. Tous passent.
- Le workflow de production ne lit aucun secret `_STAGING`. YAML de staging valide.
- Runbook : section « Fournisseurs de staging » de `docs/runbooks/environment.md`.
- Premier appel guidé : script rédigé dans la fiche VOICE-01, section 4. Le numéro, le restaurant et les conditions de staging restent à fournir.
- Landing : brouillon `/solutions/assistant-telephonique-restaurant`, noindex, hors sitemap et hors navigation, cinq tests verts, typecheck sans erreur. Publication soumise aux conditions de la section 10.12, inchangées.

**Ce qui bloque, par ordre.**

1. Clés de staging, à fournir sans les coller dans le chat ni dans le dépôt, avec `pbpaste | gh secret set NOM --repo Sshindraa/Sokar` après les avoir copiées dans le presse-papiers :
   - `RESEND_API_KEY_STAGING` : clé Resend dédiée à staging. Confirmer la liste des destinataires autorisés, exigée par le runbook ;
   - `TELNYX_API_KEY_STAGING`, `TELNYX_PUBLIC_KEY_STAGING`, `TELNYX_FROM_NUMBER_STAGING` (secrets) et `TELNYX_CONNECTION_ID_STAGING` (variable) : compte Telnyx, application d'appel dédiée à staging avec webhook `https://api-staging.sokar.tech/voice/telnyx`, numéro non affecté à la production.
2. Décision de Hamza : `VOICE_DISABLED=false` en staging, réglage critique à signaler dans la PR concernée.
3. Clés voix de staging à vérifier avec l'équipe : `ELEVENLABS_API_KEY` (transcription), et un LLM (`CEREBRAS_API_KEY` ou `OPENROUTER_API_KEY`).
4. Session opérateur sur staging dans le navigateur intégré, pour la visibilité, la notification et le traitement.

**Ce qui est vérifié, et ce qui ne l'est pas.**

- Enregistrement d'une démo sur staging : vérifié (201, section 10.2).
- Notification en staging : bloquée, la clé d'envoi manque.
- Notification en production : le chemin est configuré, non testé. Un essai créerait une demande réelle en production : à faire seulement avec votre accord.
- Visibilité et traitement : bloqués, la session opérateur manque.
- Voix : aucun appel passé, aucune clé écrite dans le dépôt ni dans le chat.

### 10.14 Preuves après déploiement de #420 et synchronisation des destinataires (13/10/2026, après 19:55 UTC)

- **Déploiements** : #420 fusionnée à 19:44:46 UTC (squash `f6302538`). Deploy Staging (run 38458094330) à 19:50:54 et Deploy Production (run 38458617445) à 19:54:50 : succès.
- **Destinataires des démos** : le script a écrit « Destinataires des demandes de démonstration synchronisés » en staging (19:51:09) et en production (19:54:59). La valeur n'apparaît dans aucun journal.
- **Pages publiques en production** : `/register` et `/login` ne contiennent plus le témoignage, « 98.4 % », « Taux de réponse garanti » ni « Appels traités ce mois » (zéro occurrence chacun). Le libellé « Exemple illustratif — données simulées » est présent.
- **Landing brouillon** : `/solutions/assistant-telephonique-restaurant` répond 404 en production et n'apparaît pas dans le sitemap. Elle est sur la branche `codex/landing-draft-2026-10-13`, en PR brouillon (#422).
- **E-mail en staging** : non vérifié. `RESEND_API_KEY` n'est pas configurée en staging, donc l'envoi est désactivé ; le test de bout en bout attend la clé.
- **Session opérateur** : toujours absente. `https://staging.sokar.tech/dashboard/admin/demo-requests` redirige vers `/dashboard`.
- **Téléphonie staging** : `telnyx` reste en erreur. Les secrets `*_STAGING` restent à fournir ; leur synchronisation est dans cette PR (#423).

### 10.15 Correction de la configuration staging et appels sortants (13/10/2026)

**Corrections** (la PR #423 contenait des erreurs de nommage et de périmètre) :

- `TELNYX_APP_ID` retiré : aucun consommateur dans l'API. Le rattachement d'un numéro lit `TELNYX_CONNECTION_ID` (`admin/provisioning.service`, assign-phone).
- `TELNYX_WEBHOOK_SECRET` retiré : aucun consommateur. La signature des webhooks est vérifiée avec `TELNYX_PUBLIC_KEY` (`voice/telnyx.guard`).
- `TELNYX_CONNECTION_ID` ajouté (variable `TELNYX_CONNECTION_ID_STAGING`) ; `EMAIL_FROM` ajouté (variable `EMAIL_FROM_STAGING`). Sans `EMAIL_FROM`, le code envoie depuis `noreply@sokar.fr`.
- Script, workflow de staging, runbook et exemples `.env` alignés. Le workflow de production ne lit aucun réglage `_STAGING`. Treize vérifications du script passent, sur des valeurs factices.

**Appels sortants : vérifiés, non opérationnels.** Trois défauts de code, non corrigés ici car ils touchent au pipeline vocal :

1. Les deux appelants (`provisioning.service`, `restaurant.routes`) ne transmettent pas `connectionId` : `connection_id` part vide.
2. Le webhook transmis est `${PUBLIC_API_URL}/voice/stream`, route WebSocket du flux média, et non un webhook HTTP. La cible serait `${PUBLIC_API_URL}/voice/telnyx`, mais le pipeline ne traite pas encore l'état `onboarding_test_call`.
3. `PUBLIC_API_URL` n'a pas de valeur par défaut en staging. Le test d'appel du provisioning retombe alors sur `https://api.sokar.tech`, c'est-à-dire la production ; la route restaurant utilise l'hôte de la requête.

Impact : le test d'appel et `validate-test-call` (niveau 1 de VOICE-01) sont bloqués. L'appel de réservation entrant, par `/voice/telnyx`, ne l'est pas.

**Liste consolidée des éléments manquants**

| Élément                                          | Destination                                                                   | Utilité                                           | Statut                                                       |
| ------------------------------------------------ | ----------------------------------------------------------------------------- | ------------------------------------------------- | ------------------------------------------------------------ |
| `RESEND_API_KEY`                                 | secret `RESEND_API_KEY_STAGING`                                               | Envoi des notifications de démo                   | Manquant (clé dédiée à staging)                              |
| `EMAIL_FROM`                                     | variable `EMAIL_FROM_STAGING`, valeur `noreply@sokar.tech` (corrigé en 10.16) | Expéditeur                                        | Renseigné : expéditeur déjà vérifié et utilisé en production |
| `TELNYX_API_KEY`                                 | secret `TELNYX_API_KEY_STAGING`                                               | Toute opération Telnyx                            | Manquant (clé dédiée)                                        |
| `TELNYX_PUBLIC_KEY`                              | secret `TELNYX_PUBLIC_KEY_STAGING`                                            | Acceptation des webhooks                          | Manquant                                                     |
| `TELNYX_CONNECTION_ID`                           | variable `TELNYX_CONNECTION_ID_STAGING`                                       | Rattachement du numéro à l'application de staging | Manquant (identifiant de l'application)                      |
| `TELNYX_FROM_NUMBER`                             | secret `TELNYX_FROM_NUMBER_STAGING`                                           | Numéro émetteur, appels sortants et SMS           | Manquant (numéro E.164 de staging)                           |
| `PUBLIC_API_URL`                                 | `.env` de staging                                                             | Cible des webhooks sortants                       | À confirmer : `https://api-staging.sokar.tech`               |
| `ELEVENLABS_API_KEY`                             | `.env` de staging                                                             | Transcription                                     | À confirmer                                                  |
| LLM : `CEREBRAS_API_KEY` ou `OPENROUTER_API_KEY` | `.env` de staging                                                             | Dialogue                                          | À confirmer                                                  |
| Session opérateur staging                        | navigateur intégré                                                            | Visibilité, notification, traitement              | Manquante                                                    |
| `VOICE_DISABLED=false`                           | `.env` de staging                                                             | Activation de la voix                             | Décision de Hamza                                            |

### 10.16 Test d'appel sortant, e-mail de staging, abonnements et landing : résultats vérifiés (13/10/2026)

**Résultats vérifiés**

- **Appel de test sortant** (code, commit `602136a9`). `connection_id` est repris de `TELNYX_CONNECTION_ID`, sinon refus explicite. Le webhook est `${PUBLIC_API_URL}/voice/telnyx`. Au décroché (`call.answered`), le message est lu ; à la fin de la lecture (`call.speak.ended`), l'appel est raccroché. Ces événements sont traités avant la résolution du restaurant par le numéro appelé. Tests : paramètres d'appel (5), état et actions (6), routage du pipeline (2), URL de webhook dans le test de route (1). Pipeline : 29 tests verts. Typage de l'API : sans erreur.
- **Contrats existants.** La signature de `placeOutboundCall` et les réponses des routes sont inchangées. Une seule assertion a été modifiée : l'URL de webhook du test de route, `/voice/stream` devenant `/voice/telnyx`. Elle figeait le défaut.
- **E-mail de staging.** Expéditeur retenu : `noreply@sokar.tech`, déjà vérifié et utilisé en production (journal du 26/08 : clé d'envoi restreinte, envoi test accepté). Restriction `EMAIL_TEST_ALLOWLIST` : 3 tests verts. Variables de dépôt créées : `EMAIL_FROM_STAGING=noreply@sokar.tech`, `EMAIL_TEST_ALLOWLIST_STAGING=hamza@sokar.tech`, `PUBLIC_API_URL_STAGING=https://api-staging.sokar.tech`.
- **Synchroniseur.** Treize vérifications et dix vérifications complémentaires passent, sur des valeurs factices.
- **Abonnements** (`scripts/ops/verify-stripe-catalog.mjs`, lecture seule, clé de test, prix de staging) : 8 lignes sur 8 conformes, 0 échec. Essential 199 € par mois, 1 910,40 € par an ; Pro 299 € ; Multi-site 249 € ; site supplémentaire 99 €.
- **Landing** (`/solutions/assistant-telephonique-restaurant`, worktree, port 3107). Rendu correct : titre, H1, `noindex, nofollow`, canonical, liens vers `/demo` et `/pricing`, emplacement de preuve. Console sans erreur. À 375 px : pas de défilement horizontal, contrôle visuel du haut et du bas de page. Aucun défaut relevé, aucune modification de la branche.

**Constats non corrigés**

- L'appel de test sortant n'a pas été joué sur le réseau : aucune clé Telnyx n'est disponible depuis ce poste. Le résultat réel dépend d'un appel de test par une personne.
- Le repli de `EMAIL_FROM` dans le code reste `noreply@sokar.fr`, obsolète : la production utilise `noreply@sokar.tech`. Non modifié, hors périmètre.

**Dépendances réelles, par bloc**

| Bloc                      | Éléments manquants                                                                                                                                                                                   | Où les fournir                                       |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| E-mail                    | `RESEND_API_KEY`, clé d'envoi restreinte pour staging                                                                                                                                                | secret `RESEND_API_KEY_STAGING`                      |
| Voix entrante             | `TELNYX_API_KEY`, `TELNYX_PUBLIC_KEY`, `TELNYX_CONNECTION_ID` de l'application de staging, numéro de test rattaché ; clés `ELEVENLABS_API_KEY` et LLM à confirmer ; `VOICE_DISABLED=false`, décision | secrets et variables `_STAGING` ; `.env` de staging  |
| Appel de test sortant     | `TELNYX_FROM_NUMBER` (numéro E.164 de staging) ; profil vocal sortant de l'application à confirmer                                                                                                   | secret `TELNYX_FROM_NUMBER_STAGING` ; portail Telnyx |
| Démo                      | session opérateur sur staging dans le navigateur intégré                                                                                                                                             | navigateur intégré                                   |
| Abonnements en production | clé Stripe de lecture, mode live, non fournie                                                                                                                                                        | non fournie                                          |

### 10.17 Premier lot SEO restaurateurs — contrôle du 14/10/2026

**État de départ.** Dernier main `f2ccffc7` (#430), production sur ce commit (SSH et
Deploy Production 38483758248 réussi). Deploy Staging 38483246357 réussi ; le checkout
staging observé par SSH est `d1fc99b7` : le SHA du checkout ne suffit pas à identifier
les artefacts servis. Travaux locaux du checkout principal préservés ; branche dédiée
`codex/seo-acquisition-2026-10-14`, worktree propre issu d’origin/main.
Les corrections #417/#418/#420 sont intégrées : métadonnées B2B, sitemap réellement
servi par Connect et formulaire sans compte. #422 et #426 sont ouvertes : diff
examiné contre main, reprise de la landing et du seul correctif de notification.
Aucun changement des tarifs, catalogue v3 conservé ; la landing renvoie vers `/pricing`
sans dupliquer montants, quotas ni calcul d’arrondi.

**HTTP et HTML réellement servis avant ce lot**, curl depuis le poste le 14/10 à
12:26 Europe/Paris, sans authentification. Aucun X-Robots-Tag sur les URL ci-dessous.
Le contenu et les H1 sont présents dans le HTML initial, sans exécution JavaScript.
Les canonical pointent sur leur URL production, sans redirection sur les pages 200.

| URL                                            | HTTP | Indexabilité avant ce lot                                | Sitemap           | Indexation réelle          |
| ---------------------------------------------- | ---- | -------------------------------------------------------- | ----------------- | -------------------------- |
| `/`                                            | 200  | index, follow ; canonical racine                         | Oui               | NON VÉRIFIÉE               |
| `/pricing`                                     | 200  | index, follow ; canonical propre                         | Oui               | NON VÉRIFIÉE               |
| `/demo`                                        | 200  | index, follow ; formulaire dans HTML                     | Oui               | NON VÉRIFIÉE               |
| `/assistant`                                   | 200  | index, follow ; canonical propre, intention consommateur | Oui               | NON VÉRIFIÉE               |
| `/robots.txt`                                  | 200  | Allow / ; seuls espaces privés interdits                 | Référence sitemap | Sans objet                 |
| `/sitemap.xml`                                 | 200  | XML valide, quatre pages publiques et Chez Suppernote    | Sans objet        | Ne prouve pas l’indexation |
| `/restaurant/chez-sokar-demo`                  | 200  | **Anomalie : index, follow, fiche fictive**              | **Oui**           | NON VÉRIFIÉE               |
| `/restaurant/chez-sokar-bistrot-paris`         | 404  | Non indexable par statut                                 | Non               | NON VÉRIFIÉE               |
| `/solutions/assistant-telephonique-restaurant` | 404  | Brouillon #422 absent du main                            | Non               | NON VÉRIFIÉE               |

Titles/H1 vérifiés : accueil « Suppernote — Assistant téléphonique pour restaurants » /
« Un assistant téléphonique pour vos réservations » ; tarifs « Tarifs — Suppernote » /
« L’accueil commence avant le premier couvert. » ; démo « Demander une démonstration —
Suppernote » / « Demander une démonstration » ; assistant « Réserver avec votre assistant IA |
Suppernote » / « Réservez avec votre assistant IA ». Descriptions françaises, canonical et
liens internes présents. Accueil comporte 13 liens internes, tarifs 9, démo 6, assistant 2.
La description tarifs servie utilise Multi-site 299 € et remise annuelle 10 %, cohérente
avec main actuel ; aucun retour aux anciens montants de #426.

**Démonstrations.** L’API sitemap ne renvoie que `chez-sokar-demo`, `/public/cities`
renvoie `[]`. Les neuf autres slugs explicites du script historique
`packages/database/scripts/unpublish-demo-restaurants.ts` répondent tous 404 sur
`/public/r/:slug`. Aucun établissement réel n’est disponible pour un échantillon de
fiches réelles : ne pas inventer un inventaire. Liste exacte portée par
`@suppernote/shared/connect-demo` ; aucun filtre par nom ou préfixe. Ce lot applique
`noindex, follow` (robots et Googlebot), titre/description de démonstration et bandeau
visible sur les fiches explicites ; retire leurs données structurées Restaurant/FAQ
et leur présence dans le sitemap, les listes paginées et les comptes/pages locales.
Accès direct et réservations d’essai conservés. Robots.txt reste ouvert pour lire
noindex. Aucune écriture sur les restaurants ni suppression de données.

**403 : cause non établie.** Aucun refus reproduit depuis ce poste : curl ordinaire
et User-Agent OAI-SearchBot répondent 200 sur l’accueil ; origine dashboard, origine
Connect sitemap et origine API répondent 200 via SSH. L’outil web retourne « Internal
Error » sur l’ouverture de l’accueil, sans statut HTTP ni cf-ray exploitable.
Les journaux Nginx ne sont pas lisibles par deploy. Sans réponse originale du 403
(horodatage, cf-ray) ni événements de sécurité Cloudflare, on ne peut attribuer le
refus au WAF, à l’origine ou au relais de l’outil. Aucune protection modifiée.
Un User-Agent déclaré n’authentifie pas un robot ; accès du vrai Googlebot inconnu.
Prochaine action : corréler un refus réel avec Cloudflare Security Events, sans
ouvrir globalement les protections ni déduire un blocage Googlebot.

**Search Console.** Session Brave connectée à `hamza@sokar.tech`, écran
`https://search.google.com/search-console/welcome` « Ajouter un site Web ».
Aucune propriété Suppernote accessible. Manque : propriété domaine `sokar.tech` validée
ou accès à sa propriété existante pour ce compte. Pas de sitemap inspecté dans GSC,
pas de test en direct ni canonical retenue par Google vérifiés. Indexation réelle
**NON VÉRIFIÉE**. Aucune soumission d’indexation prétendue.

**Intention française.** Recherche web « assistant téléphonique pour restaurant
réservation France », 14/10/2026 ; lecture des résultats primaires
[Resadine](https://www.resadine.com/), [Phonalia](https://phonalia.com/restaurants) et
[Replybot](https://www.replybot.org/fr/use-cases/restaurant). Questions observables :
appels pendant le service, réservation et informations pratiques, intégration au
carnet/logiciel existant, renvoi du numéro, configuration et reprise humaine.
Aucun volume ni classement déduit. La landing répond à ces questions ; commandes,
allergènes, synchronisation tierce et reprise instantanée ne sont pas promis.

**LAND-01 finalisé en brouillon.** Route de #422 réutilisée, title/H1 précis,
canonical propre, FAQ, configuration, CTA `/demo?source=assistant-telephonique` et
lien tarifs. Emplacement audio vide retiré ; lien vers la simulation existante de
l’accueil `/#demo`, explicitement qualifiée comme illustration d’interface, sans
appel réel ni résultat client. Pas d’audio, témoignage ou gain inventé. Maintien
`noindex, follow`, hors sitemap et hors navigation ; aucun lien SEO entrant tant
que les conditions documentées de publication ne sont pas satisfaites.
La page est un Server Component sans fetch ni nouveau JS client ; le layout racine
lit déjà cookies pour la langue, empêchant le rendu statique global. Pas de refonte
locale/auth pour ce lot ; Core Web Vitals terrain inconnus.

**Conditions encore manquantes.** VOICE-01 reste non exécuté dans sa fiche : manque
preuve du provisioning/renvoi/appel de test, premier appel créant la réservation
exacte dans le carnet, puis les scénarios et limites qualifiés. Au contrôle SSH,
staging : RESEND_API_KEY, TELNYX_API_KEY et TELNYX_CONNECTION_ID absentes ;
TELNYX_PUBLIC_KEY, ElevenLabs et LLM présents (valeurs jamais affichées).
La session staging `/admin/demo-requests` redirige vers `/dashboard` : manque une
session opérateur autorisée. Hamza est responsable ; destination autorisée
`hamza@sokar.tech`, sans engagement de délai. Les affirmations hébergement précis,
ton et rapport quotidien ont été omises de la landing, pas validées artificiellement.

**Parcours démo.** CTA ouvre le formulaire dans le navigateur. La source connue
uniquement devient `pageVersion=demo-assistant-tel-v1`, champ existant conservé par
l’API et visible dans le suivi opérateur ; aucune query arbitraire ni PII envoyée en
analytics, aucun nouvel outil. Tests : source, persistance API, idempotence, erreur
réseau, validation, refus/exception fournisseur. Correctif #426 : tous les destinataires
sont tentés ; `notifiedAt` n’est renseigné que si chaque résultat est explicitement
`success`. Demande enregistrée même après échec. Libellé opérateur « Envoi accepté »
vs « Envoi non confirmé » ; acceptation fournisseur, réception effective et traitement
restent trois preuves différentes. Réception et traitement humains non vérifiés.

**Recette locale.** Node 22.23.2 ; API 51 tests ciblés, Connect 14, dashboard 24,
typage API/Connect/dashboard sans erreur. Mobile 375×812, iPad 768×1024,
desktop 1440×900 : scrollWidth égal à la largeur, pas de débordement ; inspection
visuelle et FAQ ouverte. Captures dans `assets/seo-2026-10-14/`.
Publication technique, CI et contrôles post-déploiement à suivre dans la PR de ce lot ;
aucun déploiement de cette branche n’est encore revendiqué à cette étape.

**Prochaine action SEO.** Donner accès à la propriété GSC et qualifier VOICE-01 +
suivi opérateur. Ensuite seulement : retirer noindex de la landing, l’ajouter au
sitemap Connect et au maillage accueil/pages pertinentes, inspecter les URL et
soumettre le sitemap. Ne pas lancer des pages par ville sans inventaire réel.

**Contrôle obligatoire pre-push.** Le hook a exécuté la suite API et rencontré deux
échecs existants dans `loyalty.routes.test.ts` : fixture expirant le 14/10/2026 à
10:00 UTC comparée à l’heure réelle. Horloge Date de cette seule suite figée à son
NOW historique (14/09), puis restaurée après chaque test ; aucun changement métier.
Le hook sera rejoué avec ce préalable déterministe, sans ignorer les tests.

### 10.18 Preuves après déploiement du lot SEO (14/10/2026)

- PR [#432](https://github.com/Sshindraa/Sokar/pull/432), fusion automatique le
  14/10 à 12:42:39 Europe/Paris. Commit squash `bb0759f0e38db6a73690f6e3fe89fb26eed60b5e`
  (commits de branche `5b67fcdc`, `829cc62a`). Les deux CI de branche sont vertes
  (38550659680, 38550667826) ; CI main 38551470336 verte, CodeQL vert.
- Deploy Staging [38552161298](https://github.com/Sshindraa/Sokar/actions/runs/38552161298)
  et Deploy Production [38552689157](https://github.com/Sshindraa/Sokar/actions/runs/38552689157) :
  **succès, smoke tests inclus**. Staging snapshot `20261014T105132Z`, commit local
  `c3b3df7f` intitulé « snapshot bb0759f0… » ; c’est la représentation de source du
  déploiement staging, pas un autre lot. Le snapshot staging précédent `d1fc99b7`
  portait de la même façon la source `f2ccffc7`. Production snapshot
  `20261014T105602Z`, `.latest-hash=bb0759f0…`.
- Staging a répondu brièvement 502 puis 404 pendant le redémarrage et le test de
  rollback prévu par le workflow. La release courante a été restaurée, puis la
  landing contrôlée en 200 après workflow vert. Aucun changement de protection ni
  réparation manuelle du déploiement.
- Santé production : `/health` et `/livez` API en 200. Snapshot conservé ; rollback
  applicatif via `scripts/deploy.sh --env prod rollback`, sans rollback DB par
  défaut. Aucune migration ni modification d’auth, paiement ou voix dans ce lot.

**Contrôle HTTP/HTML production après déploiement**, 14/10 vers 12:57 Europe/Paris :

| URL                                            | Accessible            | Indexable techniquement                                 | Indexation Google                                |
| ---------------------------------------------- | --------------------- | ------------------------------------------------------- | ------------------------------------------------ |
| `/`                                            | 200, sans redirection | Oui, canonical propre                                   | NON VÉRIFIÉE                                     |
| `/pricing`                                     | 200, sans redirection | Oui, canonical propre                                   | NON VÉRIFIÉE                                     |
| `/demo`                                        | 200, sans redirection | Oui, canonical propre                                   | NON VÉRIFIÉE                                     |
| `/assistant`                                   | 200, sans redirection | Oui, canonical propre                                   | NON VÉRIFIÉE                                     |
| `/robots.txt`                                  | 200                   | Accès public autorisé, aucun Disallow démo              | Sans objet                                       |
| `/sitemap.xml`                                 | 200                   | 4 URL B2B/information, aucune démo ni landing brouillon | Ne prouve pas l’indexation                       |
| `/restaurant/chez-sokar-demo`                  | 200                   | **Non : noindex, follow**, Googlebot idem               | NON VÉRIFIÉE, retrait effectif de Google inconnu |
| `/solutions/assistant-telephonique-restaurant` | 200                   | **Non : brouillon noindex, follow**                     | NON VÉRIFIÉE                                     |

Titles, descriptions, H1 et canonical toujours présents dans le HTML initial ;
aucun X-Robots-Tag en production. Chez Suppernote : title « Chez Suppernote — Démonstration Suppernote |
Suppernote », description d’établissement fictif, bandeau d’essai visible, aucun JSON-LD
Restaurant. La liste publique staging n’annonce plus de restaurant (`total=0`).
Les tarifs v3 sont inchangés. Landing : title « Assistant téléphonique pour restaurant —
Suppernote », H1 « Un assistant téléphonique pour votre restaurant », canonical absolue propre,
liens démo avec source et tarifs présents. Hors sitemap et hors maillage entrant, décision
maintenue tant que VOICE-01 et le parcours opérateur ne sont pas qualifiés.

**Parcours réel depuis le navigateur et vérification de stockage en lecture seule :**

| Environnement | Référence opaque d’essai               | Enregistrement et source                                                  | Notification                                                                    | Traitement        |
| ------------- | -------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ----------------- |
| Staging       | `9a23707f-a057-4060-86b7-9ee3b86264aa` | Confirmation UI ; en base à 12:53:50, `pageVersion=demo-assistant-tel-v1` | `notifiedAt=null` ; Resend absent, demande conservée                            | `NEW`, non traité |
| Production    | `f8d822c7-0cb1-4dc7-a421-628473cde0e0` | Confirmation UI ; en base à 12:58:34, même source                         | `notifiedAt=12:58:34` après `outcome=success`, destination autorisée uniquement | `NEW`, non traité |

Les deux demandes sont explicitement marquées essais techniques SEO, sans restaurant
réel ni prospect commercial. Elles ont été conservées, aucune suppression de données.
Adresse de notification production et allowlist vérifiées sans afficher de secret :
uniquement `hamza@sokar.tech`, clé d’envoi présente. L’acceptation du fournisseur suit
le garde-fou du code déployé ; **réception effective dans la boîte mail non vérifiée**.
Session opérateur production : redirection vers `/login` ; staging : vers `/dashboard`.
**Visibilité et traitement réels dans l’interface opérateur non vérifiés**, contrairement
aux tests UI/API verts et à la persistance/source constatées en base. Aucun droit élargi.

Captures remplacées par celles de production :
[desktop](assets/seo-2026-10-14/landing-desktop.jpg),
[iPad](assets/seo-2026-10-14/landing-ipad.jpg),
[mobile](assets/seo-2026-10-14/landing-mobile.jpg),
[confirmation production](assets/seo-2026-10-14/demo-production-success.jpg),
[confirmation staging](assets/seo-2026-10-14/demo-staging-success.jpg).
Les trois largeurs production ont scrollWidth égal à innerWidth : 1440, 768, 375 px.
Ces captures prouvent le rendu, pas une conversation vocale ni des Core Web Vitals terrain.

**Blocages précis et prochaine action.** L’accès direct à la propriété GSC
`sc-domain:sokar.tech` affiche « Désolé, vous n’avez pas accès à cette propriété »
pour `hamza@sokar.tech` : demander l’accès à un propriétaire ou vérifier la propriété.
Puis inspecter les URL, canonical Google et sitemap, sans promettre de délai ni de rang.
Pour rendre la landing indexable : archiver VOICE-01 niveaux 1/2 et scénarios, puis
consulter et traiter une demande avec une session opérateur autorisée, confirmer sa
réception. Les clés staging Resend/Telnyx API/connexion restent à fournir ; aucun
nouveau chantier téléphonie lancé. Cause des anciens 403 toujours non établie :
obtenir réponse originale/cf-ray et accès aux événements Cloudflare avant toute correction.

### 10.19 — Réception, suivi opérateur et Search Console qualifiés (14/10/2026)

**Parcours production confirmé.** La notification du test technique
`f6ff0cb4-bc6a-45b6-8a3e-b1aa451b3ba0` est reçue dans Gmail à 13 h 36
Europe/Paris après retrait de la seule suppression Resend héritée d’un rejet
Google `550 5.1.1 NoSuchUser` du 18 septembre. La boîte reçoit désormais ;
l’acceptation fournisseur seule ne constituait pas une preuve de réception.

Le compte opérateur existant accède à `/admin/demo-requests` après #434
(`fac259cc2d2b8e193a929bbf43295d03a290f98d`). Le garde client attend désormais
la résolution de la session Clerk avant toute redirection. Aucun droit élargi.
Notre seul essai a été passé à **CLOSED** dans l’interface ; état confirmé après
rechargement et en base, en lecture seule. `contactedAt` et `demoDoneAt` restent
nuls : aucune prise de contact client ni démonstration commerciale revendiquée.
L’autre demande technique a été laissée intacte.

Validation : reproduction de l’échec avant correctif, 9 tests ciblés verts,
619 tests dashboard et 71 shared verts, typage et lint verts. CI main
`38563729276`, staging `38564475720` et production `38565018595` réussis.

**Search Console accessible sans nouveau droit.** La propriété
`sc-domain:sokar.tech` est accessible avec le compte Google personnel déjà
connecté ; le compte Workspace reste sans accès. Le sitemap existant
`https://sokar.tech/sitemap.xml` a été renvoyé une seule fois le 14 octobre :
confirmation « Sitemap envoyé ». La dernière lecture affichée reste celle du
13 octobre ; aucun délai d’exploration ou d’indexation n’est garanti.

L’inspection de l’accueil indique que l’URL est sur Google. Le test direct du
14 octobre à 14:26:36 réussit : accès smartphone, exploration et indexation
autorisées, récupération réussie, canonical déclarée `https://sokar.tech/`.
Le test direct ne détermine pas la canonical choisie par Google à l’indexation.
Il ne permet pas d’expliquer rétrospectivement les anciens 403.

Le rapport global d’indexation est daté du **9 octobre**, avant les derniers
changements : 3 pages indexées, 4 non indexées. Exemples indexés alors : accueil,
ancienne URL HTTP `/login` et ancienne fiche `/restaurant/chez-sokar-tapas-paris`.
Au contrôle HTTP actuel, `/login` est noindex et l’ancienne fiche renvoie 404 ;
leur retrait effectif reste à vérifier au prochain rapport. Le HTTP `/login`
répond encore 200 sans redirection HTTPS, point observé hors de ce lot.
Aucune modification de protection réseau ou DNS.

Référence acquisition, période affichée du 12 juillet au 11 octobre :
15 clics, 670 impressions, CTR 2,2 %, position moyenne 16,5. Les requêtes visibles
sont surtout la marque et ses variantes ; leur liste est partielle et ne
permet pas d’attribuer tous les clics à la marque.

**Prochaine dépendance : VOICE-01.** En staging, la voix est désactivée et les
variables Telnyx API, clé publique, connexion et numéro d’émission manquent.
Le contrôle fournisseur en lecture seule n’a identifié aucune application
staging/test dédiée. Ne pas copier les secrets de production ni composer le
numéro fictif du seed. Préparer une ressource de test dédiée, puis qualifier
une conversation réelle et ses effets dans l’interface : réservation,
modification, indisponibilité et recours humain selon la matrice VOICE-01.
Aucun numéro acheté, aucune clé créée, aucun appel fournisseur lancé.
La landing conserve son noindex et reste hors sitemap jusqu’à cette recette.

Preuves locales : dossier `sokar-qualification` du 14/10 dans les visualisations
Codex : `operator-cloture.png`, `sitemap-envoye.png`,
`accueil-google-test-direct.png`, `indexation-rapport-9-octobre.png` et
`pages-indexees-9-octobre.png`. Réception : `sokar-email-recovery/notification-recue.png`.

### 10.20 — VOICE-01 : préparation autorisée, recette encore ouverte (14 octobre)

Accord explicite : clé séparée temporaire, routage du seul numéro démo vers staging puis restauration production ; consommation plafonnée à 20 minutes et 5 €, sans achat/recharge. Clé staging créée, expiration le 21 octobre 2026 à 23:55 UTC, stockée uniquement dans GitHub et le fichier environnement staging après transit privé supprimé. Application « Suppernote VOICE-01 staging » créée avec webhook staging ; numéro encore en production et voix staging encore désactivée.

Blocage corrigé : le seed démo fournit un numéro de gérant fictif. Le contexte vocal le neutralise pour les seuls slugs démo explicites, aussi sur cache existant, afin de conserver le secours par message. Aucun numéro réel modifié, aucun changement de schéma ni de contrat. Deux tests échouaient avant correction ; 80 tests ciblés, typage API et lint ciblé passent.

Aucun appel réel exécuté ni résultat métier qualifié à cette étape. Staging utilise Scribe et production Deepgram : cette différence doit rester visible dans les preuves. Les sept scénarios et la réservation initiale restent à exécuter ; landing noindex et hors sitemap.

Blocage supplémentaire constaté lors de la préparation : la page opérateur staging redirige vers le dashboard parce que requireAuth remplace la session par demo-user. Correction limitée au middleware opérateur : vraie session requise en staging/production, liste autorisée conservée, preview local conservé. Trois régressions reproduites avant correction puis 10 tests du middleware verts. La connexion opérateur et les appels réels restent à vérifier après déploiement.

Le contrôle navigateur de /login a révélé le provider Clerk absent en staging démo. Le complément monte Clerk sur connexion/admin, active la lecture de session middleware et protège les routes opérateur, en gardant le dashboard démo accessible. Le proxy existant peut alors transmettre son jeton serveur. 8 tests ciblés dashboard et 23 tests auth/provisioning API verts ; typage et lint ciblés verts. Aucun changement de la liste opérateur.

#436 fusionnée (`0b1c134b`), CI main `38604351722` réussie. Déploiement staging `38605304964` : artefacts livrés, promotion bloquée par trois tests simulant un opérateur sans session Clerk. Les remplacer à distance par une preuve réelle de refus sans session, tout en conservant les tests du shell en preview local : 6 tests distants réussis, 3 scénarios locaux non applicables.

Le compte opérateur configuré appartient à Clerk Production et renvoie 404 dans Clerk Development ; le compte personnel connecté est une identité distincte. Accord explicite reçu pour autoriser ce seul compte sur staging via SOKAR_OPERATOR_USER_IDS_STAGING. Aucun ajout en production ; aucun appel à ce stade.

### 10.21 — Dépendances corrigées : simulation, acquisition et pilotes (15 octobre)

Décision explicite de Hamza : la démonstration publique est un exemple simulé, sans parcours de
réservation client réelle. DEMO-SIM vérifie sa transparence et son isolation. VOICE-01 qualifie
les opérations réelles sur données de test avant activation client ; OPS-01 qualifie l'installation.
La landing peut être publiée quand son contenu est exact, son exemple isolé s'il est présenté et
son CTA/suivi minimal fonctionnel, sans attendre tous les appels, les entretiens ou un renouvellement.
Le noindex actuellement servi reste inchangé dans ce lot documentaire.

Entretiens, SEO et préparation des pilotes avancent en parallèle. Huit à douze entretiens sont un
repère, pas un quota. Le premier candidat qualifié peut démarrer sans attendre le second. Essential
reste le périmètre initial, sous réserve d'adéquation au besoin ; aucune modification automatique
d'offre. La revue à sept jours vérifie l'exploitation, pas la fidélisation ou la rentabilité durable.
Le suivi commercial commence avec les sources existantes ; sa complétude future ne bloque pas
l'acquisition. Les preuves client, paiements et renouvellements restent à constater.

État opérationnel relu le 14 octobre : #437 déployée, CI/staging/production réussis ; santé API 200/ok des deux
environnements ; variables Telnyx staging présentes et VOICE_DISABLED=false. Deux appels démo
du jour relus en base, sans coordonnées ni transcript : NO_ACTION et réservation liée absente.
La landing publique reste 200/noindex et hors sitemap. Aucun test vocal supplémentaire, achat,
envoi, activation ou changement de droits dans ce lot. La section 2 remplace le tableau initial
obsolète ; les observations datées sont préservées.

### 10.22 — Simulation publique et landing : recette locale du 15 octobre 2026

**Préparé et vérifié localement, non commité, non déployé.** Roadmap corrigée #439 consultée
par son diff et reprise dans les documents locaux sans fusion ni changement de branche. Les
observations distantes de §10.21 proviennent de cette roadmap ; elles n’ont pas été rejouées ici.
Les changements préexistants des bancs voix et d’environnement sont conservés.

**DEMO-SIM : qualifié localement pour l’animation existante.** La landing renvoie uniquement à
`/#demo` : `DemoSection` déroule `SIMULATOR_STEPS` par timers et état React. Les curseurs changent
seulement leur état visuel. Aucun fetch, WebSocket, microphone, lecteur audio, outil de réservation,
notification, paiement, transfert ni événement analytique métier dans ce chemin. Les nombres sont
codés dans la maquette ; ils n’alimentent aucun résultat commercial. Le storyboard de l’accueil
est lui aussi illustratif, sans action métier. Aucun lien de ce parcours ne mène à un restaurant
client. Le formulaire `/demo` est une demande commerciale distincte ; ses envois ont été mockés.

Restaurant explicitement fictif (« Bistrot Exemple »), disponibilités et résultat simulés, retrait
de l’annonce de SMS envoyé. Nature sans audio et limites de preuve visibles, réglages explicitement
visuels. Pas de conversation interactive ni d’enregistrement à transcrire ; les chemins de secours
vocaux ne sont donc pas exercés par cet exemple. VOICE-01 reste une recette réelle séparée avant
activation client, sans qualification supplémentaire revendiquée.

**LAND-01 : critères locaux satisfaits, livraison en attente.** Cible, demandes prises en charge,
préparation dans l’établissement, limites et recours humain, demande de démonstration et tarifs
explicites. Retrait local du seul noindex de cette landing, canonical absolue vérifiée dans le HTML,
ajout au sitemap Connect et liens depuis accueil et tarifs. Les restaurants fictifs conservent
leur noindex et leur exclusion du sitemap ; tests de métadonnées et fixtures réussis. Aucun tarif,
calcul, abonnement, fournisseur, secret ou droit modifié. Aucun sitemap soumis ni indexation demandée.

**Recette.** 48 tests ciblés uniques dashboard et Connect, typage dashboard, build production dashboard et lint ciblé réussis. Navigateur
Chromium aux dimensions 1440×900, 390×844 et 768×1024 : canonical, absence de noindex, ouverture FAQ,
aucun débordement horizontal, aucun pageerror. CTA vers `/demo?source=assistant-telephonique` puis
`pageVersion=demo-assistant-tel-v1` conservés. Envoi 503 puis reprise 201 simulés localement sur les
trois formats. Toutes les requêtes hors localhost étaient bloquées ; aucune n’a été observée.
Le test de l’animation déroule le scénario et manipule un curseur sans requête ni média.

Prévisualisation : http://localhost:3100/solutions/assistant-telephonique-restaurant . Captures :
`/Users/hamza/.codex/visualizations/2026/10/15/sokar-demo-landing/` (`landing-desktop.png`,
`landing-mobile.png`, `landing-ipad.png`, variantes `simulation-*` et `form-error-*`).
Le script de recette local est conservé dans ce dossier. Le build confirme `ƒ` sur la landing. Le layout racine lit déjà `cookies()`
pour la langue : le rendu dynamique préexistant reste une limite, sans refonte de l’i18n dans ce lot.

**Livraison restante.** À la demande de Hamza : revue du diff groupé, commit/PR/CI puis recette staging
et livraison selon le runbook, vérification HTTP des métadonnées, sitemap et CTA. Pas de publication
production revendiquée pour ces changements locaux ; VOICE-01 et OPS-01 restent ouverts.

Fichiers applicatifs de ce lot :

- `apps/dashboard/src/app/DemoSection.tsx` et `DemoSection.test.tsx` ;
- `apps/dashboard/src/app/constants.ts` (scénario seulement) ;
- `apps/dashboard/src/app/solutions/assistant-telephonique-restaurant/page.tsx` et `page.test.tsx` ;
- `apps/dashboard/src/app/page.tsx` et `pricing/page.tsx` (liens) ;
- `apps/connect/src/app/sitemap.ts` et `sitemap.test.ts`.

Documents : ce rapport, `docs/obsidian/Context.md`, `docs/obsidian/Journal.md` et reprise de #439
dans `docs/runbooks/seo-acquisition-execution-plan.md`, `essential-pilot-7-day.md`,
`restaurant-discovery-interview.md`. Les fichiers générés par Next ont été restaurés à leur contenu
initial ; les sorties de compilation sont exclues localement de Git.

### 10.23 — METRIC-01 et ICP-01 : supports locaux du 15 octobre 2026

**Préparé et vérifié localement, non commité, non déployé.** Lot démo/landing et autres changements
préexistants conservés. Aucun nouveau dashboard, changement d'API, schéma, événement analytique,
onboarding, rôle ou droit. Aucun contact envoyé, aucune lecture/mutation distante ni paiement déclenché.

**METRIC-01, périmètre minimal prêt.** Le [mode opératoire](../runbooks/commercial-follow-up.md)
relie les sources existantes et fournit le modèle de relevé à copier dans l'espace commercial restreint.
Les manques constatés sont explicites : `DemoRequest` n'a ni lien Clerk/compte ni marqueur test ;
`pageVersion` identifie un parcours client, pas une acquisition SEO prouvée ; les projections billing
ne prouvent pas l'encaissement et le journal de webhook ne conserve pas la facture complète.

Le rapprochement demande → identité → compte/restaurant est donc manuel, confirmé et documenté ;
pas de jointure automatique par e-mail ni de conversion attribuée si identité ambiguë. Les dates de
création du restaurant ou d'adhésion ne sont pas une inscription Clerk. Les comptes préexistants et
invitations ne sont pas de nouvelles acquisitions. Activation technique et mise en service qualifiée
VOICE-01/OPS-01 restent distinctes ; `firstCallAt` peut être un appel d'essai.

Le relevé exclut tests, fixtures, doublons, spam et inconnus des conversions et dénominateurs ; les
trois demandes techniques déjà documentées sont référencées explicitement. Un vrai refus commercial
reste dans la population. La cohorte d'onboarding agrège des essais : elle ne devient pas un bilan
commercial. Premier paiement = facture d'abonnement live réellement encaissée et reliée, dédupliquée
par facture, sans inférence depuis `active` ou le retour navigateur. Remboursements et crédits restent
séparés. Aucun rapprochement réel prospect/compte/facture qualifié dans ce lot ; le premier devra
être confirmé dans le relevé restreint avant un bilan. Aucun espace externe créé ni donnée personnelle
ajoutée au dépôt. Ce dispositif manuel compense les manques pour les premiers contacts ; il ne prétend
pas automatiser l'attribution ni filtrer les vues opérateur existantes.

**ICP-01, supports finalisés.** [Guide existant](../runbooks/restaurant-discovery-interview.md)
complété : cible indépendants mono-site, priorité bistrots/brasseries avec service à table et carnet
commun possible ; exclusions métier, décideur, budget/cadence, preuve et prochaine action datée.
Entretien aligné sur l'invitation de vingt minutes ; distinction candidat commercial/prêt à activer.
Message de prise de contact explicite sur Suppernote, invitation à une démo et proposition écrite de
pilote préparés, tous non envoyés. Essential 199 € HT/mois ; annuel −10 %, 2 149,20 € HT/an, équivalent
exact 179,10 € HT/mois. Aucun nouveau quota, remise, délai ou engagement de support inventé.
Absence actuelle de quota client voix/SMS recoupée avec les inclusions publiques ; frais de renvoi
distincts. Sept jours = observation opérationnelle, pas gratuité ni modification de l'abonnement.
Les entretiens peuvent commencer en parallèle de VOICE-01, le premier pilote n'attend pas le second.
Le [runbook pilote](../runbooks/essential-pilot-7-day.md) renvoie au relevé et distingue usages/tests.

**Vérifications.** 31 tests ciblés réussis : catalogue partagé (10), formulaire/source/reprise (7),
routes demandes et statuts avec DB/e-mail mockés (14). Montants Essential mensuel/annuel et remise
recalculés depuis le catalogue local ; 28 liens des quatre runbooks résolus. Cas synthétiques du
relevé revus : test en production, doublons, compte ambigu/préexistant, sandbox, montant nul,
paiement avant activation. Prettier, diff sans erreur et taille du vault contrôlés. Pas de nouvelle
recette navigateur nécessaire : seuls des documents ont changé dans cette continuation.

**Fichiers de cette continuation.** Nouveau `docs/runbooks/commercial-follow-up.md` ; enrichissement
`restaurant-discovery-interview.md`, `essential-pilot-7-day.md`, `seo-acquisition-execution-plan.md`,
ce rapport, `docs/obsidian/Context.md` et `Journal.md`. Tous les fichiers applicatifs du lot précédent
sont conservés. Suite humaine : choisir les premiers contacts et l'espace restreint, autoriser un
éventuel envoi, puis tenir les preuves réelles. Livraison groupée uniquement sur instruction Hamza.

### 10.24 — Revue finale locale du lot cumulé (15 octobre 2026)

[Revue et manifeste précis de livraison](2026-10-15-growth-final-review.md) : 17 fichiers du lot.
Corrections limitées : conditions d’usage au lieu de minutes incluses sur la landing ; checklist
pilote VOICE-01/OPS-01, secours, facture encaissée et droits ; ouverture d’entretien cohérente avec
le message. 82 tests ciblés, typage, lint, recette desktop/mobile/iPad avec mocks, format/liens/vault
et scan de secrets du diff livrable réussis. Aucun blocage applicatif restant identifié sur ce
périmètre. Terrain, recette vocale, installation et preuves client restent ouverts selon la revue.
Dix sources préexistantes des bancs/environnement exclues ; pendant la revue, deux fichiers de
prototype vocal sont apparus et environment.md a reçu un ajout concurrent, tous conservés hors lot.
390 autres fichiers préexistants inchangés par empreinte. Recontrôler l’inventaire avant livraison.
Statut : préparé et vérifié localement, non commité, non déployé. Livraison toujours suspendue
à l’instruction de Hamza ; aucun envoi, commit, push, PR ou déploiement exécuté.

### 10.25 — Accueil prioritaire, UI conservée et landing retirée du lot (15 octobre)

Décision Hamza : concentrer l’acquisition sur l’accueil `sokar.tech` sans changement de design.
Les ajouts de liens vers la landing et sa présence dans le sitemap sont retirés localement.
L’ancienne route devient une redirection permanente vers `/` (HTTP 308 local). Les précisions utiles
sont intégrées aux sept réponses de la FAQ existante, sans ajouter de section ni modifier ses styles.
Hero, accueil, page Tarifs, sitemap et composant FAQ identiques à HEAD ; simulation et supports
METRIC-01/ICP-01 du lot précédent conservés. Le CTA accueil générique reste inchangé, aucune
attribution automatique à l’accueil ou au SEO n’est ajoutée. LAND-01 désigne désormais l’accueil.

Manifeste actualisé de 13 fichiers dans la revue finale. Suites dashboard 692 et Connect 141 vertes,
typage/lint ciblés verts ; HTTP 308, canonical accueil, absence de liens vers l’ancienne landing et
absence de débordement vérifiés localement. Les 13 fichiers hors lot sont inchangés par empreinte.
Les anciennes captures et observations de landing restent historiques. Préparé localement,
non commité, non déployé ; aucun appel, envoi, paiement ou effet distant.

### 10.26 — Écarts SEO accueil : contrôles locaux du 15 octobre 2026

**Statut : Préparé localement, vérification partielle. Non commité, non déployé.**

État repris sans nouvel audit complet :

| Classe       | Preuve et décision                                                                                                                                                                                                     |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Acquis       | Étude d’intention du 13/10 (§10.8), indexation accueil/test direct GSC du 14/10 (§10.19), simulation/FAQ/redirection locales du 15/10 (§10.22 et §10.25). Ces preuves antérieures ne sont pas des contrôles de ce lot. |
| Ouvert       | Performance représentative en production locale ; qualification du contenu légal ; retrait effectif des anciennes URL indexées ; recette après future publication.                                                     |
| Obsolète     | Création/maillage/indexation d’une landing séparée, anciennes indications d’accès GSC absent. Aucun nouveau bloc ni nouvelle route.                                                                                    |
| À revérifier | FAQ et lien confidentialité après correction ci-dessous ; redirection et sitemap après livraison groupée.                                                                                                              |

**Intention conservée.** Cible France entière : restaurateurs recherchant un assistant téléphonique pour leurs réservations. Secondaires compatibles : gestion des appels pendant le service, disponibilités du carnet, réservations téléphone/web/salle. « Réserver une table » seul vise le consommateur et ne devient pas la cible de l’accueil. Les recherches du §10.8 suffisent à ce cadrage ; aucune étude exhaustive ni nouveau volume nécessaire. Volumes, difficulté et potentiel restent inconnus. Title « Suppernote — Assistant téléphonique pour restaurants », description, H1 et hero conservés : cible, tâche et fonctionnement explicites, sans gain chiffré. Open Graph et Twitter cohérents dans le HTML ; aucune image sociale ajoutée pour produire un changement. Un H1 ; sections en H2, détails en H3/H4. Les titres H4 du pied de page sont conservés : aucune ambiguïté commerciale démontrée justifiant une modification de structure.

**Deux corrections fondées sur des défauts observés.**

- `apps/dashboard/src/app/page.tsx` : « Confidentialité » avait `href="#"`, retour au haut de page. Destination remplacée par `/privacy`, route existante. Même élément, texte et classes. Le routage versionné sert `/privacy` depuis Connect ; cette page répond 200 sur son serveur local. La page dashboard homonyme contient des champs à remplir : elle ne prouve pas le contenu servi en production.
- `apps/dashboard/src/app/constants.ts` : la FAQ disait que la politique détaillait les sous-traitants et leur localisation. La page Connect réellement routée ne les détaille pas. Réponse limitée aux données traitées, droits et possibilité de contact. Aucun nouveau engagement juridique, tarif ou abonnement.

**Contrôles exécutés pendant ce lot.**

- Dashboard développement existant `:3100` conservé : GET accueil 200 ; un H1, hero et réponses FAQ présents dans le HTML initial ; canonical `https://sokar.tech` (équivalent racine avec slash), robots `index, follow`, pas d’en-tête X-Robots-Tag bloquant observé. Title/description/OG/Twitter métier présents.
- Ancienne route : 308 avec `Location: /`. Aucun lien de l’accueil vers cette route dans le DOM aux trois formats.
- Connect distinct `:4311`, `SITE_URL=https://sokar.tech`, API mock locale `:4312` : sitemap XML avec accueil, assistant, tarifs, démo et une fiche témoin ; deux fixtures explicites exclues, landing/book/widget absents. Robots autorise `/` et référence le sitemap de production. Le mock prouve génération/filtrage, **pas** disponibilité ni inventaire de l’API réelle. Premier essai avec SITE_URL local a produit localhost : configuration de recette corrigée, aucune configuration applicative modifiée.
- Lecture de `infra/nginx/sokar.conf` : accueil/ancienne route vers dashboard, sitemap/robots/privacy vers Connect. Aucun Nginx exécuté ni modifié ; assemblage distant à requalifier après livraison.
- Vitest dashboard ciblé : 3 fichiers, 10 tests verts (métadonnées, simulation, redirection), puis Connect sitemap : 6 tests verts. ESLint `page.tsx`/`constants.ts` et typecheck dashboard réussis. Tests ciblés dashboard rejoués après les deux corrections ; pas de nouvelle suite complète.
- Recette navigateur 1440×900, 390×844 et 768×1024 : pas de débordement horizontal, même H1, canonical et lien corrigé, sept questions conservées. FAQ données ouverte et lisible sur mobile ; pas de changement de styles, disposition, composants ou animations. Console navigateur : aucun message de niveau erreur recueilli. Captures avant issues du checkout local actuel, après issues de ce même serveur ; animations non figées, pas de promesse d’identité pixel.

**Performance : limite explicite.** Build dashboard isolé `.next-seo-local` réussi avant les deux corrections de texte/lien, typage inclus. Serveur de production isolé `:4310` en HTTP 500 : middleware refuse l’absence de `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` au build. Aucune protection contournée, aucun secret ajouté. Pas de Lighthouse, LCP/CLS/INP, mesure laboratoire représentative ni comparaison performance avant/après. Les captures développement ne sont pas des mesures de performance. Les deux corrections finales ne disposent donc pas d’un nouveau build production exécutable vérifié. Aucun correctif performance spéculatif appliqué. GSC vue d’ensemble : aucune donnée Core Web Vitals mobile/ordinateur.

**GSC relu en lecture seule ce lot.** Propriété `sc-domain:sokar.tech`, compte personnel existant. Performances trois mois : 13 juillet–12 octobre, mise à jour indiquée il y a 10 heures, 15 clics, 671 impressions, CTR 2,2 %, position 16,3. Dix premières lignes sur 19 surtout marque/variantes (`sokar` : 4 clics, 328 impressions). Liste partielle : aucun total hors marque déduit ; ces chiffres ne sont pas des volumes de marché. Vue d’ensemble : 3 pages indexées, 4 non indexées. Ni inspection URL actuelle, ni canonical choisie, ni retrait des anciennes URL vérifiés dans ce lot. Aucune soumission sitemap/demande d’indexation.

**Restes précis.** « Mentions Légales » et réseaux sociaux du footer pointent toujours vers `#` : aucune destination réelle trouvée, aucun lien inventé ni bloc/design changé. À fournir/qualifier séparément. La politique Connect reste limitée aux parcours de réservation ; revue de son exhaustivité hors lot. Promesse support 7j/7 non ajoutée, catalogue/prix inchangés. Après publication autorisée : vérifier HTTP/routage/sitemap réels, inspection accueil et retrait anciennes URL, suivre requêtes pertinentes et impressions/clics hors marque. Une demande n’est SEO que si son origine est réellement établie : `/demo` générique et `pageVersion` n’y suffisent pas ; conserver le rapprochement manuel confirmé de METRIC-01.

**Preuves de ce lot :** `/Users/hamza/.codex/visualizations/2026/10/15/sokar-home-seo/` : `before-{desktop,mobile,ipad}.png`, `after-{desktop,mobile,ipad}.png`, `after-faq-mobile.png`, `before.html`, `after.html`, `responsive.json`, `http-checks.json`, `connect-sitemap.xml`, `connect-robots.txt`, `redirect.headers`, `gsc-performance.txt`, `gsc-performance.png`. Les captures `after-faq-desktop/ipad` prises trop tôt montrent le haut de page et ne constituent pas une preuve de FAQ ouverte. Build/logs temporaires : `/tmp/sokar-home-seo-build.log`, `/tmp/sokar-home-seo-start.log`. Répertoires de build et adaptations automatiques TypeScript retirés après recette, serveur initial préservé.

### 10.27 — Production locale et performances accueil qualifiées (15 octobre 2026)

**Préparé et vérifié localement, non commité, non déployé.** Cette section lève la limite de build/serveur/mesure locale du §10.26 ; ses autres limites (routage distant, indexation, destinations légales) restent applicables. Aucun changement applicatif supplémentaire.

**Configuration existante, sans secret distant.** Vérification sans affichage des valeurs : aucune clé Clerk dans les fichiers dashboard/root ; une paire de test déjà présente dans `apps/api/.env`. Seules `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` et `CLERK_SECRET_KEY` sont transmises en mémoire aux processus temporaires, sans copie vers un fichier d’environnement ni lecture de production. Build final dashboard réussi avec `.next-seo-perf`, typage inclus, puis Next en mode production sur `:4310`. Un premier lancement lié uniquement à IPv4 échouait sur la réécriture Clerk vers localhost ; lancement standard double pile : HTTP 200, sans changement de middleware ni contournement CI/demo. Le serveur de développement `:3100` est préservé.

**Contrôles sur le build final.** Accueil 200, hero/FAQ corrigée/lien `/privacy` dans le HTML initial, un H1, canonical racine production, `index, follow`. Ancienne route : 308 vers `/`. Preuve `performance/production-http.json`. Pas de nouveau changement visuel : recette responsive du §10.26 réutilisée, sans prétendre la réexécuter. Sources/API hors lot non éditées ; comparaison des 1 423 fichiers API présents au départ : seuls trois logs ont varié, tous les autres fichiers comparés inchangés. Adaptations automatiques TypeScript restaurées depuis la sauvegarde initiale ; build temporaire et profil navigateur retirés après mesure.

**Laboratoire : Lighthouse 13.5.0 via Brave headless, URL localhost, build optimisé.** Exécution des mesures en série, aucune télémétrie Lighthouse activée, aucune action métier. Mobile : réseau simulé RTT 150 ms, débit 1 638,4 kbit/s et ralentissement CPU ×4 ; desktop : preset Lighthouse desktop. Résultats ponctuels sur ce Mac, pas des données terrain, pas une garantie de production.

| Scénario                                               | Performance | FCP       | LCP   | TBT   | CLS |
| ------------------------------------------------------ | ----------- | --------- | ----- | ----- | --- |
| Mobile première visite, stockage réinitialisé          | 79/100      | 2,3 s     | 5,0 s | 60 ms | 0   |
| Desktop première visite, stockage réinitialisé         | 97/100      | 0,8 s     | 1,2 s | 0 ms  | 0   |
| Mobile nouveau profil conservé, passage initial        | 78/100      | voir JSON | 5,0 s | 80 ms | 0   |
| Mobile passage suivant, même profil/stockage conservés | 100/100     | 0,8 s     | 0,8 s | 10 ms | 0   |

Aucune erreur de collecte ni avertissement Lighthouse. Les trois premières mesures comportent la négociation/redirection vers Clerk **de test**, avec quatre entrées dans l’audit redirects ; le dernier passage n’a aucune redirection. Celui-ci conserve aussi le cache : **il ne mesure pas un chargement à froid sans Clerk et n’isole pas causalement le coût Clerk du cache**. Ce n’est pas un avant/après correctif, aucun gain applicatif revendiqué. L’élément LCP est le H1 déjà rendu serveur. Les scores à froid incluent un service extérieur de développement : ils ne doivent pas être transposés à l’authentification de production.

**Décision : code conservé.** CLS nul sur tous les relevés et TBT de 0 à 80 ms ; aucune image lourde bloquante identifiée. Lighthouse suggère environ 4 Kio sur le logo (fichier entier 4,4 Kio), 20 Kio de CSS et 242 Kio de JS inutilisés dans le premier viewport. Ces estimations ne justifient ni migration du rendu, ni refonte CSS/i18n, ni retrait des animations ; les parties non utilisées à l’ouverture servent aussi les sections suivantes. Aucun correctif limité avec bénéfice établi dans les contraintes de ce lot n’est démontré. Le LCP mobile initial de 5 s reste signalé, sans maquillage du score ni désactivation de protection. L’impact réel des redirections sur l’instance de production et les Core Web Vitals terrain restent inconnus.

**Preuves persistées hors Git.** Dossier `/Users/hamza/.codex/visualizations/2026/10/15/sokar-home-seo/performance/` : `summary.json`, `production-http.json`, rapports HTML/JSON `mobile`, `desktop`, `mobile-profile-repeat`, JSON `mobile-profile-initial.json`. Paramètres, conditions et métriques exactes dans les JSON ; paramètres temporaires de handshake expurgés des rapports. Logs build/serveur dans `/tmp/sokar-seo-perf-{build,server}.log`, non livrables. Aucun secret dans les documents de ce lot.

**Suite inchangée.** Destinations légales/réseaux à fournir réellement. Après livraison autorisée seulement : routage public, inspection/indexation Google et mesure froide avec configuration de production déjà déployée, puis suivi pertinent hors marque et origine des demandes réellement prouvée. Aucun commit, push, PR, déploiement, soumission Google ou modification distante.

### 10.28 — Préparation de livraison groupée, sans publication (15 octobre 2026)

**Verdict : prêt à livrer techniquement après nouvelle autorisation ; aucune publication exécutée.**
[Manifeste et procédure actuels](2026-10-15-growth-final-review.md) remplacent les anciennes listes.
14 chemins vérifiés à partir du delta réel : 6 sources/tests, 8 documents dont 2 nouveaux ; Context
et Journal exigent une sélection par sections. Ce n’est pas une autorisation de livrer le checkout.

**Risque d’intégration identifié et borné.** HEAD `d62f7d65` sur
`feat/onboarding-v2-equipe-roles` contient cinq commits absents de main, dont deux merges, avec
72 chemins onboarding/voix. `origin/main=54d18e0b` concorde avec la tête distante lue sans fetch.
Les six sources/tests SEO ont la même base dans HEAD et main ; les documents suivis aussi, sauf
Context/Journal. `environment.md` est hors lot. Ne pas soumettre la branche actuelle : branche
future propre `codex/seo-accueil` depuis main, transférer seulement le delta préparé, conserver
l’original. Les deux entrées locales ElevenLabs et les entrées onboarding/voix uniquement dans
HEAD restent dans l’original et hors sélection SEO. #439 déjà dans main : ne pas rejouer sa roadmap.
Les deux nouveaux documents relus sont le manifeste et `commercial-follow-up.md` ; aucune nouvelle
source applicative. Les quatre liens restants `#` sont listés avec leur rôle dans le manifeste :
Mentions Légales = réserve d’information/conformité à qualifier, réseaux sociaux = liens facultatifs ;
aucune URL inventée ni blocage technique SEO inféré automatiquement. Aucun avis juridique de
conformité publique donné.

**Diagnostic complémentaire réutilisant les rapports, sans nouvelle mesure.** Les fichiers conservés
sont des rapports Lighthouse et audits dérivés ; pas de trace Chrome brute/devtools log séparé.
Sur mobile première visite : audit redirects, quatre entrées dont la destination finale à zéro
(trois redirections, pas quatre sauts), estimations 602,8 + 954,9 + 302,8 ms ≈ 1 860,5 ms ; service
Clerk Development dans la chaîne. L’insight document mesure **353 ms de redirections observées** et
29 ms de réponse serveur, sur une autre base que les estimations simulées. La ressource Document
est observée de 353,7 à 389,4 ms. Insight LCP observé : TTFB 383,3 ms et délai de rendu 709,2 ms,
soit environ 1,09 s ; métrique LCP **simulée** 5,0 s. Ces valeurs ne s’additionnent ni ne se
soustraient pour expliquer causalement les 5 s.

Élément LCP : H1 « Un assistant téléphonique pour vos réservations », pas une image. Polices locales
WOFF2 (transferts ~27,6 et 32,6 Ko) et deux CSS (~26,2 et 1,1 Ko) terminent vers 410–414 ms observées.
Le logo de 4,4 Kio n’est pas l’image LCP. Desktop : TTFB/délai de rendu observés 255,6/169,7 ms,
LCP simulé 1,2 s. Profil mobile conservé : aucune redirection, document 0,5–17,3 ms, polices/CSS
vers 25 ms et zéro octet transféré (cache), TTFB/délai LCP 12,8/44,6 ms observés, LCP simulé 0,8 s.
Confirmation du double changement auth/cache, **aucune isolation causale ni gain applicatif**.
Extraction sans paramètres de handshake : `performance/delivery-diagnostic.json`. Mesures acquises
97/79/100, CLS nul, conservées ; aucun correctif de design/authentification ni nouveau Lighthouse.

**Préparation concrète.** Snapshot du delta retenu hors Git dans `sokar-home-seo/delivery/`, base
et empreintes avec patch applicable aux seuls chemins retenus ; aucune sélection dans l’index du
checkout. Procédure future documentée : sélection → commit sur branche propre → `pnpm pr:submit`
(qui pousse/crée PR/active auto-merge) → CI → staging et smoke → production selon autorisations.
La chaîne de workflows peut promouvoir automatiquement ; une autorisation limitée à préparer une
PR ne suffit pas pour appeler ce script. Build : Node >=20 <23, pnpm 10.33.3 du packageManager,
workspace/shared compilés, variables de chaque environnement avant build ; aucun secret recopié.
CI de la future branche isolée reste requise, build acquis réalisé sur le checkout actuel.
Snapshots serveur/META et choix de release saine à relever seulement lors de la livraison ;
rollback artefacts explicite, sans DB. Checklist staging/production, performances et GSC dans le
manifeste, **non exécutée sur des modifications non déployées**.

Contrôles propres à cette préparation : branche/base/delta, cohérence des fichiers et nouveaux
ajouts, patch en vérification d’application seulement, empreintes hors lot, liens et format/diff.
Tests acquis non répétés car aucune source modifiée. Aucun commit, push, PR, merge, déploiement,
mutation distante ni démarchage ; sources et travaux concurrents conservés.

**État final de la revue : dérive Git concurrente constatée.** Pendant les contrôles documentaires,
HEAD est passé de `d62f7d65` à `0f4151b1` : commit des seuls six fichiers applicatifs SEO, sans
variation de contenu (empreintes vérifiées). Aucun commit effectué par cette préparation. Main
distant reste `54d18e0b`. La branche mélangée compte désormais six commits/78 chemins contre main :
cinq commits hors lot et ce commit SEO. Le manifeste reste 14 chemins contre main, mais seuls les
documents demeurent non committés ; la sélection future part toujours de main propre, pas de HEAD.
Ne pas confondre disparition du diff applicatif contre HEAD et présence dans la branche cible.
Aucun reset ni soumission de cette branche. Paquet régénéré avec état final consigné.

### 10.29 — Livraison groupée autorisée, base actualisée (15 octobre 2026)

Hamza autorise la chaîne complète (« ok go ») après réserve Mentions légales explicitée. Main a avancé à a428b373 (#438) et inclut déjà les six sources SEO identiques : pas de réapplication ni de nouveau changement applicatif. Branche codex/seo-accueil isolée ; huit documents restants sélectionnés, Context/Journal par sections, checkout d’origine conservé. Les workflows/recettes et snapshots seront consignés après observation ; aucune réussite de déploiement encore revendiquée dans cette entrée.

### 10.30 Notifications de démo et abonnements : résultats vérifiés (13/10/2026)

**Notifications de démo.** `notifyDemoRequest` tente chaque destinataire, même après un échec, et ne retourne `true` que si chaque envoi a le résultat `success`. Un refus (liste de destinataires de test), un échec, un résultat inconnu ou une exception ne renseigne jamais `notifiedAt` : la demande reste enregistrée et visible comme non notifiée. Tests : quatre cas au niveau du service (accepté, bloqué sans appel à Resend, échec d'un destinataire parmi deux, exception sans interruption) et un cas au niveau de la route. Un test existant renvoyait un retour vide et attendait `notifiedAt` : il renvoie désormais un résultat `success` explicite.

**Abonnements.**

- Un catalogue unique (`apps/dashboard/src/app/pricing-catalog.ts`) : chaque fonctionnalité porte un statut, « disponible » ou « prévu », et la formule qui l'introduit. Les cartes et le tableau comparatif en dérivent.
- Prix annuels exacts, sans arrondi : Essential 159,20 € HT par mois (1 910,40 € HT par an), Pro 239,20 € (2 870,40 €), Multi-site 199,20 € (2 390,40 €), site supplémentaire 79,20 € (950,40 €). Les anciens tests figeaient l'arrondi (159, 239, 199 et +79) : ils sont mis à jour pour les montants exacts.
- Tableau comparatif sur `/pricing` : 12 fonctionnalités, 3 formules. Vérifié dans le navigateur : 20 cellules « Disponible », 7 « Prévu », 9 « Non inclus ».
- Contrôle préalable du catalogue Stripe de staging, en lecture seule avec une clé de test : 8 lignes sur 8 conformes. Ce contrôle n'est pas le livrable du chantier.

**Vérifié dans le navigateur** (worktree, port 3107) : `/pricing` sans erreur de console. À 375 px, la page ne déborde pas ; le tableau défile dans son conteneur.

**Statuts décidés le 15/10/2026.** Google Agenda, facturation groupée Multi-site et suivi des absences (statut `NO_SHOW` des réservations) restent « disponibles » : le code les expose (client Google Agenda, total de groupe calculé par l'API, statut `NO_SHOW`), sans contrôle par formule. Restent « prévus » et affichés comme tels sur `/pricing` : le ton adapté, la réservation depuis ChatGPT et Claude, la synchronisation ZenChef, TheFork et Lightspeed.

### 10.31 Fusion avec le copilote de service de #428 (14/10/2026)

Le décompte de la section 10.30 concerne le catalogue d'avant cette fusion. Le catalogue fusionné compte 21 fonctionnalités ; le tableau comparatif affiche 39 cellules « Disponible », 7 « Prévu » et 17 « Non inclus » (décompte calculé depuis `pricing-catalog.ts`).

**Ce que la page affiche.** Pro vend le copilote de service : suggestions pour les retards, estimation des tables bientôt disponibles avec indication de fiabilité, rapprochements avec les clients en attente, analyse d'une réorganisation et plan validé par l'équipe, historique des plans et retour arrière sous conditions. Essential garde planning, placement manuel, disponibilités, liste d'attente et pouls ; il n'inclut aucune fonction avancée du copilote, ce que teste un garde-fou. Pro et Multi-site proposent « Découvrir » (démonstration) avant l'inscription. Les textes publics sont ceux de `main` ; le catalogue fournit les statuts et le tableau.

**Statuts décidés le 15/10/2026.**

- Copilote « disponible » en Pro et Multi-site : décision du produit. L'accès est porté par la capacité de formule ; #428 présente ces fonctions comme incluses. Le pilote terrain reste ouvert, et aucun résultat en conditions de service n'est annoncé.
- Rapport quotidien de vos appels « disponible » en Essential : le module de résumé quotidien existe et n'est soumis à aucun contrôle par formule.
- Les autres statuts « disponible » (Google Agenda, facturation groupée Multi-site, suivi des absences en Essential) sont confirmés, voir la section 10.30.

**Vérifié avant publication.** Typage et Prettier OK ; 620 tests du dashboard verts ; captures `/pricing` régénérées, 3/3 verts après régénération. Dans le navigateur (port 3107) : « Découvrir Pro » pointe vers `/demo?plan=pro&billing=annual`, aucun « Choisir Pro » n'apparaît, le copilote figure dans la carte Pro, console sans erreur.

### 10.32 Fusion avec la tarification de #429 (14/10/2026)

La décision de `main` remplace les montants de la section 10.30 : remise annuelle de 10 % (et non 20 %), base Multi-site de 299 € HT/mois, établissement supplémentaire inchangé à 99 € HT/mois. Les montants de la section 10.30 (20 %, 249 €, centimes sur les mensualités) ne sont plus valables.

- Source unique : le calcul local de la branche est retiré. `@suppernote/shared` fournit le catalogue, les montants exacts et l'arrondi d'affichage.
- Affichage public : mensualités arrondies à l'euro (annuel : 179 € Essential, 269 € Pro et Multi-site de base, 89 € par établissement supplémentaire). La carte n'affiche plus de total annuel : « Facturé annuellement ». Le montant exact est indiqué avant paiement.
- Montants exacts (inscription et Stripe) : 2 149,20 € HT par an pour Essential ; 3 229,20 € pour Pro et Multi-site de base ; Multi-site à 2 établissements 4 298,40 € HT par an, à 3 établissements 5 367,60 € HT par an.
- Statuts et tableau comparatif : inchangés.

**Vérifié.** Typage du dashboard et de l'API (après reconstruction de `@suppernote/shared`), Prettier ; dashboard 83 fichiers et 621 tests verts ; paquet partagé 71 tests verts ; captures `/pricing` régénérées, 3/3 verts. Dans le navigateur (port 3107) : 179, 269 et 358 € s'affichent, « Découvrir Pro » et « Découvrir Multi-site » sont présents, console sans erreur.

### 10.33 Réserves après livraison SEO : staging et confidentialité (15/10/2026)

Le lot accueil a été livré via #438/#440 ; production source `629f857d`, release
`20261014T235908Z`, après CI et staging verts. Laboratoire public Lighthouse 13.5.0 :
desktop première visite 100/LCP 0,6 s ; mobile première visite 92/LCP 3,3 s ; mobile
profil conservé 100/LCP 1,0 s ; CLS nul. Ces mesures ne sont pas des données terrain
et ne démontrent pas un gain causal. Le test Google en direct autorise exploration et
indexation ; l’indexation de cette version et le canonical retenu restent à observer.

**Réserve légale ouverte.** L’utilisateur refuse la publication de son identité légale.
Aucune page limitée au nom commercial Suppernote n’est présentée comme conforme ; aucun
nom, adresse, document source ni coordonnées personnelles ajoutés au dépôt. OVHcloud
est confirmé par l’utilisateur comme hébergeur. Le lien Mentions légales reste à résoudre,
les liens sociaux restent facultatifs. Référence :
[Service Public — mentions obligatoires](https://entreprendre.service-public.gouv.fr/vosdroits/F31228).

**Corrections indépendantes, branche `codex/seo-reserves`, base `75f447e0`.**

- Démo : navigation documentaire native vers `/privacy`, même libellé et classes ;
  évite le préchargement RSC du dashboard vers une page servie par Connect.
- Staging : `X-Robots-Tag: noindex, nofollow` avec `always` répété dans les sept
  locations redéfinissant des en-têtes ; les autres héritent du serveur. Route exacte
  `/privacy` vers Connect alignée sur production. Configuration production inchangée.
  Staging reste publiquement accessible : cette exclusion d’indexation n’est pas un
  contrôle d’accès. Ne pas bloquer l’exploration empêchant Google de lire `noindex`.
  Sources : [Nginx](https://nginx.org/en/docs/http/ngx_http_headers_module.html),
  [Google](https://developers.google.com/search/docs/crawling-indexing/block-indexing).

Manifeste exact de ce correctif :

1. `apps/dashboard/src/app/demo/DemoRequestForm.tsx`
2. `apps/dashboard/src/app/demo/DemoRequestForm.test.tsx`
3. `apps/dashboard/src/__tests__/staging-noindex.test.ts`
4. `infra/nginx/sokar-staging.conf`
5. `docs/audits/2026-10-13-growth-execution.md`
6. `docs/obsidian/Context.md`
7. `docs/obsidian/Journal.md`

Contrôles : 11 tests Vitest ciblés réussis, ESLint ciblé et Prettier réussis.
Typecheck dashboard après compilation du package partagé ; aucun secret de production
nécessaire au diagnostic. Dépendances de build : pnpm/Node du dépôt, workspace partagé
compilé et variables applicatives habituelles fournies par la chaîne de livraison.
Test isolé sur Nginx 1.24.0 réel du VPS, serveur temporaire en boucle locale, réponses
amont simulées 200/308/503 : baseline 30 échecs/39, candidat 0/39. Aucun vhost actif
modifié par ce test. Preuves locales `~/.codex/visualizations/2026/10/15/sokar-seo-reserves/`.
Le test isolé ne remplace pas la recette après déploiement.

Livraison : sélection des sept chemins → commit de branche → `pnpm pr:submit` → CI →
staging et smoke → production selon AGENTS.md. Conserver les releases/META et leur
prédécesseur. Retour applicatif : `scripts/deploy.sh --env prod|staging rollback`, sans
restauration DB ; pour Nginx staging, restaurer la version précédente via le wrapper
privilégié et vérifier `nginx -t` avant rechargement (le rollback applicatif seul ne
constitue pas une preuve de restauration du vhost). Aucun changement DB/auth/voix/paiement.

Recette restante : vérifier les en-têtes sur accueil/démo/privacy/assets/widget/erreurs
staging, absence de noindex ajoutée sur l’accueil production, `/privacy` servi par Connect,
navigation depuis la démo sans requête RSC vers cette page ; conserver UI et navigation
sans soumettre de formulaire. Puis lire Search Console séparément : indexabilité,
indexation, canonical retenu, requêtes et clics hors marque, sans délai garanti.

### 10.34 Confidentialité : rendu navigateur et nonce CSP (15/10/2026)

#441 fusionnée (`22fb08b3`), CI main `38729949554` et staging `38730708031` verts.
Staging release `20261015T115647Z` (snapshot `22b99f76`, source #441) : en-tête
noindex présent sur accueil, démo, privacy, embed, assets, widget, book, erreurs 404
et santé API. La production reste indexable. Le test HTTP ne suffit pas : une
page privacy HTTP 200 devient blanche après hydratation sur les deux environnements.
Les scripts inline du HTML statique ne portent pas le nonce de la CSP courante ;
le navigateur rapporte « Connection closed ». Le correctif du préchargement #441
reste utile mais ne suffit donc pas à clore la recette privacy.

Correctif séparé `codex/privacy-csp`, base `22fb08b3` : seul `/privacy` passe en
rendu par requête, et reçoit le nonce via la CSP de requête analysée par Next.js.
La CSP de réponse et ses restrictions restent identiques ; aucun `unsafe-inline`
ajouté pour les scripts. Aucune généralisation du rendu dynamique aux autres pages,
aucune modification auth, design, contenu légal, DB ou voix. Exception au rendu
statique justifiée par le nonce par requête :
[documentation Next.js](https://nextjs.org/docs/app/guides/content-security-policy).

Manifeste exact : `apps/connect/src/app/privacy/page.tsx`,
`apps/connect/src/middleware.ts`, `apps/connect/src/middleware.test.ts`,
`apps/connect/e2e/privacy.spec.ts`, ce rapport, `docs/obsidian/Context.md`,
`docs/obsidian/Journal.md`. Génération Next temporaire hors sélection ; aucun
fichier de configuration TypeScript généré conservé dans le patch.

Validation : Vitest 4.1.5, 16 tests middleware ; typage et ESLint Connect verts.
Build Next 15.5.21 local de production réussi, `/privacy` dynamique attendu.
Test Playwright ciblé sur le serveur de production local : scripts inline tous
porteurs du nonce de réponse, contenu visible après hydratation, aucune pageerror.
Aucune clé Clerk requise pour Connect. Recette publique à refaire après livraison.

Livraison selon AGENTS : commit de branche → `pnpm pr:submit` → CI → staging/smoke
→ production. Changement sécurité signalé : transmission du nonce, sans élargir les
sources CSP. Snapshots applicatifs et META conservés par la chaîne ; retour arrière
applicatif vers la release précédente, sans restauration DB. Pas de changement Nginx
supplémentaire. Mentions légales toujours ouvertes, aucune identité personnelle publiée.

Point de départ GSC lu le 15/10 : période 13/07–12/10, 15 clics, 671 impressions,
CTR 2,2 %, position moyenne 16,3 ; les 19 requêtes détaillées n’indiquent aucun clic
hors marque pertinent. Les totaux incluent des clics non détaillés : ne pas affirmer
un total hors marque nul. Données antérieures à la livraison, aucune attribution de gain.
Sitemap lu le 14/10, succès, quatre URLs : aucune nouvelle soumission nécessaire.

### 10.35 Recette finale des réserves techniques — livrée le 15/10/2026

**État final local après déploiement**, complément de preuve non encore commité.
#441 et #442 fusionnées ; source production `3699e6da`. CI main `38733835822`,
staging `38734664480` et production `38735057706` : succès. Le nouveau test de
rendu privacy est vert en CI, ainsi que CodeQL après passage à un parseur DOM.

Release production `20261015T123042Z`, prédécesseur `20261015T120048Z` ; staging
`20261015T122746Z` (snapshot `0ae798d6`, source #442), prédécesseur `20261015T115647Z`.
META et empreintes enregistrées dans `sokar-seo-reserves/releases-final.txt`.
Retour applicatif explicite production depuis `/opt/sokar` :
`bash scripts/deploy.sh --env prod --confirm-production rollback 20261015T120048Z`.
Staging depuis `/opt/sokar-staging` :
`bash scripts/deploy.sh --env staging rollback 20261015T115647Z`.
Sans restauration DB. Ces commandes ne restaurent pas automatiquement un vhost Nginx.
Le vhost antérieur à #441 est conservé dans `staging-vhost-before.conf` si nécessaire.

Recette publique réalisée :

- Staging : HTTP 200 accueil/démo/privacy ; `noindex, nofollow` sur les 12 réponses
  représentatives (dont santé API, assets et erreurs 404). Exposition publique conservée.
- Production : accueil HTTP 200, aucun `X-Robots-Tag` noindex ajouté ; privacy HTTP 200.
- Deux environnements : 14 scripts inline du document privacy portent le nonce de la
  CSP de réponse ; cache privé/no-store. Aucun élargissement de la politique CSP.
- Dans Brave, sessions neuves démo → lien confidentialité : page visible et stable,
  aucune erreur console observée, aucun formulaire envoyé. Captures et arbres AX conservés.
- Aucune retouche hero/styles/animations/tarifs, aucune nouvelle landing. Contrôles
  Lighthouse antérieurs conservés, non réexécutés pour ce correctif.

Preuves locales : `/Users/hamza/.codex/visualizations/2026/10/15/sokar-seo-reserves/`
(`public-after.json`, `privacy-nonces-after.json`, `production-privacy-final.png`,
`staging-privacy-final.png`, JSON des workflows et META). Les fixtures Nginx isolées
avec réponses 308/503 restent distinguées des réponses réelles observées.

**Restes :** mentions légales non finalisées, identité légale non autorisée à publier ;
aucune donnée personnelle du PDF publiée. Liens sociaux facultatifs. GSC : référence
historique décrite en §10.34 ; indexation de la nouvelle version, canonical retenu et
clics hors marque à observer ultérieurement, sans résultat ni délai garanti.
Checkout original et travaux voix/onboarding conservés. Pas de changement de leurs sources.
