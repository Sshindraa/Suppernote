# Spec — Cartes cadeaux dans Suppernote

> **Statut : LIVRÉ / DOCUMENT DE RÉFÉRENCE — vérifié le 12 septembre 2026.**
> Packs, montant libre, cagnotte, widget, dashboard, codes courts, Stripe, remboursements et
> protections transactionnelles existent. Les mentions « mode test P1 » et « Stripe futur »
> appartiennent au plan initial. Restent l'unicité DB stricte du PaymentIntent après audit des
> doublons et la qualification du cycle financier complet en environnement réel. Voir
> [`DOCUMENTATION_STATUS.md`](./DOCUMENTATION_STATUS.md).
> But : permettre aux restaurateurs Suppernote de vendre des cartes cadeaux digitales, intégrées nativement au parcours de réservation, avec packs expérience, option "réserver maintenant" et cagnotte collective.

---

## 1. Contexte et objectifs

### État au moment de la rédaction (historique)

- Suppernote gère les réservations via `hold` / `confirm` (Connect, widget, voice, MCP).
- Le CRM `Customer` existe avec historique, VIP, consentements.
- Le modèle `GiftCard`, `GiftCardRedemption` et `GiftCardContribution` a été créé en P1.
- Aucun flux de paiement réel n’existe aujourd’hui (P1 = mode test / marquage manuel).

### Objectifs

1. Permettre à un client d’acheter une carte cadeau pour un restaurant Suppernote (montant libre ou pack expérience).
2. Permettre au bénéficiaire de l’utiliser automatiquement au moment de la réservation.
3. Proposer une option "réserver maintenant" : l’expéditeur offre directement un créneau au bénéficiaire.
4. Différencier Suppernote via le concierge IA (recommandation de montant, message, créneaux).
5. Offrir au restaurateur un dashboard de création, suivi et statistiques par type de cadeau.
6. Garder le système compatible avec un futur paiement Stripe (P2) et marketplace (P3). La cagnotte groupe est désormais incluse dans le P1.

### Différenciation Suppernote vs Zenchef / OpenTable

| Zenchef classique      | Suppernote next level                                           |
| ---------------------- | --------------------------------------------------------------- |
| Achat web uniquement   | Achat web + widget + voice (P1.5)                               |
| Code générique         | Code personnalisé avec message texte généré par IA              |
| Montant fixe           | Montant libre + packs expérience + suggestions IA               |
| Cadeau anonyme         | Cadeau lié au CRM (expéditeur, destinataire, occasion)          |
| Utilisation manuelle   | Utilisation automatique au moment de la réservation             |
| Pas de cagnotte        | Cagnotte collective (P1)                                        |
| Pas de pack expérience | Packs "menu + vin", "dégustation", etc. gérés par le restaurant |

---

## 2. Périmètre

### In scope (P1)

- Modèle de données Prisma : `GiftCard`, `GiftCardPack`, `GiftCardRedemption`, `GiftCardContribution`.
- Cagnotte collective : création, contribution multi-contributeurs, déblocage automatique.
- Flux d’achat : web + widget (mode test / manuel en P1).
- Flux "réserver maintenant" : 3 créneaux proposés, choix du bénéficiaire, confirm sans CB.
- Flux d’utilisation classique : code valable 12 mois, saisie au confirm.
- Packs expérience : CRUD dashboard, affichage widget, achat pack.
- Concierge IA pour recommander le montant, le message et les créneaux.
- Dashboard restaurateur : cartes cadeaux, packs, stats par type.
- API routes admin + public.
- Intégration widget : bouton "Offrir".
- Tests et roadmap.

### Out of scope (P1)

- Paiement réel (Stripe) — mode test ou marquage manuel en P1.
- Cadeau physique / livraison (P3).
- Marketplace de cartes cadeaux entre restaurants (P3).
- Remboursement automatique (P2 ; P1 = annulation manuelle côté restaurateur).
- Multi-devise (P1 = EUR uniquement).
- Message vocal (P3).

---

## 3. Modèle de données Prisma

### Choix retenu

`GiftCard` est la source de vérité. `GiftCardRedemption` trace chaque utilisation pour permettre un solde restant et un historique. `GiftCardPack` liste les offres commerciales du restaurant. `GiftCardContribution` stocke les contributions individuelles à la cagnotte collective (P1).

`code` est unique et non-énumérable. P1 utilise un UUID ; P2 pourra ajouter un code court mnémonique avec rate-limiting et hash.

### Schema proposé

```prisma
model GiftCard {
  id              String   @id @default(uuid())
  restaurantId    String   @map("restaurant_id")
  code            String   @unique @default(uuid())
  amount          Decimal  @db.Decimal(10, 2)
  remainingAmount Decimal  @db.Decimal(10, 2) @map("remaining_amount")
  currency        String   @default("EUR")
  status          String   @default("ACTIVE") // ACTIVE, REDEEMED, EXPIRED, CANCELLED
  purchasedAt     DateTime @default(now()) @map("purchased_at")
  expiresAt       DateTime? @map("expires_at")
  validityMonths  Int      @default(12) @map("validity_months")

  // Montant libre ou pack expérience
  packId          String?   @map("pack_id")
  pack            GiftCardPack? @relation(fields: [packId], references: [id], onDelete: SetNull)

  // Option "réserver maintenant"
  preferredDate      DateTime? @map("preferred_date")
  preferredTime      String?   @map("preferred_time")
  preferredPartySize Int?      @map("preferred_party_size")

  senderName      String? @map("sender_name")
  senderEmail     String? @map("sender_email")
  senderPhone     String? @map("sender_phone")
  recipientName   String? @map("recipient_name")
  recipientEmail  String? @map("recipient_email")
  recipientPhone  String? @map("recipient_phone")

  message         String? // message texte personnalisé
  occasion        String? // anniversaire, remerciement, etc.

  customerId      String? @map("customer_id") // lien CRM (expéditeur ou destinataire)
  createdBy       String  @default("CLIENT") @map("created_by") // CLIENT, DASHBOARD, VOICE
  purchaseReference String? @map("purchase_reference") // référence de paiement (test P1)

  restaurant      Restaurant @relation(fields: [restaurantId], references: [id], onDelete: Cascade)
  customer        Customer?  @relation(fields: [customerId], references: [id], onDelete: SetNull)
  redemptions     GiftCardRedemption[]
  contributions   GiftCardContribution[]

  @@index([restaurantId, status])
  @@index([code])
  @@map("gift_cards")
}

model GiftCardPack {
  id            String   @id @default(uuid())
  restaurantId  String   @map("restaurant_id")
  name          String
  description   String?
  amount        Decimal  @db.Decimal(10, 2)
  minPartySize  Int      @default(1) @map("min_party_size")
  maxPartySize  Int      @default(2) @map("max_party_size")
  isActive      Boolean  @default(true) @map("is_active")

  restaurant    Restaurant @relation(fields: [restaurantId], references: [id], onDelete: Cascade)
  giftCards     GiftCard[]

  @@index([restaurantId, isActive])
  @@map("gift_card_packs")
}

model GiftCardRedemption {
  id            String    @id @default(uuid())
  giftCardId    String    @map("gift_card_id")
  reservationId String?   @map("reservation_id")
  amount        Decimal   @db.Decimal(10, 2)
  redeemedAt    DateTime  @default(now()) @map("redeemed_at")

  giftCard      GiftCard      @relation(fields: [giftCardId], references: [id], onDelete: Cascade)
  reservation   Reservation?  @relation(fields: [reservationId], references: [id], onDelete: SetNull)

  @@index([giftCardId])
  @@map("gift_card_redemptions")
}

model GiftCardContribution {
  id              String   @id @default(uuid())
  giftCardId      String   @map("gift_card_id")
  contributorName String?  @map("contributor_name")
  amount          Decimal  @db.Decimal(10, 2)
  contributedAt   DateTime @default(now()) @map("contributed_at")

  giftCard GiftCard @relation(fields: [giftCardId], references: [id], onDelete: Cascade)

  @@index([giftCardId])
  @@map("gift_card_contributions")
}

// Champ JSONB ajouté sur Reservation (P1) pour tracer l'application de carte cadeau.
model Reservation {
  // ... champs existants ...
  giftCardRedemptionSnap Json? @map("gift_card_redemption_snap")
  giftCardComplementAmount Decimal? @map("gift_card_complement_amount")
}
```

### Justification des champs

- `amount` / `remainingAmount` : montant initial et solde courant. `remainingAmount` est dénormalisé pour éviter un `SUM` à chaque usage.
- `validityMonths` : validité par défaut 12 mois. Détermine `expiresAt` si non fourni.
- `packId` / `GiftCardPack` : permet d’acheter une expérience prédéfinie (menu dégustation, accord mets/vins, etc.). `null` = montant libre.
- `preferredDate` / `preferredTime` / `preferredPartySize` : option "réserver maintenant". Stockés sur la carte pour proposer les créneaux au bénéficiaire.
- `sender*` / `recipient*` : personnalisation et envoi email/SMS. Obligatoire en production selon le canal.
- `message` : message texte personnalisé, généré ou édité par l’expéditeur.
- `occasion` : input du concierge IA pour recommander le montant, le message et les créneaux.
- `customerId` : lien CRM pour historique et segmentation.
- `createdBy` / `purchaseReference` : traçabilité de l’origine (web, dashboard, voice, test).
- `GiftCardContribution` : stocke les contributions individuelles à la cagnotte collective (P1). Chaque contribution est liée à une carte cadeau de type cagnotte.
- `Reservation.giftCardRedemptionSnap` : snapshot JSON de l’application (montant appliqué, complément, statut).

### Migrations requises

- `20260703013602_add_gift_cards` : création des tables `gift_cards`, `gift_card_redemptions`, `gift_card_contributions`.
- `20260703014532_add_gift_card_redemption_snap` : ajout de `gift_card_redemption_snap` sur `reservations`.
- Migrations P1 à venir :
  - création de `gift_card_packs`.
  - ajout de `pack_id`, `validity_months`, `preferred_date`, `preferred_time`, `preferred_party_size` sur `gift_cards`.
  - ajout de `gift_card_complement_amount` sur `reservations`.
- Option P1.5 : ajout de `Restaurant.giftCardEnabled` pour activer/désactiver la feature.

---

## 4. Flux d’achat

### 4.1 Choix du type de cadeau

```text
┌─────────────┐     ┌──────────────┐     ┌────────────────────────────┐
| Client      |────▶| Widget/site  |────▶| Montant libre ou pack ?      |
| (expéditeur)|     | "Offrir"     |     |                              |
└─────────────┘     └──────────────┘     └────────────────────────────┘
```

L’expéditeur choisit entre :

- **Montant libre** : il saisit un montant (min 10 €, suggestion IA).
- **Pack expérience** : il choisit un pack créé par le restaurant (ex. "Menu dégustation 2 personnes — 120 €").

### 4.2 Saisie des informations

Formulaire commun :

- Type de cadeau (montant libre / pack).
- Occasion (anniversaire, remerciement, affaires, romantique, départ, etc.).
- Expéditeur : nom, email, téléphone (optionnel).
- Destinataire : nom, email, téléphone (optionnel).
- Message texte personnalisé (généré par IA, éditable).
- **Option "Proposer directement des créneaux au destinataire"** (case à cocher).
  - Si cochée : fourchette de dates + nombre de personnes.
  - L’IA propose 3 créneaux disponibles.
- Paiement (P1 = mode test, P2 = Stripe).

### 4.3 Paiement et création

1. Validation du formulaire (Zod côté API).
2. Vérification de la disponibilité des créneaux si option "réserver maintenant".
3. Création de la `GiftCard` en statut `ACTIVE`.
   - `validityMonths` = 12 par défaut.
   - `expiresAt` = `purchasedAt + validityMonths` si non fourni.
   - `purchaseReference` = `'test'` en P1.
4. Envoi email/SMS au destinataire :
   - **Option classique** : code cadeau + URL de réservation.
   - **Option "réserver maintenant"** : lien `/gift-card/:code/slots` avec les 3 créneaux.

---

## 5. Flow "réserver maintenant" (optionnel)

```text
Bénéficiaire reçoit le lien
   │
   ▼
Page /gift-card/:code/slots
   │
   ▼
3 créneaux proposés (IA + disponibilité restaurant)
   │
   ▼
Choix du créneau
   │
   ▼
POST /public/gift-cards/:code/book
   │
   ▼
Confirm sans saisie de CB (carte cadeau appliquée)
   │
   ▼
Réservation confirmée
```

### Endpoints publics

- `POST /public/gift-cards/:code/slots`
  - Body : `{ preferredDate, preferredTime, preferredPartySize }` (optionnel, peut être lu depuis la carte).
  - Response : `{ slots: [{ date, time, tableId? }] }` — 3 créneaux disponibles.
- `POST /public/gift-cards/:code/book`
  - Body : `{ slotIndex, customer }`.
  - Response : `{ reservationId, status, giftCardApplication }`.
  - Le backend appelle `reservation.service.createReservation` avec `giftCardCode` et `giftCardReservationAmount`.

### Règles métier

- Si le montant du pack couvre exactement la réservation : aucun complément.
- Si le montant est inférieur : statut `COMPLEMENT_REQUIRED`, la réservation est créée mais marquée comme en attente de paiement.
- Si le montant est supérieur : le solde reste sur la carte (`PARTIAL`).

---

## 6. Flow classique (code valable 12 mois)

Le bénéficiaire reçoit un code. Il peut :

1. Réserver via le widget / le site / le voice (P1.5).
2. Saisir le code au moment du `confirm` (`POST /public/r/:slug/confirm`).
3. Le backend appelle `GiftCardService.applyToReservation` après la création de la réservation.

---

## 7. Packs expérience

### Dashboard restaurateur

Page `/dashboard/gift-card-packs` :

- Liste des packs avec nom, description, montant, party size, actif/inactif.
- Bouton "Créer un pack".
- Formulaire : nom, description, montant, `minPartySize`, `maxPartySize`, actif.
- Actions : modifier, activer/désactiver, supprimer (soft-delete via `isActive=false` en P1).

### Widget

Étape 1 : choix "Montant libre" ou "Pack expérience".
Si "Pack" : affichage de la liste des packs actifs avec leur description et montant.

### API admin

- `GET /restaurants/:id/gift-card-packs`
- `POST /restaurants/:id/gift-card-packs`
- `PATCH /restaurants/:id/gift-card-packs/:packId`
- `POST /restaurants/:id/gift-card-packs/:packId/toggle`
- `DELETE /restaurants/:id/gift-card-packs/:packId` (P1.5 : soft-delete)

---

## 8. Cagnotte collective (P1)

### Modèle

`GiftCardContribution` stocke les contributions. La cagnotte utilise :

- `GiftCard.isCagnotte` : boolean.
- `GiftCard.targetAmount` : montant cible.
- `GiftCard.contributions` : liste des contributeurs.

### Flow

1. L’expéditeur crée une cagnotte avec un montant cible et une date de clôture.
2. Partage du lien `/public/gift-cards/:code/contribute`.
3. Les contributeurs saisissent leur nom et montant.
4. Déblocage automatique quand `SUM(contributions) >= targetAmount`.
5. La carte passe en `ACTIVE` et le bénéficiaire reçoit le code.

### Endpoints publics P1

- `POST /public/gift-cards/:code/contribute`
- `GET /public/gift-cards/:code/progress`

---

## 9. Routes API

### Routes admin (restaurateur)

Base : `/restaurants/:id/gift-cards`

| Méthode | Route                                            | Description                                                        |
| ------- | ------------------------------------------------ | ------------------------------------------------------------------ |
| GET     | `/restaurants/:id/gift-cards`                    | Liste paginée avec filtres status, search, limit, offset.          |
| POST    | `/restaurants/:id/gift-cards`                    | Créer une carte manuelle (montant libre ou pack).                  |
| GET     | `/restaurants/:id/gift-cards/:giftCardId`        | Détail avec redemptions.                                           |
| PATCH   | `/restaurants/:id/gift-cards/:giftCardId`        | Modifier message/destinataire/expiration (montant non modifiable). |
| POST    | `/restaurants/:id/gift-cards/:giftCardId/cancel` | Annuler la carte.                                                  |
| GET     | `/restaurants/:id/gift-cards/stats`              | Stats globales.                                                    |

Base : `/restaurants/:id/gift-card-packs`

| Méthode | Route                                             | Description         |
| ------- | ------------------------------------------------- | ------------------- |
| GET     | `/restaurants/:id/gift-card-packs`                | Liste des packs.    |
| POST    | `/restaurants/:id/gift-card-packs`                | Créer un pack.      |
| PATCH   | `/restaurants/:id/gift-card-packs/:packId`        | Modifier un pack.   |
| POST    | `/restaurants/:id/gift-card-packs/:packId/toggle` | Activer/désactiver. |
| DELETE  | `/restaurants/:id/gift-card-packs/:packId`        | Supprimer (P1.5).   |

### Routes publics

Base : `/public/gift-cards`

| Méthode | Route                            | Description                                         | Rate limit |
| ------- | -------------------------------- | --------------------------------------------------- | ---------- |
| POST    | `/public/gift-cards/check`       | Vérifier solde et validité.                         | 30/min     |
| POST    | `/public/gift-cards/recommend`   | Recommander un montant et un message.               | 30/min     |
| POST    | `/public/gift-cards/purchase`    | Acheter une carte (mode test P1).                   | 10/min     |
| POST    | `/public/gift-cards/apply`       | Appliquer une carte à une réservation existante.    | 20/min     |
| POST    | `/public/gift-cards/:code/slots` | Proposer 3 créneaux (option "réserver maintenant"). | 30/min     |
| POST    | `/public/gift-cards/:code/book`  | Confirmer un créneau avec la carte.                 | 10/min     |

### Intégration Connect

- `POST /public/r/:slug/confirm` accepte `giftCardCode` dans le body.
- Le backend calcule un montant estimé (`priceRange * 25 * partySize`) et applique la carte cadeau après la création de la réservation.
- La réponse inclut `giftCardApplication`.

---

## 10. Dashboard UI

### Onglet "Cartes cadeaux"

- Liste avec colonnes :
  - Code (masqué).
  - Type : "Montant libre" ou "Pack : [nom du pack]".
  - Montant / solde.
  - Destinataire.
  - Statut (ACTIVE, REDEEMED, EXPIRED, CANCELLED).
  - "Réservation clé en main" (oui/non + créneau si confirmé).
  - Date d’achat / expiration.
- Filtres : statut, type, recherche.
- Bouton "Créer une carte manuelle" avec choix montant libre / pack.
- Bouton d’annulation.
- Stats globales : CA vendu, solde restant, nombre par type, nombre par statut.

### Onglet "Packs cadeaux"

- Liste des packs.
- Formulaire de création/édition.
- Activation/désactivation.

---

## 11. Widget UI

### Étape 1 : choix du type

Deux boutons : "Montant libre" / "Pack expérience".

### Étape 2 : contenu

- **Montant libre** : champ montant + suggestion IA.
- **Pack** : liste des packs actifs avec carte (nom, description, montant, party size).

### Étape 3 : infos et message

- Occasion.
- Expéditeur / destinataire.
- Message texte (généré par IA, éditable).

### Étape 4 : option "réserver maintenant"

- Case à cocher "Proposer directement des créneaux au destinataire".
- Si cochée : calendrier pour la fourchette de dates + nombre de personnes.
- Affichage des 3 créneaux proposés.

### Étape 5 : paiement et confirmation

- Paiement mode test (P1).
- Récapitulatif + confirmation.

---

## 12. Concierge IA

### Recommandations

- Montant selon `priceRange`, `occasion`, `partySize`, `budget`.
- Message texte selon l’occasion et le destinataire.
- Créneaux selon la disponibilité du restaurant et les préférences.

### Implémentation

- Service `gift-card-recommender.ts` pour montant et message.
- Service à créer pour la proposition de créneaux (réutilise `AvailabilityService` + `TableAllocationService`).

---

## 13. Roadmap

### P1 (actuel)

- Modèle de données : `GiftCard`, `GiftCardPack`, `GiftCardRedemption`, `GiftCardContribution`.
- Service core : `GiftCardService`, `GiftCardRecommender`.
- Routes admin + public.
- Packs expérience.
- Option "réserver maintenant" (3 créneaux).
- Dashboard cartes cadeaux + packs.
- Widget achat.
- Tests.

### P1.5

- Voice : dialogue d’achat par téléphone.
- Amélioration UI cagnotte collective.
- Soft-delete des packs.
- Activation par restaurant (`Restaurant.giftCardEnabled`).

### P2

- Paiement Stripe réel.
- Codes courts mnémoniques.
- Rappels automatiques si carte non utilisée.
- Remboursement automatique.

### P3

- Marketplace entre restaurants.
- Cadeaux physiques.
- Message vocal (TTS / agent).
- Multi-devise.

---

## 14. Fichiers à modifier

### Modèle de données

- `packages/database/prisma/schema.prisma`
- `packages/database/prisma/migrations/2026XXXXXX_add_gift_card_packs/migration.sql`
- `packages/database/prisma/migrations/2026XXXXXX_update_gift_card_fields/migration.sql`

### API

- `apps/api/src/modules/gift-cards/gift-card.types.ts`
- `apps/api/src/modules/gift-cards/gift-card.service.ts`
- `apps/api/src/modules/gift-cards/gift-card-recommender.ts`
- `apps/api/src/modules/gift-cards/gift-card.routes.ts`
- `apps/api/src/modules/gift-cards/gift-card-pack.service.ts` (nouveau)
- `apps/api/src/modules/gift-cards/gift-card-pack.routes.ts` (nouveau)
- `apps/api/src/modules/gift-cards/gift-card-slots.service.ts` (nouveau)
- `apps/api/src/modules/gift-cards/__tests__/gift-card.service.test.ts`
- `apps/api/src/modules/gift-cards/__tests__/gift-card.routes.test.ts`
- `apps/api/src/modules/gift-cards/__tests__/gift-card-pack.test.ts` (nouveau)
- `apps/api/src/main.ts`

### Dashboard

- `apps/dashboard/src/app/dashboard/gift-cards/page.tsx` (nouveau)
- `apps/dashboard/src/app/dashboard/gift-card-packs/page.tsx` (nouveau)
- `apps/dashboard/src/components/gift-cards/gift-card-list.tsx` (nouveau)
- `apps/dashboard/src/components/gift-cards/gift-card-form.tsx` (nouveau)
- `apps/dashboard/src/components/gift-cards/gift-card-pack-form.tsx` (nouveau)
- `apps/dashboard/src/lib/api/gift-cards.ts` (nouveau)
- `apps/dashboard/src/components/layout/nav.tsx` (ajout des liens)

### Widget / Connect

- `apps/connect/src/app/gift-card/page.tsx` ou composant widget (nouveau)
- `apps/connect/src/lib/api/gift-cards.ts` (nouveau)
- `apps/api/src/modules/connect/connect.routes.ts` (déjà mis à jour pour `giftCardCode`)
- `apps/api/src/modules/connect/connect.types.ts` (déjà mis à jour)

### Tests

- Tests unitaires et d’intégration pour les nouveaux services et routes.
- Mise à jour des tests existants si le modèle de données évolue.

---

## 15. Critères d’acceptation

- [x] Le message vocal est retiré de P1.
- [x] L’option "réserver maintenant" est clairement optionnelle.
- [x] La carte cadeau a une validité par défaut de 12 mois.
- [x] Les packs expérience sont intégrés dans le modèle, l’API et le dashboard.
- [x] La cagnotte collective est implémentée en P1 (modèle, API, widget, dashboard).
- [x] Le dashboard expose les cartes cadeaux et les packs.
- [x] Le widget permet de choisir entre montant libre et pack.
- [x] Le copy est en français avec `vous`.
- [x] Les tests passent : `pnpm --filter @suppernote/api test` et `pnpm --filter @suppernote/api typecheck`.

---

## 16. shortCode mnémonique (P2 complémentaire)

### Format

- `SKR-XXXX-XX` (ex: `SKR-X7F2-9K`)
- Alphabet : `ABCDEFGHJKMNPQRSTUVWXYZ23456789` (exclut 0, O, I, L pour éviter la confusion visuelle)
- Le code UUID reste l'identifiant technique. Le shortCode est un alias public lisible.

### Génération

- `gift-card-code.util.ts` : `generateShortCode()` + `generateUniqueShortCode(prisma)` (vérif DB, max 10 tentatives)
- Appelé automatiquement dans `GiftCardService.create()`

### Routes acceptant shortCode ou UUID

- `GET /public/gift-cards/:code/pdf` — détecte `SKR-` pour choisir shortCode vs UUID
- `POST /public/gift-cards/check` — `validateCode()` accepte les deux
- `POST /public/gift-cards/:code/slots` — via `findByCodeOrShortCodeWithPack`
- `POST /public/gift-cards/:code/book` — via `findByCodeOrShortCodeWithPack`

### Affichage

- **PDF** : shortCode en grand (18pt), code UUID en petit (8pt, "Référence : ...")
- **Emails** : shortCode en grand (28pt), code UUID en petit (11pt)
- **Connect (confirmation)** : shortCode en grand (2xl), code UUID en petit (10px)
- **Dashboard (liste)** : shortCode en gras + code UUID en petit

### Backfill des cartes existantes

Un script idempotent génère des shortCodes pour les cartes existantes sans shortCode :

```bash
npx tsx apps/api/scripts/backfill-gift-card-shortcodes.ts
```

- Récupère toutes les cartes avec `shortCode IS NULL`
- Génère un shortCode unique pour chacune via `generateUniqueShortCode`
- Log le nombre de cartes traitées
- Idempotent : les cartes avec shortCode sont ignorées
- À exécuter en local d'abord, puis en production après déploiement
