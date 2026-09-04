/**
 * What a dump looks like, shared by the writer and the reader.
 *
 * Its own module on purpose, with no side effects. The loader used to import
 * these from dump-db.ts, which calls main() at the top level - so importing a
 * constant ran a whole dump of the live database and the load never happened.
 * A module you import for a type must not do anything when imported.
 */

/**
 * Parents before children.
 *
 * Restoring in this order means every foreign key already has something to
 * point at, so no deferred constraints or disabled triggers are needed.
 * Deleting walks it backwards.
 */
export const TABLE_ORDER = [
  "categories",
  "areas",
  "shops",
  "products",
  "bookers",
  "booker_areas",
  "batches",
  "bookings",
  "sales",
  "payments",
  "invoice_counters",
  "audit_logs",
] as const;

export type Dump = {
  takenAt: string;
  /** Host it came from, so the loader can refuse to write it back there. */
  sourceHost: string;
  tables: Record<string, Record<string, unknown>[]>;
};

export function hostOf(url: string | undefined): string {
  if (!url) return "unknown";
  try {
    return new URL(url).host;
  } catch {
    return "unknown";
  }
}
