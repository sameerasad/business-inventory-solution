import { z } from "zod";
import { isDateOnly } from "@/lib/dates";

/* ------------------------------------------------------------------ helpers */

const dateOnlyString = z
  .string()
  .trim()
  .min(1, "Date is required")
  .refine(isDateOnly, "Date must be a valid YYYY-MM-DD calendar date");

/**
 * FormData gives us strings for everything. These coercers turn "" into a
 * validation error rather than a silent 0, which is the whole point.
 */
const positiveInt = (label: string) =>
  z
    .string()
    .trim()
    .min(1, `${label} is required`)
    .refine((v) => /^\d+$/.test(v), `${label} must be a whole number`)
    .transform((v) => Number.parseInt(v, 10))
    .refine((n) => n > 0, `${label} must be greater than 0`)
    .refine((n) => n <= 100_000_000, `${label} is unrealistically large`);

const nonNegativeMoney = (label: string) =>
  z
    .string()
    .trim()
    .min(1, `${label} is required`)
    .refine((v) => /^\d+(\.\d{1,2})?$/.test(v), `${label} must be a number with at most 2 decimals`)
    .transform((v) => Number.parseFloat(v))
    .refine((n) => Number.isFinite(n) && n >= 0, `${label} cannot be negative`)
    .refine((n) => n <= 10_000_000, `${label} is unrealistically large`);

const dbId = (label: string) =>
  z
    .string()
    .trim()
    .min(1, `${label} is required`)
    .refine((v) => /^[1-9]\d*$/.test(v), `${label} is required`)
    .transform((v) => Number.parseInt(v, 10));

const optionalDbId = z
  .string()
  .trim()
  .optional()
  .transform((v) => (v === undefined || v === "" || v === "none" ? null : v))
  .refine((v) => v === null || /^[1-9]\d*$/.test(v), "Invalid selection")
  .transform((v) => (v === null ? null : Number.parseInt(v, 10)));

const optionalNotes = z
  .string()
  .trim()
  .max(1000, "Notes cannot exceed 1000 characters")
  .optional()
  .transform((v) => (v ? v : null));

const shortName = (label: string, max = 120) =>
  z
    .string()
    .trim()
    .min(1, `${label} is required`)
    .max(max, `${label} cannot exceed ${max} characters`);

/**
 * Idempotency key. The form mints one per render; a double-submit reuses it and
 * the unique index turns the second write into a no-op instead of a duplicate
 * stock movement. Optional so the actions still work if JS is disabled.
 */
const idempotencyKey = z
  .string()
  .trim()
  .max(100)
  .optional()
  .transform((v) => (v ? v : null));

/* ------------------------------------------------------------------- schemas */

export const createBatchSchema = z.object({
  productId: dbId("Product"),
  quantity: positiveInt("Quantity"),
  unitCost: nonNegativeMoney("Unit cost"),
  receivedDate: dateOnlyString,
  notes: optionalNotes,
  idempotencyKey,
});
export type CreateBatchInput = z.infer<typeof createBatchSchema>;

export const createSaleSchema = z.object({
  productId: dbId("Product"),
  batchId: dbId("Batch"),
  areaId: dbId("Area"),
  shopId: optionalDbId,
  quantity: positiveInt("Quantity"),
  salePrice: nonNegativeMoney("Sale price"),
  saleDate: dateOnlyString,
  notes: optionalNotes,
  idempotencyKey,
});
export type CreateSaleInput = z.infer<typeof createSaleSchema>;

export const createProductSchema = z.object({
  categoryId: dbId("Category"),
  name: shortName("Product name"),
  packagingType: shortName("Packaging type", 60),
  variantValue: shortName("Variant / volume", 60),
  // Blank SKU means "generate one for me" - see deriveSku().
  sku: z
    .string()
    .trim()
    .max(40, "SKU cannot exceed 40 characters")
    .optional()
    .transform((v) => (v ? v.toUpperCase() : null))
    .refine(
      (v) => v === null || /^[A-Z0-9][A-Z0-9-]*$/.test(v),
      "SKU may only contain letters, digits and dashes",
    ),
  unit: shortName("Unit", 40),
  defaultSalePrice: nonNegativeMoney("Default sale price"),
});
export type CreateProductInput = z.infer<typeof createProductSchema>;

export const updateProductPriceSchema = z.object({
  productId: dbId("Product"),
  defaultSalePrice: nonNegativeMoney("Default sale price"),
});

export const areaSchema = z.object({
  name: shortName("Area name"),
});

export const updateAreaSchema = z.object({
  id: dbId("Area"),
  name: shortName("Area name"),
});

export const shopSchema = z.object({
  areaId: dbId("Area"),
  name: shortName("Shop name"),
});

export const updateShopSchema = z.object({
  id: dbId("Shop"),
  name: shortName("Shop name"),
});

export const idOnlySchema = z.object({ id: dbId("Record") });

export const softDeleteSchema = z.object({
  id: dbId("Record"),
  reason: z
    .string()
    .trim()
    .max(300)
    .optional()
    .transform((v) => (v ? v : null)),
});

/* --------------------------------------------------------- SKU auto-generation */

const STOPWORDS = new Set(["juice", "beverage", "drink", "the", "and"]);

/**
 * Builds a SKU like MNG-BTL-250 from the product identity, mirroring the
 * convention used by the seeded catalog:
 *   3 letters of the distinctive word + 3 letters of packaging + digits of volume.
 */
export function deriveSku(input: {
  name: string;
  packagingType: string;
  variantValue: string;
}): string {
  const words = input.name
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .filter((w) => !STOPWORDS.has(w.toLowerCase()));
  const nameSource = (words[0] ?? input.name).replace(/[^A-Za-z0-9]/g, "");
  const namePart = nameSource.slice(0, 3).toUpperCase().padEnd(3, "X");

  const packSource = input.packagingType.replace(/[^A-Za-z0-9]/g, "");
  const packPart = packSource.slice(0, 3).toUpperCase().padEnd(3, "X");

  const digits = input.variantValue.replace(/[^0-9]/g, "");
  const variantPart = digits || input.variantValue.replace(/[^A-Za-z0-9]/g, "").slice(0, 4).toUpperCase();

  return [namePart, packPart, variantPart].filter(Boolean).join("-");
}

/* ------------------------------------------------------- action result shape */

export type ActionState = {
  ok: boolean;
  message: string | null;
  /** Field name -> first error message, for inline display next to inputs. */
  fieldErrors: Record<string, string>;
};

export const emptyActionState: ActionState = { ok: false, message: null, fieldErrors: {} };

export function zodFieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join(".") || "form";
    if (!(key in out)) out[key] = issue.message;
  }
  return out;
}

export function failure(message: string, fieldErrors: Record<string, string> = {}): ActionState {
  return { ok: false, message, fieldErrors };
}

export function success(message: string): ActionState {
  return { ok: true, message, fieldErrors: {} };
}
