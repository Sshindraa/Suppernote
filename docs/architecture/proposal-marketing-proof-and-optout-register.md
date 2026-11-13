# Proposition : preuve du consentement complète et liste d'opposition séparée

Statut : **acceptée le 23/10/2026 et implémentée** (durée 3 ans, portée par restaurant, texte présenté et
auteur conservés ; migration `20261023120000_marketing_opt_out_register`). Le texte d'origine de la
proposition suit.

Ancien statut : proposition à relire, rien n'était appliqué. Le SQL ci-dessous a été généré avec
`prisma migrate diff --from-schema-datamodel <schéma actuel> --to-schema-datamodel <schéma proposé> --script`
(aucune base n'a été contactée) ; il ne contient ni `DROP` ni `TRUNCATE`.

Contexte : relecture juridique du runbook [`marketing-email-pilot.md`](../runbooks/marketing-email-pilot.md)
(§4, « Limites connues de la preuve » et « Durées de conservation »). Deux manques y sont relevés avant
d'écrire à de vrais clients. Ils ne bloquent pas le pilote interne.

## 1. Ce qui manque aujourd'hui

1. **La preuve ne permet pas de restituer ce que le client a vu.** `MarketingPermissionEvent` garde la version
   du texte et l'empreinte SHA-256 de `version|canal|phrase`, mais pas la phrase. Le texte est reconstruit
   avec le **nom actuel** du restaurant : si ce nom change, l'empreinte ne se vérifie plus.
2. **Une saisie par le restaurant ne dit pas qui l'a faite.** Seule la méthode (`DASHBOARD_IN_PERSON`,
   `DASHBOARD_PHONE`, `DASHBOARD_PAPER`) est conservée.
3. **Un désinscrit disparaît avec sa fiche.** L'effacement RGPD (`erasure.service.ts`) supprime les
   `MarketingPermission`, `MarketingPermissionEvent` et `MarketingSuppression` du client. Si la personne est
   ensuite réimportée (nouvelle réservation, import), rien ne rappelle qu'elle s'était opposée : elle
   pourrait être sollicitée de nouveau.

## 2. Proposition A : deux colonnes sur le journal d'événements

Sur `MarketingPermissionEvent` (journal en ajout seul, une ligne par changement) :

| Colonne                              | Contenu                                                                                                                                |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| `proof_text` (texte, optionnelle)    | La phrase exacte présentée, avec le nom du restaurant **à ce moment-là**. Ce n'est pas une donnée personnelle (phrase commune à tous). |
| `actor_user_id` (texte, optionnelle) | Identifiant opaque du membre de l'équipe qui a saisi ou retiré un accord ; `NULL` quand c'est le client lui-même.                      |

Effets : l'empreinte reste vérifiable même si le nom du restaurant change ; une saisie manuelle devient
attribuable. L'ADR dit que « le texte brut n'est pas stocké dans le ledger » : cette décision est revue ici,
car le texte n'est pas personnel et sa conservation sert la preuve (art. 7 RGPD). Les lignes existantes
restent à `NULL` (rien à rétro-remplir ; leur preuve reste l'empreinte seule).

Côté code : `upsertMarketingPermission` accepte `proofText` et `actorUserId` optionnels ;
`recordBookingMarketingConsent` et `recordStaffMarketingConsent` les renseignent (l'auteur vient de la
session Clerk de la route).

## 3. Proposition B : un registre d'opposition minimal

Nouvelle table `marketing_opt_outs`, **sans lien avec la fiche client**, qui survit à son effacement :

| Colonne                        | Contenu                                                                                                                 |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `restaurant_id`                | Restaurant (suppression en cascade avec le restaurant).                                                                 |
| `channel`                      | `EMAIL`, `SMS` ou `WHATSAPP`.                                                                                           |
| `address_hash`                 | **HMAC-SHA256** de l'adresse e-mail normalisée ou du téléphone E.164, avec une clé serveur. Jamais l'adresse elle-même. |
| `reason`, `source`             | `UNSUBSCRIBE`, `COMPLAINT` ou `MANUAL` ; d'où vient l'opposition (lien, dashboard).                                     |
| `opted_out_at`, `retain_until` | Date de l'opposition et date de purge (durée à décider, voir §5).                                                       |

Unicité : `(restaurant_id, channel, address_hash)`.

Règles :

- **Écriture** : à chaque retrait (lien de désinscription, retrait dans le dashboard) et à chaque plainte.
  Les rebonds définitifs restent dans `MarketingSuppression` seulement (c'est de la délivrabilité, pas une
  opposition).
- **Lecture** : l'aperçu d'audience et le contrôle de dernière minute avant envoi excluent tout destinataire
  dont le hachage figure au registre (nouvelle raison d'exclusion `OPTED_OUT_REGISTER`). Il gagne sur une
  `MarketingPermission` `OPTED_IN`.
- **Effacement RGPD** : le registre n'est **pas** supprimé avec la fiche (c'est son rôle). Il est purgé à
  `retain_until` par une tâche planifiée distincte.
- **Réinscription** : une personne qui coche de nouveau la case après s'être opposée est un nouvel acte
  explicite : l'écriture de la nouvelle permission `OPTED_IN` retire la ligne du registre correspondante
  (et le journal d'événements garde la trace des deux actes).
- **Un hachage n'est pas anonyme** : un SHA-256 simple d'une adresse se retrouve par dictionnaire. D'où le
  HMAC avec une clé serveur. Le registre reste une donnée personnelle pseudonymisée : il doit figurer dans la
  politique et dans l'annexe client (finalité : ne pas solliciter de nouveau une personne qui s'est opposée).

### Nouveau secret

`MARKETING_OPTOUT_HASH_SECRET` (≥ 32 caractères, distinct des autres secrets marketing), lu uniquement dans
l'environnement (`key_env`), documenté dans `docs/runbooks/environment.md`, posé à la main dans
`apps/api/.env` du VPS comme les autres secrets marketing. **Perdre ou changer cette clé rend le registre
inutilisable** (les hachages ne correspondent plus) : sauvegarde de la clé obligatoire ; sans clé, l'API
refuse d'envoyer plutôt que d'ignorer le registre.

## 4. Schéma Prisma proposé (non appliqué)

```prisma
model MarketingPermissionEvent {
  // …champs existants inchangés…
  proofText    String?  @map("proof_text")
  actorUserId  String?  @map("actor_user_id")
}

model MarketingOptOut {
  id           String           @id @default(uuid())
  restaurantId String           @map("restaurant_id")
  channel      MarketingChannel
  addressHash  String           @map("address_hash")
  reason       String
  source       String
  optedOutAt   DateTime         @map("opted_out_at")
  retainUntil  DateTime         @map("retain_until")
  createdAt    DateTime         @default(now()) @map("created_at")

  restaurant Restaurant @relation(fields: [restaurantId], references: [id], onDelete: Cascade)

  @@unique([restaurantId, channel, addressHash], map: "marketing_opt_outs_restaurant_channel_hash_key")
  @@index([retainUntil], map: "marketing_opt_outs_retain_until_idx")
  @@map("marketing_opt_outs")
}

// et, dans model Restaurant : marketingOptOuts MarketingOptOut[]
```

## 5. Migration à relire (SQL généré, non appliqué)

```sql
-- AlterTable
ALTER TABLE "marketing_permission_events" ADD COLUMN     "actor_user_id" TEXT,
ADD COLUMN     "proof_text" TEXT;

-- CreateTable
CREATE TABLE "marketing_opt_outs" (
    "id" TEXT NOT NULL,
    "restaurant_id" TEXT NOT NULL,
    "channel" "MarketingChannel" NOT NULL,
    "address_hash" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "opted_out_at" TIMESTAMP(3) NOT NULL,
    "retain_until" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "marketing_opt_outs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "marketing_opt_outs_retain_until_idx" ON "marketing_opt_outs"("retain_until");

-- CreateIndex
CREATE UNIQUE INDEX "marketing_opt_outs_restaurant_channel_hash_key" ON "marketing_opt_outs"("restaurant_id", "channel", "address_hash");

-- AddForeignKey
ALTER TABLE "marketing_opt_outs" ADD CONSTRAINT "marketing_opt_outs_restaurant_id_fkey" FOREIGN KEY ("restaurant_id") REFERENCES "restaurants"("id") ON DELETE CASCADE ON UPDATE CASCADE;
```

Points de revue :

- **Additive et sans perte** : deux colonnes nullables sur une table existante (pas de réécriture de table,
  verrou très court) et une table neuve vide. Aucune donnée n'est lue ni modifiée.
- **Déploiement** : fichier de migration normal sous `packages/database/prisma/migrations/`, appliqué par
  `prisma migrate deploy` via `scripts/deploy.sh`, jamais de `db push` distant. Avant l'application : relire
  le diff (`prisma migrate diff --from-url --to-schema-datamodel --script`) et vérifier l'absence de
  `DROP`/`TRUNCATE`, sauvegarde préalable comme pour toute migration.
- **Retour arrière** : le code doit d'abord ignorer les nouveaux champs (déploiement du code, puis de la
  migration, jamais l'inverse). Ensuite `ALTER TABLE … DROP COLUMN` et `DROP TABLE marketing_opt_outs` ne
  perdent aucune donnée existante ; ils perdent seulement ce que les nouveaux champs auraient accumulé.

## 6. Reprise de l'existant (hors migration SQL)

Le HMAC exige la clé du serveur : le remplissage initial **ne peut pas se faire en SQL**. Un script à
exécuter une fois (avec `--dry-run` d'abord, nombre de lignes affiché sans adresse) inscrit au registre les
`MarketingPermission` `OPTED_OUT` et les `MarketingSuppression` de raison `UNSUBSCRIBE` ou `COMPLAINED`
dont la fiche a une adresse ou un téléphone. Aucun envoi n'a encore eu lieu en production : le volume à
reprendre est probablement nul ou très faible.

## 7. Décisions attendues de Hamza

1. **Durée de conservation du registre** (`retain_until`). La CNIL recommande au moins 3 ans pour la liste
   d'opposition ; cette durée est une recommandation à confirmer, pas une règle universelle. Proposition :
   3 ans à partir de l'opposition, puis purge.
2. **Stockage du texte présenté** (`proof_text`) : accord pour revenir sur « le texte brut n'est pas stocké »
   de l'ADR.
3. **Identifiant de l'auteur** (`actor_user_id`) : accord pour conserver un identifiant opaque de membre
   d'équipe dans le journal (visible dans l'export RGPD du client ?). À trancher avec la politique.
4. **Portée du registre** : par restaurant (proposé : une opposition envers un restaurant ne vaut pas pour un
   autre) ou commune à tous les restaurants de Suppernote.
5. **Mention** du registre dans la politique de confidentialité et l'annexe client, avant écriture à de vrais
   clients.

## 8. Ordre de travail si la proposition est acceptée

1. Migration + schéma + client Prisma régénéré (une PR dédiée, migration relue, signalée en tête).
2. Service de registre (hachage HMAC, écriture, lecture, purge) + clé `MARKETING_OPTOUT_HASH_SECRET`
   documentée dans `environment.md`.
3. Branchement : retrait (lien, dashboard), plainte, aperçu d'audience, contrôle avant envoi,
   réinscription, effacement RGPD (le registre est conservé).
4. `proof_text` et `actor_user_id` dans le service de permission et les deux routes d'enregistrement.
5. Script de reprise de l'existant (`--dry-run`), puis tests : concurrence d'inscription et de retrait,
   effacement puis réimport, clé absente, aucune adresse dans les journaux.

Rien de cela n'est nécessaire pour le pilote interne sur adresses de test ; tout est nécessaire avant les
premiers vrais clients.
