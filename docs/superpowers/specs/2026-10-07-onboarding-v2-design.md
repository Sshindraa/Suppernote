# Onboarding v2 — du produit au restaurateur

Date : 2026-10-07 · Statut : phase 1 livrée en dev, phases 2 et 3 à lancer.

## Pourquoi

L'onboarding était organisé par produit Suppernote (assistant vocal, puis Connect). Le restaurateur raisonne
par résultat : « d'où viennent mes réservations, et mes tables sont-elles justes ? ». Sur les quatre
canaux d'entrée (téléphone, widget et lien Google Maps, assistants IA par MCP, passage sans réservation),
seul le téléphone avait un parcours.

Défaut principal constaté : **aucun canal ne pouvait proposer de créneau après l'onboarding**. La
disponibilité se calcule sur les tables des plans de salle actifs
(`availability-capacity-aware.service.ts`), mais la création d'un restaurant ne crée aucune table et
l'onboarding n'en demandait pas. La « capacité totale » saisie dans Connect ne servait qu'au score Connect.

## Principe

On configure le restaurant une seule fois, puis chaque canal se branche dessus.

| Phase          | Contenu                                                                                                                       | État                       |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| A — Socle      | restaurant, horaires, salle, règles : indispensables à tous les canaux                                                        | **Phase 1, livrée en dev** |
| B — Canaux     | vérifier les disponibilités, préparer le téléphone et la page en ligne, publier Connect, puis distribuer le lien et le widget | Phase 2                    |
| C — Croissance | Stripe (acomptes, cartes cadeaux, expériences) en une seule connexion, puis avis, fidélité, marketing, caisse, événements     | Phase 3                    |

## Phase 1 — ce qui est livré

- **Étape `floor` « Votre salle et vos règles »** : un seul écran pour les tables et les règles.
  Tables : compteurs par taille de table, modèles de départ (petite, moyenne,
  grande salle), autres tailles. `GET/PUT /restaurant/onboarding/floor`. Le service applique un diff par
  taille : une table retirée est supprimée si elle n'a ni réservation, ni blocage, ni combinaison ;
  sinon elle est désactivée. Les nouvelles tables sont rangées en grille sous les existantes.
- **Règles dans le même écran** : durée d'un repas, taille maximale des groupes (≤ plus grande table,
  sinon aucun créneau n'existe pour cette taille), annulation, acompte. L'étape `connect-capacity` est
  supprimée ; plus de champ « capacité totale » (dérivée des tables). Les règles comptent comme
  configurées dès que `serviceDurationMinutes` est enregistré : c'est la clé que la disponibilité lit
  (l'ancienne `serviceDuration`, écrite par l'ancienne étape, n'était lue par rien).
- **Mobile du gérant** : demandé et requis pour valider « Votre restaurant » (alertes de réservation à
  valider, ventes de cartes cadeaux). Normalisé en E.164.
- **`readiness`** : `ready` vrai seulement avec horaires, tables actives et règles. Exposé par
  `GET /restaurant/onboarding`. `PATCH complete floor` sans table → 409 `NO_TABLES`, sans règles → 409 `NO_RULES`, sans réponses pratiques → 409 `NO_PRACTICAL_INFO` ; `PATCH activate` si
  non prêt → 409 `NOT_READY_TO_BOOK`. Bandeau sur le tableau de bord et avertissement avant la
  publication Connect.
- **Compatibilité** : tous les changements d'API sont additifs ; `onboardingDone` couvre désormais 7
  étapes `voice` (au lieu de 5) ; Connect passe à 4 étapes.

### Hors périmètre de la phase 1, volontairement

- `minimumViableDone` exige restaurant, horaires, salle et règles (aucun restaurant réel n'est encore
  onboardé, donc personne n'est enfermé derrière la modale).
- Pas de simulateur de disponibilités ni de test de bout en bout (phase 2).
- Pas de plan de salle graphique dans l'onboarding : l'éditeur existant reste la référence.

## Phase 2a — livrée en dev

Étape `channels` « Vos canaux de réservation », dernière du groupe `voice` :

- simulateur de disponibilités (date préremplie au prochain jour d'ouverture, taille du groupe plafonnée
  par la règle du restaurant) alimenté par l'API de disponibilité réelle ;
- schéma des quatre canaux d'entrée (Téléphone, Réservation en ligne, Assistants IA, Sur place) reliés
  à un seul planning (`ChannelsDiagram`) : chaque canal affiche son état, tiré de l'existant (étape
  `phone`, `connectPublished`, `connectAgentic`), et son connecteur est plein s'il est branché, en
  pointillés sinon ; « Sur place » n'a aucun réglage et reste « Toujours actif » ; le panneau du
  planning résume le socle (tables, couverts) et héberge le simulateur ;
- aucune action sur les cartes : renvoi d'appel, publication et découverte IA restent dans leurs
  étapes ; le lien Google Maps n'est pas suivi tant qu'il n'est pas construit (phase 2b) ;
- lien public et code widget disponibles dans `ConnectActivationStep`, uniquement après publication ;
- réglage de découverte par les assistants IA conservé dans l'étape de publication Connect, à un
  seul endroit ; la gestion « sur place » reste dans les outils d'exploitation ;
- état vide du simulateur limité au résultat de la date et du groupe choisis, sans diagnostic non
  vérifié ;
- bouton « Continuer vers Suppernote Connect » : refusé tant que `readiness.ready` est faux (409
  `NOT_READY_TO_BOOK`). Cette étape vérifie le socle et enchaîne vers Connect ; elle ne publie pas
  la page et ne prétend pas ouvrir tous les canaux.

## Phase 2b — FAQ structurée, livrée en dev (voix d'abord)

Les informations pratiques sont une **section obligatoire de l'étape `floor`** « Votre salle et vos
règles », qui est un parcours guidé en trois sections : Votre salle, Vos règles, En pratique. Une seule
section est ouverte à la fois (jamais de scroll), chacune se résume en une ligne une fois faite,
chaque « Continuer » enregistre sa section, et l'écran s'ouvre sur la première section à compléter.

- Six réponses obligatoires : terrasse, parking, accessibilité, animaux, menu enfant, privatisation.
  Options alimentaires, adresse du menu et précisions libres : « aucune » est une réponse valable.
  Le serveur refuse de valider l'étape sans elles (409 `NO_PRACTICAL_INFO`).
- Stockage : colonne additive `restaurants.practical_info` (JSONB). Terrasse et privatisation restent
  synchronisées avec `ambiance`, dietary réutilise `dietary` : rien n'est ressaisi.
- Voix : bloc « CE QUE TU SAIS DU RESTAURANT » dans le prompt, uniquement pour les restaurants listés dans
  `VOICE_PRACTICAL_INFO_RESTAURANT_IDS`. Sans faits, le prompt est identique octet pour octet.
- À mesurer avant d'élargir : appels avec question pratique (réponse juste, « je ne sais pas » avec
  passage au gérant, aucune invention).
- Pas encore branché : page Connect, widget, MCP.

## Phase 2b — reste à faire

1. Test de bout en bout : réserver via le widget, voir la réservation dans le planning, l'annuler.
2. Téléphone : stratégie de renvoi (tous les appels, si occupé, hors horaires), codes par opérateur, règle
   d'escalade vers le mobile du gérant. Dépend de la décision sur l'attribution automatique du numéro.
3. Site et Google Maps : détection du CMS, lien « Réserver » pour la fiche Google Business Profile,
   QR code, liens Instagram et Facebook.
4. Connect ramené à un seul écran, tout étant déjà pré-rempli par l'import Google.
5. Assistants IA : interrupteur, explication, prompt à copier dans ChatGPT pour constater la présence.
6. Sur place : app iPad, ajout d'un client sans réservation, invitation de l'équipe avec ses rôles.
7. Brancher les faits pratiques sur Connect, le widget et le MCP (la voix les lit déjà).

## Phase 3 — croissance (à écrire)

Checklist contextuelle dans le tableau de bord : Stripe connecté une seule fois (deux comptes séparés
aujourd'hui : `giftCardStripeAccountId` et `experienceStripeAccountId`), cartes cadeaux, puis avis,
fidélité et marketing après environ 50 réservations.

## Décisions ouvertes

1. Numéro de téléphone : attribution automatique via l'API Telnyx, ou manuelle ?
2. Stripe : un seul compte Connect par restaurant ?
3. Qui fait l'onboarding : le propriétaire seul, ou le propriétaire puis son équipe ?

## Mesure

Activation = première vraie réservation, tous canaux confondus, sous 7 jours. L'entonnoir admin
(`onboarding-funnel`) couvre déjà les 11 étapes, `floor` incluse.
