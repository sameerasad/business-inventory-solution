-- Database-level guards for the business rules. The Prisma schema language cannot
-- express CHECK constraints, so they live in this hand-written migration.
-- The application validates the same rules first; these are the backstop that
-- makes negative inventory impossible even under a race or a bad manual UPDATE.

-- No negative inventory, and you can never have more left than you received.
ALTER TABLE "batches"
  ADD CONSTRAINT "batches_quantity_positive" CHECK ("quantity" > 0),
  ADD CONSTRAINT "batches_remaining_qty_non_negative" CHECK ("remaining_qty" >= 0),
  ADD CONSTRAINT "batches_remaining_qty_lte_quantity" CHECK ("remaining_qty" <= "quantity"),
  ADD CONSTRAINT "batches_unit_cost_non_negative" CHECK ("unit_cost" >= 0);

ALTER TABLE "sales"
  ADD CONSTRAINT "sales_quantity_positive" CHECK ("quantity" > 0),
  ADD CONSTRAINT "sales_sale_price_non_negative" CHECK ("sale_price" >= 0);

ALTER TABLE "products"
  ADD CONSTRAINT "products_default_sale_price_non_negative" CHECK ("default_sale_price" >= 0);

-- Partial index: the "pick a batch for this sale" dropdown only ever looks at
-- live batches that still have stock, so index exactly those rows.
CREATE INDEX "batches_available_idx"
  ON "batches" ("product_id", "received_date")
  WHERE "is_deleted" = false AND "remaining_qty" > 0;

-- Partial index for the dashboard aggregates, which always filter is_deleted = false.
CREATE INDEX "sales_live_by_date_idx"
  ON "sales" ("sale_date", "product_id", "area_id")
  WHERE "is_deleted" = false;
