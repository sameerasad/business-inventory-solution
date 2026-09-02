/**
 * Who you are, in one place.
 *
 * The site header, the invoice PDF and the WhatsApp message all have to say the
 * same business name. Reading `process.env` separately in three files is exactly
 * how they drift apart - the invoice said one thing and the header another - so
 * everything goes through here.
 */

export type BusinessDetails = {
  name: string;
  address: string;
  phone: string;
  email: string;
  taxId: string;
};

/** Set these in `.env` locally and in the Vercel project settings for the live site. */
export function business(): BusinessDetails {
  return {
    name: process.env.BUSINESS_NAME?.trim() || "Your Business Name",
    address: process.env.BUSINESS_ADDRESS?.trim() || "",
    phone: process.env.BUSINESS_PHONE?.trim() || "",
    email: process.env.BUSINESS_EMAIL?.trim() || "",
    taxId: process.env.BUSINESS_TAX_ID?.trim() || "",
  };
}

/** Words that carry no identity, so they never make it into the badge. */
const FILLER = new Set(["and", "the", "of", "for", "co", "company", "sons", "&"]);

/**
 * Up to two initials for the header badge, e.g. "Asad and Sons Beverages" -> "AB".
 *
 * Dropping filler words keeps the badge meaningful; without that the same name
 * would read "AA", which identifies nothing.
 */
export function businessInitials(name: string): string {
  const words = name
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 0 && !FILLER.has(w.toLowerCase()));

  const source = words.length > 0 ? words : name.split(/\s+/).filter(Boolean);
  const initials = source.map((w) => w[0]!.toUpperCase()).join("");

  // A one-word name gets its first two letters rather than a lonely letter.
  if (initials.length === 1 && source[0]!.length > 1) {
    return (source[0]![0]! + source[0]![1]!).toUpperCase();
  }
  return initials.slice(0, 2) || "IP";
}
