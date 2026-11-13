# Stratégie d'onboarding Suppernote

> **Statut : LIVRÉ / DOCUMENT DE RÉFÉRENCE — vérifié dans le code le 12 septembre 2026.**
> Les cinq actions proposées par la version initiale sont implémentées. Le travail restant porte
> sur la mesure de leur effet et les corrections guidées par ces données. Voir
> [`DOCUMENTATION_STATUS.md`](./DOCUMENTATION_STATUS.md).

## État d'implémentation

| Action                                 | Statut  | Preuve technique                                                                                                              |
| -------------------------------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Aha moment avec appel démo             | `LIVRÉ` | `POST /restaurant/onboarding/demo-call` dans `apps/api/src/modules/restaurants/restaurant.routes.ts` et `DemoCallPlayer.tsx`. |
| Montrer ce que les réponses débloquent | `LIVRÉ` | Trois scénarios sélectionnables : réservation, annulation et question menu ; rendu audio Cartesia ou transcript de repli.     |
| Message du fondateur après la valeur   | `LIVRÉ` | `KnowledgeStep.tsx` affiche le message après `onPlayed`, pas à l'inscription Clerk.                                           |
| Progressive disclosure                 | `LIVRÉ` | `systemPromptExtra` est masqué derrière « Affiner le comportement (optionnel) ».                                              |
| Écran préalable au renvoi d'appel      | `LIVRÉ` | `PhoneStep.tsx` explique le flux, le numéro attribué et la reprise de contrôle avant confirmation.                            |

## Parcours technique actuel

Le parcours est orchestré dans `apps/dashboard/src/features/onboarding/` :

```text
RestaurantStep
  -> HoursStep
  -> FloorStep
       -> salle, règles et informations pratiques
  -> KnowledgeStep
       -> sauvegarde de la personnalité
       -> DemoCallPlayer
       -> POST /api/proxy/restaurant/onboarding/demo-call
       -> audio Cartesia ou transcript fallback
       -> message du fondateur après lecture
  -> PhoneStep
       -> écran préalable
       -> POST /api/proxy/restaurant/onboarding/test-call
       -> confirmation explicite « J'ai reçu l'appel »
       -> PATCH /api/proxy/restaurant/onboarding (action=first_call + callControlId)
  -> ConnectIdentityStep
  -> ConnectLocationStep
  -> ConnectCuisineStep
  -> ConnectActivationStep
       -> aperçu et publication explicite
       -> lien public et code du widget après publication
```

Après les appels, le parcours passe directement à Suppernote Connect : cinq étapes vocales, puis quatre
étapes Connect. La finalisation est la dernière étape (`ConnectActivationStep`), avec aperçu et
publication explicite. La clé historique `channels` reste dans le contrat API et est acquise lorsque
le socle de réservation est prêt ; elle ne correspond plus à une page visible. Ses anciennes URL
ouvrent la présentation Connect. Le lien et le widget sont proposés après publication.
Le réglage `connectAgentic` reste dans `ConnectActivationStep`, son point de configuration unique.

`KnowledgeStep` enregistre `profileType`, `fillerStyle`, `speakingRate` et
`systemPromptExtra`, puis sépare la sauvegarde de la configuration de l'écoute de l'aperçu.
`DemoCallPlayer` appelle le proxy dashboard, qui relaie vers l'API avec `X-Sokar-Site-ID` lorsque
le contexte multi-site est disponible.

L'API accepte un scénario borné par schéma Zod, construit une clé de cache dépendant du restaurant,
du script et de la configuration Cartesia, puis retourne :

- un flux audio lorsque le provider est disponible ;
- un transcript structuré comme repli contrôlé ;
- un événement `onboarding_demo_call_played` pour mesurer l'usage.

La démo ne lance pas un appel Telnyx. Elle évite donc de lier le premier moment de valeur au
provisionnement téléphonique et garde un parcours utilisable en développement ou lorsque le
provider vocal est indisponible.

## Ce qui reste à développer

Le prochain chantier est une boucle de mesure, pas une nouvelle refonte visuelle.

### 1. Funnel d'activation exploitable

Établir un événement versionné pour chaque transition utile :

```text
onboarding_started
restaurant_identity_saved
hours_saved
personality_saved
onboarding_demo_call_requested
onboarding_demo_call_played
onboarding_demo_call_failed
phone_prepermission_confirmed
onboarding_test_call_started
onboarding_test_call_succeeded
connect_published
first_real_call_completed
first_real_reservation_confirmed
```

Chaque événement doit contenir au minimum `restaurantId`, `accountId`, `siteId`, `step`,
`onboardingVersion`, `occurredAt` et un `correlationId`. Ne jamais placer le transcript, un numéro
complet, un email ou du texte libre de consigne dans le payload analytics.

### 2. Métriques de décision

Calculer par cohorte et version d'onboarding :

- taux `personality_saved -> demo_call_played` ;
- délai médian avant première écoute ;
- taux de fallback transcript et taux d'échec provider ;
- taux `demo_call_played -> phone_prepermission_confirmed` ;
- taux `phone_prepermission_confirmed -> test_call_succeeded` ;
- délai jusqu'au premier appel réel et à la première réservation confirmée ;
- abandon par étape et reprise après 24 heures / 7 jours.

Les métriques doivent distinguer les environnements, les restaurants de démonstration et les vrais
comptes. Une lecture agrégée incluant les fixtures donnerait un faux signal d'activation.

### 3. Critères de sortie

Le parcours est commercialement validé lorsque :

1. la télémétrie ne perd pas d'événements entre dashboard et API ;
2. un utilisateur peut reprendre chaque étape après fermeture du navigateur ;
3. l'indisponibilité Cartesia conserve le transcript et n'empêche pas la suite ;
4. l'absence de numéro Telnyx produit une action claire pour l'équipe Suppernote ;
5. les métriques de cohorte permettent d'identifier précisément l'étape d'abandon ;
6. au moins une cohorte de vrais restaurants termine le parcours et réalise un appel réel.

## Décisions produit conservées

- L'utilisateur doit entendre ou lire le comportement de Suppernote avant le test téléphonique réel.
- Le champ de consignes libres reste avancé et optionnel.
- Le renvoi d'appel est précédé d'une explication concrète et réversible.
- Le message du fondateur apparaît après une action de valeur.
- La gamification consumer, un paywall au milieu du wizard et l'ajout d'étapes sans mesure restent
  hors du parcours.

## Entretien du document

Toute modification de l'onboarding doit mettre à jour cette matrice, les événements concernés et
les tests de ton français. Une livraison UI sans événement mesurable ne suffit pas à clôturer un
objectif d'activation.
