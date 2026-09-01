/**
 * Phone normalisation and message building. Pure logic, no database.
 */
import {
  buildInvoiceMessage,
  buildWhatsAppUrl,
  normalisePhone,
  urlTooLong,
} from "@/lib/whatsapp";

let checks = 0;
let failures = 0;
function ok(label: string, cond: boolean, detail?: unknown) {
  checks += 1;
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}`, detail ?? "");
  }
}
function section(n: string) {
  console.log(`\n=== ${n} ===`);
}

section("phone normalisation (country code 92)");
const good: [string, string][] = [
  ["0300-1234567", "923001234567"],
  ["0300 123 4567", "923001234567"],
  ["03001234567", "923001234567"],
  ["+92 300 1234567", "923001234567"],
  ["+923001234567", "923001234567"],
  ["0092 300 1234567", "923001234567"],
  ["00923001234567", "923001234567"],
  ["923001234567", "923001234567"],
  ["300 1234567", "923001234567"],
  ["(0300) 1234567", "923001234567"],
  ["0300/1234567", "923001234567"],
];
for (const [input, expected] of good) {
  const r = normalisePhone(input, "92");
  ok(`"${input}" -> ${expected}`, r.ok && r.e164 === expected, r);
}

section("phone normalisation rejects rubbish");
const bad: [string, string][] = [
  ["", "empty"],
  ["   ", "whitespace only"],
  ["abcdef", "no digits"],
  ["12345", "too short"],
  ["9230012345671234567890", "too long"],
];
for (const [input, why] of bad) {
  const r = normalisePhone(input, "92");
  ok(`rejects ${why}`, !r.ok, r);
}

section("a different country code still works");
const uk = normalisePhone("07700 900123", "44");
ok('UK "07700 900123" -> 447700900123', uk.ok && uk.e164 === "447700900123", uk);
const intl = normalisePhone("+1 415 555 2671", "92");
ok("an explicit + is never re-prefixed", intl.ok && intl.e164 === "14155552671", intl);
// A local number that happens to begin with the country code digits must not be
// prefixed twice.
const already = normalisePhone("923001234567", "92");
ok("already-international number is left alone", already.ok && already.e164 === "923001234567", already);

section("message body");
const lines = [
  { description: "Mango Juice - Bottle 250ml", quantity: 150, unitPrice: 450, lineTotal: 67500 },
  { description: "Apple Juice - Tetra Pack 500ml", quantity: 40, unitPrice: 120, lineTotal: 4800 },
];
const msg = buildInvoiceMessage({
  invoiceNo: "INV-2026-00001",
  businessName: "Asad and Sons Beverages",
  bookingDate: new Date("2026-04-10T00:00:00Z"),
  customerName: "Al-Madina Store",
  shopName: "Central Mart",
  lines,
  total: 72300,
  totalUnits: 190,
  pdfUrl: "https://example.vercel.app/api/invoices/share/abc123",
});
ok("names the business", msg.includes("Asad and Sons Beverages"), msg);
ok("names the invoice", msg.includes("INV-2026-00001"), msg);
ok("shows the date", msg.includes("2026-04-10"), msg);
ok("addresses the customer", msg.includes("Al-Madina Store"), msg);
ok("lists both items", msg.includes("Mango Juice") && msg.includes("Apple Juice"), msg);
ok("prices are in rupees", msg.includes("Rs"), msg);
ok("shows the total", msg.includes("72,300"), msg);
ok("says packs", msg.includes("packs"), msg);
ok("includes the download link", msg.includes("https://example.vercel.app/api/invoices/share/abc123"), msg);
// A customer document must not carry cost or profit.
ok("leaks no cost or profit", !/\b(cost|profit|margin)\b/i.test(msg), msg);

section("falls back to the shop when there is no customer name");
const walkIn = buildInvoiceMessage({
  invoiceNo: "INV-2026-00002",
  businessName: "Asad and Sons Beverages",
  bookingDate: "2026-04-10",
  customerName: null,
  shopName: "Central Mart",
  lines: [lines[0]],
  total: 67500,
  totalUnits: 150,
  pdfUrl: "https://x/y",
});
ok("uses the shop name", walkIn.includes("Central Mart"), walkIn);
const anon = buildInvoiceMessage({
  invoiceNo: "INV-2026-00003",
  businessName: "B",
  bookingDate: "2026-04-10",
  customerName: null,
  shopName: null,
  lines: [lines[0]],
  total: 1,
  totalUnits: 1,
  pdfUrl: "https://x/y",
});
ok("omits the To: line entirely when neither is known", !anon.includes("To:"), anon);

section("long orders are summarised, not truncated mid-URL");
const many = Array.from({ length: 26 }, (_, i) => ({
  description: `Some Product With A Fairly Long Name Number ${i + 1} - Bottle 1000ml`,
  quantity: 100,
  unitPrice: 750,
  lineTotal: 75000,
}));
const bigMsg = buildInvoiceMessage({
  invoiceNo: "INV-2026-00004",
  businessName: "Asad and Sons Beverages",
  bookingDate: "2026-04-10",
  customerName: "Big Buyer",
  shopName: null,
  lines: many,
  total: 1950000,
  totalUnits: 2600,
  pdfUrl: "https://example.vercel.app/api/invoices/share/abc123",
});
ok("only the first 8 lines are listed", (bigMsg.match(/^• /gm) ?? []).length === 9, (bigMsg.match(/^• /gm) ?? []).length);
ok("says how many were left out", bigMsg.includes("and 18 more item(s)"), bigMsg);
const bigUrl = buildWhatsAppUrl("923001234567", bigMsg);
ok("the resulting URL stays under the practical limit", !urlTooLong(bigUrl), bigUrl.length);

section("the click-to-chat URL");
const url = buildWhatsAppUrl("923001234567", "hello world & more");
ok("uses wa.me with the bare number", url.startsWith("https://wa.me/923001234567?text="), url);
ok("percent-encodes the text", url.includes("hello%20world%20%26%20more"), url);
ok("no raw newlines survive encoding", !url.includes("\n"), url);

console.log(`\n${checks - failures}/${checks} whatsapp checks passed`);
if (failures > 0) process.exitCode = 1;
