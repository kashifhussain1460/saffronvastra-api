-- Garment measurements per size (JSON, nullable): additive, existing rows keep NULL until seeded.
ALTER TABLE "products" ADD COLUMN "measurements" JSONB;
