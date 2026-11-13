# Livraison groupée — accueil Suppernote

15 octobre 2026. **Livré en staging et production, recette publique exécutée avec réserves (§10.30).**
Le texte de préparation ci-dessous est historique ; Hamza a ensuite autorisé la livraison par « ok go ».
Aucune publication autorisée par cette préparation. Aucun commit, index Git, push, PR, merge,
déploiement ou contact commercial effectué par cette préparation. Sources applicatives conservées telles que vérifiées
aux §10.26–10.27 du [rapport growth](2026-10-13-growth-execution.md).

## Base et séparation du lot

- Checkout : `feat/onboarding-v2-equipe-roles`, HEAD initial `d62f7d65c818e25a5dd79987e6846a0d491ae612`, puis HEAD final
  `0f4151b1a6c8750c115e48b64cc50f94c0e2c4ff` après un commit concurrent des six sources SEO.
  Ce commit n’a pas été effectué par cette préparation ; contenus inchangés par empreinte.
- Cible : `main`, référence locale `origin/main` et tête distante lue via `git ls-remote` concordantes :
  `54d18e0bedbb05998a2df4dabee01540942ce9b9` (#439).
- Avant ce commit concurrent, la branche contient cinq commits absents de main (dont deux merges), soit 72 fichiers de
  différences commitées : onboarding/équipe/provisioning et adaptateurs/bancs voix. **Ne pas soumettre
  cette branche ni la prendre comme base de la branche SEO.** Aucun de ces commits n’est nécessaire
  au lot. Ne pas les cherry-pick, stasher, déplacer ou réinitialiser.
- Les six sources/tests applicatifs du manifeste avaient la même base dans le HEAD initial et main ;
  ils sont désormais committés dans `0f4151b1` sur la branche mélangée, toujours absents de main.
  Le delta total final de cette branche contre main couvre 78 chemins et six commits (deux merges inclus). Les autres
  documents suivis ont aussi la même base, sauf Context et Journal : sélection partielle ci-dessous.
- #439 est déjà dans main : ne pas rejouer sa roadmap ni son entrée Journal. Le delta restant reprend
  seulement les changements postérieurs. Les métadonnées métier, l’isolation initiale des simulations,
  le sitemap/filtrage des fixtures et la page Tarifs sont déjà dans la cible.
- Index Git vide au contrôle. Fichier local modifié hors lot : `docs/runbooks/environment.md`
  (configuration voix). Il reste exclu, avec tous les travaux onboarding/voix committés ou locaux.

## Manifeste exact contre main

Le nombre est calculé sur le delta actuel : **14 chemins**, dont **2 nouveaux documents** et
**2 documents partagés à sélectionner partiellement**. Il ne faut pas copier aveuglément tous les
fichiers locaux. Les supports METRIC-01/ICP-01 ci-dessous restent documentaires, sans nouvel outil,
envoi ni activation client.

| Chemin                                                                             | Sélection future et objet                                                                                                                                                                          |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/dashboard/src/app/page.tsx`                                                  | Delta entier : seul href Confidentialité, `#` → `/privacy`.                                                                                                                                        |
| `apps/dashboard/src/app/DemoSection.tsx`                                           | Delta entier : simulation et réglages explicités, libellés fictifs, aria-labels ; mêmes composants/styles.                                                                                         |
| `apps/dashboard/src/app/DemoSection.test.tsx`                                      | Delta entier : scénario sans requête ni média.                                                                                                                                                     |
| `apps/dashboard/src/app/constants.ts`                                              | Delta entier : scénario fictif et sept réponses FAQ ; catalogue, calculs et FAQ tarifaire inchangés.                                                                                               |
| `apps/dashboard/src/app/solutions/assistant-telephonique-restaurant/page.tsx`      | Delta entier : redirection permanente vers `/`, plus de landing autonome.                                                                                                                          |
| `apps/dashboard/src/app/solutions/assistant-telephonique-restaurant/page.test.tsx` | Delta entier : redirection/canonical/noindex de l’ancienne route.                                                                                                                                  |
| `docs/audits/2026-10-13-growth-execution.md`                                       | Delta entier : état courant et historique daté, dont §10.26–10.28.                                                                                                                                 |
| `docs/audits/2026-10-15-growth-final-review.md`                                    | Nouveau : présent manifeste/procédure, remplace les anciens comptes 17/13/14.                                                                                                                      |
| `docs/obsidian/Context.md`                                                         | Partiel : trois lignes TODO SEO, Démo, Croissance ; conserver la ligne onboarding de main dans le futur checkout SEO.                                                                              |
| `docs/obsidian/Journal.md`                                                         | Partiel : ajouts SEO/croissance post-HEAD, dont cette préparation ; exclure les deux sections locales ElevenLabs et les entrées onboarding/voix déjà commitées uniquement sur la branche actuelle. |
| `docs/runbooks/commercial-follow-up.md`                                            | Nouveau : suivi manuel et limites d’attribution, sans donnée prospect réelle.                                                                                                                      |
| `docs/runbooks/essential-pilot-7-day.md`                                           | Delta entier : conditions de recette et preuve d’encaissement, pas de changement produit/facturation.                                                                                              |
| `docs/runbooks/restaurant-discovery-interview.md`                                  | Delta entier : préparation ICP-01/France entière, aucun démarchage exécuté par ce lot.                                                                                                             |
| `docs/runbooks/seo-acquisition-execution-plan.md`                                  | Delta entier post-#439 : accueil prioritaire et suivi minimal.                                                                                                                                     |

Les sections locales Journal exclues sont exactement « Prototype adaptateur ElevenLabs Text to
Dialogue (drapeau désactivé) » et « Branchement de l’adaptateur ElevenLabs dans le tour de parole
(drapeau désactivé) ». Elles restent intactes dans le checkout actuel. Les autres nouvelles entrées
SEO/croissance, y compris les états historiques ensuite remplacés, sont conservées.

`pricing/page.tsx`, `PricingSection.tsx`, `FaqSection.tsx`, `marketing-metadata.ts`, sitemap Connect
et catalogue partagé ne sont pas au manifeste : leur diff contre main est vide. Aucun fichier
API, schéma/migration, configuration auth, fournisseur, Nginx/DNS/Cloudflare ou lockfile sélectionné.

## Résultat confirmé et réserves

Accueil = page commerciale principale ; hero, disposition, composants, classes et animations
conservés. Sept questions FAQ existantes ; démo explicitement fictive, sans audio ni effet métier.
Ancienne route : 308 vers `/`, absente du sitemap et des liens internes applicatifs (recherche hors
tests ; mentions historiques dans les documents autorisées). Confidentialité → `/privacy`.
Prix, calculs, catalogue, abonnements et CTA démo/tarifs conservés.

| Lien restant                       | Rôle et qualification                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Mentions Légales → `#`             | Information légale attendue, accès actuellement inopérant ; sujet de conformité à qualifier avec des informations/destination réelles. Ce rapport ne valide pas la conformité juridique publique. Ce défaut préexistant ne casse ni l’indexabilité ni le CTA ; aucune raison technique SEO démontrée d’empêcher la correction groupée. Si la validation juridique est une condition de publication décidée par Hamza, elle doit être satisfaite avant cette étape. |
| Twitter, Facebook, Instagram → `#` | Liens facultatifs du footer ; à remplacer uniquement par des profils réellement confirmés. Pas de blocage fonctionnel du parcours démo ni du SEO identifié.                                                                                                                                                                                                                                                                                                        |

`/privacy` est effectivement routé vers Connect ; la page dashboard homonyme contient des champs
à remplir et ne prouve pas le contenu public. Exhaustivité de la politique à qualifier séparément.
Aucun lien inventé. Aucune réserve transformée en garantie de conformité ou de performance publique.

## Contrôles acquis, versions et limites

- §10.25 (preuve antérieure) : dashboard 692 tests, Connect 141 ; recette responsive et redirection.
- §10.26 (preuve antérieure ciblée) : Vitest 4.1.5, dashboard 10 tests/3 fichiers puis Connect sitemap
  6 tests ; typecheck dashboard, ESLint des deux sources corrigées, Prettier et diff-check réussis.
  Accueil 200/HTML initial/canonical/robots/OG/Twitter ; Connect distinct avec API mock ; trois formats
  1440×900, 390×844, 768×1024 sans débordement. Mock ≠ inventaire API réel.
- §10.27 : build final Next 15.5.21 avec typecheck réussi, Node 22.23.2 et pnpm 10.33.3 ; serveur
  production local 200, HTML corrigé et ancienne route 308. Configuration Clerk de test déjà locale,
  transmise aux seuls processus temporaires, jamais recopiée dans les documents.
- Lighthouse 13.5.0 : desktop première visite 97/LCP 1,2 s ; mobile première visite 79/LCP 5,0 s ;
  profil mobile conservé 100/LCP 0,8 s ; CLS 0. Diagnostic détaillé §10.28 : H1 LCP, polices locales,
  temps observés distincts des estimations simulées et cache/auth confondus. Aucune trace Chrome brute
  séparée conservée ; les rapports contiennent les audits dérivés. Aucun gain applicatif déduit.
- Cette préparation : comparaison main/HEAD/diff, lecture des deux nouveaux documents, contrôle des
  liens applicatifs, diagnostic des rapports existants, empreintes, cohérence et applicabilité du
  patch documentaire/source préparé hors Git. Aucune suite acquise ni Lighthouse relancés sans
  modification source. Seuls les deux rapports et cette préparation dans le Journal ont été modifiés ;
  les 81 autres fichiers du relevé initial sont inchangés par empreinte. Le build acquis était sur la branche actuelle : la future branche isolée
  doit passer sa propre CI, même si les six bases applicatives coïncident avec main.

## Dépendances de build

Utiliser `packageManager` du dépôt : **pnpm 10.33.3** (AGENTS mentionne encore 10.8), Node >=20 <23
(local vérifié 22.23.2), `pnpm install --frozen-lockfile` et compilations des paquets workspace
nécessaires selon CI/Turbo. `@suppernote/shared` fournit catalogue/utilitaires ; aucun changement de
version ou paquet supplémentaire. Polices locales, pas de téléchargement Google Fonts requis.
Clerk : variables habituelles de chaque environnement présentes avant build, notamment
`NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, clé secrète seulement via l’environnement prévu. Ne jamais
injecter le test local dans une release publique. `NEXT_PUBLIC_*` sont figées au build ; vérifier
`NEXT_PUBLIC_SITE_URL` et les URL publiques selon le runbook, sans afficher de valeurs sensibles.
Connect sitemap n’appelle pas l’API au build ; la recette runtime requiert les sources API existantes
et `SITE_URL` cohérent. Aucun nouveau fournisseur, migration ni activation de drapeau voix.

## Procédure future — à exécuter seulement après autorisation

1. Relire l’état Git/IDE et la tête distante de main. Créer un checkout isolé propre, branche
   `codex/seo-accueil`, depuis main actualisée ; conserver intégralement le checkout actuel.
   Revalider le delta si main a avancé : ne jamais appliquer un paquet périmé à l’aveugle.
2. Transférer le seul patch du manifeste (sélection par sections Context/Journal). Vérifier son
   application, le diff contre main, les nouveaux fichiers et les empreintes des six sources déjà
   testées. Aucun commit onboarding/voix ni `environment.md`. Examiner la sélection explicite ;
   indexer uniquement les 14 chemins retenus dans ce checkout propre, jamais `git add .` sur l’actuel.
3. Contrôles proportionnés aux éventuelles différences nouvelles et hooks requis ; commit sur la
   branche de travail. Puis **`pnpm pr:submit`** depuis ce checkout propre. Le script refuse un arbre
   sale, pousse, crée/réutilise la PR et active le squash auto-merge : cet appel a un effet de
   publication et n’est pas exécuté dans cette préparation.
4. Suivre CI PR puis CI main, vérifier le SHA fusionné. Staging automatique après CI verte,
   smoke tests bloquants du même SHA ; recette ci-dessous. Production suit automatiquement le
   workflow staging réussi, sous les autorisations/protections applicables. Ne pas supposer qu’une
   pause manuelle existe entre staging et production. Toute autorisation future doit tenir compte
   de cette chaîne ; ne pas lancer `pr:submit` sous une autorisation limitée à préparer une PR.
5. Archiver références PR/runs/SHA, preuves des recettes et snapshot/retour arrière. Si le SHA change
   ou qu’un check échoue, traiter la cause dans ce seul périmètre ; ne pas contourner les protections.

## Snapshot et retour arrière futurs

Préparation locale consultable hors Git : `sokar-home-seo/delivery/` dans les visualisations du
15 octobre, contenant `seo-home-only.patch`, `selection.json` (base et empreintes) et `verification.json` (contrôles). Ce paquet n’est ni une release ni un
snapshot serveur. Régénérer/vérifier ses empreintes si les documents changent avant sélection.

Avant chaque promotion, relever la release saine active, son SHA et son `META`, et conserver les
liens CI/staging/health checks. Le script de déploiement prend les snapshots pré/post build dans
`/opt/sokar-staging/releases/<horodatage>/` et `/opt/sokar/releases/<horodatage>/` avec fichier `META`
(timestamp, label, date, git_hash, git_branch). Artefacts : API dist, dashboard/Connect `.next` et
public, packages config/database/shared dist. Aucune sauvegarde ni release distante vérifiée ou
créée pendant cette préparation ; horodatage de rollback à enregistrer au moment de la livraison.

Retour arrière applicatif futur, via le compte deploy et la procédure existante : depuis
`/opt/sokar-staging`, `bash scripts/deploy.sh --env staging rollback <release-saine>` ; depuis
`/opt/sokar`, `bash scripts/deploy.sh --env prod --confirm-production rollback <release-saine>`.
Choisir la release effectivement enregistrée, ne pas inventer un horodatage. Relancer les health
checks et la recette concernée après restauration. Le rollback restaure les artefacts, pas les
données, l’environnement, Nginx ou DNS ; aucune option `--with-db-rollback` pour ce lot sans migration.
Voir [rollback](../runbooks/rollback.md). Rien de cela n’est lancé maintenant.

## Recette après publication — checklist non exécutée

À appliquer **staging puis production**, sur le SHA livré et derrière le vrai routage public :

- [ ] Accueil HTTP 200 ; H1/texte/FAQ/métadonnées dans le HTML initial ; canonical et robots attendus
      pour l’environnement (production indexable ; staging conserve ses protections d’indexation).
- [ ] Ancienne landing en 308 vers `/`, pas de boucle ni contenu autonome ; absence de ses liens.
- [ ] `/sitemap.xml` servi par Connect, accueil présent, pas de landing ; API réelle disponible,
      fixtures explicitement exclues et pages transactionnelles hors sitemap/noindex selon leurs
      règles. Distinguer une vraie fiche publiée d’une fixture, sans filtre arbitraire de nom.
- [ ] `/privacy` fonctionnel dans le routage réel ; CTA démo et tarifs navigables, choix/cadence
      conservés. Ne pas envoyer de demande réelle ni déclencher de paiement pour cette recette
      sans autorisation spécifique ; vérifier les états de formulaire avec les mocks existants.
- [ ] Desktop/mobile/iPad : UI, animations, FAQ et simulation conservées, absence de débordement,
      erreurs console et affichage du montant/CTA sans régression.
- [ ] Performance : première visite et profil conservé distincts, paramètres/versions/profil/cache
      notés ; identifier l’instance auth réellement déployée sans lire ni exporter les secrets.
      Relever chaînes de redirections, document, ressources critiques et élément LCP ; collecter
      trace et réseau si nécessaire. Ne pas attribuer à Clerk ce que les traces ne séparent pas.
      Laboratoire distinct des données terrain CrUX/GSC si disponibles, aucune garantie de score.
- [ ] Search Console : inspection accueil, accès Google/canonical déclarée et choisie observés
      séparément ; indexabilité ≠ indexation effective. Lire le sitemap existant, actualiser/soumettre
      uniquement si nécessaire dans le cadre autorisé. Aucun délai ni classement garanti.

## Autorisation attendue

Hamza doit autoriser explicitement **la livraison groupée de ce manifeste depuis une branche propre
issue de main : commit, `pnpm pr:submit`, squash auto-merge après CI, staging/smoke puis production
selon la chaîne existante, avec recette et retour arrière applicatif si nécessaire**. Cette
préparation ne vaut pas cette autorisation. Aucun nouveau démarchage, appel fournisseur, paiement
ou fonctionnalité n’est inclus.

## Résultat final observé après publication

#438 avait déjà intégré les six fichiers applicatifs ; #440 a livré les huit documents restants depuis une branche propre. Fusion 629f857d, CI main/staging/production et smoke tests verts ; production active confirmée. HTTP/HTML/canonical/robots/308/sitemap/privacy/CTA et trois formats contrôlés. Lighthouse public : desktop 100/LCP 0,6 s ; mobile premier passage 92/LCP 3,3 s ; profil conservé 100/LCP 1,0 s ; CLS 0. Google test actif 15/10 13:03 réussi, canonical racine ; index enregistré du 6 octobre distinct de cette version. Sitemap existant réussi, aucune nouvelle soumission.

Mentions légales/social sans destination, indexabilité de l’accueil staging et préchargement RSC /privacy via démo restent des réserves ; navigation privacy classique vérifiée fonctionnelle. Détails, runs, snapshots/rollback et preuves au rapport growth §10.30. Résultats ajoutés localement après publication, sans nouvelle livraison de documentation ni modification applicative.
