import { dateOnly, money, qty } from "@/lib/format";

/**
 * Building blocks for "send this invoice on WhatsApp".
 *
 * WhatsApp click-to-chat (wa.me) can pre-fill TEXT only - it cannot attach a
 * file. So the message carries the invoice summary plus a link the customer taps
 * to download the PDF. Attaching the PDF itself would need the WhatsApp Business
 * Cloud API (Meta business account, verified sender, message templates).
 *
 * Everything here is pure so it can be unit tested without a browser.
 */

/** Default country code for local numbers written without one. 92 = Pakistan. */
export const DEFAULT_COUNTRY_CODE = process.env.WHATSAPP_COUNTRY_CODE?.replace(/\D/g, "") || "92";

export type PhoneResult =
  | { ok: true; e164: string; display: string }
  | { ok: false; reason: string };

/**
 * Turns a number as a human typed it into the digits-only international form
 * wa.me needs (no +, no spaces, no dashes).
 *
 *   "0300-1234567"    -> 923001234567   (leading 0 is the national prefix)
 *   "+92 300 1234567" -> 923001234567
 *   "0092 3001234567" -> 923001234567   (00 is the international prefix)
 *   "300 1234567"     -> 923001234567   (no prefix at all)
 *   "923001234567"    -> 923001234567   (already international)
 */
export function normalisePhone(raw: string, countryCode = DEFAULT_COUNTRY_CODE): PhoneResult {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return { ok: false, reason: "No phone number" };

  // A leading + means the rest is already international.
  const hadPlus = trimmed.startsWith("+");
  let digits = trimmed.replace(/\D/g, "");
  if (!digits) return { ok: false, reason: "No digits in that number" };

  if (!hadPlus) {
    if (digits.startsWith("00")) {
      // 00 is the international dialling prefix.
      digits = digits.slice(2);
    } else if (digits.startsWith("0")) {
      // A single leading 0 is the national trunk prefix; swap it for the country code.
      digits = countryCode + digits.slice(1);
    } else if (!digits.startsWith(countryCode)) {
      // A bare local number with no prefix at all.
      digits = countryCode + digits;
    }
  }

  // Loose sanity bounds. E.164 allows up to 15 digits; anything under 8 is not
  // a reachable number.
  if (digits.length < 8) return { ok: false, reason: "That number looks too short" };
  if (digits.length > 15) return { ok: false, reason: "That number looks too long" };

  return { ok: true, e164: digits, display: `+${digits}` };
}

export type InvoiceMessageInput = {
  invoiceNo: string;
  businessName: string;
  bookingDate: Date | string;
  customerName: string | null;
  shopName: string | null;
  lines: { description: string; quantity: number; unitPrice: number; lineTotal: number }[];
  total: number;
  totalUnits: number;
  /** Absolute URL the customer taps to download the PDF. */
  pdfUrl: string;
};

/** Lines beyond this are summarised, to keep the wa.me URL a sane length. */
const MAX_LINES = 8;

/**
 * The message body. Plain text with WhatsApp's *bold* markers, deliberately
 * short: a long body makes an unwieldy URL and gets truncated by some clients.
 */
export function buildInvoiceMessage(input: InvoiceMessageInput): string {
  const parts: string[] = [];

  parts.push(`*${input.businessName}*`);
  parts.push(`Invoice *${input.invoiceNo}*  ·  ${dateOnly(input.bookingDate)}`);

  const billTo = input.customerName?.trim() || input.shopName?.trim();
  if (billTo) parts.push(`To: ${billTo}`);
  parts.push("");

  const shown = input.lines.slice(0, MAX_LINES);
  for (const line of shown) {
    parts.push(
      `• ${line.description} — ${qty(line.quantity)} × ${money(line.unitPrice)} = ${money(line.lineTotal)}`,
    );
  }
  if (input.lines.length > shown.length) {
    parts.push(`• …and ${input.lines.length - shown.length} more item(s)`);
  }

  parts.push("");
  parts.push(`*Total: ${money(input.total)}*  (${qty(input.totalUnits)} packs)`);
  parts.push("");
  parts.push("Download the invoice PDF:");
  parts.push(input.pdfUrl);

  return parts.join("\n");
}

/**
 * The click-to-chat URL. wa.me is the documented short form and works on
 * mobile and desktop WhatsApp alike.
 */
export function buildWhatsAppUrl(e164: string, message: string): string {
  return `https://wa.me/${e164}?text=${encodeURIComponent(message)}`;
}

/**
 * Practical ceiling on the whole URL. Browsers and WhatsApp both cope with a
 * couple of thousand characters; past that the text starts getting cut.
 */
export const MAX_URL_LENGTH = 2000;

export function urlTooLong(url: string): boolean {
  return url.length > MAX_URL_LENGTH;
}
