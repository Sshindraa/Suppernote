# Runbook — Testing

> **Statut : ACTIF — réconcilié le 15 septembre 2026.** La matrice locale/CI/staging correspond au
> dépôt. Les validations qui contactent un fournisseur ou modifient une donnée métier doivent
> conserver une preuve datée. Voir [`../DOCUMENTATION_STATUS.md`](../DOCUMENTATION_STATUS.md) et la
> [réconciliation des audits](../audits/2026-09-15-current-state.md).

## Unit / integration

```zsh
pnpm test       # Vitest
pnpm lint       # turbo lint + stylelint
pnpm typecheck  # per-app tsc --noEmit
```

## Catalogue prix et usage — contrôles locaux

Ces suites vérifient que la grille Essential 199 € / Pro 299 € reste cohérente entre la
configuration, le calcul de marge et les surfaces publiques. Elles ne créent ni prix Stripe ni
abonnement. Le test ROI charge le `dist` de `@suppernote/config` dans le workspace actuel ; reconstruire
ce package avant la suite si le dossier a été nettoyé.

```zsh
pnpm --filter @suppernote/config run build
pnpm --filter @suppernote/shared exec vitest run src/__tests__/plan.test.ts
pnpm --filter @suppernote/api exec vitest run \
  src/modules/analytics/__tests__/roi.service.test.ts \
  src/modules/billing/__tests__/billing.routes.test.ts \
  src/modules/billing/__tests__/billing.service.test.ts
pnpm --filter @suppernote/dashboard exec vitest run src/app/PricingSection.test.tsx
```

La promesse client Essential/Pro est sans quota. `/usage/current` affiche donc uniquement la
quantité observée et annonce `customerUsagePolicy=UNLIMITED`, sans coût ni marge. Le feed de coût et
de marge reste réservé aux opérations via `SOKAR_INTERNAL_USAGE_TOKEN`.

L'import du catalogue fournisseur est vérifiable sans provider ni écriture en base en exécutant la
suite dédiée :

```zsh
pnpm --filter @suppernote/api exec vitest run \
  src/modules/usage/__tests__/usage-tariff-import.service.test.ts
```

Le script `apps/api/scripts/import-usage-tariffs.ts` reste en dry-run par défaut. Il refuse les
devises autres qu'EUR, les prix au-delà de `DECIMAL(18,9)`, les fenêtres invalides, les conflits de
version et les chevauchements. Pour appliquer un fichier fourni par les opérations, lancer d'abord
le dry-run et conserver sa sortie avec la facture, puis ajouter `--apply` dans une base locale ou
un environnement contrôlé. Aucun fichier de facture ou taux réel ne doit être ajouté au dépôt.

Le rapprochement d'un export de facture avec le ledger est également local et en lecture seule :

```zsh
pnpm --filter @suppernote/api exec vitest run \
  src/modules/usage/__tests__/usage-reconciliation.service.test.ts
pnpm --filter @suppernote/api exec tsx apps/api/scripts/reconcile-usage-invoice.ts \
  --file ./private/provider-invoice-2026-09.csv \
  --cost-tolerance 0.01 \
  --output ./private/reports/provider-invoice-2026-09.json
```

Les périodes de facture sont en UTC avec une borne de fin exclusive. La commande retourne un statut
par dimension et échoue si une ligne est `MISMATCH`, `INVOICE_ONLY`, `USAGE_ONLY` ou
`UNPRICED_USAGE`. Les tolérances ne sont jamais implicites ; leur justification doit rester avec la
facture. Avec `--output`, le rapport JSON est écrit avant le code de sortie, y compris lorsque la
commande échoue sur un écart. Le script ne réécrit pas les événements ni les rollups. Le fichier de
sortie contient `reportHash`, un SHA-256 des bornes, tolérances, compteurs et lignes ; il peut être
repris comme référence immuable lors de la création d'un ajustement.

### Lecture Telnyx — export d'une facture sans accès à la base fournisseur

Le connecteur `scripts/fetch-telnyx-usage-invoice.ts` utilise uniquement des requêtes `GET` vers
Telnyx ([Usage Reports API](https://developers.telnyx.com/docs/reporting/usage-reports),
[List invoices](https://developers.telnyx.com/api-reference/list-invoices) et
[Get invoice by ID](https://developers.telnyx.com/api-reference/get-invoice-by-id)). Il suit la pagination de
`/v2/usage_reports`, demande la dimension `currency` par défaut,
agrège les métriques `cost` et `parts` pour la messagerie (ou `cost` et `billed_sec` pour la voix),
puis écrit exactement le format attendu par `reconcile-usage-invoice.ts`. Il ne crée ni prix, ni
événement, ni abonnement et ne persiste jamais le `download_url` signé de la facture. Avec
`--invoice-file`, il peut toutefois télécharger une fois le fichier depuis l'hôte HTTPS Telnyx
autorisé, le borner à 50 MiB et conserver uniquement le fichier local et son SHA-256 dans le
manifeste. L'action `action=link` est utilisée pour obtenir ce lien éphémère ; selon le compte,
Telnyx peut retourner un hôte `*.telnyxstorage.com` ou un hôte S3 régional
`s3.us-east-<n>.amazonaws.com`.

La clé est injectée par le gestionnaire de secrets au moment de l'exécution ; elle ne doit pas être
passée en argument de ligne de commande ni écrite dans un fichier de preuve.

```zsh
# Le mode liste ne récupère que les métadonnées non signées des factures du mois.
TELNYX_API_KEY="<key>" pnpm --filter @suppernote/api usage:telnyx:fetch \
  --month 2026-09 \
  --list-invoices \
  --output ./private/telnyx-invoices-2026-09.json

# Après avoir choisi l'invoice_id dans cette liste, récupérer l'usage et les métadonnées.
TELNYX_API_KEY="<key>" pnpm --filter @suppernote/api usage:telnyx:fetch \
  --month 2026-09 \
  --product messaging \
  --product sip-trunking \
  --invoice-id <invoice-uuid> \
  --invoice-file ./private/telnyx-invoice-2026-09.pdf \
  --output ./private/telnyx-usage-2026-09.json

# Si Telnyx retourne zéro ligne pour un produit, l'opt-in explicite conserve
# une ligne quantité/coût à zéro afin de pouvoir rapprocher cette absence.
TELNYX_API_KEY="<key>" pnpm --filter @suppernote/api usage:telnyx:fetch \
  --month 2026-09 \
  --product messaging \
  --allow-empty \
  --output ./private/telnyx-usage-2026-09.json

# Rapprocher ensuite l'export avec le ledger local.
pnpm --filter @suppernote/api exec node --import tsx scripts/reconcile-usage-invoice.ts \
  --file ./private/telnyx-usage-2026-09.json \
  --cost-tolerance 0.01 \
  --output ./private/reports/telnyx-usage-2026-09.json
```

Le fichier `<export>.manifest.json` est généré automatiquement. Il contient le hash du snapshot,
la période, la métrique, la devise et les métadonnées de facture ; le lien signé de téléchargement
est explicitement marqué comme non stocké. Si `--invoice-file` est utilisé, le manifeste ajoute le
chemin local, la taille, le type MIME et le SHA-256 du fichier, jamais son URL signée. La commande
exige EUR, car le ledger Sokar refuse les
montants non convertis. Si Telnyx renvoie USD ou plusieurs devises, l'export échoue et aucune ligne
ne doit être rapprochée sans une conversion documentée par la comptabilité. Pour couvrir une facture
qui contient à la fois messagerie et voix, répéter `--product` (chaque produit est appelé séparément
car l'API Telnyx ne permet pas une requête multi-produit) ; utiliser `--product sip-trunking` ou
`--product call-control` pour la voix. Le champ `billed_sec` doit alors être comparé aux secondes
enregistrées par le ledger, avec une tolérance justifiée si Telnyx arrondit. `--quantity-field` est
volontairement réservé à une commande mono-produit afin d'éviter d'appliquer `parts` à la voix ou
`billed_sec` aux SMS.

Les tests du connecteur utilisent des réponses simulées et ne contactent aucun fournisseur :

```zsh
pnpm --filter @suppernote/api exec vitest run \
  src/modules/usage/__tests__/telnyx-billing.service.test.ts
```

Un export de zéro usage est valide uniquement avec `--allow-empty`, et le rapprochement classe alors
la ligne `MATCH` seulement si la quantité et le coût sont tous les deux nuls. Cette étape externe
ne rend aucune information de coût visible dans le dashboard restaurateur. Pour préparer l'import
aval, le constructeur de paquet conserve séparément l'usage EUR et les lignes de facture fournisseur
dans leur devise d'origine (MRC Telnyx en USD) :

```zsh
pnpm --filter @suppernote/api usage:accounting:package -- \
  --month 2026-08 \
  --usage-csv ./private/sokar-usage-accounting-2026-08.csv \
  --invoice ./private/telnyx-invoice-2026-08.json \
  --invoice-pdf ./private/telnyx-invoice-2026-08.pdf \
  --reconciliation ./private/telnyx-reconciliation-2026-08.json \
  --mrc-amount 1.00 --mrc-currency USD \
  --output-dir ./private/accounting/2026-08
```

Le paquet est une destination fichier contrôlée et porte `READY_FOR_IMPORT` tant qu'aucun outil
comptable n'est choisi. Il reste conservé comme artefact interne : son import est différé et ne
bloque pas le cockpit admin. La preuve réelle Telnyx d'août, le paquet et le contrôle non nul de mai
sont consignés dans `docs/release/evidence/p0-usage-production-2026-09-14.md`,
`docs/release/evidence/p0-usage-accounting-package-2026-08.md` et
`docs/release/evidence/p0-usage-nonzero-2026-05.md`.

Après revue, un opérateur peut conserver un delta dans `UsageReconciliationAdjustment` via
`POST /admin/usage/reconciliation-adjustments`, puis le valider ou le refuser via
`POST /admin/usage/reconciliation-adjustments/:id/decision`. La création est idempotente par hash
du rapport, portée, dimension et période ; la décision utilise la condition `status = OPEN` et ne
réécrit jamais le ledger. La file se consulte avec `GET /admin/usage/reconciliation-adjustments`.

La concurrence réelle se vérifie dans une base PostgreSQL jetable après application des migrations :

```zsh
AGENTIC_INT_TESTS=1 pnpm --filter @suppernote/api exec vitest run \
  src/modules/usage/__tests__/usage-adjustment.concurrency.integration.test.ts
```

Le test crée une fixture isolée, vérifie l'unicité d'insertion et la décision atomique, puis la
supprime. Il reste ignoré dans la suite unitaire.

L'évaluateur local des seuils de suivi interne est vérifiable sans provider :

```zsh
pnpm --filter @suppernote/api exec vitest run \
  src/modules/usage/__tests__/usage-alerts.service.test.ts \
  src/modules/usage/__tests__/usage-alert-budget.service.test.ts \
  src/shared/queue/workers/__tests__/usage-alerts.worker.test.ts
```

Le worker ne contacte aucun canal tant que `USAGE_ALERTS_ENABLED=false` (valeur par défaut). Une
claim Redis `SET NX` est posée par mois, restaurant, métrique et seuil avant dispatch afin qu'un
rejeu horaire ou deux processus concurrents ne renvoient pas le même jalon. Ces seuils sont
strictement internes, facultatifs et sans effet sur le service du restaurant ; le suivi visuel de
référence est `/admin/margin` (l'ancienne URL `/dashboard/admin/margin` redirige). Pour un test contrôlé, définir en plus
`USAGE_ALERT_VOICE_BUDGET_MINUTES` et/ou `USAGE_ALERT_SMS_BUDGET_SEGMENTS` ; ces budgets ne sont
jamais lus comme un quota client.

## E2E

```zsh
pnpm test:e2e   # Playwright dashboard
```

### Connect E2E (API réelle, base seedée)

```zsh
pnpm --filter @suppernote/connect test:e2e   # Playwright Connect
```

Le job CI `connect-e2e` fournit Postgres 16 et Redis 7 éphémères, applique les migrations, seed le
restaurant de démo puis son plan de salle (`pnpm --filter @suppernote/database seed` puis
`seed:floor-plan`), démarre l'API sur `:4000` et lance les trois parcours publics (fiche restaurant,
widget de réservation, carte cadeau). `API_URL` est lu par le serveur Next de Connect pour ses
fetches SSR : sans cette variable, Connect appellerait `:3001`.

En local, sans API joignable, les specs se skippent : c'est le comportement voulu pour ne pas
bloquer un poste sans infra. En CI, `CI=true` rend l'API obligatoire — une API absente fait échouer
la suite, et une absence de créneaux (plan de salle incomplet) échoue au lieu de sauter le parcours
de réservation. Un skip silencieux en CI masquerait une régression de la surface commerciale.

Le groupe `Espace administration Sokar` de `apps/dashboard/e2e/dashboard.spec.ts` vérifie aussi
les trois formats (`iphone-14`, `ipad-mini`, `desktop-1440`) : ouverture de `/admin`, redirection
des anciennes URLs `/dashboard/admin/*` et renvoi d'un compte non opérateur vers `/dashboard`.

La CI exécute également le job `api-integration` sur Postgres 16 et Redis 7
éphémères. Il applique les migrations versionnées, active `AGENTIC_INT_TESTS=1`
et lance `pnpm --filter @suppernote/api test:int`. Ce job ne contacte aucun provider
réel ; son objectif est de rendre la preuve transactionnelle reproductible à
chaque livraison.

Après une livraison sur `main`, le workflow staging exécute en outre les smoke
tests Playwright contre les URLs publiques : le Dashboard vérifie
`/widget/chez-suppernote-demo` et ses disponibilités, et Connect vérifie
`/restaurant/chez-suppernote-demo`. Les smoke tests CI contrôlent aussi les deux
URLs historiques `chez-sokar-demo` pendant la migration. Tout échec bloque la conclusion
du workflow staging et donc la promotion production. La confirmation de
réservation et l'achat de carte cadeau restent des campagnes contrôlées, car
ils écrivent des données métier ou nécessitent l'activation commerciale du
restaurant de démo.

Le smoke du widget attend le DOM et les éléments métier plutôt que `networkidle` :
la page charge des images distantes qui peuvent rester en vol sur un runner CI.
Cette règle évite un faux timeout sans masquer une erreur de chargement, puisque
les données restaurant, l'état de disponibilité et le changement de date restent
assertés.

La porte de promotion peut être vérifiée sans modifier la production : lancer le
workflow `Deploy Staging` avec `force_smoke_failure=true`. Après les smoke tests,
le job échoue intentionnellement et le workflow `Deploy Production`, qui exige un
staging vert, doit rester absent.

## Visual regression

`pnpm test:visual` captures screenshots of 6 critical pages (`/dashboard`, `/dashboard/reservations`, `/dashboard/calls`, `/dashboard/gift-cards`, `/`, `/pricing`) on 3 viewports (iPhone 14, iPad Mini, desktop 1440px) and compares them to the baseline in `apps/dashboard/e2e/__snapshots__/`. Tolerance threshold: 0.2% pixel diff.

### Update baselines after intentional visual changes

```zsh
cd apps/dashboard
npx playwright test visual-regression --update-snapshots
git diff --stat apps/dashboard/e2e/__snapshots__/
git add apps/dashboard/e2e/__snapshots__/
git commit -m "feat(dashboard): update visual baselines for <description>"
```

### Screenshot stability

- Animations disabled (`animations: 'disabled'`).
- CSS transitions neutralized via `e2e/visual-stability.css` (also forces `-webkit-font-smoothing: antialiased`).
- Text caret hidden.
- For `/dashboard`, wait for `.recharts-surface` (async SVG charts) and use a `settleMs` of 3000 ms.
- Dashboard pages without Clerk display demo data or a skeleton — no random content.

### Cross-platform

Baselines are generated on macOS (suffix `-darwin`). In CI (Linux), a script copies `-darwin` baselines to `-linux` before running. The 0.2% threshold absorbs micro-differences (font anti-aliasing).

## Agentic Postgres integration (local-only)

Les tests de concurrence de réservation sont désactivés par défaut. Pour une
validation contrôlée, utiliser uniquement une base locale jetable avec un nom
dédié, appliquer les migrations déjà versionnées avec
`prisma migrate deploy`, puis vérifier la présence de
`reservation_audit_log_append_only` avant le test :

```zsh
DATABASE_URL='postgresql://<local-user>@127.0.0.1:5432/<dedicated-db>' \
  AGENTIC_INT_TESTS=1 \
  pnpm --filter @suppernote/api test:int
```

La base doit être isolée d'une base de développement/staging/production. Après
le test, contrôler l'absence de restaurant, hold, réservation et record
d'idempotence, puis supprimer explicitement la base dédiée. Ne jamais utiliser
les données staging existantes pour activer `AGENTIC_INT_TESTS`.

### Prérequis d'extension

La migration `20260621003000_agentic_p0_extensions` crée `pg_trgm`, `cube` et
`earthdistance`, ce qui exige un rôle superuser. Le rôle `sokar` ne l'est pas :
sur une base jetable, créer les extensions avant la première migration, sinon
`migrate deploy` échoue en `E42501` et laisse la migration marquée _failed_
(à reprendre par `prisma migrate resolve --rolled-back <migration>`).

```zsh
createdb -O sokar sokar_parity_test
psql -d sokar_parity_test -c \
  "CREATE EXTENSION IF NOT EXISTS pg_trgm; CREATE EXTENSION IF NOT EXISTS cube; \
   CREATE EXTENSION IF NOT EXISTS earthdistance; CREATE EXTENSION IF NOT EXISTS btree_gist;"
DATABASE_URL='postgresql://sokar:…@localhost:5432/sokar_parity_test' \
  pnpm --filter @suppernote/database migrate:deploy
```

### Parité des deux entrées de réservation (R1-4)

`src/modules/agentic-reservations/__tests__/concurrency.test.ts` contient un
bloc `contrat — parité des deux entrées d’écriture`. Il exécute le service
legacy et le service agentic contre la même base, puis compare leurs sorties
normalisées via le harness shadow
(`src/modules/reservations/contract-shadow-harness.ts`). Trois propriétés sont
verrouillées :

- les deux entrées écrivent une ligne qui respecte la projection canonique
  (`status` est exactement `creationProjection(state).status`) ;
- une validation manuelle porte `status = CONFIRMED` et `state = PENDING`, et le
  filtre du handler de réponse SMS (`status` **et** `state`) ne la retient pas ;
- les écarts entre les deux entrées sont exactement ceux documentés :
  `idempotency` (l'agentic est keyé, le legacy non) et `auditEvents` (l'agentic
  matérialise un `hold_consumed`, le legacy n'a pas cette notion).

Toute différence supplémentaire fait échouer le test : c'est le garde-fou contre
une dérive silencieuse entre les deux chemins. Le bloc est ignoré sans
`AGENTIC_INT_TESTS=1`, donc il ne tourne que dans le job CI `api-integration` et
en local sur base jetable.

Le même harnais contient aussi les tests de capacité : 17 cas sont exécutés
en mode intégration. Les six tests historiques de concurrence, idempotence et
append-only sont complétés par 11 cas sur les états actifs avec/sans
`tableId`, les holds actifs, `releaseTable` et le blocage global du chemin agentic. Les cinq
logs d'audit append-only résiduels de la fixture sont attendus avant la
suppression de la base ; ils ne doivent pas être supprimés par contournement du
trigger.

## Résultats inconnus des notifications — Phase 3D

Les tests des cinq workers protégés par claim utilisent exclusivement des
providers et un Redis fakes. Ils ne nécessitent ni Telnyx, ni WhatsApp, ni
Resend, ni une base staging/production :

```zsh
pnpm --filter @suppernote/api exec vitest run \
  src/shared/queue/__tests__/notification-idempotency.test.ts \
  src/shared/queue/workers/__tests__/outbound-confirm.worker.test.ts \
  src/shared/queue/workers/__tests__/confirmation-sms.worker.test.ts \
  src/shared/queue/workers/__tests__/call-recovery.worker.test.ts \
  src/shared/queue/workers/__tests__/reconciliation.worker.test.ts \
  src/modules/agentic-reservations/workers/__tests__/waiting-list-promote.worker.test.ts \
  src/modules/gift-cards/workers/__tests__/gift-card-reminder.worker.test.ts \
  src/shared/messaging/__tests__/sender.test.ts
```

Le contrat testé est :

- `success` conserve la claim et permet au worker de poser son marqueur/audit
  existant ;
- `failure_certain` libère la claim pour le retry déjà prévu ;
- `unknown` conserve la claim, interdit un nouvel appel provider immédiat et
  ajoute un `notification-status` à la queue `reconciliation` avec un job ID
  déterministe ;
- une consultation impossible ou sans identifiant provider reste `unknown` et
  rejoint `dead-letter` pour revue manuelle, sans nouvel envoi.

Les assertions de concurrence dédupliquent les jobs de réconciliation par leur
`jobId` stable. Elles ne promettent pas exactly-once chez le provider externe.
Un crash avant la transition locale du claim est traité conservativement comme
une tentative en cours ; il ne déclenche pas de renvoi aveugle. Les tests
vérifient également que le fallback WhatsApp→SMS n'a lieu qu'après un échec
certain, jamais après `unknown`.

## Clôture opérationnelle des notifications — Phase 3E

La campagne Phase 3E reste entièrement déterministe et sans appel externe :

```zsh
pnpm --filter @suppernote/api exec vitest run \
  src/shared/queue/__tests__/notification-idempotency.test.ts \
  src/shared/queue/__tests__/notification-repair.test.ts \
  src/shared/queue/__tests__/provider-adapters.contract.test.ts \
  src/shared/queue/workers/__tests__/reconciliation.worker.test.ts \
  src/shared/queue/workers/__tests__/outbound-confirm.worker.test.ts \
  src/shared/queue/workers/__tests__/confirmation-sms.worker.test.ts \
  src/shared/queue/workers/__tests__/call-recovery.worker.test.ts \
  src/shared/observability/__tests__/metrics.test.ts \
  src/shared/messaging/__tests__/sender.test.ts \
  src/modules/agentic-reservations/workers/__tests__/waiting-list-promote.worker.test.ts \
  src/modules/gift-cards/workers/__tests__/gift-card-reminder.worker.test.ts
```

Les fixtures Telnyx/Resend testent les normaliseurs d'adapter : identifiant
provider, acceptation, refus certain et résultat inconnu. Elles ne valident pas
les réponses d'un compte staging. `success` signifie acceptation de la requête,
pas livraison au destinataire.

Le contrôle marketing ajoute les suites ciblées suivantes :

```zsh
pnpm --filter @suppernote/api exec vitest run \
  src/modules/marketing/__tests__/marketing-provider.service.test.ts \
  src/modules/marketing/__tests__/marketing-provider.routes.test.ts \
  src/modules/marketing/__tests__/marketing-provider-reconciliation.worker.test.ts
```

Un callback signé dont l'identifiant n'est pas encore connu crée une ligne
`MarketingProviderReconciliation` idempotente. Le worker planifié
`marketing-provider-reconciliation/5min` la rattache dès que la
`CampaignMessage` existe ; le feed opérateur peut lister ou ignorer une ligne
avec `SOKAR_INTERNAL_MARKETING_TOKEN`. Aucun de ces contrôles n'envoie un
message et le flag `MARKETING_SENDS_ENABLED` n'est pas requis.

Les fondations POS, paiement de réservation et CRM groupe se vérifient de la même façon sans
contacter de fournisseur :

```zsh
pnpm --filter @suppernote/api exec vitest run \
  src/modules/pos/__tests__ \
  src/modules/reservation-payments/__tests__ \
  src/modules/customer-groups/__tests__
```

Ces suites vérifient notamment le dry-run et l'absence d'appel externe, l'idempotence des écritures,
les transitions et signatures, l'isolation compte/site, le consentement inter-sites et le masquage
des téléphones. Les flags `POS_CONNECTORS_ENABLED`, `RESERVATION_PAYMENTS_ENABLED` et
`CUSTOMER_GROUPS_ENABLED` restent `false` pendant les tests de promotion ; l'ouverture d'un pilote
nécessite ensuite une preuve sandbox séparée.

La fondation réputation se vérifie sans provider ni Redis réel :

```zsh
pnpm --filter @suppernote/api exec vitest run \
  src/modules/reputation/__tests__/reputation.service.test.ts \
  src/modules/reputation/__tests__/reputation.routes.test.ts \
  src/modules/reputation/__tests__/reputation-feedback-expiry.worker.test.ts
```

Ces tests couvrent l'exigence `HONORED`, le token haché et expirant, le rejeu public, la transaction
score faible → tâche de récupération, l'isolation tenant et les transitions de résolution. L’envoi privé par e-mail est réservé aux offres Pro/Multi-site ; aucun appel de plateforme d’avis n’est effectué.

La récupération quotidienne réutilise le job existant `reconciliation/sms` :
une claim `in_progress` âgée de 15 minutes devient `unknown` par CAS Redis et
est replanifiée avec un ID stable ; une claim legacy sans token va en revue
manuelle. Une panne Redis/queue conserve la protection et n'appelle pas le
provider. Le test de crash arrête volontairement le scénario entre l'appel
provider simulé et l'écriture Redis ; il ne remplace pas encore un test de
processus réellement tué en staging.

Après `failure_certain`, le worker relance le même job BullMQ déterministe,
avec les bornes existantes : 5 tentatives/backoff 5 s pour les queues fiables
principales, 3 tentatives/backoff 5 s pour waiting-list, et 3 tentatives/backoff
60 s pour gift-card. `unknown` n'est jamais relancé automatiquement vers le
provider. Après épuisement, le listener commun alimente la DLQ existante ; la
procédure de revue humaine et la validation staging restent à approuver. Si
une lecture de réconciliation transforme ensuite un `unknown` en
`failure_certain`, elle ne reconstitue pas le payload source absent de la
claim : le cas reste en revue manuelle jusqu'à décision sur une référence de
rejeu sûre.

## Jeu de test de comportements vocaux

Mesure si le tour structuré tient des comportements de conversation (attendre une correction annoncée, ne pas
rouvrir un accueil après l'au revoir, ne pas redemander à vide, récapitulatif court, extraction du brouillon…).
Chaque cas rejoue un moment réel d'appel (`apps/api/scripts/fixtures/voice-behavior/cases.json`) devant le modèle
de production, plusieurs tirages, et compare la part de réponses conformes à un seuil. Contrôles structurels ;
un motif dans la phrase ne sert qu'à interdire une dérive connue.

```bash
scripts/ops/voice-behavior-eval.sh        # compose ici, rejoue sur le VPS (la clé y reste), note ici
```

- À relancer après tout changement de `structured-turn/prompt.ts`, du schéma ou du modèle vocal.
- Un cas se tire d'un appel : ajouter l'historique, la phrase, l'état du brouillon et un ou deux contrôles.
- Consomme du quota Cerebras : une seule clé sert aux appels et aux rejeux, donc le crédit des appels réels. Plafond
  de 150 requêtes (`VBE_MAX_REQUESTS`) ; vérifier le solde avant de lancer.
- Hors CI (pas de clé) ; la logique de notation est testée (`behavior-eval.test.ts`).
- Juger un autre modèle (un secours) : `VBE_PROVIDER=openrouter VBE_MODEL=<modèle> VBE_BASE_URL=https://eu.openrouter.ai/api/v1`
  (+ `VBE_REASONING_OFF=1` pour un modèle à raisonnement optionnel comme DeepSeek ; les autres refusent ce paramètre).
  Crédit OpenRouter, pas Cerebras ; mêmes garde-fous (arrêt à 401/402/403) ; la sortie dit quel hébergeur a servi.

### Suite « dégradation » et découpage calibration / contrôle

La suite par défaut mesure des comportements connus. La suite `perturb` mesure autre chose : ce que fait le modèle
quand la transcription est abîmée, sans qu'on écrive de phrase. Les variantes sont **générées** à partir des cas
annotés (`valueSpans` : la sous-chaîne exacte de la phrase qui porte une heure, un nombre ou un nom, et la valeur
qu'elle porte ; `spanPool` : spans supplémentaires servant de donneurs) avec une graine fixe (`PERTURB_SEED`).

| Famille      | Altération                                       | Comportement attendu                                                              |
| ------------ | ------------------------------------------------ | --------------------------------------------------------------------------------- |
| ablation     | la sous-chaîne annotée est retirée               | brouillon inchangé sur ce champ, OU `interpretation=unclear`, OU `confidence=low` |
| substitution | remplacée par celle d'un autre appel, même champ | le brouillon porte la nouvelle valeur                                             |
| bruit        | un mot du corpus des cas est inséré à côté       | la valeur annotée reste extraite                                                  |

```bash
VBE_SUITE=perturb VBE_JSON_OUT=/chemin/absolu/hors/depot/perturb.json scripts/ops/voice-behavior-eval.sh
```

- `VBE_UNDERSTANDING=1` compose les requêtes avec la vérification de compréhension (active pour tous les
  restaurants en production depuis le 22/10/2026) ; sans, comportement historique. Pour juger ce drapeau : même suite
  sans puis avec, en rejeu A/B (voir plus bas), jamais contre un score stocké.
- `VBE_SUITE=default|perturb|all`. `perturb` = 27 variantes × 5 tirages = 135 requêtes (plafond 150).
- Indicateurs par découpage : **fausse acceptation** (part des tirages d'ablation où une valeur absente de la phrase
  entre dans le brouillon ; le pire cas, à faire baisser), **fidélité** (substitution), **robustesse au bruit**.
- Les variantes et le cas `truthStatus: "unverified"` sont **informatifs** : rapportés (`·`), jamais bloquants. Les
  seuils se fixent après la mesure de référence.
- **Découpage** : un tiers des cas est en `holdout`, par hachage de l'identifiant (jamais choisi à la main ; un
  `split` explicite reste possible). On règle et on diagnostique sur `calibration`, **jamais** sur `holdout`. Une
  variante suit le découpage de son cas de départ. Attention : les 29 cas d'origine ont déjà servi à régler les
  prompts, leur `holdout` n'est donc pas vierge. Seuls les cas ajoutés à partir de maintenant peuvent l'être.
- **Aucune liste de phrases, de mots ou de formulations** dans le code, les prompts d'exemple ou les cas générés.
  Un contrôle porte sur la structure de la sortie (champs, brouillon, `interpretation`, `confidence`, `action`),
  jamais sur le texte dit. Pas de nouveau contrôle `say`. Ce qui s'apparente à une phrase est de la donnée
  annotée dans `cases.json`.
- Un cas dont la vérité terrain n'est pas établie (ex. `appel-bf3893ae-enonce-incoherent`) porte
  `truthStatus: "unverified"` jusqu'à une écoute humaine de l'enregistrement.

### Fiabilité : familles, dimensionnement et rejeu A/B

« Fiable » veut dire **voir une baisse de 20 points par famille de comportements**, pas passer des seuils.

- Chaque cas déclare : `family` (attente, epellation, extraction, conge, relance, repetition, horaires),
  `measures` (`model` : la sortie brute du modèle ; `engine` : la décision après les garde-fous du code, seuil et
  écart lus après garde-fous, le brut est noté à côté) et `origin` (`real` : défaut observé sur un appel ;
  `variant` : variante d'un défaut réel documenté, `variantOf`, sans donnée personnelle ; `control` : témoin
  inventé pour une hypothèse, il ne compte pas dans les défauts exigés). Un cas dont un contrôle passe par le moteur
  (`hangsUp`) déclare `engine` (test).
- Les cas se choisissent d'après des défauts réels. La difficulté (`difficulty`) est notée à l'ajout, **jamais
  utilisée pour choisir ni écarter** un cas : filtrer sur un score fait régresser vers la moyenne et fabrique des
  progrès.
- Dimensionnement : au moins 4 défauts (réels ou variantes de défauts réels, vérité établie) par famille, et
  `FAMILY_DRAWS` tirages par bras (75, d'après la formule de `power.ts` : test unilatéral à 5 %, puissance 80 %,
  pire taux de départ 50 %). `build --family-draws auto` répartit ces tirages entre les cas de la famille ;
  `coverage --family-draws auto` dit, par famille, si c'est dimensionné.
- **Pas de référence stockée.** Une modification se juge par un rejeu A/B : requêtes de la référence (arbre sans la
  modification) et du candidat tirées dans la même session, une de chaque bras à tour de rôle
  (`scripts/ops/voice-behavior-ab.sh ref.json cand.json`, refuse de partir sans `VBE_MAX_REQUESTS` explicite :
  un rejeu se chiffre et s'approuve avant). Les deux bras ont les mêmes cas ; l'écart se calcule cas par cas puis par
  famille (intervalle à 90 % par rééchantillonnage des cas puis des tirages) ; une famille sous-dimensionnée ou dont
  la référence est sous 20 % est rapportée « non concluant », pas « tenue ».
- Comptes de jetons : le rejeu relève `usage` (entrée/sortie) par bras auprès du fournisseur ; ce sont ces chiffres,
  pas une hypothèse, qui chiffrent le rejeu suivant. `VBE_PROVIDER_ORDER=DeepInfra` fixe l'hébergeur OpenRouter
  (sans repli : une quantification d'un bout à l'autre) et `VBE_REASONING_OFF=1` coupe le raisonnement.
- **Vraie base de prompt, toujours.** Chaque requête passe par `buildSystemPrompt(…, structuredTurn: true)` avec la
  fiche d'un restaurant : le profil par défaut du fichier (`defaultProfile`) est Chez Sokar tel qu'en base de
  production (nom, horaires réels, fuseau, taille de groupe, `systemPromptExtra`, genre de la voix). Il n'existe plus
  de consigne « minimale » : un cas sans profil de restaurant ne se construit pas (test). Un profil de démonstration
  (`midi`) reste possible pour mesurer un autre restaurant.
- Calage entre fournisseurs : `voice-behavior-eval.ts calibrate production.json autre.json` (deux rejeux séparés,
  mêmes cas) ; avec 12 tirages par cas il ne voit que les écarts de 30 points ou plus et ne dit jamais « équivalent ».
  `build --case-draws N` fixe N tirages par cas (sonde, calage).
