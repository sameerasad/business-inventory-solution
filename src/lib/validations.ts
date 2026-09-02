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
  address: z
    .string()
    .trim()
    .max(400, "Shop address cannot exceed 400 characters")
    .optional()
    .transform((v) => (v ? v : null)),
  phone: z
    .string()
    .trim()
    .max(40, "Phone cannot exceed 40 characters")
    .optional()
    .transform((v) => (v ? v : null)),
});

export const updateShopSchema = z.object({
  id: dbId("Shop"),
  name: shortName("Shop name"),
  address: z
    .string()
    .trim()
    .max(400, "Shop address cannot exceed 400 characters")
    .optional()
    .transform((v) => (v ? v : null)),
  phone: z
    .string()
    .trim()
    .max(40, "Phone cannot exceed 40 characters")
    .optional()
    .transform((v) => (v ? v : null)),
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

/* ------------------------------------------------------------------ payments */

export const createPaymentSchema = z.object({
  bookingId: dbId("Booking"),
  amount: nonNegativeMoney("Amount").refine((n) => n > 0, "Amount must be greater than 0"),
  paidOn: dateOnlyString,
  method: z
    .string()
    .trim()
    .max(60, "Method cannot exceed 60 characters")
    .optional()
    .transform((v) => (v ? v : null)),
  notes: optionalNotes,
  idempotencyKey,
});
export type CreatePaymentInput = z.infer<typeof createPaymentSchema>;

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

/* ------------------------------------------------------------------ bookings */

/**
 * One line of a booking. The booker gives product, quantity and unit price; the
 * server works out which batches to draw from.
 */
export const bookingLineSchema = z.object({
  productId: z
    .number()
    .int()
    .positive("Pick a product for every line"),
  quantity: z
    .number()
    .int("Quantity must be a whole number")
    .positive("Quantity must be greater than 0")
    .max(100_000_000, "Quantity is unrealistically large"),
  unitPrice: z
    .number()
    .nonnegative("Unit price cannot be negative")
    .max(10_000_000, "Unit price is unrealistically large")
    // Money is stored to 2 decimals; reject anything finer so the invoice total
    // and the recorded revenue can never disagree by a rounding artefact.
    .refine((n) => Number.isInteger(Math.round(n * 100)) && Math.abs(n * 100 - Math.round(n * 100)) < 1e-9,
      "Unit price cannot have more than 2 decimals"),
});
export type BookingLineInput = z.infer<typeof bookingLineSchema>;

/**
 * Lines arrive as a JSON string in a hidden field - the form is a dynamic list,
 * which does not map cleanly onto flat FormData keys.
 */
const bookingLinesFromJson = z
  .string()
  .min(1, "Add at least one product line")
  .transform((raw, ctx) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Could not read the order lines" });
      return z.NEVER;
    }
    const result = z.array(bookingLineSchema).min(1, "Add at least one product line").safeParse(parsed);
    if (!result.success) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: result.error.issues[0]?.message ?? "Invalid order lines",
      });
      return z.NEVER;
    }
    return result.data;
  });

export const createBookingSchema = z.object({
  bookerId: optionalDbId,
  // Optional: a walk-in or cash sale often has no name worth recording.
  customerName: z
    .string()
    .trim()
    .max(160, "Customer name cannot exceed 160 characters")
    .optional()
    .transform((v) => (v ? v : null)),
  customerPhone: z
    .string()
    .trim()
    .max(40, "Phone cannot exceed 40 characters")
    .optional()
    .transform((v) => (v ? v : null)),
  areaId: dbId("Area"),
  shopId: optionalDbId,
  bookingDate: dateOnlyString,
  notes: optionalNotes,
  lines: bookingLinesFromJson,
  idempotencyKey,
});
export type CreateBookingInput = z.infer<typeof createBookingSchema>;

/* ------------------------------------------------------------------- bookers */

const bookerFields = {
  name: shortName("Booker name", 120),
  code: z
    .string()
    .trim()
    .max(30, "Code cannot exceed 30 characters")
    .optional()
    .transform((v) => (v ? v : null)),
  phone: z
    .string()
    .trim()
    .max(40, "Phone cannot exceed 40 characters")
    .optional()
    .transform((v) => (v ? v : null)),
  notes: optionalNotes,
};

export const createBookerSchema = z.object(bookerFields);
export const updateBookerSchema = z.object({ id: dbId("Booker"), ...bookerFields });
