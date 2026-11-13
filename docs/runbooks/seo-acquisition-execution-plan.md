# Suppernote — Plan d'exécution commercial et SEO pour l'agent

Date initiale : **13 octobre 2026 — Europe/Paris**. Dépendances révisées le **15 octobre 2026**.

Statut : **brief d'exécution révisé ; état des livraisons dans le rapport growth**. Les hypothèses commerciales
ci-dessous sont proposées pour le premier test. Ce document ne certifie ni la production actuelle,
ni la réalisation des pilotes, ni l'efficacité du canal SEO.

## 1. Mission et résultat attendu

Faire progresser Suppernote vers des clients restaurateurs qui paient, utilisent réellement le produit
et renouvellent. Développer en parallèle une acquisition organique fondée sur une description
exacte du produit ; réserver les témoignages et gains chiffrés aux résultats prouvés.

L'agent doit livrer des modifications concrètes, vérifiées et documentées. Pour les étapes qui
dépendent de restaurateurs, il prépare le protocole et les supports, indique précisément la
dépendance humaine et poursuit les travaux indépendants. Il ne remplace jamais une preuve terrain
par une simulation ou un avis supposé.

Décision du 15 octobre : l’accueil `https://suppernote.com/` est la page commerciale et SEO prioritaire.
Conserver son UI ; retirer la landing dédiée du lot et rediriger son ancienne adresse vers `/`.
LAND-01 conserve son identifiant de suivi, mais désigne désormais la consolidation de l’accueil.
Aucune nouvelle landing n’est à créer dans ce lot.

Résultats attendus, selon les dépendances de la section 4, sans imposer une exécution séquentielle :

1. Une vitrine compréhensible, dont les simulations et les chiffres illustratifs sont identifiés.
2. Un exemple public clairement simulé, distinct de la recette interne et des opérations clients.
3. Un parcours demande de démonstration → suivi → inscription → activation → paiement mesurable.
4. Un diagnostic de production SEO et des corrections proportionnées aux problèmes constatés.
5. Un segment testé par des entretiens et des décisions d'achat réelles.
6. Une qualification interne du parcours réel avant activation des pilotes payants documentés.
7. Une décision commerciale fondée sur le renouvellement, l'usage et le coût de service.
8. Un accueil commercial consolidé dès que ses critères sont remplis, puis une expansion
   conditionnelle de Connect et des contenus.

L'état courant est tenu dans la section 2 du [rapport growth](../audits/2026-10-13-growth-execution.md).
Ses observations historiques gardent leur date ; elles ne constituent pas des TODOs à réexécuter.

Le but n'est pas de livrer une nouvelle stratégie abstraite ou de produire un nombre prédéfini de pages.

## 2. Règles de travail et sources de vérité

### 2.1 Démarrage obligatoire

- Lire [AGENTS.md](../../AGENTS.md) et les éventuelles instructions plus spécifiques aux fichiers touchés.
- Lire uniquement les TODOs actifs du vault et les trois dernières lignes du Journal au démarrage :

  ```sh
  sed -n '/^## TODOs actifs/,/^## Décisions récentes/p' docs/obsidian/Context.md
  tail -3 docs/obsidian/Journal.md
  ```

- Inspecter la branche, le statut Git, les changements locaux et les artefacts/worktrees disponibles.
- Le checkout principal contient au moment de la rédaction des changements non commités sur
  l'onboarding, les formules, le provisioning et les rôles. Préserver ce travail ; isoler le chantier
  si nécessaire. Vérifier quelles dépendances sont réellement intégrées avant de bâtir dessus.
- Inspecter les processus Git/IDE avant les opérations Git importantes. Stager uniquement les fichiers
  du chantier. Sur une branche de travail, après commit, suivre `pnpm pr:submit` et attacher la PR
  au chat avec l'outil de l'app lorsqu'il est disponible. Aucun push direct sur `main`.
- Rechercher ce qui existe avant de créer une route, un événement, un formulaire, une table ou un dashboard.
- Vérifier la version Node avec `pnpm node:check` et utiliser les scripts présents dans les
  `package.json` courants. Le catalogue de commandes du repo peut évoluer.

### 2.2 Documents à réutiliser

| Source                                                                                            | Usage                                                                                                              |
| ------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| [Positionnement face à Zenchef](../positioning-vs-zenchef.md)                                     | Capacité produit, limites et comparaison ; certaines informations datent de septembre et doivent être réconciliées |
| [Ouverture Essential du 22/09/2026](../release/evidence/essential-checkout-opening-2026-09-22.md) | Preuve historique d'ouverture, prix et porte commerciale restée ouverte à cette date                               |
| [Pilote Essential sur sept jours](essential-pilot-7-day.md)                                       | Conditions d'entrée, paiement, suivi, incidents et décision de sortie                                              |
| [Billing Stripe](stripe-billing.md)                                                               | Catalogue, Checkout, webhooks et preuves de paiement                                                               |
| [Environnement](environment.md)                                                                   | Variables et configuration ; secrets uniquement en environnement                                                   |
| [Déploiement](deployment.md) et [rollback](rollback.md)                                           | CI, staging, promotion, snapshot et retour arrière                                                                 |
| [Architecture dashboard](../architecture/dashboard.md)                                            | Composants, tokens, responsive et règles CSS                                                                       |
| [Carte du projet](../PROJECT_MAP.md)                                                              | Localiser les modules et les surfaces d'intégration                                                                |

### 2.3 Périmètre et responsabilités

- L'agent prend en charge audit, préparation des supports, implémentation, tests et preuves techniques.
- Hamza ou le responsable commercial prend en charge sélection finale des établissements,
  entretiens, conditions commerciales, accords de pilote et relation client.
- Préparer les messages de prospection est dans le périmètre. Leur envoi, ou tout contact extérieur,
  nécessite une instruction explicite du responsable ; ce brief ne programme aucune campagne.
- Respecter les contrats externes : routes publiques, widget, schémas MCP et noms d'événements
  existants. Toute évolution doit être additive ; obtenir confirmation avant un changement cassant.
- Respecter les garde-fous DB du repo. Aucune opération destructive ni `db push` distant sans
  confirmation explicite. Les éventuelles migrations nécessaires doivent être explicites et revues.
- Aucune coordonnée client, transcript brut, clé ou token dans Git, logs, Sentry ou analytics.
  Les données de contact du formulaire restent dans un stockage restreint approprié. Utiliser
  `redactPii()` pour les chemins de journalisation concernés.
- Toute nouvelle interface française emploie **vous**, les composants Shadcn, Lucide, `cn()` et
  les tokens existants. Prévoir chargement, vide, erreur, succès et affichage à largeur iPad.
- La production suit l'autorisation du repo : CI et staging verts, snapshot, santé et rollback.
  Signaler en commentary les changements de paiement, auth, voix, DB ou configuration critique,
  puis suivre les procédures applicables sans ajouter une approbation systématique.
- Ne pas activer au passage les expériences, paiements de réservation, Places, campagnes Pro
  ou intégrations non qualifiées. L'ouverture historique d'Essential ne valide pas ces fonctions.
- Actualiser le Journal après une décision ou un changement significatif. Modifier Context uniquement
  pour une décision sur l'état actuel ou un TODO, en conservant sa taille limitée.

## 3. Hypothèses de départ à tester

### 3.1 Premier segment

Restaurant indépendant établi, un seul site, demandes téléphoniques régulières et réservations
principalement gérées avec un cahier, un tableur ou un processus manuel.

Qualification recherchée :

- problème observé pendant un service récent ; distinguer réservation, information et autres appels ;
- décideur directement impliqué et disponible pour le pilote ;
- volonté d'adopter une référence commune pour les réservations, y compris celles prises en salle ;
- équipement et organisation permettant à l'équipe de consulter et tenir le système à jour ;
- acceptation explicite du prix, des limites d'usage et des modalités d'installation ;
- configuration téléphonique permettant un renvoi qualifié et un secours humain.

Un cahier ne prouve ni le besoin, ni le budget, ni une adoption facile. Aucun seuil arbitraire
d'appels/jour ne constitue une validation : mesurer la fréquence, la nature des demandes et la valeur.

### 3.2 Offre et message provisoires

La plateforme Suppernote couvre les réservations, l'organisation du service et la relation client ;
l'assistant vocal en est une fonction. Le message ci-dessous est une hypothèse pour un premier
pilote Essential, pas la définition de tout le produit. Voir la
[carte produit](../PROJECT_MAP.md#ce-quest-sokar) pour les modules développés et leurs limites.

**Essential**, sur la base historique de **199 € HT/mois**, avec périmètre et limites à revérifier
dans le catalogue actif, les entitlements, le site et Stripe avant toute proposition ferme.

> Suppernote aide les restaurants à réunir leurs réservations et à préparer leur service dans un même
> outil. Un assistant vocal est conçu pour traiter les appels transférés lorsque l'équipe est occupée.

Premier usage : remplacer un processus manuel de réservation. Ne pas promettre la parité complète
avec Zenchef ni une synchronisation Zenchef/TheFork/POS sans preuve d'un adaptateur réel opérationnel.

Le gain opérationnel, la simplicité et l'installation accompagnée sont des hypothèses à mesurer.
La centralisation et l'IA vocale ne sont pas, à elles seules, des avantages concurrentiels exclusifs.

### 3.3 Trois validations distinctes

| Validation              | Preuve attendue                                                                                      | Ce qu'elle ne permet pas encore de conclure                              |
| ----------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Produit et exploitation | Appels utiles, réservations fiables, équipe autonome, incidents maîtrisés                            | Rentabilité ou rétention du segment                                      |
| Offre commerciale       | Paiement réel, bénéfice reconnu, renouvellement et coût de service acceptable                        | Performance du SEO                                                       |
| Acquisition organique   | Pages découvertes/indexées, prospects pertinents et conversions attribuables avec limites explicites | Demande nationale ou acquisition à grande échelle après quelques visites |

La simulation publique illustre une expérience : elle ne certifie aucune de ces trois validations.
Elle peut être un exemple enregistré ou interactif avec résultats simulés. Sa nature doit être
visible ; elle ne doit produire aucune réservation client, facturation client ou notification à un client.
L'existence d'un restaurant fictif ne suffit pas à démontrer cette isolation.

## 4. Priorités, ordre et dépendances

**P0** : bloque la crédibilité, une conversion importante, l'exploitation du pilote ou sa mesure.
**P1** : construit la première preuve commerciale et l'acquisition ciblée.
**P2** : amélioration ou expansion, après justification par les données.

| Phase | Priorité                                 | Travail                                                | Dépendance pour avancer                                                                |
| ----- | ---------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| 0     | P0                                       | État initial et inventaire des preuves                 | Aucune                                                                                 |
| 1     | P0                                       | Crédibilité de la vitrine et promesse                  | Phase 0                                                                                |
| 2     | P0 simulation ; P0 avant pilote          | Exemple public isolé ; recette interne et installation | Simulation avant publication de l'exemple ; recette réelle avant activation client     |
| 3     | P0                                       | Demande de démo, suivi et instrumentation minimale     | Phase 0 ; promesse cohérente de phase 1                                                |
| 4     | P0 diagnostic ; corrections selon impact | Santé SEO de production                                | Phase 0 ; indépendante du pilote                                                       |
| 5     | P1                                       | Entretiens et sélection du segment                     | Supports préparés ; interlocuteurs disponibles, sans quota bloquant                    |
| 6     | P0 avant extension                       | Première revue opérationnelle des pilotes              | Candidat qualifié, recette interne, installation, suivi minimal et facturation prêts   |
| 7     | P1                                       | Renouvellement, adoption et économie de service        | Pilotes démarrés ; durée d'observation suffisante                                      |
| 8     | P1                                       | Accueil commercial et étude de demande                 | Texte exact, exemple isolé s'il est présenté, demande de démo et mesure minimale prêts |
| 9     | P2 conditionnel                          | Qualité et croissance Connect                          | Inventaire réel et technique publique qualifiés                                        |
| 10    | P2 conditionnel                          | Expansion contenus et distribution                     | Signaux commerciaux et acquisition documentés                                          |

Après la phase 0, les phases 1, 2, 3, 4 et la préparation de 5/8 peuvent avancer en parallèle au
sens de chantiers indépendants. Une dépendance humaine ne bloque pas tout le programme. Le traitement
du sitemap Connect n'est pas une condition générale de publication de l’accueil B2B.
VOICE-01, le nombre d'entretiens, la fin des deux pilotes et un renouvellement ne sont pas des
conditions générales de publication SEO. Une capacité non qualifiée reste présentée avec ses
limites ; ne pas la déclarer validée en retirant simplement le noindex.

Repères de calendrier, à adapter à l'accès aux outils et aux disponibilités humaines :

- **J1–J3** : état initial, crédibilité, préparation démo et parcours, diagnostic SEO.
- **J4–J14** : entretiens disponibles, démos qualifiées, premières demandes et sélection des pilotes ;
  consolider l’accueil dès qu’il respecte ses critères, sans attendre une date arbitraire.
- **Deux périodes de sept jours** : observer les pilotes selon le runbook ; elles peuvent se chevaucher.
- **Premier renouvellement** : décision commerciale, avec suivi d'usage ; un paiement annuel ne
  fournit pas une preuve de renouvellement mensuel.
- **J30–J90 et au-delà** : consolider et décider des expansions. Aucun engagement de trafic ou de rang.

## 5. Phase 0 — Établir l'état initial

### Actions

1. Distinguer pour chaque surface : code local, branche intégrée, staging, production, preuve terrain.
2. Recenser les CTA, routes publiques, scripts de démo, analytics, billing, usage et monitoring existants.
3. Vérifier si les deux preuves de pilote existent déjà dans Git ou dans les outils restreints.
4. Documenter les dépendances de l'onboarding en cours : numéro, renvoi, appel test, canal en ligne,
   accès dashboard, paiement et rôles. Ne pas réintroduire un parcours parallèle incompatible.
5. Relever les informations manquantes : accès Search Console, données Stripe/usage, enregistrements
   qualifiés, responsable du suivi commercial et disponibilité des restaurants.

### Livrables et critère de sortie

- Créer un état daté dans `docs/audits/YYYY-MM-DD-growth-baseline.md`, sans données personnelles.
- Créer un suivi du backlog reprenant les IDs de la section 17, avec preuve et prochaine action.
- Chaque constat a une source et une date. Une donnée absente porte **UNKNOWN**, jamais zéro.
- Si une dépendance manque, indiquer son détenteur, sa conséquence et les tâches qui restent faisables.

## 6. Phase 1 — Rendre la vitrine crédible et claire

### Fichiers à inspecter

- `apps/dashboard/src/app/page.tsx`, `layout.tsx`, `pricing/page.tsx` et `pricing/layout.tsx`.
- `apps/dashboard/src/app/DemoSection.tsx`, `constants.ts`, `PricingPlans.tsx`.
- `apps/dashboard/src/components/AuthCTA.tsx` et les autres CTA retrouvés par recherche.

### Actions

1. Inventorier les affirmations visibles : disponibilité, taux de réponse, revenus, nombre d'appels,
   réservations et mentions de temps réel. Vérifier leur provenance.
2. Identifier explicitement la simulation dans `DemoSection.tsx`. Les valeurs illustratives observées
   dans le code sont 412 appels, 189 tables, 98 % de réponse et 5 420 € de revenus récupérés.
   Les retirer si inutiles ou afficher une mention visible **« Exemple illustratif — données simulées »**.
3. Réviser « Console de Dialogue Live », « Appel client en cours » et « temps réel » lorsqu'ils
   décrivent un scénario prédéfini. La précision doit être visible avant que le visiteur interprète les chiffres.
4. Clarifier le bénéfice dans le hero, avec un vocabulaire produit explicite. Éviter les garanties
   « zéro appel manqué », de revenu récupéré ou de supériorité sans preuve.
5. Définir des métadonnées propres à l'accueil et aux tarifs, vérifier canonical, Open Graph et base
   des métadonnées. Inspecter les héritages Next.js avant toute correction.
6. Réconcilier prix, HT, mensualité/annualité, quotas, dépassements et périmètre réellement vendable.
7. Conserver un accès explicite à la création de compte pour les visiteurs prêts à s'inscrire.

### Recette

- Une simulation ne peut pas être raisonnablement confondue avec un résultat client ou une activité live.
- Prix et fonctions correspondent aux preuves actuelles ; aucune nouvelle promesse non qualifiée.
- Le HTML livré expose le sujet et les métadonnées attendus sur l'accueil et les tarifs.
- Vérification visuelle desktop, mobile et iPad, et contrôle pertinent du build/typecheck.

## 7. Phase 2 — Distinguer simulation publique, recette interne et installation

### Exemple public (DEMO-SIM)

- Réutiliser le dispositif existant ; aucune nouvelle fonctionnalité imposée par ce plan.
- Annoncer « Exemple de démonstration — réservation simulée » à proximité de l'exemple.
- Montrer un restaurant fictif et un scénario compréhensible, sans demander une vraie réservation.
- Vérifier l'isolation des actions : aucune écriture client, facturation client, notification client ou
  transfert vers un numéro réel. Les éventuelles données techniques de test sont identifiées,
  isolées et exclues des métriques commerciales.
- Pour un exemple interactif, vérifier les chemins d'erreur et le secours simulé. Pour un exemple
  enregistré, indiquer sa nature et fournir la transcription si l'audio est proposé.
- Documenter ce que l'exemple illustre et ce qu'il ne démontre pas. Son contrôle ne nécessite ni
  abonnement, ni compte opérateur public, ni recette complète de réservation réelle.

Critère de sortie : nature simulée explicite, résultat d'exemple cohérent et effets isolés.
Si l'isolation est inconnue, ne pas présenter l'exemple comme un bac à sable sûr.

### Recette interne du produit (VOICE-01), avant activation client

Cette recette exerce les vraies opérations métier sur des données de test contrôlées. Elle reste
distincte de l'exemple montré au visiteur et ne doit pas lui être imposée.

### Réutiliser l'existant

Inspecter le parcours d'appel test et les routes de démonstration dans le module `restaurants`,
`apps/api/src/modules/voice/demo/`, ainsi que les diagnostics et rapports de voix existants.
Une animation, une lecture TTS d'un script et une conversation live avec écritures simulées sont
trois dispositifs différents. Documenter pour chacun le niveau de preuve réellement apporté.

### Scénarios minimaux de recette interne

| Scénario                           | Vérification métier                                                          |
| ---------------------------------- | ---------------------------------------------------------------------------- |
| Demande simple                     | Créneau, nombre de personnes, informations nécessaires et réservation exacte |
| Changement pendant la conversation | La demande finale remplace correctement l'intention précédente               |
| Restaurant complet                 | Absence de réservation impossible ; réponse et alternative cohérentes        |
| Nom/heure ambigus                  | Clarification utile et absence d'écriture prématurée                         |
| Question pratique                  | Information vérifiée ou transfert/solution de secours sans invention         |
| Reprise ou répétition              | Pas de création en double ; cohérence entre appel et dashboard               |
| Service ou fournisseur dégradé     | Comportement de secours réel et absence de perte silencieuse                 |

Utiliser des coordonnées de test contrôlées. Les artefacts publics doivent être enregistrés pour
cet usage ou correctement anonymisés ; aucune donnée de client réel dans le dépôt.

### Actions et livrables

- Qualifier des appels avec les vrais fournisseurs et préciser environnement/version/configuration.
- Vérifier le résultat par lecture du dashboard et des traces métier autorisées, pas uniquement par l'audio.
- Qualifier numéro, renvoi, absence de boucle et secours humain avant routage d'appels clients.
- Traiter les blocages de voix/onboarding nécessaires au pilote avec changements ciblés et rollback.
- Conserver une preuve interne du résultat métier et de ses limites. Un artefact montré au public
  suit les critères DEMO-SIM ; ne pas utiliser une simulation comme preuve de fiabilité réelle.
- Préciser les différences de fournisseurs/configuration entre staging et production ; une recette
  staging ne qualifie pas automatiquement un pipeline de production différent.
- Définir un protocole de mise à jour : rejouer la preuve après une évolution significative du pipeline.
- Documenter la qualification dans `docs/audits/YYYY-MM-DD-commercial-demo-validation.md`.

### Critère de sortie de la recette interne

Le scénario annoncé est reproductible, la réservation finale est exacte, les limites et le secours
sont compris avant activation client. Ce critère n'est pas le critère de publication SEO.
Aucun défaut bloquant ouvert selon le runbook pilote. Le taux de réussite se calcule
avec le nombre d'essais, leur périmètre et les échecs inclus ; ne pas sélectionner uniquement les succès.

## 8. Phase 3 — Livrer une demande de démo et un suivi cohérents

### Parcours cible

Page commerciale → **Demander une démonstration** → demande enregistrée → échange de qualification
→ démonstration réalisée → inscription normale → activation accompagnée → abonnement.

La destination envisagée est `/demo`. Vérifier avant création si une route ou un système de demande
réutilisable existe. Le formulaire ne doit pas imposer un compte Clerk et ne doit pas prétendre
qu'un créneau est réservé lorsqu'il recueille seulement une demande.

### Implémentation minimale

- Champs requis limités au besoin de suivi : établissement et moyen de contact professionnel.
  Outil actuel et problème principal peuvent être facultatifs pour limiter la friction.
- Validation serveur, anti-abus adapté, état pending, succès persistant et erreur avec reprise.
- Prévenir les doublons de requête, distinguer succès serveur et simple clic, éviter les demandes
  perdues lors d'un échec de notification. Réutiliser les composants/infrastructures existants.
- Prévoir un stockage restreint, un accès opérateur, un responsable et une règle de délai de réponse
  interne adaptée. L'absence de délai commercial annoncé ne bloque pas la publication ; afficher
  uniquement une promesse de réponse réellement tenue.
- Afficher l'information relative à l'utilisation des données et identifier toute dépendance de
  validation juridique ; ne pas ajouter un opt-in marketing obligatoire à une demande de démo.
- Préparer le mécanisme de notification interne. Pour un test, utiliser un destinataire contrôlé ;
  la mise en service des envois réels suit l'autorisation applicable et les providers qualifiés.
- Relier la demande à l'inscription via un identifiant opaque, selon le besoin, sans placer
  e-mail/téléphone dans URL, logs ou événements analytics.
- Conserver un lien secondaire **Créer votre compte** vers `/register`.

### Instrumentation

Mode opératoire local : [suivi commercial minimal](commercial-follow-up.md), rapprochement manuel
vérifié et exclusion explicite des essais, sans nouveau dashboard.

Pour démarrer l'acquisition, réutiliser les demandes persistées, leur source et leurs statuts ;
tenir le suivi qualification/démo dans l'outil existant ou un relevé restreint. Ne pas construire
un nouveau dashboard ni attendre tout le funnel. Avant un pilote, vérifier les liens entre
restaurant, activation, usage et paiement. Renouvellement et rétention deviennent observables plus tard.

Les noms ci-dessous sont **des propositions**. Mapper d'abord les événements existants. Si de nouveaux
événements sont nécessaires, les ajouter sans renommer ceux consommés ailleurs.

| Étape logique               | Nom proposé si absent            | Source de vérité et condition                              |
| --------------------------- | -------------------------------- | ---------------------------------------------------------- |
| Demande reçue               | `demo_requested`                 | Persistance serveur réussie, une fois par demande          |
| Démo faite                  | `demo_completed`                 | Statut confirmé par le responsable commercial              |
| Pilote commencé             | `pilot_started`                  | Conditions du runbook satisfaites et début daté            |
| Premier usage utile         | `first_useful_call`              | Demande réellement traitée ; définition fixée, hors test   |
| Première réservation        | `first_reservation_confirmed`    | Réservation confirmée métier, hors démonstration           |
| Premier paiement            | `subscription_payment_succeeded` | Facture/paiement Stripe vérifié, pas retour navigateur     |
| Renouvellement payé         | `subscription_renewal_paid`      | Nouvelle échéance encaissée, distincte du premier paiement |
| Maintien d'usage à 30 jours | `retained_30d`                   | Cohorte observable, abonnement actif et usage utile récent |

Pour les paiements : idempotence sur l'identité de facture/événement, rejouabilité des webhooks,
distinction live/test, mensuel/annuel, échec, remboursement et résiliation. Pour les milestones :
éviter la double émission et conserver l'horodatage métier. Un événement manquant reste UNKNOWN.

Limiter les propriétés au besoin : IDs opaques, source/campagne permise, version de page,
environnement, date, statut et motif structuré. Ni coordonnées ni récit libre d'appel en analytics.

### Recette

- Demande réelle de test enregistrée, visible par le responsable, suivie et sans compte obligatoire.
- Double clic/retry ne crée pas deux leads ; erreur de notification ne supprime pas le lead.
- Aucune conversion de paiement émise par le frontend seul.
- Parcours inscription/onboarding existant préservé ; rôle et isolation vérifiés si un accès est ajouté.
- Mini-tableau de suivi suffisant ; pas de nouvel outil BI ou CRM complet pour deux pilotes.

## 9. Phase 4 — Diagnostiquer et corriger le SEO de production

### Observations de départ, à reproduire

Au 13/10/2026, une consultation externe a trouvé les métadonnées génériques sur l'accueil et les
tarifs ; le sitemap reçu contenait uniquement `/` et `/assistant`. Les appels externes à
`/public/sitemap-data` et `/public/cities` ont répondu 403. Ce constat n'explique pas le chemin interne.

Dans le code consulté, `fetchPublishedSlugs()` et `fetchCities()` retournent `[]` sur erreur.
L'absence de fiches dans le sitemap peut donc correspondre à zéro publication ou à une récupération
en échec. Aucun incident ni nombre de restaurants ne doit être déduit sans investigation.

### Diagnostic ordonné

1. Compter en lecture seule les établissements correspondant à `PUBLIC_CONNECT_WHERE`, puis ceux
   possédant un slug utilisable. Conserver les comptes, pas les coordonnées.
2. Comparer API Fastify interne, chemin réellement utilisé par Connect et endpoint public externe.
   Identifier proxy/WAF/auth/rate-limit uniquement si les réponses le justifient.
3. Comparer slugs API, sitemap généré, réponse publique et caches. Dater les observations.
4. Inspecter `infra/nginx/sokar.conf`, configuration Connect et environnement sans afficher les secrets.
5. Contrôler robots/noindex, canonical, statuts, HTML et liens internes des pages importantes.
6. Vérifier le domaine Search Console, les sitemaps et un échantillon d'inspections d'URL si l'accès
   existe. Sans cet accès, livrer la checklist et laisser l'indexation effective UNKNOWN.

### Corrections selon preuve

- Ajouter les pages B2B indexables importantes au sitemap réellement servi par Nginx, sans créer
  dans dashboard un sitemap que le proxy ne publie jamais. Un sitemap coordonné suffit au départ.
- En cas d'échec API, éviter un remplacement silencieux par un sitemap tronqué. Évaluer conservation
  du dernier résultat valide ou réponse temporaire d'erreur selon les caches existants ; tester le
  comportement effectif de Next.js/Nginx. Distinguer succès vide et échec, sans conserver des URL
  retirées indéfiniment. Ajouter une observation/alerte proportionnée au volume publiable connu.
- Réserver `noindex` aux pages techniques/transactionnelles appropriées après inspection de leur rôle.
  Candidats : `/login`, `/register`, `/book/...`, `/widget/...`. Une interface utile à réserver
  doit rester accessible. Le `noindex` n'est pas un mécanisme d'authentification.
- Ne pas combiner mécaniquement `Disallow` et `noindex` : le robot doit pouvoir lire la directive
  pour les pages publiques dont on veut retirer l'indexation.
- Harmoniser les règles cuisine API/page/sitemap/maillage si elles excluent des pages utiles.
  Les valeurs 5/10 sont des garde-fous internes, pas des exigences de Google.
- Utiliser une vraie modification significative pour `lastModified`, ou omettre le champ inconnu.
  Ne pas passer du temps à régler `priority`/`changefreq`, ignorés par Google.
- Mesurer latence et cache avant une refonte de rendu. `force-dynamic` n'établit pas à lui seul un défaut SEO.
- Garder le français comme première cible. Les URL de langue/hreflang attendent un besoin d'expansion.

### Recette

- Chaque URL restaurant éligible avec slug apparaît dans le sitemap et répond avec une page
  canonique utile, sans `noindex` involontaire ; une URL retirée disparaît selon le délai documenté.
- Tests distincts : inventaire vide normal, données présentes, API indisponible, slug manquant,
  publication/dépublication et effets du cache pertinents.
- Aucun élargissement de sécurité ni publication de données de démonstration pour remplir le sitemap.
- Les métadonnées, canonical et directives sont vérifiées sur le HTML livré après déploiement.
- Rapport dans `docs/audits/YYYY-MM-DD-production-seo.md`, avec blocages, corrections et inconnues.

## 10. Phase 5 — Confronter l'offre aux restaurateurs

### Préparation par l'agent

- Préparer une fiche de qualification et un guide d'entretien ; contacts dans un outil restreint.
- Cibler environ 8 à 12 retours comme repère de recherche, sans quota préalable au premier pilote
  ni prétention statistique. Continuer les entretiens pendant les pilotes.
- Préparer un message de prospection et une proposition de pilote payant transparents, à faire
  valider par le responsable avant envoi. Aucun paiement/engagement supposé à partir d'un avis positif.
- Comparer les alternatives réellement utilisées : cahier, salarié, renvoi, messagerie, autres logiciels.
- Réexaminer les offres concurrentes officielles, en datant les prix, options et quotas ; éviter
  les affirmations de supériorité ou de compatibilité non testées.

### Questions et preuves à collecter

1. Lors du dernier service chargé, qui gérait le téléphone et les réservations ?
2. Comment une réservation prise par téléphone ou en salle devient-elle visible à toute l'équipe ?
3. Quels appels ont été manqués, avec quelle preuve et quelles conséquences observées ?
4. Quelles tentatives de solution ont déjà été faites, payées ou abandonnées ?
5. Qu'est-ce qui empêcherait l'adoption d'un outil commun et qui le tiendrait à jour ?
6. Quelles contraintes téléphoniques, horaires et exceptions faut-il absolument préserver ?
7. Après une démo et une offre précise, quelle action concrète le responsable accepte-t-il de faire ?

Séparer fait observé, estimation déclarée, opinion, objection, action acceptée et paiement.
Conserver aussi les refus et absences de réponse. Un restaurant ami bénéficiant d'une assistance
exceptionnelle doit être identifié comme tel dans l'analyse anonymisée.

### Critère de sortie

Chaque candidat peut avancer lorsque besoin, organisation, décideur, préparation technique,
prix et conditions sont explicitement qualifiés. Le premier n'attend pas le second ni la fin des
entretiens. Vérifier l'adéquation de la formule à son besoin ; Essential reste le périmètre initial,
toute autre formule ou condition commerciale exige une décision explicite. Sinon documenter pourquoi : segment inadapté,
offre, fiabilité, budget, installation ou changement d'habitude. Ne pas lancer de nouvelles fonctions
sur la base d'une seule objection ; rechercher la répétition du besoin et sa valeur.

## 11. Phase 6 — Exécuter les deux pilotes Essential

Appliquer [essential-pilot-7-day.md](essential-pilot-7-day.md), avec ses conditions d'entrée et ses
critères d'arrêt. Aucun troisième pilote avant la revue prévue dans ce runbook.
Ce plafond initial maîtrise la charge opérationnelle ; il ne prouve pas la validité du segment.
Le premier pilote peut commencer dès que ses propres conditions sont satisfaites.

### Avant démarrage

- Responsable restaurant et responsable Suppernote identifiés ; dates, accord et modalités conservés
  dans un système restreint. Pilotes sous Essential payant selon le runbook actuel.
- Prix, facture, plan et cadence vérifiés ; ne pas prendre un Checkout créé pour une facture payée.
- Onboarding normal terminé, numéro/renvoi/appel qualifiés, disponibilité et secours opérationnels.
- Toutes les réservations prises manuellement entrent dans la référence commune ; équipe formée.
- Snapshot initial d'usage et de facturation, monitoring, incident et rollback prêts.
- Relever une référence avant activation, sur des services comparables si possible. Sans référence
  fiable, rapporter les résultats absolus et les limites ; ne pas fabriquer un pourcentage de gain.

### Pendant les sept jours

Suivre par restaurant : appels totaux, appels éligibles, traitement utile, transferts, réservations
confirmées, corrections manuelles, incidents, usage équipe, support et temps d'installation.
Exclure les appels de test des gains client. Donner les dénominateurs des taux.

Réutiliser après validation de leur périmètre : `/api/internal/pilot-kpis`,
`/admin/onboarding-funnel/cohort`, `/analytics/voice`, monitoring, billing et données d'usage existantes.
Ces sources peuvent être globales ou agrégées : vérifier le scope avant d'attribuer une valeur à un
restaurant. Ne pas exposer les endpoints d'exploitation au public.

### Sortie

Deux fiches datées, sept jours complets chacune, statut facturation, incidents, feedback et décision
explicite **GO / NO-GO / prolonger sous contrôle**, avec les noms prévus par le runbook.
L'agent ne marque pas la porte commerciale fermée tant que les preuves requises manquent.
La revue à sept jours est opérationnelle. Elle ne prouve ni fidélisation, ni renouvellement,
ni rentabilité durable ; ces conclusions relèvent de la phase 7 et du temps d'observation réel.

## 12. Phase 7 — Vérifier adoption durable et rentabilité

### Deux économies distinctes

**Restaurant** : interruptions évitées ou temps gagné observables, fiabilité, réservations utiles,
travail supplémentaire de saisie/formation et prix réellement payé. Une réservation traitée par
Suppernote n'est pas automatiquement une réservation supplémentaire ; un appel manqué n'est pas une
vente perdue. Aucun revenu récupéré sans méthode d'attribution explicite.

**Suppernote** : recettes HT nettes des remises/remboursements, coûts voix/opérateurs/STT/TTS/LLM,
SMS, paiement et infrastructure imputable, support récurrent, temps initial d'installation et vente.

Calculs à présenter avec hypothèses et périmètre :

```text
Contribution récurrente par restaurant
  = recettes HT reconnues sur la période
  - coûts variables récurrents
  - support récurrent valorisé

Coût initial d'acquisition et d'installation
  = temps commercial valorisé + dépenses d'acquisition + temps d'installation valorisé

Délai de récupération indicatif
  = coût initial / contribution mensuelle positive
```

Ne pas confondre encaissement annuel et revenu mensuel. Ne pas compter deux fois une tâche dans
CAC et installation. Séparer coûts mesurés, alloués et estimés. Un calcul sur deux restaurants ne
constitue pas un LTV robuste.

### Critère de passage vers extension

- Les clients utilisent le produit sans une intervention permanente exceptionnelle de l'équipe Suppernote.
- Une décision explicite de continuer et la preuve de paiement correspondante sont disponibles.
- La contribution et le coût d'installation sont connus assez précisément pour arbitrer l'extension.
- Les limites acceptables sont définies **avant la revue**, avec Hamza : support récurrent,
  fiabilité, marge et délai de récupération. Aucune cible chiffrée ne doit être inventée comme acquise.
- Sinon : prolonger l'observation, corriger le produit, réviser le segment ou le packaging avec
  décision documentée. Pas de modification automatique des tarifs ou contrats.

Livrable : `docs/audits/YYYY-MM-DD-essential-commercial-review.md`, avec tableau par pilote,
limites de l'échantillon, observations à 30 jours et décision d'investissement suivante.

## 13. Phase 8 — Consolider et mesurer l’accueil commercial

Préparer cette phase dès le démarrage. Publier dès que les textes sont exacts, l'exemple public
est clairement simulé et isolé s'il est présenté, et la demande de démo et son suivi fonctionnent.
La recette interne VOICE-01, le premier pilote et le renouvellement ne sont pas des prérequis
généraux. Une fonctionnalité non qualifiée ne doit pas être annoncée comme prouvée ou disponible
sans réserve ; ajuster la promesse ou retirer l'affirmation concernée.
Les témoignages et les gains chiffrés attendent leurs propres preuves.

### Étude de demande proportionnée

- Étudier 15 à 25 expressions autour de l'assistant téléphonique, des réservations par téléphone
  et des interruptions de service, avec vocabulaire issu des entretiens.
- Utiliser Search Console si disponible, suggestions, résultats de recherche français et données
  Keyword Planner autorisées. Noter date, zone et méthode. Aucun volume ou score de difficulté inventé.
- Distinguer recherche de restaurateur, recherche de consommateur et demande d'information.
- Comparer les pages présentes et les alternatives satisfaisant chaque intention.
- Séparer adéquation commerciale, demande observable et difficulté SEO. Éviter une moyenne qui
  masquerait un besoin d'intégration ou une preuve produit manquante.

### Page retenue

`/`, canonical `https://suppernote.com/`. Conserver les sections, styles, polices, animations et CTA
existants. Réutiliser la FAQ pour les précisions utiles, sans ajouter de bloc ni refaire le hero.
L’ancienne route `/solutions/assistant-telephonique-restaurant` redirige définitivement vers `/`
et reste hors sitemap. Les mentions de sa préparation dans le rapport sont historiques.

Contenu : cible, problème concret, fonctionnement, exemple simulé/transcription et résultat illustré,
configuration et secours, limites, installation, prix/quotas vérifiés, questions pratiques et CTA.
Les intentions proches « appels manqués » et « réservation téléphonique » peuvent rester des sections.

### Recette et suivi

- HTML principal disponible, title/H1 descriptifs, canonical correcte, statut 200, sitemap et
  maillage depuis les pages marketing. Préserver autant que possible le rendu statique.
- Responsive, accessibilité, audio contrôlé par le visiteur et transcription disponible.
- Conversion définie en phase 3 ; source et version de page traçables sans PII.
- Observer requêtes, impressions, clics, prospects qualifiés, paiements et objections.
- Les clics hors marque de Search Console et les sessions attribuées aux clients sont deux
  ensembles différents : requêtes anonymisées et attribution incomplète interdisent un lien parfait.
- Avec peu de trafic, privilégier retours qualitatifs et changements documentés ; ne pas présenter
  un A/B test insuffisamment alimenté comme une validation statistique.
- Mesurer les performances utilisateur réelles si disponibles. Sans données terrain, distinguer
  diagnostics de laboratoire et Core Web Vitals réels.

Une deuxième page exige une intention distincte, une réponse produit, des preuves et un chemin
commercial propres. « Logiciel réservation », CRM/no-show/cartes cadeaux ne deviennent pas prioritaires
simplement parce que les modules existent.

## 14. Phase 9 — Développer Connect à partir d'un inventaire réel

1. Qualifier les fiches des restaurants réellement publiés : informations, photos, horaires,
   identité, disponibilité, canonical et réservation.
2. Commencer par les recherches portant sur leur nom ; garder l'identité du restaurant au premier plan.
3. Préparer les liens de réservation depuis leurs sites et points de présence autorisés. Les
   changements sur leurs comptes/sites relèvent de leur accord et de l'accès correspondant.
4. Relier clics et confirmations réelles ; contrôler annulations, tests et doubles comptes.
5. Créer/améliorer les pages ville puis cuisine seulement si elles rendent un service utile,
   avec une offre réelle et des informations distinctives.
6. Mesurer coût de maintenance, qualité et réservations par établissement avant extension.

Les mesures B2B et Connect restent distinctes ; mutualiser les composants et la collecte pertinente.
Une réservation chez un partenaire n'est pas un lead SaaS. Aucun seed public ou fiche fictive pour
atteindre les seuils d'indexation. Aucun volume de pages locales fixé indépendamment de l'inventaire.

## 15. Phase 10 — Étendre selon les preuves

Ordre proposé : améliorer les pages qui répondent aux bonnes intentions → cas clients publiables
avec accord → nouvelle landing distincte → ressources métier originales → outil/calculateur si
utile → distribution éditoriale pertinente.

- Les démos, cas clients et données doivent conserver leur date, périmètre, méthode et limites.
- Un calculateur utilise scénarios, capacité disponible, autres canaux et marge ; aucun ROI garanti.
- Préparer demandes de liens et partenariats, avec validation avant contact. Pas d'achat massif
  de liens ni de publication automatique de centaines de pages similaires.
- Garder les informations structurées et MCP existants cohérents ; un chantier GEO autonome ou
  `llms.txt` ne passe pas avant les problèmes commerciaux observés.
- Les FAQ servent à répondre aux visiteurs. Les résultats enrichis FAQ Google ont été supprimés
  en mai 2026 ; leur balisage ne constitue pas un objectif d'affichage enrichi.
- L'internationalisation marketing attend une demande réelle, des URL distinctes et une stratégie
  linguistique cohérente, sans supposer qu'un cookie de langue suffit au référencement.

Chaque réinvestissement précise : preuve, coût prévu, responsable, résultat attendu, durée
d'observation et condition de report/arrêt. Un manque de trafic initial n'est pas, à lui seul,
la preuve d'un échec SEO ; un trafic sans prospects pertinents n'est pas une validation commerciale.

## 16. Vérification, livraison et preuves

Choisir les vérifications selon le changement. Les commandes ci-dessous sont des bases à contrôler
dans le repo courant ; ne pas lancer une suite complète pour une simple correction éditoriale.

```sh
pnpm node:check
pnpm exec prettier --check docs/runbooks/seo-acquisition-execution-plan.md
pnpm --filter @suppernote/dashboard typecheck
pnpm --filter @suppernote/api typecheck
```

- UI : contrôle navigateur mobile/iPad/desktop ; build ou typecheck adapté ; tests de comportements
  significatifs et du ton français selon périmètre ; lint CSS si styles touchés.
- Formulaire/API : validation, succès persistant, retry/doublon, panne notification, anti-abus,
  restriction d'accès et absence de PII dans les traces.
- Analytics/billing : événements uniques, webhook rejoué, live/test, scoping, paiement réel et
  échec ; jamais de paiement live de test facturé sans instruction/accord correspondant.
- Sitemap/indexabilité : données vides, erreurs API, inventaire présent, suppression, cache et HTML.
- Voix : vrais fournisseurs pour les preuves annoncées, assertions métier et qualification du secours.
- CI et staging : checks requis puis smoke tests. Après promotion autorisée, vérifier les routes
  modifiées et la santé ; garder la release et le chemin de rollback.

Une preuve technique indique environnement, version/commit, commande ou procédure, date et résultat.
Une preuve commerciale indique protocole, référence opaque, observation, limites et décision.
Les captures/audios doivent être **expurgés** avant archivage public.

## 17. Backlog prêt à reprendre

Ce tableau décrit les critères, pas l'état courant. Lire d'abord la section 2 du rapport growth
et ses preuves datées ; ne pas remettre en TODO un travail déjà qualifié. Créer les issues GitHub
si demandé ou si le workflow utilisé le requiert.

| ID         | Priorité                | Livrable                                                 | Dépendance                                                          | Critère de fin                                                               |
| ---------- | ----------------------- | -------------------------------------------------------- | ------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| BASE-01    | P0                      | État initial et preuves disponibles                      | Aucune                                                              | Local/staging/prod/terrain distingués ; inconnues listées                    |
| TRUST-01   | P0                      | Simulation et chiffres transparents                      | BASE-01                                                             | Aucun chiffre illustratif présenté comme preuve réelle                       |
| COPY-01    | P0                      | Accueil/tarifs/CTA/métadonnées cohérents                 | BASE-01                                                             | Produit et prix explicites ; HTML vérifié                                    |
| DEMO-SIM   | P0 avant exemple public | Simulation transparente et isolée                        | BASE-01, TRUST-01                                                   | Exemple cohérent, aucune action client, nature simulée visible               |
| VOICE-01   | P0 avant pilote         | Recette interne du parcours vocal                        | BASE-01                                                             | Opérations réelles sur données de test correctes, limites documentées        |
| OPS-01     | P0 avant pilote         | Installation et secours                                  | BASE-01, VOICE-01                                                   | Onboarding normal, renvoi et référence commune qualifiés                     |
| DEMO-01    | P0                      | Demande de démo sans compte                              | BASE-01, COPY-01                                                    | Lead persistant, erreurs/retry traités                                       |
| DEMO-02    | P0                      | Suivi opérateur de la demande                            | DEMO-01                                                             | Responsable et accès opérationnels ; délai public uniquement si tenu         |
| METRIC-01  | P0 minimal ; suite P1   | Suivi demande/démo puis activation/paiement              | BASE-01, DEMO-01                                                    | Acquisition mesurable sans nouveau dashboard ; suite selon usage observable  |
| BILL-01    | P0 avant pilote         | Paiement et droits ; renouvellement observé plus tard    | BASE-01                                                             | Catalogue, paiement et entitlements réconciliés ; renouvellement non inventé |
| SEO-01     | P0 diagnostic           | Inventaire/API/sitemap de production                     | BASE-01                                                             | Cause établie ou inconnue précisément bornée                                 |
| SEO-02     | P0 si blocage avéré     | Indexabilité et pages B2B découvertes                    | SEO-01, COPY-01                                                     | URL importantes et HTML/robots/canonical cohérents                           |
| ICP-01     | P1                      | Qualification et supports d'entretien                    | BASE-01                                                             | Cible, exclusions et protocole prêts                                         |
| ICP-02     | P1                      | Synthèse des retours terrain                             | ICP-01, interlocuteurs                                              | Faits/refus/actions séparés ; choix argumenté                                |
| PILOT-01   | P0 avant extension      | Revue opérationnelle à sept jours, deux pilotes initiaux | OPS-01, mesure minimale, BILL-01, candidat qualifié                 | Fiche par pilote ; premier démarrage indépendant du second                   |
| ECON-01    | P1                      | Adoption, coût et renouvellement                         | PILOT-01, temps écoulé                                              | Usage, paiement et contribution documentés                                   |
| LAND-01    | P1                      | Recherche de demande et accueil                          | COPY-01, DEMO-01/02, mesure minimale ; DEMO-SIM si exemple présenté | Texte exact, exemple isolé, CTA fonctionnel et indexabilité vérifiée         |
| CONNECT-01 | P2 conditionnel         | Qualité et réservation partenaires                       | SEO-01/02, inventaire réel                                          | Fiches fiables et confirmations mesurées                                     |
| SCALE-01   | P2 conditionnel         | Décision de réinvestissement                             | ECON-01, LAND-01 ; CONNECT-01 si local                              | Coût, preuves et objectif de l'extension explicites                          |

## 18. Format de suivi pour l'autre agent

Mettre à jour un document de suivi daté, sans remplir le vault d'entrées d'activité :

```markdown
### Ticket : ID — titre

- Statut : TODO / EN COURS / LIVRÉ TECHNIQUEMENT / EN ATTENTE TERRAIN / VALIDÉ / BLOQUÉ
- Priorité et phase :
- Hypothèse ou problème :
- Source avant modification :
- Changement livré et fichiers :
- Vérification : environnement, version, procédure, résultat
- Preuve : lien vers PR/rapport/artefact expurgé
- Dépendance humaine/externe : détenteur et action nécessaire
- Prochaine action concrète :
- Décision : poursuivre / corriger / observer / reporter / arrêter
```

Ne pas cocher un pilote, un renouvellement, Search Console ou une intégration fournisseur sur la
base de la seule présence du code. À chaque point d'avancement, résumer ce qui est livré, ce qui
est prouvé, ce qui reste inconnu et l'action indépendante à poursuivre.

## 19. Sources externes et portée des observations

Informations vérifiées ou discutées au **13 octobre 2026** ; reconsulter les sources avant
publication d'un comparatif ou arbitrage dépendant d'une offre actuelle.

- [Zenchef — tarifs, options et quotas](https://www.zenchef.com/fr/formules) : prix total à comparer
  avec les limites, options et conditions, pas seulement le prix de base.
- [Zenchef — AI Concierge](https://help.zenchef.com/hc/fr/articles/32270919614493-AI-Concierge-de-Zenchef-Aper%C3%A7u-et-configuration) : fonctions annoncées ; pas une preuve de qualité comparative avec Suppernote.
- [TheFork Manager — offre](https://www.theforkmanager.com/fr/logiciel-restauration-prix) : automatisation
  téléphonique annoncée ; disponibilité et périmètre exacts à vérifier avant comparaison détaillée.
- [Google — sitemaps](https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap).
- [Google — noindex](https://developers.google.com/search/docs/crawling-indexing/block-indexing).
- [Google — fonctionnalités IA](https://developers.google.com/search/docs/appearance/ai-features).
- [Google — mises à jour, suppression FAQ](https://developers.google.com/search/updates).
- [Search Console — rapport de performances](https://support.google.com/webmasters/answer/7576553?hl=fr).
- [Next.js 15 — configuration de segment](https://nextjs.org/docs/15/app/api-reference/file-conventions/route-segment-config).

## 20. Instruction de démarrage à copier à l'agent

> Travaillez sur `docs/runbooks/seo-acquisition-execution-plan.md`. Lisez d'abord l'état courant
> dans la section 2 du rapport growth ; reprenez uniquement les points non qualifiés. Avancez les chantiers
> indépendants de démonstration, parcours de demande, mesure et SEO. Réutilisez l'existant et
> préservez les changements locaux. Livrez des modifications vérifiées et des preuves, avec
> les PR/déploiements selon AGENTS.md. Préparez les supports terrain et rendez explicites les
> interventions nécessaires de Hamza sans inventer entretiens, accords, paiements ni renouvellements.
> Distinguez simulation publique et recette interne. Consolidez l’accueil existant, sans modifier son UI, dès que ses textes
> sont exacts, son exemple isolé s'il est présenté et sa demande de démo fonctionnelle. Ne bloquez
> pas ce travail sur VOICE-01, le nombre d'entretiens ou un renouvellement.
> Suivez ensuite les deux pilotes, la validation commerciale et les phases d'expansion selon leurs
> critères. Continuez les tâches indépendantes lorsqu'une étape attend un retour externe.
