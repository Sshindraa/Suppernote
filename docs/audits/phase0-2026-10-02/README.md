# Suppernote — référence visuelle phase 0

Cette série fige l’interface locale **après les corrections de fiabilité de phase 1**, avant les retouches des phases 2 à 5. Elle permet une comparaison visuelle honnête avec ces prochaines phases ; elle ne représente pas l’état antérieur à la phase 1. Les noms, réservations, tables et réponses API sont fictifs. Aucune base ni service client n’a été modifié.

## Reproduction

Lancer le dashboard local avec `NEXT_PUBLIC_DEMO_RESTAURANT_ID=e2e-demo-restaurant NEXT_PUBLIC_DEMO_STAGING=true pnpm --dir apps/dashboard dev --port 3100`, puis `node apps/dashboard/scripts/capture-ui-phase0.mjs` depuis la racine. Le script accepte `UI_CAPTURE_BASE_URL` pour un autre port local. Les requêtes `/api/proxy/**` sont interceptées ; une requête non prévue est inscrite dans [manifest.json](/Users/hamza/Projects/Sokar/docs/audits/phase0-2026-10-02/manifest.json), et les captures ne doivent pas être considérées propres tant que cette liste n’est pas vide.

Playwright Chromium utilise l’heure fixe du **2 octobre 2026 à 20 h 15, Europe/Paris** ; la variante Salle après minuit fixe le **3 octobre à 00 h 15**. Les trois formats sont 1440 × 1000, 1024 × 768 et 390 × 844, zoom et défilement au départ, animations coupées. Chaque capture attend un contenu métier reconnaissable. La photographie de restaurant provient de l’URL d’image déjà employée par le widget ; son chargement reste dépendant du CDN. Le manifeste contient route, scénario, état et dimensions. Le badge de diagnostic Next du serveur de développement est masqué dans les captures.

## Neuf vues principales

| Écran                                     | Desktop                                        | iPad                                        | Téléphone                                     |
| ----------------------------------------- | ---------------------------------------------- | ------------------------------------------- | --------------------------------------------- |
| Salle, une recommandation                 | [Voir](salle-desktop-une-recommandation.png)   | [Voir](salle-ipad-une-recommandation.png)   | [Voir](salle-mobile-une-recommandation.png)   |
| Réservations, six dossiers                | [Voir](reservations-desktop-liste-remplie.png) | [Voir](reservations-ipad-liste-remplie.png) | [Voir](reservations-mobile-liste-remplie.png) |
| Widget, créneau 20 h 30 repris de Connect | [Voir](widget-desktop-creneau-selectionne.png) | [Voir](widget-ipad-creneau-selectionne.png) | [Voir](widget-mobile-creneau-selectionne.png) |

Vues complémentaires : [Salle avec trois recommandations](salle-mobile-trois-recommandations.png), [Salle après minuit](salle-desktop-apres-minuit.png), [Réservations en chargement](reservations-desktop-chargement.png), [liste vide](reservations-desktop-liste-vide.png), [erreur](reservations-mobile-erreur.png), [widget étape coordonnées desktop](widget-desktop-coordonnees.png) et [mobile](widget-mobile-coordonnees.png), [créneau demandé indisponible](widget-mobile-creneau-indisponible.png), [jour complet](widget-mobile-jour-complet.png).

## Relevé de départ

- **Salle.** À 1440 px, la seule recommandation occupe le coin gauche d’un panneau large d’environ 1 300 px ; le reste est vide. Le plan commence vers 380 px du haut. Sur téléphone, le panneau finit vers 380 px et le plan débute vers 530 px : il reste visible, mais les tables les plus basses et les commandes de service sont proches de la navigation fixe. Avec trois recommandations, le plan descend davantage. Préserver le plan reconnaissable et les formes des tables ; diminuer la hauteur perdue sans cacher une urgence utile.
- **Réservations.** Sur desktop, les six lignes tiennent au premier écran, mais l’heure est derrière le nom et la colonne téléphone vide prend de la largeur. Sur téléphone, les fonds des actions de glissement sont visibles sans geste et recouvrent statut, couverts et revenu. Plusieurs actions visuellement présentes ne sont pas pertinentes pour tous les états. C’est le premier défaut à corriger en phase 2/4 ; le statut et l’action possible doivent être identifiables sans glisser.
- **Widget.** Le créneau demandé par Connect est bien sélectionné après disponibilité et reste visible dans le récapitulatif. Sur téléphone, la photo et le grand bloc de récapitulatif poussent le bouton principal sous le premier écran de 844 px, malgré l’affichage des horaires. La sélection noire est lisible ; conserver cette netteté. La variante indisponible explique le changement, et le jour complet a un état distinct. Dans le héros desktop, le sous-titre sombre manque de contraste sur la photo.

Ces observations concernent des captures du navigateur local avec fixtures. Elles indiquent quoi comparer, sans conclure au comportement de données réelles ni à l’état de production.
