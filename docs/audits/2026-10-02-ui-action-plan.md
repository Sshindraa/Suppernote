# Suppernote — plan d’action UI, première passe

Date : 2 octobre 2026. Statut : phases 0 à 4 réalisées ; les retouches visuelles de phase 5 ont été annulées à la demande de l’utilisateur et le widget a retrouvé l’apparence de phase 2. Vérifications locales phase 6 terminées ; PR et staging en attente d’un lot isolé.

Suivi du 2 octobre : les retards sont bornés à la fenêtre métier de 60 minutes et les recommandations expirées sont exclues avant classement. Le widget reprend les critères de Connect et ne sélectionne l’heure qu’après vérification ; il explique la disparition du créneau. Tests API (15), tests widget (19), contrôles de types API/dashboard et parcours `/book` sur desktop/iPad/téléphone réussis avec l’heure encodée dans l’URL. Le lien avec `:` littéral est reproduit dans les captures locales de phase 0. Les références et leurs constats sont dans [la planche phase 0](/Users/hamza/Projects/Sokar/docs/audits/phase0-2026-10-02/README.md).

Suivi du 3 octobre : matrice des actions par état dans Réservations, avec la même prochaine action sur tableau et cartes mobiles ; état en cours, confirmation de l’annulation et retour serveur conservé. Copilot sépare panne et réponse vide, et le widget sépare ouverture, disponibilité vérifiée, complet et erreur avec nouvel essai. Le faux « Retirer » a été supprimé : `DELETE /reservations/:id` clôture la ligne en `CANCELLED` et la laisse dans l’historique, donc une suppression visuelle serait trompeuse. [Captures comparatives phase 2](/Users/hamza/Projects/Sokar/docs/audits/phase2-2026-10-03/README.md).

Suivi du 3 octobre, phase 3 : panneau de recommandations compact uniquement dans Salle, lecture des tables recentrée sur nom/capacité/statut et sélection indépendante de la couleur d’état. Le clic sur une réservation déplaçable ouvre les actions de sa table. [Captures comparatives phase 3](/Users/hamza/Projects/Sokar/docs/audits/phase3-2026-10-03/README.md).

Suivi du 3 octobre, phase 4 : priorité visuelle à l’heure, puis client, couverts, statut et table ; téléphone intégré sous le nom et revenu estimé replié sur iPad. La liste mobile reprend cette hiérarchie en gardant l’action principale visible. [Captures comparatives phase 4](/Users/hamza/Projects/Sokar/docs/audits/phase4-2026-10-03/README.md).

Suivi du 3 octobre, phase 5 : la première finition visuelle a été annulée après retour utilisateur. Le widget conserve maintenant l’apparence de la référence phase 2, notamment la mini-photo, les cartes secondaires, les capsules et les espacements antérieurs ; les corrections fonctionnelles restent en place. Les captures de la variante phase 5 sont conservées comme archives et ne décrivent plus l’UI courante : [note de restauration](/Users/hamza/Projects/Sokar/docs/audits/phase5-2026-10-03/README.md).

Suivi du 3 octobre, phase 6 : les six scénarios et les captures des phases 0/2/3/4/5 ont été consolidés dans [le rapport de validation](/Users/hamza/Projects/Sokar/docs/audits/phase6-2026-10-03/README.md). Après restauration de phase 5, tests widget 21/21 et typecheck passent ; la capture Playwright n’a pas été refaite car le serveur local préexistant ne répondait pas. Playwright Salle/widget antérieur : 19 réussis, 11 ignorés par sélecteur de format. Le smoke distingue désormais un jour « ouvert » d’un créneau vérifié et le parcours retour/modification/confirmation est couvert. La suite dashboard complète a aussi révélé sept échecs hors de ces écrans, dans les chantiers Cartes cadeaux et Expériences. Aucun PR ni staging : le checkout courant est `main` avec de nombreux changements non liés ; les essais matériel réel, zoom et utilisateurs restent à faire.

Référence : [audit UI et produit](/Users/hamza/Projects/Sokar/docs/audits/2026-10-02-ui-product-audit.md).

## Objectif et périmètre

Conserver l’identité de Suppernote et rendre trois parcours existants plus fiables et plus lisibles : Salle, Réservations et widget canonique du dashboard. Chaque phase produit un résultat visible ou vérifiable avant la suivante.

Conserver palette ivoire/charbon/champagne, polices, verre, capsules, shell, navigation Copilot/Salle, plan et formes des tables, tableau et cartes mobiles, widget à deux étapes. La finition suit trois rôles : **navigation expressive, cartes de lecture calmes, sélection nette**. La densité reste propre à chaque usage.

Les corrections de confiance et d’action sont P1 ; la finition est P2. Aucun P0 n’a été établi. Liste d’attente avec rappel, configuration guidée, fiche complète d’appel, nouveaux outils de recherche/création et refonte globale restent hors de cette passe. L’onglet de file d’attente déjà présent est conservé et contrôlé contre les régressions.

## Vue d’ensemble

| Phase | Travail                                 | Rendu attendu                                                                                          | Preuve de sortie                                                         |
| ----- | --------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| 0     | Références reproductibles               | Les trois écrans actuels avec de vraies situations de travail, au même instant et aux mêmes dimensions | Captures « avant », données de référence et relevé des défauts           |
| 1     | Recommandations et présélection fiables | Une urgence actuelle dans Salle ; le choix Connect retrouvé dans le widget                             | Tests des règles et scénarios 1/5                                        |
| 2     | Actions et états cohérents              | Boutons adaptés à l’état ; résultat ou erreur explicite ; disponibilité annoncée avec précision        | Scénarios 2/3/4/6 et parité des capacités                                |
| 3     | Finition Salle                          | Plan plus accessible, recommandations compactes, tables et sélection lisibles                          | Comparaison Salle aux trois formats                                      |
| 4     | Finition Réservations                   | Lecture immédiate heure → client → couverts → statut, actions bien hiérarchisées                       | Comparaison liste et cartes aux trois formats                            |
| 5     | Finition widget                         | Identité du restaurant conservée, choix de réservation plus visibles, sélection évidente               | Comparaison des deux étapes aux trois formats                            |
| 6     | Validation et livraison                 | Une version cohérente des trois écrans et une preuve claire de chaque amélioration                     | Planche avant/après, six scénarios, contrôles ciblés et écarts résiduels |

Ordre : 0 → 1 → 2 → 3 → 4 → 5 → 6. Les deux correctifs de phase 1 peuvent être développés en parallèle ; les choix visuels sont évalués écran par écran pour éviter de généraliser trop tôt un mauvais dosage.

## Phase 0 — Établir le rendu de référence

### Actions

1. Relever les modifications locales déjà présentes et isoler le périmètre de cette passe. Le shell, les traductions et `globals.css` contiennent notamment d’autres travaux en cours.
2. Préparer les six scénarios de l’audit avec données fictives locales, photos stables et réponses déterministes. Aucun peuplement d’une base distante.
3. Fixer l’horloge au 2 octobre 2026, 20 h 15, Europe/Paris ; ajouter une variante au 3 octobre, 00 h 15. Fixer aussi l’horloge côté API lorsque le scénario teste le temps métier.
4. Produire les captures à 1440 × 1000, 1024 × 768 et 390 × 844, avec mêmes thème, zoom, défilement, sélection et panneau ouvert.
5. Attendre un contenu métier précis avant chaque capture : réservation témoin visible, table chargée ou créneaux effectivement reçus. Capturer séparément chargement, absence de données et erreur.
6. Relever les défauts constatés et les indicateurs de référence : place visible du plan, longueur de défilement jusqu’aux horaires, informations repérables, actions disponibles par état.

### Rendu à obtenir

Une planche de référence avec neuf vues principales : trois écrans × trois formats. Ajouter les vues nécessaires des panneaux, de la deuxième étape du widget et des états particuliers. Chaque image indique route, scénario, dimensions et état ; une capture vide ne représente pas le parcours rempli.

### Validation de sortie

Chaque scénario est reproductible. On peut expliquer ce qui devra changer sur sa capture et ce qui sert de repère visuel à préserver. Les données de référence restent séparées des données client.

**Attention aux tests existants :** les profils Playwright utilisent notamment 1440 × 900 et iPad Mini, différents des dimensions retenues ici. Utiliser des dimensions explicites pour la série d’audit ; conserver les profils existants pour les contrôles de non-régression. La suite visuelle actuelle ne couvre ni Salle ni le widget canonique ; sa vue Réservations attend surtout le titre et un délai. Elle ne remplace pas ces références.

Sources : [suite visuelle](/Users/hamza/Projects/Sokar/apps/dashboard/e2e/visual-regression.spec.ts), [configuration Playwright](/Users/hamza/Projects/Sokar/apps/dashboard/playwright.config.ts).

## Phase 1 — Corriger les deux défauts de confiance

### 1A. Salle : recommandations encore pertinentes

- Borner les réservations candidates selon la fenêtre métier existante. Le code définit déjà un seuil de retard de 15 minutes et une expiration à 60 minutes après le début : conserver ces règles pour ce correctif, puis en tester précisément les limites.
- Exclure les recommandations dont l’expiration est atteinte avant de trier et de retenir les trois premières. Une réservation ancienne ne doit pas évincer une action actuelle.
- Tester le passage à minuit sans coupure arbitraire au début du jour civil.
- Vérifier l’accord entre le contexte affiché et la portée des recommandations. Si elles concernent le service en cours alors que la date du plan change, l’interface doit le rendre explicite ou ne pas les présenter comme des recommandations pour cette autre date. Ne pas inventer ici un moteur de recommandations historiques.

**Rendu attendu :** même panneau, mêmes cartes, mais uniquement des actions encore valides. Le retard fictif de plusieurs milliers de minutes disparaît ; un groupe réellement en retard reste visible. L’absence d’action valide allège l’écran selon son état vide existant.

**Validation :** retard valide, seuil exact, expiration exacte, ancienne réservation, exclusion avant limite de trois, passage à minuit et maintien des autres catégories valides. Aucun changement du format public des réponses.

Fichiers : [service](/Users/hamza/Projects/Sokar/apps/api/src/modules/floor-plan/service-copilot.service.ts), [tests du service](/Users/hamza/Projects/Sokar/apps/api/src/modules/floor-plan/__tests__/service-copilot.service.test.ts), [affichage](/Users/hamza/Projects/Sokar/apps/dashboard/src/app/dashboard/ServiceCopilotWidget.tsx).

### 1B. Widget : conserver le choix effectué dans Connect

- Lire `date`, `time` et `partySize` ; valider format, plage de réservation existante et taille du groupe prise en charge.
- Initialiser date et groupe valides après résolution du restaurant, sans les écraser ensuite avec « aujourd’hui / 2 personnes ».
- Vérifier l’horaire demandé dans la réponse de disponibilité correspondant exactement à cette date et ce groupe.
- Conserver les choix encore valides si l’horaire n’est plus disponible. Afficher un message précis, par exemple : « Le créneau de 20 h 30 n’est plus disponible. Choisissez un autre horaire. »
- Éviter qu’une réponse ancienne ou lente réapplique la présélection après une modification manuelle de l’utilisateur.
- Traiter les paramètres absents ou invalides avec les valeurs de repli habituelles, sans sélectionner un horaire non vérifié.

**Rendu attendu :** en arrivant depuis Connect pour quatre personnes à 20 h 30, le widget affiche quatre personnes, la bonne date et, après vérification, la capsule 20 h 30 sélectionnée. Si elle n’est plus disponible, date et groupe restent en place ; un message apparaît près des horaires et le bouton de continuation attend un choix valide.

**Validation :** paramètres valides/invalides, date passée, horaire indisponible, réponse lente et changement rapide du groupe. Vérifier le parcours public `/book/...` réécrit vers le widget canonique, en plus de son accès direct.

Fichiers : [widget canonique](/Users/hamza/Projects/Sokar/apps/dashboard/src/app/widget/[restaurantId]/page.tsx), [tests](/Users/hamza/Projects/Sokar/apps/dashboard/src/app/widget/[restaurantId]/page.test.tsx), [lien Connect](/Users/hamza/Projects/Sokar/apps/connect/src/app/restaurant/[slug]/page.tsx). Le lien Connect ne nécessite une modification que si le contrat vérifié l’exige.

## Phase 2 — Terminer les actions et distinguer les états

### Actions

1. Établir la matrice état → actions autorisées à partir des règles API actuelles. Utiliser la même matrice pour tableau et cartes mobiles, avec des présentations adaptées.
2. Mettre en avant la prochaine action utile : confirmer une attente, attribuer une table lorsque nécessaire, installer une réservation éligible, terminer un service installé. Garder les actions secondaires et destructives moins dominantes.
3. Respecter les préconditions métier : une installation exige notamment une table et un créneau encore valide. Afficher la raison d’une action indisponible lorsqu’elle aide l’équipe à avancer.
4. Montrer un état en cours sur l’action concernée ; éviter les doubles soumissions ; afficher le résultat après réponse du serveur et conserver le contexte en cas d’échec.
5. Distinguer chargement, zéro recommandation et échec de chargement. Le composant Copilot assimile aujourd’hui une erreur à « Copilot opérationnel / Aucune action à traiter » dans sa variante avec état calme : supprimer cette fausse assurance avec un état indisponible discret.
6. Aligner les libellés des recommandations sur leur destination réelle. Réutiliser un accès direct existant s’il existe ; sinon annoncer honnêtement l’ouverture de la liste. Aucune nouvelle fiche n’est nécessaire pour terminer ce lot.
7. Dans le widget, employer « ouvert / fermé » ou « prochain jour d’ouverture » quand seule l’ouverture est connue. Réserver « disponible / complet » à ce que la réponse API permet réellement d’affirmer pour les critères choisis, y compris dans les noms accessibles.

### Rendu à obtenir

Sur une réservation, le statut et la prochaine action se comprennent ensemble. Le téléphone donne les mêmes capacités essentielles que le desktop. Pendant une mutation, le bouton indique qu’elle est en cours ; après un échec, l’ancien état reste visible avec un message utile. L’annulation reste accessible avec confirmation et conserve la ligne en état `CANCELLED` ; le contrat API actuel ne fournit pas de suppression physique.

Dans Salle, « aucune action » signifie une réponse vide valide. Un échec de chargement n’affiche pas un signal de réussite. Dans le widget, les jours ouverts ne promettent plus automatiquement une place.

### Validation de sortie

Rejouer les états `PENDING`, `CONFIRMED`, `SEATED`, `HONORED`, `CANCELLED`, `NO_SHOW`, ainsi que les états terminaux techniques lorsqu’ils sont reçus. Tester erreurs de mutation, reprise et parité mobile/desktop. Contrôler que l’onglet de file d’attente actuel fonctionne toujours.

**Point d’implémentation :** `state` et le `status` historique ne sont pas interchangeables. Le PATCH historique accepte quatre statuts ; `HONORED` n’en fait pas partie. Réutiliser la route de transition existante déjà appelée par le plan de salle pour installer/terminer, sans élargir artificiellement l’ancien enum ni modifier le schéma. La réponse serveur reste la référence.

Fichiers : [page Réservations](/Users/hamza/Projects/Sokar/apps/dashboard/src/app/dashboard/reservations/page.tsx), [tests de la page](/Users/hamza/Projects/Sokar/apps/dashboard/src/app/dashboard/reservations/page.test.tsx), [projection des états](/Users/hamza/Projects/Sokar/apps/api/src/shared/reservations/reservation-state.ts), [cycle de vie](/Users/hamza/Projects/Sokar/apps/api/src/modules/reservations/reservation-lifecycle.service.ts), [actions du plan](/Users/hamza/Projects/Sokar/apps/dashboard/src/app/dashboard/floor-plan/_components/FloorPlanCanvas.tsx).

## Phase 3 — Affiner Salle

### Actions visuelles

- Réduire les répétitions dans chaque recommandation : une situation, son contexte utile et son action ; éviter de répéter le même retard dans titre, raison et métrique.
- Réduire les marges imbriquées du panneau et des cartes, en préservant les cibles tactiles et la taille des textes utiles. Garder les zones dans leur ordre actuel.
- Atténuer les ombres et reflets derrière les textes denses. Conserver une navigation expressive ; différencier le plan et ses outils sans ajouter de nouveaux halos.
- Rendre la table sélectionnée reconnaissable indépendamment de son statut. Préserver formes, placement, zoom et interactions actuelles.
- Vérifier les tables rondes : numéro ou nom de table prioritaire, capacité et statut lisibles ; nom client long accessible dans le panneau existant plutôt que tassé dans la forme.
- Corriger les collisions des contrôles de date, service et plan aux dimensions étroites.

### Rendu à obtenir

**Desktop :** le plan reste le centre de travail. Les recommandations occupent une bande plus compacte ; leur action se repère sans que chaque carte attire autant l’œil que la sélection.

**iPad :** date, outils et table sélectionnée sont utilisables au toucher ; la zone de plan conserve une hauteur utile. Les libellés restent lisibles sans réduire toute l’interface.

**Téléphone :** dans le scénario avec une recommandation, les premières tables deviennent visibles dès l’ouverture si la hauteur des commandes le permet. Avec trois recommandations, le défilement pour atteindre le plan diminue par rapport à la référence ; aucun texte essentiel n’est coupé pour atteindre cet objectif. Pas d’accordéon ou de nouvelle navigation ajouté par défaut.

### Validation de sortie

Comparer zéro, une et trois recommandations, une table sélectionnée et un nom long. Vérifier attribution, installation et libération existantes ; focus et statut compréhensibles sans la couleur seule. Le composant de recommandations étant partagé avec Pilotage, garder les réglages de densité locaux à Salle et contrôler son autre usage.

**Livrable :** trois comparaisons principales avant/après Salle et les vues de détail nécessaires, avec indication de l’espace récupéré pour le plan.

## Phase 4 — Affiner Réservations

### Actions visuelles

- Faire ressortir heure, client, couverts et statut ; rapprocher les informations liées dans le tableau existant. Afficher les nombres avec une largeur régulière.
- Garder la date explicite puisque la liste peut contenir de l’historique. Ne pas donner l’impression qu’elle ne concerne que le service courant.
- Réduire le poids du téléphone et du revenu estimé tout en conservant l’information accessible. Le revenu garde son qualificatif « estimé ».
- Appliquer la hiérarchie d’actions de phase 2 au tableau et aux cartes mobiles ; conserver leurs composants et les onglets actuels.
- Calmer la surface du tableau, aligner les colonnes et homogénéiser les espacements internes. L’état actif et le focus restent plus visibles que la décoration de carte.
- Éviter qu’un nom long, un badge ou une action ne repousse les informations essentielles hors écran.

### Rendu à obtenir

**Desktop :** des lignes faciles à parcourir du regard ; heure/client/couverts/statut forment le premier niveau de lecture. Les coordonnées et montants viennent au second. Une seule action utile est mise en avant pour chaque état.

**iPad :** les informations et l’action essentielles restent ensemble ; si un défilement horizontal demeure nécessaire pour les colonnes secondaires, il ne cache pas la prochaine action indispensable.

**Téléphone :** la carte actuelle devient plus opérationnelle : nom, date/heure, groupe, table et statut se lisent avant les coordonnées secondaires. La suppression ne prend plus le même poids qu’une confirmation ou une installation.

### Validation de sortie

Comparer liste courte et longue, noms longs, table absente, statuts différents, chargement, vide et erreur. Vérifier les transitions après les changements visuels. Les tests actuels de la page forcent le mode desktop : couvrir explicitement la branche mobile.

**Livrable :** trois comparaisons principales avant/après et une matrice des actions disponibles selon l’état, identique fonctionnellement sur les trois supports.

## Phase 5 — Affiner le widget canonique

### Actions visuelles

- Conserver la photo principale, le panneau en verre, les capsules de choix et les deux étapes.
- Réduire la hauteur et les répétitions qui repoussent les choix : rappel de date/groupe en double et vignettes d’ambiance redondantes, lorsque leur retrait améliore effectivement la lecture.
- Rendre les fonds derrière les labels plus stables et plus opaques ; réduire le cumul reflet/ombre/bordure sans neutraliser le panneau.
- Renforcer la différence entre choix disponible, choix sélectionné, contrôle inactif et chargement. Le contraste de sélection sert l’action, avec les tokens existants.
- Ajuster les espacements du widget pour garder une lecture accueillante et des contrôles tactiles confortables, distincte de la densité de Salle.
- Pour les informations absentes, utiliser un état sobre : ne pas inventer de terrasse ni représenter une photo générique comme celle de l’établissement.
- Vérifier le bouton de continuation/confirmation, le bas du panneau et le clavier mobile : aucun horaire ni champ ne doit être masqué.

### Rendu à obtenir

**Desktop :** la photo donne le caractère du restaurant ; le panneau donne immédiatement accès au groupe, à la date et aux horaires. L’œil trouve plus facilement la sélection et l’action principale que les vignettes décoratives.

**iPad :** les deux colonnes ou leur adaptation actuelle restent équilibrées ; les textes secondaires sont lisibles et les choix utilisables au toucher.

**Téléphone :** une identité de restaurant concise précède les contrôles. Les créneaux arrivent plus tôt dans le parcours de défilement. Le bouton reste accessible sans recouvrir le dernier horaire ou un champ lorsque le clavier est ouvert.

**Étape 2 :** un récapitulatif clair de date/heure/groupe, les coordonnées et l’action de confirmation. Le retour conserve les champs pertinents et fait revérifier tout créneau affecté par un changement.

### Validation de sortie

Comparer les deux étapes avec un restaurant illustré et un établissement sans contenu optionnel. Rejouer présélection, horaire perdu, jour fermé, absence de place pour les critères, erreur réseau, retour et succès simulé. Contrôler aussi le mode intégré si un style commun à l’embed change ; préserver ses échanges `postMessage`.

**Livrable :** comparaison avant/après des deux étapes aux trois formats, avec exemples des messages d’indisponibilité et des contenus absents.

## Phase 6 — Vérifier, documenter et livrer

**Suivi d’exécution :** validation locale documentée dans [le dossier phase 6](/Users/hamza/Projects/Sokar/docs/audits/phase6-2026-10-03/README.md). La revue est exploitable, mais la livraison externe est différée jusqu’à l’isolation du lot UI et au traitement des échecs de tests hors périmètre.

### Actions

1. Rejouer les six scénarios complets avec les mêmes données et horloges ; noter réussi, échoué ou non exécuté pour chaque cas.
2. Vérifier les états chargement/vide/erreur/données et les contrôles clavier/tactiles des éléments retouchés. Vérifier le zoom et l’autre thème lorsqu’il est pris en charge.
3. Comparer les captures côte à côte. Ne mettre à jour les baselines automatisées qu’après examen des écarts intentionnels.
4. Contrôler les autres usages des composants réellement modifiés, notamment Pilotage et l’embed. Toute modification partagée élargit ses vérifications de manière explicite.
5. Exécuter les tests ciblés et les contrôles de types des applications modifiées ; lint ciblé et CSS si concernés. Les captures ne prouvent pas la réussite des mutations.
6. Produire un bilan indiquant modifications, preuves, limites et points reportés. Préparer des lots lisibles pour revue : fiabilité ; actions ; Salle ; Réservations ; widget.
7. Suivre ensuite le parcours habituel de PR, CI et staging. Un passage staging vérifie l’intégration ; ses données réelles ne sont pas utilisées comme équivalent des fixtures de comparaison.

### Rendu à obtenir

Un dossier de preuve comprenant la planche des trois écrans, les comparaisons de leurs états critiques, la matrice d’actions et les résultats des six scénarios. L’interface conserve immédiatement ses repères ; chaque correction est reliée à un problème observé.

La généralisation de nouveaux dosages de verre ou d’espacement aux styles communs est une décision issue de cette comparaison. Elle ne fait pas partie automatiquement de la livraison de ces trois écrans.

### Critères de réussite

- Aucune recommandation expirée dans les scénarios ; présélection valide conservée et revérifiée.
- Chaque action existante proposée respecte l’état et aboutit à un résultat visible ou à une erreur explicite.
- Même capacité essentielle sur desktop, iPad et téléphone.
- Moins de concurrence visuelle, espace utile augmenté là où mesuré, informations métier mieux repérables.
- Identité Suppernote et navigation immédiatement reconnaissables.
- Les gains de vitesse et d’hésitation sont mesurés lors de sessions utilisateurs ; ils ne sont pas déduits seulement de captures plus propres.

## Vérifications techniques prévues

Commandes existantes vérifiées dans les scripts du dépôt ; à exécuter selon les fichiers effectivement modifiés, au moment des corrections :

```sh
pnpm node:check
pnpm --filter @suppernote/api test src/modules/floor-plan/__tests__/service-copilot.service.test.ts
pnpm --filter @suppernote/dashboard test src/app/dashboard/reservations/page.test.tsx
pnpm --filter @suppernote/dashboard test 'src/app/widget/[restaurantId]/page.test.tsx'
pnpm --filter @suppernote/dashboard test src/app/dashboard/floor-plan/_components/FloorPlanCanvas.test.tsx src/app/dashboard/floor-plan/page.test.tsx
pnpm --filter @suppernote/dashboard test:e2e floor-plan.spec.ts widget.spec.ts
pnpm --filter @suppernote/dashboard typecheck
pnpm --filter @suppernote/api typecheck
pnpm lint:css
```

Les tests sont à compléter uniquement pour les comportements corrigés. Les ajustements purement visuels se vérifient par inspection et régression visuelle, sans tests qui recopient des classes CSS.

Le smoke widget actuel vise directement `/widget/chez-sokar-demo` et ne prouve pas la transmission des paramètres depuis `/book/...`. Il faut compléter ce cas. Ses données simulées sont désactivées quand `PLAYWRIGHT_BASE_URL` est défini : distinguer l’essai local déterministe du contrôle d’intégration distant.

Les tests et captures de cette passe n’ont pas été exécutés lors de la rédaction du plan.
