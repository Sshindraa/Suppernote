BEGIN;

DO $$
DECLARE
  legacy_id TEXT;
  canonical_id TEXT;
BEGIN
  SELECT id INTO legacy_id
  FROM "Restaurant"
  WHERE slug = 'chez-sokar-demo'
  FOR UPDATE;

  SELECT id INTO canonical_id
  FROM "Restaurant"
  WHERE slug = 'chez-suppernote-demo'
  FOR UPDATE;

  IF legacy_id IS NULL AND canonical_id IS NOT NULL THEN
    RAISE NOTICE 'Demo slug is already canonical.';
  ELSIF legacy_id IS NULL THEN
    RAISE EXCEPTION 'No demo restaurant found with either slug.';
  ELSIF canonical_id IS NOT NULL THEN
    RAISE EXCEPTION 'Both demo slugs are occupied; refusing to change either restaurant.';
  ELSE
    UPDATE "Restaurant"
    SET slug = 'chez-suppernote-demo'
    WHERE id = legacy_id AND slug = 'chez-sokar-demo';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM "Restaurant" WHERE slug = 'chez-suppernote-demo'
  ) OR EXISTS (
    SELECT 1 FROM "Restaurant" WHERE slug = 'chez-sokar-demo'
  ) THEN
    RAISE EXCEPTION 'Demo restaurant slug migration did not leave only the canonical slug.';
  END IF;
END $$;

COMMIT;
