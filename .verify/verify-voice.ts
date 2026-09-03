/**
 * Voice command parsing, in English and Urdu.
 *
 * The parser is pure, so every phrasing, accent spelling and script can be
 * tested here without a microphone. That matters more than usual: the thing
 * being tested is a guess about what a human meant, and the only way to trust it
 * is to pin down a lot of examples.
 *
 * The safety rule under test throughout: nothing that writes is ever returned as
 * ready-to-run. A booking or a payment always comes back as a proposal, and an
 * incomplete or misheard one says so.
 */
import { parseCommand, type VoiceCatalog, type VoiceCommand } from "@/lib/voice/parse";
import { allNumbers, nameScore, readNumber, tokenise } from "@/lib/voice/normalise";

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

/** A fixed stand-in for the real catalog, so results never move with the data. */
const CATALOG: VoiceCatalog = {
  products: [
    {
      id: 1,
      sku: "MNG-BTL-250",
      name: "Mango Juice",
      packagingType: "Bottle",
      variantValue: "250ml",
      defaultSalePrice: 450,
      available: 500,
      frontBatchId: 101,
    },
    {
      id: 2,
      sku: "MNG-BTL-500",
      name: "Mango Juice",
      packagingType: "Bottle",
      variantValue: "500ml",
      defaultSalePrice: 750,
      available: 40,
      frontBatchId: 102,
    },
    {
      id: 3,
      sku: "APP-BTL-250",
      name: "Apple Juice",
      packagingType: "Bottle",
      variantValue: "250ml",
      defaultSalePrice: 450,
      available: 200,
      frontBatchId: 103,
    },
    {
      id: 4,
      sku: "PCH-TET-250",
      name: "Peach Juice",
      packagingType: "Tetra Pack",
      variantValue: "250ml",
      defaultSalePrice: 50,
      available: 100,
      frontBatchId: 104,
    },
    {
      id: 5,
      sku: "POM-BTL-1000",
      name: "Pomegranate Juice",
      packagingType: "Bottle",
      variantValue: "1000ml",
      defaultSalePrice: 750,
      available: 10,
      frontBatchId: 105,
    },
    {
      id: 6,
      sku: "CHO-BAR-10",
      name: "Chocolate",
      packagingType: "Bar",
      variantValue: "10g",
      defaultSalePrice: 20,
      available: 900,
      frontBatchId: 106,
    },
  ],
  areas: [
    { id: 11, name: "Downtown" },
    { id: 12, name: "North Zone" },
    { id: 13, name: "Yaro Goth" },
  ],
  shops: [
    { id: 21, name: "Central Mart", areaId: 11 },
    { id: 22, name: "Corner Store", areaId: 11 },
    { id: 23, name: "Hillview Kiosk", areaId: 12 },
  ],
  bookers: [
    { id: 31, name: "Saifullah Khan" },
    { id: 32, name: "Imran Ali" },
  ],
  invoices: [
    { id: 41, invoiceNo: "INV-2026-0012", customerName: "Corner Store", balance: 5000 },
    { id: 42, invoiceNo: "INV-2026-0013", customerName: "Central Mart", balance: 1200 },
  ],
};

const TODAY = new Date(Date.UTC(2026, 8, 3)); // 2026-09-03
const YESTERDAY = "2026-09-02";
const TODAY_ISO = "2026-09-03";

const parse = (text: string): VoiceCommand => parseCommand(text, CATALOG, TODAY);

function num(text: string): number | null {
  const m = readNumber(tokenise(text), 0, true);
  return m ? m.value : null;
}

async function main() {
  /* ------------------------------------------------------------------ numbers */
  section("numbers: English");
  ok("digits", num("42") === 42);
  ok("one word", num("twenty") === 20);
  ok("tens and units", num("twenty five") === 25, num("twenty five"));
  ok("hyphenated", num("twenty-five") === 25, num("twenty-five"));
  ok("hundreds", num("two hundred") === 200);
  ok("hundreds and tens", num("one hundred twenty") === 120, num("one hundred twenty"));
  ok("with a joiner", num("one hundred and twenty") === 120, num("one hundred and twenty"));
  ok("thousands", num("five thousand") === 5000);
  ok(
    "mixed thousands",
    num("two thousand five hundred") === 2500,
    num("two thousand five hundred"),
  );
  ok("a dozen is twelve", num("dozen") === 12);

  section("numbers: Roman Urdu");
  ok("ek = 1", num("ek") === 1);
  ok("bees = 20", num("bees") === 20);
  ok("bis = 20 (spelling variant)", num("bis") === 20);
  ok("pachas = 50", num("pachas") === 50);
  ok("paanch = 5", num("paanch") === 5);
  ok("panch = 5 (variant)", num("panch") === 5);
  ok("ek sau bees = 120", num("ek sau bees") === 120, num("ek sau bees"));
  ok("do hazar = 2000", num("do hazar") === 2000, num("do hazar"));
  ok("paanch hazar = 5000", num("paanch hazar") === 5000, num("paanch hazar"));
  ok("do hazar paanch sau = 2500", num("do hazar paanch sau") === 2500, num("do hazar paanch sau"));
  ok("sau alone = 100", num("sau") === 100);
  ok("ek lakh = 100000", num("ek lakh") === 100000, num("ek lakh"));
  ok("bees paanch is not 25", num("bees paanch") === 20, num("bees paanch"));

  section("numbers: Urdu script");
  ok("Urdu numerals ۲۵", num("۲۵") === 25, num("۲۵"));
  ok("بیس = 20", num("بیس") === 20, num("بیس"));
  ok("پانچ ہزار = 5000", num("پانچ ہزار") === 5000, num("پانچ ہزار"));
  ok("ایک سو بیس = 120", num("ایک سو بیس") === 120, num("ایک سو بیس"));

  section("numbers: several in one sentence");
  const many = allNumbers(tokenise("bees packs 450 rupay"), false);
  ok("finds both", many.length === 2, many);
  ok("in order", many[0]?.value === 20 && many[1]?.value === 450, many);

  /* ------------------------------------------------------------ name matching */
  section("fuzzy name matching");
  ok("exact", nameScore(tokenise("corner store"), "Corner Store") === 1);
  ok("partial name", nameScore(tokenise("corner"), "Corner Store") >= 0.5);
  ok("misspelling survives", nameScore(tokenise("korner stor"), "Corner Store") > 0.7);
  ok("aam resolves to mango", nameScore(tokenise("aam"), "Mango Juice") > 0.4);
  ok(
    "a different size does not match",
    nameScore(tokenise("mango bottle 250"), "Mango Juice Bottle 500ml") <
      nameScore(tokenise("mango bottle 250"), "Mango Juice Bottle 250ml"),
  );
  ok("unrelated words do not match", nameScore(tokenise("hello there"), "Corner Store") < 0.3);

  /* --------------------------------------------------------------- navigation */
  section("navigation: English");
  for (const [text, href] of [
    ["open dashboard", "/dashboard"],
    ["show bookings", "/bookings"],
    ["go to receivables", "/receivables"],
    ["open products", "/products"],
    ["show bookers", "/bookers"],
    ["open new booking", "/bookings/new"],
    ["show areas", "/areas"],
    ["open batches", "/batches"],
  ] as const) {
    const c = parse(text);
    ok(`"${text}" -> ${href}`, c.kind === "navigate" && c.href === href, c);
  }

  section("navigation: Urdu");
  for (const [text, href] of [
    ["bookings kholo", "/bookings"],
    ["dashboard dikhao", "/dashboard"],
    ["udhar dikhao", "/receivables"],
    ["stock kholo", "/batches"],
    ["کھولو ڈیش بورڈ", "/dashboard"],
    ["آرڈرز دکھاؤ", "/bookings"],
  ] as const) {
    const c = parse(text);
    ok(`"${text}" -> ${href}`, c.kind === "navigate" && c.href === href, c);
  }

  const bare = parse("dashboard");
  ok(
    "a bare page name still navigates, but flagged low confidence",
    bare.kind === "navigate" && bare.confidence === "low",
    bare,
  );

  /* ---------------------------------------------------------------- questions */
  section("questions");
  const cases: [string, string, string][] = [
    ["how much profit today", "profit", "today"],
    ["what is the revenue this month", "revenue", "month"],
    ["aaj ka munafa kitna hai", "profit", "today"],
    ["is mahine ki bikri kitni hai", "revenue", "month"],
    ["kitna udhar hai", "outstanding", "month"],
    ["how much outstanding", "outstanding", "month"],
    ["saal ka profit batao", "profit", "year"],
    ["stock kitna hai", "stock", "month"],
    ["آج کا منافع کتنا ہے", "profit", "today"],
  ];
  for (const [text, metric, period] of cases) {
    const c = parse(text);
    ok(
      `"${text}" -> ${metric}/${period}`,
      c.kind === "query" && c.metric === metric && c.period === period,
      c,
    );
  }

  /* ----------------------------------------------------------------- bookings */
  section("bookings: English");
  const b1 = parse("sell twenty packs mango bottle 250 to Corner Store");
  ok("recognised as a booking", b1.kind === "booking", b1);
  if (b1.kind === "booking") {
    ok("product is the 250ml mango", b1.lines[0]?.sku === "MNG-BTL-250", b1.lines[0]);
    ok("quantity 20", b1.lines[0]?.quantity === 20, b1.lines[0]);
    ok("shop is Corner Store", b1.shopId === 22, b1.shopName);
    ok("area came from the shop", b1.areaId === 11, b1.areaName);
    ok("price defaulted to the catalog price", b1.lines[0]?.unitPrice === 450, b1.lines[0]);
    ok(
      "and it says so",
      b1.warnings.some((w) => w.includes("catalog price")),
      b1.warnings,
    );
    ok("date defaulted to today", b1.date === TODAY_ISO, b1.date);
    ok("nothing missing", b1.missing.length === 0, b1.missing);
  }

  const b2 = parse("book 30 apple bottle 250 for Central Mart at 500 rupees");
  ok(
    "explicit price is used, not the catalog one",
    b2.kind === "booking" && b2.lines[0]?.unitPrice === 500,
    b2,
  );
  ok("quantity is still the quantity", b2.kind === "booking" && b2.lines[0]?.quantity === 30, b2);
  ok("apple, not mango", b2.kind === "booking" && b2.lines[0]?.sku === "APP-BTL-250", b2);

  section("bookings: Urdu");
  const b3 = parse("bees packs aam bottle 250 Corner Store ko bech do");
  ok("Roman Urdu order parsed", b3.kind === "booking", b3);
  if (b3.kind === "booking") {
    ok("aam -> mango 250", b3.lines[0]?.sku === "MNG-BTL-250", b3.lines[0]);
    ok("bees -> 20", b3.lines[0]?.quantity === 20, b3.lines[0]);
    ok("shop found", b3.shopId === 22, b3.shopName);
  }

  const b4 = parse("pachas chocolate becho Central Mart");
  ok("chocolate order", b4.kind === "booking" && b4.lines[0]?.sku === "CHO-BAR-10", b4);
  ok("pachas -> 50", b4.kind === "booking" && b4.lines[0]?.quantity === 50, b4);

  const b5 = parse("kal bees seb bottle 250 Corner Store ko becha");
  ok("kal resolves to yesterday", b5.kind === "booking" && b5.date === YESTERDAY, b5);
  ok(
    "and a spoken date produces no assumed-date warning",
    b5.kind === "booking" && !b5.warnings.some((w) => w.includes("today is assumed")),
    b5.kind === "booking" ? b5.warnings : null,
  );

  section("bookings: the size is never mistaken for a quantity or a price");
  const b6 = parse("sell 10 pomegranate bottle 1000");
  ok("1000 is the size", b6.kind === "booking" && b6.lines[0]?.sku === "POM-BTL-1000", b6);
  ok("10 is the quantity", b6.kind === "booking" && b6.lines[0]?.quantity === 10, b6);
  ok(
    "price is the catalog price, not 1000",
    b6.kind === "booking" && b6.lines[0]?.unitPrice === 750,
    b6,
  );

  section("bookings: what must be flagged rather than assumed");
  const b7 = parse("sell mango bottle 250 to Corner Store");
  ok(
    "no quantity is reported missing",
    b7.kind === "booking" && b7.missing.includes("quantity"),
    b7,
  );
  ok("and it is not high confidence", b7.kind === "booking" && b7.confidence === "low", b7);

  const b8 = parse("sell 20 mango bottle 250");
  ok("no place means area is missing", b8.kind === "booking" && b8.missing.includes("area"), b8);

  const b9 = parse("sell 100 mango bottle 500 to Corner Store");
  ok(
    "over-stock is warned about, using real availability",
    b9.kind === "booking" && b9.warnings.some((w) => w.includes("40")),
    b9.kind === "booking" ? b9.warnings : null,
  );
  ok("but still returned for a human to fix", b9.kind === "booking", b9);

  const b10 = parse("sell 20 spaceships to Corner Store");
  ok("an unknown product is refused outright", b10.kind === "unknown", b10);

  /* ----------------------------------------------------------------- payments */
  section("payments");
  const p1 = parse("invoice 12 ka paanch hazar aa gaya");
  ok("recognised as a payment", p1.kind === "payment", p1);
  if (p1.kind === "payment") {
    ok("invoice 12 resolved", p1.invoiceNo === "INV-2026-0012", p1.invoiceNo);
    ok("amount 5000", p1.amount === 5000, p1.amount);
    ok("nothing missing", p1.missing.length === 0, p1.missing);
    ok("dated today", p1.date === TODAY_ISO, p1.date);
  }

  const p2 = parse("payment received 1200 from Central Mart");
  ok("matched by customer name", p2.kind === "payment" && p2.invoiceNo === "INV-2026-0013", p2);
  ok("amount 1200", p2.kind === "payment" && p2.amount === 1200, p2);

  const p3 = parse("Corner Store se do hazar mila");
  ok("Urdu payment", p3.kind === "payment" && p3.invoiceNo === "INV-2026-0012", p3);
  ok("do hazar -> 2000", p3.kind === "payment" && p3.amount === 2000, p3);

  const p4 = parse("payment aa gaya");
  ok(
    "no invoice and no amount are both reported",
    p4.kind === "payment" && p4.missing.length === 2,
    p4,
  );
  ok("never guesses the balance", p4.kind === "payment" && p4.amount === null, p4);

  const p5 = parse("invoice 12 ka das hazar aa gaya");
  ok(
    "more than the balance is warned about",
    p5.kind === "payment" && p5.warnings.some((w) => w.includes("5000")),
    p5.kind === "payment" ? p5.warnings : null,
  );

  const p6 = parse("invoice 999 ka hazar aa gaya");
  ok(
    "an unknown invoice number is reported, not silently dropped",
    p6.kind === "payment" && p6.warnings.some((w) => w.includes("999")),
    p6.kind === "payment" ? p6.warnings : null,
  );

  /* ------------------------------------------------------ nothing auto-writes */
  section("safety: writes are only ever proposals");
  const writes = [
    parse("sell twenty packs mango bottle 250 to Corner Store"),
    parse("invoice 12 ka paanch hazar aa gaya"),
  ];
  ok(
    "every write command carries a confirmation payload, not a result",
    writes.every((c) => c.kind === "booking" || c.kind === "payment"),
    writes.map((c) => c.kind),
  );
  ok(
    "and exposes its own uncertainty for the UI to show",
    writes.every(
      (c) => (c.kind === "booking" || c.kind === "payment") && Array.isArray(c.warnings),
    ),
  );

  section("safety: nonsense is refused, not guessed at");
  for (const text of ["", "   ", "hello", "the a of to", "kar do", "asdfgh qwerty"]) {
    const c = parse(text);
    ok(`"${text}" -> unknown`, c.kind === "unknown", c);
  }

  section("a delete is never a voice command");
  for (const text of [
    "delete all sales",
    "sab kuch mita do",
    "remove batch 5",
    "drop the database",
  ]) {
    const c = parse(text);
    ok(
      `"${text}" is not actionable`,
      c.kind === "unknown" || c.kind === "navigate" || c.kind === "query",
      c,
    );
  }

  /* -------------------------------------------------- multi-line orders */
  section("orders with more than one line");
  const m1 = parse("sell bees mango bottle 250 aur tees apple bottle 250 to Corner Store");
  ok("parsed as one booking", m1.kind === "booking", m1);
  if (m1.kind === "booking") {
    ok("two lines", m1.lines.length === 2, m1.lines);
    ok(
      "the right two products",
      m1.lines.map((l) => l.sku).join(",") === "MNG-BTL-250,APP-BTL-250",
      m1.lines.map((l) => l.sku),
    );
    ok(
      "quantities kept apart",
      m1.lines[0]?.quantity === 20 && m1.lines[1]?.quantity === 30,
      m1.lines,
    );
    ok("one shop for the whole order", m1.shopId === 22, m1.shopName);
  }

  const m2 = parse("book 10 mango bottle 250 at 500 and 5 chocolate at 25 for Central Mart");
  ok("prices stay with their own line", m2.kind === "booking", m2);
  if (m2.kind === "booking") {
    ok("line 1 price 500", m2.lines[0]?.unitPrice === 500, m2.lines[0]);
    ok("line 2 price 25", m2.lines[1]?.unitPrice === 25, m2.lines[1]);
  }

  const m3 = parse("sell ek sau bees mango bottle 250 to Corner Store");
  ok(
    "'aur' inside a number does not split the order",
    m3.kind === "booking" && m3.lines.length === 1 && m3.lines[0]?.quantity === 120,
    m3,
  );

  const m4 = parse("sell 10 mango bottle 250 and 20 mango bottle 250 to Corner Store");
  ok(
    "the same product twice is flagged, not silently merged",
    m4.kind === "booking" && m4.warnings.some((w) => w.includes("twice")),
    m4.kind === "booking" ? m4.warnings : null,
  );

  /* -------------------------------------------------------- stock coming in */
  section("receiving stock");
  const s1 = parse("das hazar mango bottle 250 aaye cost do sau");
  ok("recognised as a stock receipt", s1.kind === "batch", s1);
  if (s1.kind === "batch") {
    ok("quantity 10000", s1.quantity === 10000, s1.quantity);
    ok("cost 200", s1.unitCost === 200, s1.unitCost);
    ok("right product", s1.sku === "MNG-BTL-250", s1.sku);
    ok("nothing missing", s1.missing.length === 0, s1.missing);
  }

  const s2 = parse("purchased 500 chocolate at cost 12");
  ok("English phrasing works too", s2.kind === "batch" && s2.sku === "CHO-BAR-10", s2);
  ok("quantity and cost", s2.kind === "batch" && s2.quantity === 500 && s2.unitCost === 12, s2);

  const s3 = parse("das hazar mango bottle 250 aaye");
  ok(
    "a receipt with no cost is blocked, never guessed",
    s3.kind === "batch" && s3.missing.includes("unit cost") && s3.unitCost === null,
    s3,
  );

  const s4 = parse("stock kitna hai");
  ok("'stock' on its own is still a question, not a receipt", s4.kind === "query", s4);

  const s5 = parse("payment received 5000 from Corner Store");
  ok("'received' about money is still a payment, not stock", s5.kind === "payment", s5);

  /* ----------------------------------------------------------- counter sales */
  section("cash sales over the counter");
  const c1 = parse("paanch chocolate cash bech diye Downtown");
  ok("recognised as a counter sale", c1.kind === "sale", c1);
  if (c1.kind === "sale") {
    ok("quantity 5", c1.quantity === 5, c1.quantity);
    ok("product", c1.sku === "CHO-BAR-10", c1.sku);
    ok("area required and found", c1.areaId === 11, c1.areaName);
    ok("batch chosen for you, oldest first", c1.batchId === 106, c1.batchId);
    ok("catalog price used", c1.unitPrice === 20, c1.unitPrice);
  }

  const c2 = parse("sell 20 mango bottle 250 to Corner Store");
  ok("without 'cash' it stays an order on credit", c2.kind === "booking", c2);

  const c3 = parse("paanch chocolate cash bech diye");
  ok("a cash sale with no area is blocked", c3.kind === "sale" && c3.missing.includes("area"), c3);

  /* -------------------------------------------------------- richer questions */
  section("questions about one thing");
  const q1 = parse("mango bottle 250 ka stock kitna hai");
  ok("per-product stock question", q1.kind === "query" && q1.metric === "stock", q1);
  ok("and it knows which product", q1.kind === "query" && q1.productId === 1, q1);

  const q2 = parse("stock kitna hai");
  ok(
    "without a product it stays the whole-catalog question",
    q2.kind === "query" && q2.productId === null,
    q2,
  );

  const q3 = parse("Corner Store ka balance kitna hai");
  ok("shop balance question", q3.kind === "query" && q3.metric === "balance", q3);
  ok("and it knows which shop", q3.kind === "query" && q3.shopId === 22, q3);

  const q4 = parse("kitna udhar hai");
  ok(
    "without a shop it stays the whole book",
    q4.kind === "query" && q4.metric === "outstanding",
    q4,
  );

  const q5 = parse("aaj kitne order huye");
  ok("order count question", q5.kind === "query" && q5.metric === "orders", q5);
  ok("for today", q5.kind === "query" && q5.period === "today", q5);

  /* ------------------------------------------------------- still no deleting */
  section("safety: the new commands write nothing on their own");
  const writesToo = [
    parse("das hazar mango bottle 250 aaye cost do sau"),
    parse("paanch chocolate cash bech diye Downtown"),
  ];
  ok(
    "both come back as proposals with their own warnings",
    writesToo.every((c) => (c.kind === "batch" || c.kind === "sale") && Array.isArray(c.warnings)),
    writesToo.map((c) => c.kind),
  );

  console.log(`\n${checks - failures}/${checks} voice checks passed`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
