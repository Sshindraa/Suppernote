-- Lien court de gestion (SMS) : colonnes additives, aucune suppression.
ALTER TABLE "reservations"
  ADD COLUMN "management_short_code" TEXT,
  ADD COLUMN "management_short_code_phone" TEXT;

CREATE UNIQUE INDEX "reservations_management_short_code_key"
  ON "reservations"("management_short_code");
