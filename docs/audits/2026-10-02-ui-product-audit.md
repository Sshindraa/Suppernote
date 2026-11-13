# Audit UI et produit Suppernote — 2 octobre 2026

## Diagnostic

Suppernote possède déjà une identité identifiable : palette ivoire/charbon/champagne, verre, capsules, navigation compacte, cartes arrondies et séparation Copilot/Salle. L’impression d’interface générée vient surtout de la répétition des traitements, d’une hiérarchie parfois trop uniforme, de textes génériques et de finitions fonctionnelles inégales.

**Périmètre corrigé à la demande de l’utilisateur : conserver l’UI actuelle et l’améliorer.** Garder son identité, son shell, ses espaces, ses composants et ses habitudes d’interaction. Les recommandations portent sur le dosage des effets, la lisibilité, la cohérence, les actions et la fiabilité des écrans existants.

La proposition initiale de nouvelle architecture et la maquette alternative sont écartées. Aucun changement applicatif ni déploiement n’a été réalisé dans cet audit.

Déclinaison opérationnelle : [plan d’action détaillé et rendus attendus par phase](/Users/hamza/Projects/Sokar/docs/audits/2026-10-02-ui-action-plan.md).

**Première passe retenue : Salle, Réservations et widget canonique.** Fiabiliser les données présentées, terminer les actions déjà présentes et améliorer leur lisibilité. Les constats concernant les autres pages restent dans le backlog de l’audit ; ils ne sont pas inclus dans cette passe. Les nouveaux parcours — liste d’attente avec rappel, configuration guidée, fiche complète de traitement d’appel — sont différés. Recherche, nouveaux filtres et création ne sont pas ajoutés à cette passe au seul motif de leur absence.

La cohérence doit porter sur les règles typographiques, les composants et les états, avec une densité adaptée à chaque usage. Le Pilotage sert à comprendre une tendance ; la Salle à agir vite ; Réservations à comparer les dossiers ; le widget à choisir et confirmer sans hésitation.

## Méthode et limites

- Inspection du code courant, modifications locales non commitées incluses ; le workspace contient d’autres travaux en cours.
- Observation navigateur locale du Pilotage, de Réservations, de la Salle en direct, de la page commerciale et de sa démonstration, de la page restaurant Connect et du widget canonique de réservation.
- Observation du dashboard à 1440 × 1000, du Service à 390 × 844 et du rendu initial à largeur tablette. Les autres pages ont été examinées dans le code ; leur apparence complète n’a pas été validée visuellement.
- Lecture des sources officielles publiques des concurrents. Aucun test de leurs applications privées ; les fonctionnalités citées sont annoncées/documentées par leurs éditeurs.
- Aucun appel téléphonique, réservation, paiement ou message client envoyé. Aucun concept alternatif ne fait partie du livrable retenu.

Point de périmètre important : en production, Nginx envoie `/book/[slug]` au dashboard, qui le réécrit vers son widget. Le 404 observé sur le serveur Connect local isolé ne prouve donc pas un défaut de production. Le widget Connect existe aussi, mais ses défauts ne doivent pas être attribués au widget canonique.

Preuves : [routage Nginx](/Users/hamza/Projects/Sokar/infra/nginx/sokar.conf:209), [middleware dashboard](/Users/hamza/Projects/Sokar/apps/dashboard/src/middleware.ts:39).

## Ce qui produit l’impression d’« AI slop »

### 1. Une matière visuelle omniprésente

Le fond du dashboard, les panneaux, la navigation et les boutons cumulent transparence, halos, ombres, gradients et bordures. Ces traitements se répètent sans indiquer une différence de fonction. Sur le Service mobile, la recommandation occupe une grande partie du premier écran avant que l’équipe puisse voir la salle.

**Conserver :** effet de verre, palette, capsules, rayons et composition générale. Le verre est une signature que l’on peut mieux doser.

**Ajuster localement :** travailler la différence d’intensité entre surfaces. Garder une navigation expressive, calmer les cartes de lecture et rendre la sélection immédiatement identifiable par contraste, contour et libellé. Sur les cartes denses, augmenter l’opacité et éviter l’addition d’une ombre externe, d’un reflet interne et d’un halo. Comparer ce dosage dans Salle, Réservations et le widget avant de modifier le fond global ou les styles partagés. Atténuer tous les effets de la même manière ferait perdre du caractère sans nécessairement améliorer la hiérarchie.

Preuves : [styles de carte](/Users/hamza/Projects/Sokar/apps/dashboard/src/app/globals.css:193), [navigation en verre](/Users/hamza/Projects/Sokar/apps/dashboard/src/app/globals.css:1193), [fond du shell](/Users/hamza/Projects/Sokar/apps/dashboard/src/app/dashboard/_layout-client.tsx:877).

### 2. Une navigation dessinée pour sa silhouette

Le rail desktop cache les textes et place les destinations derrière des icônes. La capsule Copilot / Salle / Companion constitue une seconde architecture. Entrer dans Salle remplace la navigation ; le retour vers les autres tâches demande de retrouver le bon espace. Companion « bientôt » occupe durablement le chrome sans parcours utile.

**Améliorer en gardant la structure :** renforcer l’état actif du groupe et de la page, donner des infobulles cohérentes aux icônes au survol et au focus, garder le nom du groupe bien visible dans chaque panneau, uniformiser largeur et espacement des sous-menus. Conserver Copilot et Salle ; rendre leur rôle plus clair avec des aides courtes. Atténuer Companion « bientôt » pour qu’il ne concurrence pas les espaces utilisables. Harmoniser les libellés desktop/mobile.

Preuves : [groupes](/Users/hamza/Projects/Sokar/apps/dashboard/src/app/dashboard/_layout-client.tsx:96), [rail](/Users/hamza/Projects/Sokar/apps/dashboard/src/app/dashboard/_layout-client.tsx:178), [changement d’espace](/Users/hamza/Projects/Sokar/apps/dashboard/src/app/dashboard/_layout-client.tsx:403), [Companion](/Users/hamza/Projects/Sokar/apps/dashboard/src/app/dashboard/_layout-client.tsx:490).

### 3. Une identité neutre qui neutralise aussi les états

`success` et `info` partagent exactement le même champagne dans le thème sombre ; `warning` reste voisin. La palette est cohérente comme matière de marque, mais ne distingue pas assez les situations opérationnelles.

**Modifier localement :** mieux différencier les statuts par libellé, icône et contraste, à partir des tokens existants. Garder le champagne pour les éléments de marque. Vérifier d’abord qu’une sélection et un statut se comprennent sans leur seule couleur. Une évolution de la palette sémantique commune reste une décision ultérieure, après validation des trois écrans dans les deux thèmes.

Preuve : [tokens](/Users/hamza/Projects/Sokar/apps/dashboard/src/app/globals.css:94).

### 4. Une communication qui pourrait appartenir à presque n’importe quel outil IA

Le hero « L’IA devient le nouveau levier de la restauration » exprime une tendance, pas une situation vécue ni une preuve. La démonstration parle d’« Admirez », de « console » et affiche des décors `SYS_OK`, `01_HMI_TUNER`, `METRIC_CARD`. La conversation est scriptée en boucle alors que le texte annonce le temps réel. Les chiffres de démonstration ne constituent pas des résultats clients mesurés.

**Enlever :** vocabulaire pseudo-technique décoratif, injonction à admirer, promesses abstraites, chiffres sans statut de démonstration, liens sociaux sans destination réelle.

**Modifier :** montrer un scénario vérifiable : appel reçu pendant le service → réservation créée → demande particulière transmise → équipe prête à accueillir. Une voix doit s’écouter ; la démonstration doit indiquer clairement ce qui est enregistré, simulé ou réellement interactif.

Proposition de titre : **« Vos appels pris en charge. Votre service sous contrôle. »** Sous-titre : « Suppernote réunit les réservations, les demandes téléphoniques et le contexte client pour préparer chaque accueil. » À ajuster au périmètre effectivement disponible.

Le bouton « Réserver une démo » pointe vers l’inscription : aligner la destination et la promesse. Les liens Confidentialité et Mentions légales du footer pointent vers `#` : leur donner de vraies destinations. Il s’agit ici d’un constat de navigation, pas d’une qualification juridique.

Preuves : [hero et CTA](/Users/hamza/Projects/Sokar/apps/dashboard/src/app/page.tsx:173), [décors de démo](/Users/hamza/Projects/Sokar/apps/dashboard/src/app/DemoSection.tsx:185), [conversation scriptée](/Users/hamza/Projects/Sokar/apps/dashboard/src/app/DemoSection.tsx:337), [texte temps réel](/Users/hamza/Projects/Sokar/apps/dashboard/src/app/DemoSection.tsx:380), [footer](/Users/hamza/Projects/Sokar/apps/dashboard/src/app/page.tsx:353).

## Priorités de la première passe

**Aucun P0 n’est établi par cet audit.** P0 désigne ici un parcours principal complètement bloqué, une action erronée grave ou une perte de données avérée. P1 concerne la fiabilité et la capacité à accomplir une action existante ; P2 concerne la lisibilité et la finition. Un défaut de contraste, de focus ou de mise en page devient P1 lorsqu’il empêche effectivement une action essentielle.

| Priorité               | Constat et niveau de preuve                                                                                                                                                                                                                                                                | Résultat attendu                                                                                                                                                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1 — premier correctif | **Urgence périmée.** Observé dans la Salle : plus de 14 000 minutes de retard pour un dossier ancien, alors que le plan affiche le 2 octobre. Le code sélectionne des réservations confirmées antérieures au seuil sans borne inférieure ; les expirations calculées ne sont pas filtrées. | Borner la recherche selon la règle métier de validité des retards ; exclure les recommandations expirées avant tri et limitation. Tester le service traversant minuit. Aucun nouvel espace « À régulariser ».                    |
| P1 — premier correctif | **Présélection perdue entre Connect et le widget.** Vérifié dans le code : le lien transmet `date`, `time` et `partySize`, mais le widget initialise ses propres valeurs.                                                                                                                  | Lire et valider les paramètres, conserver date et groupe valides, puis vérifier l’horaire dans les disponibilités réelles. Expliquer un horaire devenu indisponible sans changer silencieusement le choix.                       |
| P1                     | **Capacités différentes selon le support dans Réservations.** Vérifié dans le code : actions mobiles Confirmer / Annuler / Retirer indépendantes de l’état ; pas d’Installer / Terminer dans la liste mobile.                                                                              | Réutiliser les transitions existantes avec une action principale adaptée à l’état et les mêmes capacités essentielles aux trois formats. Garder les actions destructives secondaires.                                            |
| P1                     | **Promesse de disponibilité non vérifiée.** Vérifié dans le widget : les badges de jours et la « Prochaine disponibilité » sont déduits des heures d’ouverture.                                                                                                                            | Employer un libellé d’ouverture lorsque seule l’ouverture est connue ; réserver la promesse de place à une réponse de disponibilité vérifiée. Aucun nouveau moteur de recherche multijour.                                       |
| P2                     | **Informations et surfaces en concurrence.** Observé : recommandations très hautes sur téléphone, effets répétés, informations secondaires dominantes dans la liste.                                                                                                                       | Compacter les recommandations, calmer les cartes de lecture, renforcer heure / client / couverts / statut et rendre la sélection nette, sans déplacer les grandes zones. Vérifier les états et les formats avant généralisation. |

Pour les recommandations, la borne temporelle et le filtre d’expiration corrigent deux défauts distincts : limiter la recherche ne dispense pas de filtrer chaque résultat expiré. La règle doit tenir compte du fuseau du restaurant et des services après minuit ; une coupure arbitraire à minuit ne suffit pas.

## Constats conservés hors de cette première passe

Ces points restent utiles pour les lots suivants. Leur présence dans l’audit ne vaut pas décision de développer une fonctionnalité supplémentaire.

| Écran                                     | Constat et suite à qualifier                                                                                                                                                                                                                          |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Réservations                              | Liste historique sans recherche, date/service ni création dans cet écran ; le backend ignore le `limit=100` envoyé. Qualifier séparément la volumétrie, l’ordre et le contrat de pagination. Définir ensuite l’utilité des nouveaux outils d’en-tête. |
| Pilotage / démonstration                  | Mélange observé de KPI de démonstration et de données du restaurant, avec des périodes différentes. Clarifier les sources et les périodes dans une passe dédiée ; la gravité dépend du contexte d’exposition.                                         |
| Clients                                   | Le bouton mobile « Appeler » ouvre un dialogue informatif. Raccorder une action existante ou rendre le libellé fidèle lors de la revue de cet écran.                                                                                                  |
| CRM / Réglages / Partenaires / Réputation | Clés JSON, identifiants fournisseur, détails de diagnostic ou UUID dans des surfaces client. Nettoyer les libellés et qualifier les champs réellement nécessaires. Une configuration guidée constitue un chantier distinct.                           |
| Appels                                    | Journal avec opérateur télécom et transcription tronquée. Revoir sa lisibilité ; une fiche complète de traitement, des filtres et des liens supplémentaires demandent un périmètre produit séparé.                                                    |
| Accessibilité transversale                | Viewport tentant d’interdire le zoom, labels de réglages non associés et gestion du focus du menu mobile à vérifier. Traiter immédiatement ce qui bloque les trois parcours retenus ; examiner les autres surfaces lors de leur passe.                |

Preuves principales : [retards](/Users/hamza/Projects/Sokar/apps/api/src/modules/floor-plan/service-copilot.service.ts:395), [tri sans filtrage d’expiration](/Users/hamza/Projects/Sokar/apps/api/src/modules/floor-plan/service-copilot.service.ts:214), [appel widget](/Users/hamza/Projects/Sokar/apps/dashboard/src/app/dashboard/ServiceCopilotWidget.tsx:210), [réservations](/Users/hamza/Projects/Sokar/apps/dashboard/src/app/dashboard/reservations/page.tsx:99), [service historique](/Users/hamza/Projects/Sokar/apps/api/src/modules/reservations/reservation.service.ts:924), [action Clients](/Users/hamza/Projects/Sokar/apps/dashboard/src/app/dashboard/customers/page.tsx:145), [préférences CRM](/Users/hamza/Projects/Sokar/apps/dashboard/src/app/dashboard/customers/crm/[id]/page.tsx:868), [Partenaires](/Users/hamza/Projects/Sokar/apps/dashboard/src/app/dashboard/distribution/page.tsx:396), [assistant dans Réglages](/Users/hamza/Projects/Sokar/apps/dashboard/src/app/dashboard/settings/page.tsx:988), [Appels](/Users/hamza/Projects/Sokar/apps/dashboard/src/app/dashboard/calls/page.tsx:230), [zoom](/Users/hamza/Projects/Sokar/apps/dashboard/src/app/layout.tsx:14).

## Réservation publique : distinguer les deux widgets

Le widget canonique possède déjà des éléments à conserver : deux étapes, dates françaises, actualisation des horaires après changement de date ou de groupe, téléphone français normalisé, récapitulatif et ajout au calendrier. Sa palette est plus proche d’un produit d’hospitalité que le hero commercial.

Les améliorations prioritaires du **widget canonique dashboard** :

1. **Ne pas appeler disponibilité une simple ouverture.** Les badges des jours et `nextAvailability` sont déduits des horaires d’ouverture ; la capacité n’est interrogée que pour le jour sélectionné. Le texte « Prochaine disponibilité » peut donc promettre une place non vérifiée. Afficher « Prochain jour d’ouverture » tant que la disponibilité n’est pas confirmée. Une synthèse multijour des places sort de cette passe.
2. **Respecter le lien d’entrée.** Connect fabrique des liens contenant date, heure et taille du groupe ; le widget canonique ne lit pas ces paramètres pour initialiser ses sélections. Préserver le choix d’un créneau depuis la page restaurant, puis le revérifier.
3. **Préserver l’identité réelle de l’établissement.** Une photo générique et « Terrasse » sont utilisés en fallback. Remplacer un contenu non renseigné par un état sobre ; ne pas présenter une terrasse ou une décoration inconnue comme un attribut du restaurant.
4. **Mieux équilibrer la composition existante.** Garder le hero photo et le panneau en verre. Réduire les vignettes d’ambiance redondantes, mieux contraster les labels, régler la hauteur du hero pour faire remonter les créneaux et vérifier que le bouton de bas de panneau ne masque aucun horaire aux différentes tailles d’écran.
5. **Rendre l’état complet exact et utilisable.** Expliquer l’absence de créneau pour les critères courants et permettre de modifier la date ou le groupe avec les contrôles existants. Liste d’attente, rappel et recherche automatique d’alternatives sont différés.

Preuves : [rafraîchissement réel du jour](/Users/hamza/Projects/Sokar/apps/dashboard/src/app/widget/[restaurantId]/page.tsx:370), [prochaine ouverture](/Users/hamza/Projects/Sokar/apps/dashboard/src/app/widget/[restaurantId]/page.tsx:409), [badges des jours](/Users/hamza/Projects/Sokar/apps/dashboard/src/app/widget/[restaurantId]/page.tsx:1100), [initialisation](/Users/hamza/Projects/Sokar/apps/dashboard/src/app/widget/[restaurantId]/page.tsx:184), [fallback Terrasse](/Users/hamza/Projects/Sokar/apps/dashboard/src/app/widget/[restaurantId]/page.tsx:992), [lien d’entrée Connect](/Users/hamza/Projects/Sokar/apps/connect/src/app/restaurant/[slug]/page.tsx:350).

Le **widget Connect**, examiné dans le code, a des problèmes distincts : recherche manuelle, téléphone international exigé, absence d’alternatives dès le complet, attribution technique visible hors embed et grille pouvant rester affichée après changement de critères. Ils doivent être qualifiés dans les canaux qui utilisent encore ce composant ; ils ne décrivent pas le parcours canonique observé.

Preuves : [widget Connect](/Users/hamza/Projects/Sokar/apps/connect/src/components/booking-widget.tsx:751), [attribution](/Users/hamza/Projects/Sokar/apps/connect/src/components/booking-widget.tsx:837), [grille](/Users/hamza/Projects/Sokar/apps/connect/src/components/booking/slot-grid.tsx:11).

## Finition locale des trois écrans retenus

| Écran conservé    | Ajustements recommandés                                                                                                                                                                                                                                                                                                                                                |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Salle Live**    | Garder plan, formes des tables, onglets, sélecteurs et espace Salle. Compacter les recommandations, particulièrement sur téléphone ; donner plus de hauteur utile au plan. Vérifier les statuts tronqués sur les tables rondes. Raccorder les actions aux destinations déjà disponibles et aligner leur libellé sur ce qu’elles ouvrent, sans créer de nouvelle fiche. |
| **Réservations**  | Garder tableau, cartes mobiles et onglets. Renforcer visuellement heure, nom, couverts et statut ; reléguer téléphone et revenu estimé. Donner des actions adaptées à l’état et rendre la suppression secondaire. Conserver une densité permettant de comparer les lignes.                                                                                             |
| **Widget public** | Garder hero, palette, panneau et deux étapes. Ajuster la hauteur du hero pour rapprocher les choix utiles ; calmer les reflets derrière les labels ; garder davantage d’espace entre les contrôles. Fiabiliser les disponibilités et préserver la présélection venant de Connect.                                                                                      |

Le verre garde trois rôles : **navigation expressive, lecture calme, sélection visible**. Le Pilotage pourra conserver davantage d’air pour lire les tendances ; Salle restera plus dense ; le widget espacera les choix. Les mêmes composants n’imposent pas les mêmes marges ni les mêmes hauteurs de section.

## Pistes pour les autres écrans — backlog

| Écran conservé    | Ajustements recommandés                                                                                                                                                                                                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Pilotage**      | Garder les KPI et graphiques. Réduire la hauteur du bloc Jours creux ; rendre ses lignes plus compactes et ses actions plus précises. Uniformiser les espacements entre en-tête, filtres et cartes. Mieux distinguer séries graphiques et périodes.                                              |
| **Appels**        | Garder la liste actuelle. Faire ressortir motif et résultat ; harmoniser lecteur audio, boutons et badges. Qualifier séparément l’ajout d’un détail complet et des fonctions de suivi.                                                                                                           |
| **Clients / CRM** | Garder listes et fiches. Remplacer les préférences en JSON par des champs métier à l’intérieur des formulaires actuels. Séparer visuellement préférence durable, demande de visite et note de l’équipe. Donner des actions qui réalisent effectivement leur libellé.                             |
| **Offres**        | Garder le panneau textuel actuel, les trois catégories et le sélecteur de création. Uniformiser les en-têtes, alignements, filtres, états vides et libellés de création entre expériences, événements et cartes cadeaux. Faire remonter uniquement les blocages qui empêchent l’action courante. |
| **Réglages**      | Garder l’organisation présente et améliorer les ancres, titres et retours d’enregistrement. Pour la voix, afficher un nom et un aperçu sonore à la place d’un identifiant fournisseur dans le formulaire ordinaire.                                                                              |
| **Marketing**     | Garder la composition, le thème sombre et les sections. Rendre les titres plus concrets ; enlever les faux labels techniques ; préciser le statut de la démo ; corriger les liens et destinations des boutons.                                                                                   |

La page Offres courante redirige vers Expériences ; partir de cet état, et non de l’ancienne vue d’ensemble décrite dans certaines entrées du Journal.

Les règles communes concernent l’échelle de titres, les boutons à fonction comparable, les rayons par famille, le vocabulaire et les états actifs. Les espacements et la densité varient selon l’usage de l’écran. Conserver les polices actuelles et utiliser des chiffres tabulaires pour les colonnes d’heures, de couverts et de montants. Ne généraliser un ajustement de style qu’après l’avoir validé localement.

Sur iPad et téléphone, vérifier chaque correction dans son état réel : textes longs, erreur, chargement, absence de données et beaucoup de lignes. Les opérations essentielles doivent rester visibles et utilisables au toucher. Autoriser le zoom et vérifier le focus clavier.

Le plan Live possède déjà attribution, installation/libération et gestion des retards : améliorer la lisibilité et la continuité de ces fonctions dans leurs panneaux actuels. Le simulateur conserve son indication explicite de lecture seule.

Preuves : [actions Live](/Users/hamza/Projects/Sokar/apps/dashboard/src/app/dashboard/floor-plan/_components/FloorPlanCanvas.tsx:7120), [simulateur](/Users/hamza/Projects/Sokar/apps/dashboard/src/app/dashboard/floor-plan/_components/ServiceCopilotSimulator.tsx:424).

## Positionnement face aux concurrents

**L’IA téléphonique seule ne constitue plus un avantage distinctif.** SevenRooms annonce une Voice AI intégrée aux réservations et au CRM, avec transfert humain et résumé. Zenchef annonce AI Call et la catégorisation des notes clients. OpenTable propose des intégrations Voice AI. Sources : [SevenRooms](https://sevenrooms.com/platform/VoiceAI/), [Zenchef](https://www.zenchef.com/solution/ai-solutions-for-restaurants), [OpenTable](https://www.opentable.com/restaurant-solutions/products/reservation-management/voice-ai/).

SevenRooms met l’accent sur le contexte client et le lien entre opérations et relation ; Zenchef organise son produit autour de la réservation, du paiement, de la communication, de la promotion et de l’analyse ; OpenTable propose des outils de service et un accès à son réseau de clients. Leurs surfaces publiques montrent ces capacités, sans démontrer ici leur fiabilité ou leur rapidité réelle. Sources : [SevenRooms CRM](https://sevenrooms.com/platform/crm/), [organisation Zenchef](https://blog.zenchef.com/blog-post/new-zenchef-five-products), [OpenTable Table Management](https://www.opentable.com/restaurant-solutions/products/table-management/).

Zenchef a lui-même expliqué sa nouvelle organisation en cinq produits par les difficultés de repérage et les clics remontés par les utilisateurs. Pour cet audit, la leçon à retenir est de mesurer le repérage et les gestes dans la navigation Suppernote existante. [Annonce Zenchef du 15 septembre 2026](https://blog.zenchef.com/blog-post/new-zenchef-five-products).

L’ambition crédible pour Suppernote : gagner d’abord sur **la vitesse, la continuité et la confiance dans un service réel en français**. Un meilleur écran ne remplace pas le réseau de clients d’OpenTable, ni la profondeur CRM de SevenRooms. Ces dimensions demandent un travail produit et commercial distinct.

## Ordre de travail recommandé

1. **Référence reproductible.** Fixer données, heure et états ; relever les comportements actuels et réaliser les captures de référence des trois écrans aux trois formats ci-dessous.
2. **Deux correctifs de confiance.** Borner les retards et filtrer les expirations ; respecter la présélection Connect en la revérifiant. Vérifier ces règles avant toute retouche visuelle.
3. **Actions existantes.** Corriger les transitions proposées selon le statut et le support, les retours d’erreur et les libellés de disponibilité. Aucun nouveau parcours.
4. **Finition locale.** Ajuster hiérarchie, densité et intensité des surfaces dans Salle, Réservations et le widget. Comparer les mêmes états avant/après ; garder le shell et les grandes zones.
5. **Décision de généralisation.** Étendre aux styles communs uniquement les réglages validés, après contrôle des autres pages. Les nouvelles fonctionnalités et le backlog restent séparés.

## Protocole de validation avant/après — à exécuter

Ce protocole prépare la passe corrective. **Il n’a pas été exécuté dans cet audit ; aucune série complète de captures avant/après ni aucun gain mesuré n’est revendiqué.**

Utiliser des données locales fictives et une horloge de référence au **2 octobre 2026, 20 h 15, Europe/Paris**. Prévoir une variante à **00 h 15 le 3 octobre** pour le service traversant minuit. Le navigateur et le serveur doivent partager la même référence temporelle.

Rejouer chaque scénario à **1440 × 1000 (desktop), 1024 × 768 (iPad paysage) et 390 × 844 (téléphone)**. Ces dimensions servent aux comparaisons ; elles ne remplacent pas un essai tactile sur un iPad réel. Garder identiques données, heure, thème, niveau de zoom, défilement, sélection et panneau ouvert entre les captures. Pour les surfaces retouchées, contrôler aussi l’autre thème, le focus clavier et le zoom.

| Scénario                                            | Données et parcours fixes                                                                                                                                | Critères d’acceptation                                                                                                                                                                                                                 |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1. Salle : retard actuel et dossiers anciens**    | Réservations confirmées à 19 h 50 le jour courant, la veille et douze jours avant ; recommandation déjà expirée ; variante de service après minuit.      | Aucun dossier historique présenté comme urgence actuelle ; aucune recommandation expirée. Un retard encore valide reste visible. La borne suit la règle métier et le fuseau, y compris après minuit.                                   |
| **2. Salle : action et retour au plan**             | Groupe de quatre, nom fictif long, table ronde sélectionnée. Ouvrir une action existante, la terminer puis revenir au plan.                              | Destination conforme au libellé, résultat visible, sélection compréhensible. Plan accessible sans traverser une grande pile de recommandations. Statut lisible et identifiable sans sa seule couleur. Aucun nouveau panneau requis.    |
| **3. Réservations : actions selon le statut**       | Un dossier pour chaque état déjà pris en charge : attente, confirmé, installé, terminé, annulé et absent. Rejouer les transitions autorisées existantes. | Même capacité essentielle aux trois formats ; aucune action incompatible avec l’état. Statut et actions se mettent à jour ensemble. Suppression secondaire et confirmation existante conservée.                                        |
| **4. Réservations : lecture, erreur et reprise**    | Liste assez longue pour défiler, noms longs, notes et couverts variés. Échec contrôlé d’une action, nouvelle tentative ; états vide et chargement.       | Heure, client, couverts et statut repérables ; aucun chevauchement. Aucun succès apparent après échec. Contexte conservé pour réessayer ; chargement distinct de l’absence de données.                                                 |
| **5. Widget : présélection Connect**                | Entrée avec une date future fixe, 20 h 30 et quatre couverts. Rejouer avec horaire devenu indisponible, date passée et paramètres invalides.             | Date et groupe valides conservés ; horaire sélectionné seulement après vérification. Choix indisponible expliqué ; paramètres invalides traités sans erreur ni sélection d’un horaire non vérifié.                                     |
| **6. Widget : deux étapes, retour et confirmation** | Choisir un créneau, saisir des coordonnées fictives, revenir modifier groupe puis date. Tester succès simulé, jour complet et erreur réseau.             | Ancien créneau invalidé ou revérifié à chaque changement. Aucune confirmation sans succès serveur. Champs conservés lors des retours et erreurs lorsque pertinent. Contrôles et bouton accessibles, sans masquage par un panneau fixe. |

Les cas de règles métier nécessitent des vérifications ciblées ; les corrections visuelles se jugent sur les captures et les parcours. Consigner pour chaque scénario : résultat avant, résultat après, anomalie restante et liens vers les captures. Ne pas confondre une capture correcte avec une action réellement achevée.

Après cette vérification, une séance avec cinq personnes peut comparer les mêmes tâches dans l’interface actuelle et sa version affinée. Mesurer temps médian, erreurs, hésitations et capacité à reprendre après interruption. Le critère est de **reconnaître immédiatement Suppernote, lire plus vite, hésiter moins et voir chaque action aboutir**. Les gains restent à mesurer.
