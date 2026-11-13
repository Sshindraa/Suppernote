# Spec — Gestion de salle (Floor Plan) dans Suppernote

> **Statut : LIVRÉ / DOCUMENT DE RÉFÉRENCE — vérifié le 12 septembre 2026.**
> Les modèles salle/section/table, l'allocation atomique, la disponibilité capacitaire, le
> dashboard, le planning, la liste d'attente et Service Copilot existent. Le texte au futur décrit
> la conception d'origine et ne forme plus un backlog. Restent la preuve terrain multi-services et
> les raffinements UX/multi-plan éventuellement priorisés. Voir
> [`DOCUMENTATION_STATUS.md`](./DOCUMENTATION_STATUS.md).
> But : passer d’un moteur de réservation capacité-naïf (1 résa = 1 slot pris) à un moteur capacité-aware basé sur des tables physiques, sans casser Voice, Connect, Widget, MCP ni les réservations existantes.

---

## 1. Contexte et objectifs

### État au moment de la rédaction (historique)

- `Reservation` stocke `startsAt`, `endsAt`, `partySize`, `status`, `state`.
- Deux moteurs de disponibilité coexistent :
  - `apps/api/src/modules/reservations/reservation.service.ts` (legacy voice) : génère des slots par pas de 30 min, compte 1 réservation = 1 créneau indisponible.
  - `apps/api/src/modules/connect/availability.service.ts` a été supprimé ; Connect/widget utilise maintenant `CapacityAwareAvailabilityService` (floor-plan).
  - `apps/api/src/modules/agentic-reservations/core/availability.service.ts` (MCP/voice agentic) : P0 ultra-conservateur, 1 table par slot/partySize.
- `RestaurantExposureSettings.capacitySpecials` est un blob JSON qui contient aujourd’hui des compteurs par section (ex: `{ terrasse: 2 }`) mais pas de `serviceDuration`.
- Aucun modèle `Table`, `Section`, `FloorPlan`.
- Le dashboard a une liste de réservations (`/dashboard/reservations`) mais pas de vue salle.

### Objectifs

1. Permettre au restaurateur de créer/modifier un plan de salle (sections + tables).
2. Allouer automatiquement une table physique à chaque réservation.
3. Afficher les réservations sur une vue salle (planning + occupancy).
4. Remplacer le moteur de disponibilité par une logique capacité-aware.
5. Ne pas casser les flows existants : voice, Connect, widget, MCP, agentic reservations.

---

## 2. Périmètre

### In scope (P1)

- Modèle de données Prisma : `FloorPlan`, `Section`, `Table`, + lien `Reservation.tableId`.
- Moteur d’allocation de tables avec stratégie par défaut.
- Moteur de disponibilité capacité-aware (remplace les 2-3 services existants ou les fait converger).
- API routes admin pour gérer le plan de salle.
- API routes public inchangées en surface (`GET /public/r/:slug/availability`, `POST /public/r/:slug/hold`, `POST /public/r/:slug/confirm`).
- Page dashboard `/dashboard/floor-plan` : CRUD plan + vue planning du jour.
- Impact sur Voice / Connect / MCP documenté.
- Migration idempotente des réservations et des restaurants existants.
- Tests stratégiques identifiés.

### Out of scope (P1)

- Drag-and-drop visuel 2D ultra-complexe (on commence par une grille/liste ; le modèle supporte `positionX`, `positionY`, `shape` pour P2).
- Multi-site / multi-floor-plan par restaurant.
- Historique des positions des tables.
- Paiement lié à une table.
- Réservation d’une table spécifique par le client (allocation automatique uniquement).
- Surbooking explicite (capacité > tables physiques) : on peut autoriser temporairement une table en `isActive=false` si le restaurateur veut surbooker, mais ce n’est pas un feature flag.
- Restriction des `frame-ancestors` aux domaines enregistrés (feature ultérieure).

---

## 3. Modèle de données Prisma

### Choix retenu

On ajoute 3 modèles et 1 champ sur `Reservation`. Le modèle `Table` est la source de vérité de la capacité physique. `FloorPlan` est unique par restaurant (P1). `Section` est optionnelle : une table peut n’appartenir à aucune section (salle principale implicite).

Pourquoi `Table` est rattaché à `FloorPlan` ET optionnellement à `Section` :

- `floorPlanId` permet de récupérer toutes les tables d’un restaurant en une requête.
- `sectionId` permet de regrouper logiquement (terrasse, salle haute, etc.) et d’appliquer des préférences d’allocation.
- `sectionId` est nullable pour simplifier le cas "toutes les tables dans une seule salle".

Pourquoi `Reservation.tableId` est nullable :

- Rétrocompatibilité avec les réservations legacy (P1).
- Si un restaurant n’a pas encore créé de plan de salle, les réservations continuent de fonctionner.

### Schema proposé

````prisma
model FloorPlan {
  id           String     @id @default(uuid())
  restaurantId String     @unique @map("restaurant_id")
  name         String     @default("Salle principale")
  restaurant   Restaurant @relation(fields: [restaurantId], references: [id], onDelete: Cascade)
  sections     Section[]
  tables       Table[]
  createdAt    DateTime   @default(now()) @map("created_at")
  updatedAt    DateTime   @updatedAt @map("updated_at")

  @@map("floor_plans")
}

model Section {
  id          String    @id @default(uuid())
  floorPlanId String    @map("floor_plan_id")
  name        String
  position    Int       @default(0)
  floorPlan   FloorPlan @relation(fields: [floorPlanId], references: [id], onDelete: Cascade)
  tables      Table[]

  @@index([floorPlanId, position])
  @@map("floor_plan_sections")
}

model Table {
  id          String    @id @default(uuid())
  floorPlanId String    @map("floor_plan_id")
  sectionId   String?   @map("section_id")
  name        String
  capacity    Int
  minCapacity Int       @default(1) @map("min_capacity")
  positionX   Int?      @map("position_x")
  positionY   Int?      @map("position_y")
  shape       String    @default("rect") // rect | round
  isActive    Boolean   @default(true) @map("is_active")
  floorPlan   FloorPlan @relation(fields: [floorPlanId], references: [id], onDelete: Cascade)
  section     Section?  @relation(fields: [sectionId], references: [id], onDelete: SetNull)
  reservations Reservation[]

  @@index([floorPlanId, isActive])
  @@index([sectionId])
  @@map("floor_plan_tables")
}

model Reservation {
  // ... champs existants inchangés ...
  tableId String? @map("table_id")
  table   Table?  @relation(fields: [tableId], references: [id], onDelete: SetNull)

  // ... indexes existants ...
  @@index([restaurantId, tableId, startsAt])
  @@index([tableId, startsAt])
}

### Champs additionnels sur AgenticHold

Le modèle `AgenticHold` doit aussi référencer la table allouée, pour que le confirm puisse réutiliser la même table sans réallouer.

```prisma
model AgenticHold {
  // ... champs existants inchangés ...
  tableId String? @map("table_id")
  table   Table?  @relation(fields: [tableId], references: [id], onDelete: SetNull)

  // ... indexes existants ...
  @@index([tableId, slotStart])
}
````

Pourquoi `SetNull` :

- Si une table est supprimée, les holds historiques ne doivent pas être supprimés (audit).
- Le hold est temporaire, donc une table supprimée pendant la durée de vie d’un hold est un cas rare ; on réallouera au confirm si `tableId` est null.

### Variantes considérées et rejetées

| Variante                                                                                     | Pourquoi rejetée                                                                                                       |
| -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `Table` sans `sectionId`, seulement un champ `section` en texte libre                        | Empêche les préférences d’allocation et la vue salle structurée.                                                       |
| `FloorPlan` multi-plan par restaurant (`isDefault`, `floorNumber`)                           | Multiplie la complexité d’allocation et de migration pour un MVP. On garde `restaurantId @unique`.                     |
| `Table` reliée directement à `Restaurant` sans `FloorPlan`                                   | Rend le multi-plan impossible plus tard et alourdit les requêtes. Le modèle `FloorPlan` est un conteneur clair.        |
| `Reservation.tableId` non nullable + création automatique d’une table “virtuelle” par défaut | Oblige à créer des données bidons pour tous les restaurants legacy. Nullable + allocation conditionnelle est plus sûr. |

### Index stratégiques

- `Table(floorPlanId, isActive)` : allocation rapide.
- `Table(sectionId)` : filtrage par section.
- `Reservation(tableId, startsAt)` + `Reservation(restaurantId, tableId, startsAt)` : détection de chevauchement.

---

## 4. Moteur d’allocation de tables

### Entrées

```ts
type AllocateTableInput = {
  restaurantId: string;
  partySize: number;
  startsAt: Date;
  endsAt: Date;
  preferredSectionId?: string; // optionnel
  excludeTableIds?: string[]; // pour retry si le best-fit échoue
};
```

### Contraintes

1. `table.isActive = true`.
2. `table.capacity >= partySize`.
3. `table.minCapacity <= partySize` (optionnel mais recommandé).
4. Pas de chevauchement avec une autre réservation sur la même table, sur `[startsAt, endsAt)`.
5. Chevauchement avec les holds actifs : un hold ne bloque pas définitivement une table (il est temporaire), mais on ne l’alloue pas à une autre réservation pendant sa durée de vie.

### Stratégie par défaut : Best Fit + Section Preference

Algorithme :

```ts
1. Récupérer toutes les tables actives du restaurant avec capacity >= partySize.
2. Si preferredSectionId est fourni, garder d’abord les tables de cette section ; fallback sur toutes les tables si aucune dispo.
3. Pour chaque table candidate, vérifier qu’aucune réservation (state in [PENDING, CONFIRMED, SEATED]) et aucun hold actif ne chevauchent [startsAt, endsAt).
4. Parmi les tables disponibles, choisir celle avec la plus petite capacity >= partySize (best fit).
5. En cas d’égalité, choisir celle avec le plus petit `minCapacity`.
6. En cas d’égalité, choisir la table de la section préférée, puis la première par ordre alphabétique de `name`.
```

Pourquoi best fit :

- Optimise l’utilisation de la salle : une table de 2 pour 2 personnes laisse les grandes tables disponibles pour les grands groupes.
- Simple à implémenter et à expliquer au restaurateur.
- La stratégie peut être rendue configurable plus tard (`first-fit`, `center-first`, etc.).

### Hold et expiration

Un hold est une réservation temporaire qui bloque une table pendant sa durée de vie. Cela garantit que la table choisie au moment du hold est encore disponible au moment du confirm.

#### Comportement attendu

1. **Au moment du hold**, le service appelle `TableAllocationService.allocate(...)` et stocke le `tableId` dans `AgenticHold.tableId`.
2. **La détection de chevauchement** doit filtrer les holds sur :
   - `status = 'ACTIVE'`
   - `expiresAt > now()`
   - `tableId` non null
   - `[slotStart, slotEnd)` chevauche `[startsAt, endsAt)` de la nouvelle demande.
3. **À l’expiration du hold**, la table est considérée comme libérée. Deux options d’implémentation (au choix de l’équipe, privilégier l’option A pour la simplicité) :
   - **Option A (lazy)** : le moteur d’allocation ignore automatiquement les holds expirés via le filtre `expiresAt > now()`. Aucun worker nécessaire.
   - **Option B (worker)** : un worker périodique passe les holds `EXPIRED` et libère explicitement la table. Cette option est plus propre pour l’audit et permet de déclencher des events.
4. **Si le confirm arrive après expiration du hold**, le service de confirmation tente de réallouer une table avec les mêmes critères (partySize, startsAt, endsAt, section). Si aucune table n’est disponible, le confirm retourne une erreur `409` ou `410` (slot expiré / plus disponible), selon le contrat existant.
5. **Annulation / release manuel** : si le client abandonne ou le hold est annulé, la table est immédiatement libérée (pas besoin d’attendre l’expiration).

> **Important** : le `tableId` stocké dans le hold n’est pas exposé au client (widget/Connect/MCP). Il est utilisé uniquement côté serveur pour garantir la cohérence entre hold et confirm.

### Détection de chevauchement

```ts
function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart < bEnd && bStart < aEnd;
}
```

Requête Prisma pour récupérer les conflits sur une table :

```ts
const conflicting = await prisma.reservation.findFirst({
  where: {
    tableId: table.id,
    state: { in: ['PENDING', 'CONFIRMED', 'SEATED'] },
    OR: [
      { startsAt: { lt: endsAt, gte: startsAt } },
      { endsAt: { gt: startsAt, lte: endsAt } },
      { AND: [{ startsAt: { lte: startsAt } }, { endsAt: { gte: endsAt } }] },
    ],
  },
});
```

> **Note** : Prisma ne gère pas nativement les intervalles Postgres. On peut utiliser une raw query avec `tsrange` en P2 si la volumétrie l’exige. En P1, la requête ci-dessus est suffisante car un restaurant a typiquement < 100 réservations/jour.

### Service proposé

`apps/api/src/modules/floor-plan/table-allocation.service.ts`

```ts
export class TableAllocationService {
  constructor(private readonly prisma: PrismaClient) {}

  async allocate(input: AllocateTableInput): Promise<Table | null>;
  async isTableAvailable(
    tableId: string,
    startsAt: Date,
    endsAt: Date,
    excludeReservationId?: string,
  ): Promise<boolean>;
  async releaseTable(reservationId: string): Promise<void>;
  async reallocate(reservationId: string, newTableId: string): Promise<void>;
}
```

---

## 5. Moteur de disponibilité capacité-aware

### Objectif

Remplacer / unifier les services suivants :

- `apps/api/src/modules/reservations/reservation.service.ts` (legacy)
- `apps/api/src/modules/connect/availability.service.ts` (supprimé ; Connect utilise déjà `CapacityAwareAvailabilityService`)
- `apps/api/src/modules/agentic-reservations/core/availability.service.ts` (garder la surface API, changer l’implémentation interne)

Le contrat de surface (`AvailabilityDto`) reste le même pour ne pas casser Connect/widget :

```ts
{ restaurantId, date, partySize, slots: [{ time, available }] }
```

### Calcul de la durée d’un service

La durée du service est nécessaire pour calculer `endsAt` à partir de `startsAt`.

Source de vérité : `RestaurantExposureSettings.capacitySpecials`.

Format étendu proposé :

```json
{
  "terrasse": 2,
  "serviceDurationMinutes": 120,
  "defaultServiceDurationMinutes": 90
}
```

- `serviceDurationMinutes` : durée explicite globale (minutes).
- `defaultServiceDurationMinutes` : fallback si `serviceDurationMinutes` n’est pas défini.
- Fallback final : 120 min pour les restaurants n’ayant rien configuré.

Pourquoi garder `capacitySpecials` :

- Évite une nouvelle table de settings. Le champ JSON est déjà utilisé pour les compteurs de section.
- Migration douce : on ajoute une clé, on ne change pas le type de la colonne.

### Calcul de `endsAt`

`Reservation.endsAt` est déjà présent dans le schéma Prisma. Il doit être systématiquement calculé comme :

```ts
const serviceDurationMinutes =
  capacitySpecials.serviceDurationMinutes ?? capacitySpecials.defaultServiceDurationMinutes ?? 120;

const endsAt = new Date(startsAt.getTime() + serviceDurationMinutes * 60_000);
```

#### Règles de cohérence

- **Tous les services** doivent utiliser `startsAt` + `serviceDuration` pour calculer le chevauchement. Plus de durée fixe `RESERVATION_DURATION_MINUTES = 120` dans `reservation.service.ts`.
- **Réservations existantes** : lors de la migration, on calcule `endsAt` pour les réservations legacy qui n’en ont pas (en utilisant le `serviceDuration` actuel ou 120 min par défaut), puis on met à jour `Reservation.tableId` et `Reservation.endsAt`.
- **Holds** : `AgenticHold.slotEnd` est calculé de la même manière au moment du hold, pour garantir que la table est bloquée sur la bonne durée.
- **Connect / Widget** : le client ne fournit qu’une date et un créneau horaire. Le serveur calcule `endsAt` côté API avant d’appeler l’allocation.
- **Voice / MCP** : idem, le serveur déduit la durée du service depuis les policies.

### Algorithme de disponibilité

```ts
1. Récupérer le restaurant, son openingHours, son timezone, ses settings.
2. Calculer serviceDurationMinutes depuis capacitySpecials (fallback 120).
3. Normaliser openingHours pour le jour de la semaine demandé.
4. Générer les créneaux par pas de 30 min entre open et close.
5. Pour chaque créneau :
   a. slotStart = date + time (UTC via timezone)
   b. slotEnd = slotStart + serviceDurationMinutes
   c. Compter les tables actives du restaurant avec capacity >= partySize.
   d. Pour chaque table, vérifier qu’aucune réservation bloquante ni hold actif ne chevauchent [slotStart, slotEnd).
   e. Si au moins une table est disponible → slot.available = true.
6. Retourner les slots.
```

### Optimisation P1

Pour éviter N×M requêtes (N créneaux × M tables), on peut :

1. Récupérer toutes les réservations bloquantes du jour et tous les holds actifs du jour en 2 requêtes.
2. Les indexer par `tableId` et `startsAt`.
3. Pour chaque créneau, itérer sur les tables et tester localement le chevauchement.

Complexité acceptable pour un restaurant de 30 tables × 20 créneaux/jour.

### Impact sur les routes existantes

- `GET /public/r/:slug/availability` : inchangée en surface. Elle devient capacité-aware en interne.
- `POST /public/r/:slug/hold` : alloue une table au moment du hold (voir §4 "Hold et expiration"). Le hold est temporaire, la table est considérée comme occupée pendant sa durée.
- `POST /public/r/:slug/confirm` : réutilise la table allouée lors du hold. Si le hold a expiré et qu’une nouvelle allocation est nécessaire, on réalloue.
- `reservation.service.ts` (legacy voice) : utiliser le même `AvailabilityService` unifié.
- `agentic-reservations/core/availability.service.ts` : remplacer l’implémentation par le service unifié, garder la surface.

---

## 6. API routes

### Admin routes (dashboard)

Base : `/restaurants/:id/floor-plan` (auth Clerk, restaurant ownership check).

```ts
GET    /restaurants/:id/floor-plan
       → { id, name, sections: [{id, name, position, tables}], tables: [...] }

POST   /restaurants/:id/floor-plan
       body: { name? }
       → créer le FloorPlan s’il n’existe pas. Idempotent (upsert sur restaurantId).

PUT    /restaurants/:id/floor-plan/sections/:sectionId
       body: { name?, position? }
       → update section.

POST   /restaurants/:id/floor-plan/sections
       body: { name, position? }
       → create section.

DELETE /restaurants/:id/floor-plan/sections/:sectionId
       → delete section, SetNull sur les tables liées.

POST   /restaurants/:id/floor-plan/tables
       body: { sectionId?, name, capacity, minCapacity?, positionX?, positionY?, shape? }
       → create table.

PATCH  /restaurants/:id/floor-plan/tables/:tableId
       body: { sectionId?, name?, capacity?, minCapacity?, positionX?, positionY?, shape?, isActive? }
       → update table.

DELETE /restaurants/:id/floor-plan/tables/:tableId
       → soft-delete : `isActive = false` si des réservations existent, hard-delete sinon.

GET    /restaurants/:id/floor-plan/reservations?date=YYYY-MM-DD
       → réservations du jour avec `tableId`, `tableName`, `sectionName`, `startsAt`, `endsAt`, `partySize`, `customerName`, `state`.
```

### Public routes (Connect / widget)

Surface inchangée. Comportement interne modifié :

```ts
GET    /public/r/:slug/availability?date=YYYY-MM-DD&partySize=N
       → même DTO, mais capacité-aware.

POST   /public/r/:slug/hold
       body: { date, time, partySize, source?, website?, preferredSection? }
       → calcule `slotStart`/`slotEnd` via `serviceDuration`, alloue une table via
         `TableAllocationService.allocate(...)`, puis stocke `tableId` dans
         `AgenticHold.tableId`. La table est bloquée temporairement pendant la
         durée du hold.

POST   /public/r/:slug/confirm
       body: { holdToken, idempotencyKey, customer, specialRequests?, ... }
       → récupère le hold. Si `AgenticHold.tableId` est présent et valide, la
         réservation est créée avec cette table. Si le hold a expiré, on
         réalloue une table ; si aucune n’est disponible, retourne 409/410.
```

### Route legacy (à unifier)

```ts
POST   /reservations
       → legacy voice. Doit utiliser le même moteur d’allocation et de disponibilité.
```

### Guards et validation

- Vérifier que le restaurateur est propriétaire du restaurant (`orgId` du token Clerk == `restaurantId`).
- Valider que `capacity >= minCapacity`, `capacity >= 1`, `minCapacity >= 1`.
- Empêcher la suppression d’une table active si elle a des réservations futures.

---

## 7. Dashboard UI : `/dashboard/floor-plan`

### P1 : interface simple et fonctionnelle

#### Onglet 1 — Plan de salle (CRUD)

- Liste des sections avec tables.
- Pour chaque section : nom, position, nombre de tables, capacité totale.
- Pour chaque table : nom, capacité, minCapacity, statut actif/inactif.
- Actions : ajouter section, ajouter table, modifier, désactiver, supprimer.
- Pas de plan 2D visuel en P1. On utilise des inputs numériques pour `positionX`/`positionY` si besoin, mais ce n’est pas obligatoire.

#### Onglet 2 — Planning du jour

- Sélecteur de date.
- Grille : tables en colonnes, créneaux horaires en lignes (par pas de 30 min).
- Une réservation apparaît comme un bloc coloré sur la table allouée, avec le nom du client, le partySize et l’état.
- Cliquer sur un bloc ouvre un drawer avec les détails de la réservation.
- Bouton pour réassigner une réservation à une autre table (P1.5 ou P2) : ouvre un sélecteur de table disponible.

#### Onglet 3 — Stats rapides

- Taux d’occupation (couvertes servies / couvertes max).
- Nombre de tables actives / inactives.
- Capacité totale du restaurant.
- Alertes : réservations sans table (legacy), surcapacité détectée.

### Design tokens

- Utiliser les composants Shadcn existants (`Card`, `Table`, `Badge`, `Button`, `Dialog`, `Select`, `Input`).
- Couleurs : `bg-background`, `text-foreground`, `border-border`, `bg-primary` pour les actions.
- French-first copy : "Vous", "Section", "Table", "Capacité", "Couverts", "Plan de salle".

---

## 8. Adaptation des canaux

### Voice (agent téléphonique)

- L’agent peut proposer une préférence de section : `"Souhaitez-vous une table en terrasse ?"`.
- La préférence est transmise au moteur d’allocation via `preferredSectionId`.
- Si la section demandée est pleine, l’agent propose une alternative (fallback automatique).
- Impact sur le LLM prompt : ajouter une variable `availableSections` avec les noms et capacités restantes.
- Le state machine de réservation n’est pas modifié : allocation côté serveur après `createReservation` ou `createHold`.

### Connect / Widget

- Le client ne choisit pas sa table.
- Affichage dans la confirmation : `"Table attribuée automatiquement"` (sous-entendu, pas de numéro de table affiché au client).
- Si le restaurant n’a pas de plan de salle, le flow actuel continue (allocation nullable).

### MCP / OpenAI Reserve

- Le tool `restaurant_reservation` garde la même interface : `partySize`, `date`, `time`, `restaurantId`.
- L’allocation se fait côté serveur dans `hold.service.ts` / `reservation.service.ts`.
- Le tool peut retourner un champ optionnel `tableAllocated: true` dans la réponse pour informer le LLM.

---

## 9. Migration des données

### 9.1. Création des FloorPlan et Tables

Script idempotent : `pnpm db:seed:floor-plan` ou migration Prisma + script.

Pour chaque restaurant existant :

```ts
1. Créer un FloorPlan si absent : { restaurantId, name: 'Salle principale' }.
2. Lire RestaurantExposureSettings.capacitySpecials.
3. Déterminer la capacité totale :
   - Si capacitySpecials.totalCapacity existe, l’utiliser.
   - Sinon, sommer les valeurs numériques de capacitySpecials (ex: terrasse: 2, salle: 8 → total = 10).
   - Sinon, fallback sur maxPartySize * 2 (heuristique conservative).
4. Générer des tables standard :
   - Si totalCapacity <= 20 : 4 tables de 2, 2 tables de 4, 1 table de 6 (total 22, légèrement au-dessus).
   - Si totalCapacity > 20 : 40% de tables de 2, 40% de tables de 4, 20% de tables de 6+.
   - Les tables sont créées dans une section "Salle principale" par défaut.
   - Toutes les tables sont `isActive = true`.
5. Marquer le FloorPlan comme `migratedAt` (métadonnée JSON optionnelle) ou utiliser un flag dans `capacitySpecials`.
```

### 9.2. Attribution rétroactive des réservations

Pour chaque réservation existante sans `tableId` et avec `startsAt` défini :

```ts
1. Vérifier que le restaurant a un FloorPlan avec des tables.
2. Allouer une table en best-fit pour (partySize, startsAt, endsAt).
3. Si aucune table n’est disponible (surbooking historique), laisser `tableId = null` et créer une alerte dashboard.
4. Mettre à jour `Reservation.tableId`.
```

Idempotence : si `Reservation.tableId` est déjà renseigné, skipper. Le script est re-runnable.

### 9.3. Migration Prisma

Deux migrations :

1. `CREATE TABLE floor_plans`, `floor_plan_sections`, `floor_plan_tables`, ajout de `Reservation.tableId`.
2. (Optionnel) `UPDATE reservation SET tableId = ...` via script Node séparé, car cela nécessite le moteur d’allocation et peut être long.

### 9.4. Réservations sans table (legacy)

- P1 : elles restent fonctionnelles. Le moteur de disponibilité les ignore pour le calcul d’occupation (ou les considère comme une table virtuelle temporaire).
- Dashboard : afficher un badge `"Sans table"` avec une action rapide `"Allouer une table"`.

---

## 10. Tests

### Tests unitaires

- `table-allocation.service.test.ts` :
  - Best-fit choisit la plus petite table adaptée.
  - Chevauchement détecté.
  - Préférence de section respectée puis fallback.
  - Table inactive ignorée.
- `availability-capacity-aware.test.ts` :
  - Créneau disponible si au moins une table libre.
  - Créneau indisponible si toutes les tables occupées.
  - `partySize` supérieur à la plus grande table → indisponible.

### Tests d’intégration routes admin

- CRUD floor-plan, sections, tables.
- Désactivation d’une table avec réservations futures interdite.
- `GET /restaurants/:id/floor-plan/reservations?date=...` retourne les bonnes réservations.

### Tests de non-régression public

- `GET /public/r/:slug/availability` : même contrat, comportement capacité-aware.
- `POST /public/r/:slug/hold` : table allouée, réservation concurrente bloquée.
- `POST /public/r/:slug/confirm` : table confirmée.

### Test de migration

- Script de migration sur une base de test : génère les bons nombres de tables, attribue les réservations existantes.
- Idempotence : exécuter 2 fois le script ne change pas le résultat.

### Test E2E (optionnel P1.5)

- Réserver via le widget, vérifier dans le dashboard que la table apparaît sur le planning.

---

## 11. Roadmap P1 / P2 / P3

### P1 — MVP (1-2 sprints)

1. Modèle de données Prisma + migration.
2. `TableAllocationService` + `CapacityAwareAvailabilityService`.
3. Routes admin floor-plan.
4. Page dashboard `/dashboard/floor-plan` (CRUD + planning simple).
5. Raccordement des routes public hold/confirm à l’allocation.
6. Migration des restaurants existants (FloorPlan + Tables).
7. Tests unitaires + intégration.

### P2 — UX salle (1 sprint)

1. Vue 2D minimale du plan de salle (positionX, positionY, shape).
2. Drag-and-drop pour réassigner une réservation à une table.
3. Préférences de section pour le client (terrasse) dans Connect/widget.
4. Taux d’occupation avancé et prévisions.
5. `tsrange` Postgres pour optimiser les requêtes de chevauchement.

### P3 — Multi-plan et raffinement

1. Multi-floor-plan par restaurant (étages, salles privées).
2. Surbooking contrôlé et file d’attente.
3. Historique des modifications du plan de salle.
4. Réservation de table spécifique par le client (optionnel, selon retour terrain).

---

## 12. Flux / diagramme

### Flux d’une réservation via widget (capacité-aware)

```
Client (widget)
    ↓
GET /public/r/:slug/availability?date=…&partySize=…
    ↓
CapacityAwareAvailabilityService
    - calcule serviceDuration
    - génère les slots
    - pour chaque slot, vérifie qu’au moins une table peut accueillir partySize
    ↓
Affichage des créneaux disponibles
    ↓
POST /public/r/:slug/hold
    ↓
TableAllocationService.allocate(partySize, startsAt, endsAt)
    - best-fit table disponible
    - stocke tableId dans le hold (métadonnées) ou considère la table occupée
    ↓
Hold créé (table temporairement réservée)
    ↓
POST /public/r/:slug/confirm
    ↓
Récupération du hold + tableId
    ↓
Création de la Reservation avec tableId
    ↓
Confirmation "Table attribuée automatiquement"
```

### Flux admin

```
Restaurateur
    ↓
Dashboard /dashboard/floor-plan
    ↓
CRUD sections/tables → POST/PUT/PATCH/DELETE /restaurants/:id/floor-plan/...
    ↓
Planning du jour → GET /restaurants/:id/floor-plan/reservations?date=...
    ↓
Réassignation manuelle → PATCH /reservations/:id (tableId)
```

---

## 13. Fichiers à modifier / créer

### Modèle de données

- `packages/database/prisma/schema.prisma` :
  - ajout des modèles FloorPlan, Section, Table ;
  - ajout de `Reservation.tableId` ;
  - ajout de `AgenticHold.tableId` (relation SetNull vers Table) et index `[tableId, slotStart]`.
- `packages/database/prisma/migrations/2026xxxxx_floor_plan/` : migration SQL.

### Moteur

- `apps/api/src/modules/floor-plan/table-allocation.service.ts` (nouveau).
- `apps/api/src/modules/floor-plan/availability-capacity-aware.service.ts` (nouveau).
- `apps/api/src/modules/floor-plan/floor-plan.types.ts` (nouveau).
- `apps/api/src/modules/reservations/reservation.service.ts` :
  - utiliser le nouveau moteur ;
  - remplacer `RESERVATION_DURATION_MINUTES = 120` par la lecture de `serviceDuration` dans `capacitySpecials` pour calculer `endsAt`.
- `apps/api/src/modules/connect/availability.service.ts` : supprimé ; Connect utilise directement `CapacityAwareAvailabilityService`.
- `apps/api/src/modules/agentic-reservations/core/availability.service.ts` : wrapper autour du nouveau service.
- `apps/api/src/modules/agentic-reservations/core/hold.service.ts` : appeler `allocate` au moment du hold.
- `apps/api/src/modules/agentic-reservations/core/reservation.service.ts` : appeler `allocate` au moment de la création si pas de hold.

### Routes

- `apps/api/src/modules/floor-plan/floor-plan.routes.ts` (nouveau) : routes admin.
- `apps/api/src/modules/connect/connect.routes.ts` : adapter hold/confirm pour l’allocation.
- `apps/api/src/modules/restaurants/restaurant.routes.ts` : si besoin d’exposer `capacitySpecials` au dashboard.

### Dashboard

- `apps/dashboard/src/app/dashboard/floor-plan/page.tsx` (nouveau).
- `apps/dashboard/src/app/dashboard/floor-plan/components/` (nouveau) : SectionList, TableList, DayPlanner, FloorPlanStats.
- `apps/dashboard/src/app/dashboard/_layout-client.tsx` : ajouter l’onglet "Salle".

### Migration

- `packages/database/scripts/migrate-floor-plan.ts` (nouveau) : script idempotent.
- `packages/database/package.json` : ajouter `db:seed:floor-plan`.

### Tests

- `apps/api/src/modules/floor-plan/__tests__/table-allocation.service.test.ts`.
- `apps/api/src/modules/floor-plan/__tests__/availability-capacity-aware.service.test.ts`.
- `apps/api/src/modules/floor-plan/__tests__/floor-plan.routes.test.ts`.
- `packages/database/scripts/__tests__/migrate-floor-plan.test.ts`.

### Docs

- `docs/floor-plan-spec.md` (ce document).
- Le positionnement produit est désormais consolidé dans `docs/roadmap-produit-crm-marketing-199-299.md`.

---

## 14. Questions résolues

### Q1 : Est-ce qu’on permet au client de demander une section spécifique (terrasse) ?

**Réponse P1 :** non côté client (widget/Connect). Le moteur prend une `preferredSectionId` en interne, mais elle n’est pas exposée au client.
**P2 :** on peut ajouter un paramètre `preferredSection` dans le widget et le transmettre au hold.

### Q2 : Est-ce qu’on alloue la table au moment du hold ou au moment du confirm ?

**Réponse :** au moment du hold. Cela garantit que la table n’est pas prise par une autre réservation pendant les 5-7 minutes de hold.
Si le hold expire, la table est libérée. Au confirm, on récupère la table du hold ; si le hold est manquant ou expiré, on réalloue.

### Q3 : Comment gérer les réservations sans table (legacy) ?

**Réponse :** `Reservation.tableId` est nullable. Les réservations legacy continuent de fonctionner. Le dashboard affiche un badge "Sans table" et permet une allocation manuelle. Le moteur de disponibilité ne les considère pas comme bloquantes pour les tables (ou les ignore) — en P1, on privilégie la simplicité.

### Q4 : Quelle est la durée par défaut d’une réservation si `serviceDuration` n’est pas configurée ?

**Réponse :** 120 minutes. Ordre de priorité : `capacitySpecials.serviceDurationMinutes` → `capacitySpecials.defaultServiceDurationMinutes` → 120.

### Q5 : Est-ce qu’on autorise le surbooking (capacité > tables physiques) ?

**Réponse P1 :** non. Si aucune table n’est disponible, le créneau est indisponible.
**Dérogation :** un restaurateur peut désactiver temporairement une table (`isActive=false`) pour réduire artificiellement la capacité, mais il ne peut pas créer de réservation sans table allouée via les canaux publics.

---

## 15. Checklist de validation de la spec

- [x] Modèle de données couvre le MVP sans être over-engineered.
- [x] Algorithme d’allocation défini (best-fit) et justifié.
- [x] Routes API publiques gardent le même contrat ; routes admin listées.
- [x] Dashboard réaliste à implémenter en 1-2 sprints (CRUD + planning simple).
- [x] Migration idempotente et rétrocompatible (tableId nullable, FloorPlan unique par restaurant).
- [x] Impacts sur Voice / Connect / MCP documentés.
- [x] Tests identifiés (unitaires, intégration, migration, non-régression).
- [x] Roadmap P1/P2/P3 définie.
- [x] Questions clés résolues.

---

## 16. Risques et mitigations

| Risque                                                                          | Mitigation                                                                                                      |
| ------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Migration lente sur gros restaurants                                            | Exécuter le script de migration en dehors des heures de pointe, par batch.                                      |
| Conflit entre hold et réservation legacy                                        | Le hold bloque la table pendant sa durée ; les réservations legacy sans table n’occupent pas de table physique. |
| Changement de durée de service (`serviceDuration`) impacte les résas existantes | `serviceDuration` est lu au moment du calcul ; les réservations existantes conservent leur `endsAt`.            |
| Restaurateur ne crée pas son plan de salle                                      | Fallback : allocation nullable, dashboard invite à créer un plan.                                               |
| Performance du chevauchement en P1                                              | Index + requête 2 requêtes/jour. Si problème, passer à `tsrange` en P2.                                         |
