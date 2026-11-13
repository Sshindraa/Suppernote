-- Empreinte bancaire de réservation : colonnes additives, aucune suppression.
ALTER TABLE "reservation_payments"
  ADD COLUMN "stripe_customer_id" TEXT,
  ADD COLUMN "stripe_payment_method_id" TEXT,
  ADD COLUMN "stripe_checkout_session_id" TEXT,
  ADD COLUMN "captured_amount" DECIMAL(10,2),
  ADD COLUMN "refunded_amount" DECIMAL(10,2),
  ADD COLUMN "terms_accepted_at" TIMESTAMP(3),
  ADD COLUMN "captured_by_user_id" TEXT,
  ADD COLUMN "dispute_status" TEXT;

CREATE UNIQUE INDEX "reservation_payments_stripe_checkout_session_id_key"
  ON "reservation_payments"("stripe_checkout_session_id");
