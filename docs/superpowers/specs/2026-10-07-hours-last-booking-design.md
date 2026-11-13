# Dernière réservation par service — conception

Date : 2026-10-07 · Statut : implémenté (travail direct dans le dossier principal, sans branche dédiée)

## Objectif

Le restaurateur indique, **pour chaque service**, l'heure de la dernière réservation acceptée :
un champ en service continu, deux en « midi et soir ». Cette heure est distincte de la fermeture
(un restaurant peut fermer à 23:00 et ne plus prendre de réservation après 21:30).

Critères de réussite :

- Les créneaux proposés (API, widget, voix) s'arrêtent à cette heure.
- L'étape « Horaires » de l'onboarding exige la valeur : on ne peut pas continuer sans.
- Les restaurants existants ne changent pas de comportement tant qu'ils n'ont pas enregistré.

## Constat sur le code actuel

- `openingHours` est un champ JSON (`packages/database/prisma/schema.prisma`, `opening_hours`) :
  par jour `{ open, close, slots?: [{open, close}], services?: [...] }`, deux services au plus.
  Ajouter un champ ne demande aucune migration.
- Il n'existe pas de notion de dernière réservation. Les créneaux sont générés par pas de 30 min
  tant que `créneau + 30 min ≤ fermeture`, soit **fermeture − 30 min** :
  `generateSlots` dans `apps/api/src/modules/floor-plan/availability-capacity-aware.service.ts`,
  boucle équivalente dans `apps/dashboard/src/app/widget/[restaurantId]/page.tsx`.
- Le schéma Zod `apps/api/src/modules/restaurants/opening-hours.schema.ts` utilise `z.object`
  non strict : un champ inconnu est **supprimé sans erreur** à l'enregistrement.
- La forme est normalisée par `normalizeOpeningHours` (`packages/shared/src/utils/opening-hours.ts`),
  qui coupe aussi les services passant minuit (fermeture jusqu'à 06:00) en deux périodes.
- L'éditeur est `apps/dashboard/src/features/onboarding/steps/HoursStep.tsx`, modèle dans
  `apps/dashboard/src/features/onboarding/hours.ts`.

## Décisions

1. **Champ** : `lastBooking: "HH:mm"`, optionnel, par service. Dans `slots[i]` pour « midi et
   soir » ; au niveau du jour pour le service continu (la forme `{ open, close }` à un service
   garde sa structure).
2. **Sens** : dernière heure de **début** de réservation acceptée, incluse. Elle est sur la grille
   de 30 min du service (`open + 30·k`) et strictement avant la fermeture.
3. **Compatibilité** : l'API accepte l'absence du champ (widget, données existantes, import Google
   Maps, tests). Aucune route, aucun champ de réponse ni schéma de base n'est renommé ou retiré
   (additif uniquement). L'obligation est portée par l'interface.
4. **Valeur par défaut** : le dernier créneau de la grille `t` tel que `t + 30 min ≤ fermeture`
   (soit fermeture − 30 min quand la fermeture tombe sur la grille). Elle reproduit exactement la
   règle actuelle, y compris pour une fermeture hors grille (19:00–22:45 → 22:00).
5. **Obligatoire dans l'étape Horaires** : le champ ne peut pas être vidé. Les préréglages et
   l'import Google Maps le remplissent d'office ; pour un restaurant existant, il s'affiche
   rempli avec la valeur par défaut (décision 4) et sera enregistré à la validation.
   _Écart avec « champ obligatoire » : pas de blocage sur un champ vide pour l'existant._
6. **Pas de branche dédiée** : travail directement dans le dossier principal (consigne de
   l'utilisateur, 2026-10-07).

## Conception

### 1. Règle unique dans `@suppernote/shared`

`NormalizedOpeningHours` gagne `lastBooking?: string` sur chaque période. Un helper partagé
calcule la dernière heure d'un service (`lastBooking`, sinon la valeur par défaut de la décision 4) et génère les
créneaux de réservation d'une période. Il remplace trois copies de la logique :

- disponibilité API (`availability-capacity-aware.service.ts`, `generateSlots`) ;
- créneaux du widget (`widget/[restaurantId]/page.tsx`, `getSlotsForDate`) ;
- garde-fou vocal (`voice/stream/structured-turn/fact-guards.ts`, test `période ouverte`).

Les services passant minuit sont traités sur une ligne de temps étendue (une `lastBooking` après
minuit appartient à la période du lendemain créée par `normalizePeriod`).

### 2. Validation

- **API** : `OpeningHourPeriodSchema` et `OpeningHoursDaySchema` acceptent `lastBooking`
  (format `HH:mm`) ; `superRefine` refuse une valeur hors du service, hors grille ou non
  strictement avant la fermeture. Le champ de jour correspond au dernier service.
- **Tableau de bord** : `validateDay` (`hours.ts`) applique la même règle, avec un message en
  français (« La dernière réservation doit tomber dans le service, par pas de 30 minutes. »).

### 3. Interface (étape Horaires)

- La ligne de chaque jour reste celle d'origine (ouverture – fermeture par service, une seule ligne
  dès 1280 px). Un bouton « Dernière résa » (texte + chevron, à toutes les largeurs) la déplie : un panneau
  affiche une liste par service, des heures valides seulement, impossible de saisir une valeur hors
  grille. Replié par défaut ; une phrase sous la grille explique où la trouver.
  Le bouton est une pastille avec un point quand l'heure diffère de la valeur par défaut. Le
  panneau explique l'effet (« Après cette heure, Suppernote ne propose plus de créneau ») et propose
  « Appliquer aux autres jours » (jours ouverts de même rythme, annulable).
- Préréglages : midi 14:00, soir 22:00, continu 21:30. L'import Google Maps pré-remplit
  la valeur par défaut.
- La dernière réservation **suit** la fermeture tant qu'elle valait l'ancienne valeur par défaut ;
  sinon elle est conservée tant qu'elle reste valide, et revient à la valeur par défaut si elle
  ne l'est plus (aucun état invalide n'est atteignable depuis l'interface).
- `switchMode` : de « midi et soir » à « continu », la dernière réservation du soir est conservée ;
  dans l'autre sens, la valeur par défaut est proposée.
- Aucune couleur arbitraire, composants `@/components/ui/*`, états chargement/erreur conservés.

### 4. Voix

`voice/prompts.ts` ajoute « dernière réservation HH:MM » à la ligne de chaque service. Le
garde-fou de `fact-guards.ts` refuse un horaire au-delà de la dernière réservation et le dit au
client.

## Hors périmètre

- Page publique Connect (`connect.service.ts`) : elle expose les horaires d'ouverture (schema.org),
  pas les réservations ; inchangée.
- Planning (`PlanningTab.tsx`) : l'étendue de la grille reste calculée sur l'ouverture/fermeture.
- Durée de repas et capacité : inchangées.

## Tests et vérification

- `@suppernote/shared` : helper (défaut, valeur explicite, passage minuit).
- API : schéma Zod (champ conservé, valeurs refusées, absence acceptée) ; disponibilité (créneaux
  jusqu'à `lastBooking`, comportement identique sans champ).
- Tableau de bord : `hours.ts` et `HoursStep.test.tsx` (préréglages, suivi de la fermeture,
  changement de mode, import) ; widget (créneaux).
- Voix : `prompts.test.ts` et garde-fous.
- `pnpm test` ciblé, `typecheck`, `pnpm lint`, vérification dans le navigateur de l'étape Horaires.

## Livraison

Modifications non commitées dans le dossier principal. Pas de migration de base, pas de variable
d'environnement. Entrée dans `docs/obsidian/Journal.md`. Signalé en commentaire de PR : touche au
widget et à la voix (surfaces d'intégration, changement additif).
