-- Idempotent re-application of the business-rule guards from
-- prisma/migrations/20260101000100_business_constraints.
--
-- Why this file exists: `prisma db push` recreates tables from schema.prisma,
-- but the Prisma schema language cannot express CHECK constraints, so a pushed
-- table comes back WITHOUT the no-negative-stock guards. Run this straight
-- after a db push to put them back.
--
-- Safe to run repeatedly: every statement checks first, so constraints that
-- already exist are left alone instead of erroring.

DO $$
BEGIN
  -- batches ------------------------------------------------------------------
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'batches_quantity_positive') THEN
    ALTER TABLE "batches" ADD CONSTRAINT "batches_quantity_positive" CHECK ("quantity" > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'batches_remaining_qty_non_negative') THEN
    ALTER TABLE "batches" ADD CONSTRAINT "batches_remaining_qty_non_negative" CHECK ("remaining_qty" >= 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'batches_remaining_qty_lte_quantity') THEN
    ALTER TABLE "batches" ADD CONSTRAINT "batches_remaining_qty_lte_quantity" CHECK ("remaining_qty" <= "quantity");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'batches_unit_cost_non_negative') THEN
    ALTER TABLE "batches" ADD CONSTRAINT "batches_unit_cost_non_negative" CHECK ("unit_cost" >= 0);
  END IF;

  -- sales --------------------------------------------------------------------
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sales_quantity_positive') THEN
    ALTER TABLE "sales" ADD CONSTRAINT "sales_quantity_positive" CHECK ("quantity" > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sales_sale_price_non_negative') THEN
    ALTER TABLE "sales" ADD CONSTRAINT "sales_sale_price_non_negative" CHECK ("sale_price" >= 0);
  END IF;

  -- products -----------------------------------------------------------------
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'products_default_sale_price_non_negative') THEN
    ALTER TABLE "products" ADD CONSTRAINT "products_default_sale_price_non_negative" CHECK ("default_sale_price" >= 0);
  END IF;
END $$;

-- Partial indexes behind the batch picker and the dashboard aggregates.
CREATE INDEX IF NOT EXISTS "batches_available_idx"
  ON "batches" ("product_id", "received_date")
  WHERE "is_deleted" = false AND "remaining_qty" > 0;

CREATE INDEX IF NOT EXISTS "sales_live_by_date_idx"
  ON "sales" ("sale_date", "product_id", "area_id")
  WHERE "is_deleted" = false;

-- payments -------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'payments_amount_positive') THEN
    ALTER TABLE "payments" ADD CONSTRAINT "payments_amount_positive" CHECK ("amount" > 0);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "payments_live_idx"
  ON "payments" ("booking_id", "paid_on")
  WHERE "is_deleted" = false;
