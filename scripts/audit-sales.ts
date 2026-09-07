/**
 * What was actually sold, and does it add up?
 *
 *     npm run audit:sales
 *     npm run audit:sales -- --day 2026-09-06
 *     npm run audit:sales -- --shop "Rajput Dairy"
 *
 * Read-only. It opens nothing and changes nothing.
 *
 * The one thing worth understanding before reading the output: `sales` is the
 * only record of goods leaving stock. A booking's lines ARE sales rows, tagged
 * with that booking's id; a counter sale is a sales row with no booking. So
 * bookings and sales are not two piles to be added - adding them counts the
 * same cartons twice, which is the most common way these numbers get doubted.
 *
 * Everything printed is derived from the rows, never from a stored total, so a
 * figure here disagreeing with a figure on screen means the screen is wrong,
 * not that two sources drifted.
 */
import { prisma } from "@/lib/db";

const DIM = "[2m";
const BOLD = "[1m";
const RED = "[31m";
const YELLOW = "[33m";
const GREEN = "[32m";
const OFF = "[0m";

const args = process.argv.slice(2);
function flag(name: string): string | null {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : null;
}

const rupees = (n: number) =>
  `Rs ${n.toLocaleString("en-PK", { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
const iso = (d: Date) => d.toISOString().slice(0, 10);

function heading(text: string) {
  console.log(`\n${BOLD}${text}${OFF}`);
  console.log(DIM + "-".repeat(text.length) + OFF);
}

async function main() {
  const today = iso(new Date());
  const day = flag("day");
  const shopFilter = flag("shop");

  /* ------------------------------------------------- the ledger, by day */
  heading("Goods out, by day");
  console.log(
    `${DIM}A booking line and a counter sale are both a sales row. ` +
      `"Total out" is every row - it is NOT bookings plus sales.${OFF}\n`,
  );

  const byDay = await prisma.$queryRaw<
    {
      sale_date: Date;
      booked_lines: bigint;
      booked_units: bigint;
      booked_value: number;
      counter_lines: bigint;
      counter_units: bigint;
      counter_value: number;
      total_value: number;
      invoices: bigint;
    }[]
  >`
    SELECT s.sale_date,
           COUNT(*) FILTER (WHERE s.booking_id IS NOT NULL)                    AS booked_lines,
           COALESCE(SUM(s.quantity) FILTER (WHERE s.booking_id IS NOT NULL), 0) AS booked_units,
           COALESCE(SUM(s.quantity * s.sale_price) FILTER (WHERE s.booking_id IS NOT NULL), 0)::float8 AS booked_value,
           COUNT(*) FILTER (WHERE s.booking_id IS NULL)                        AS counter_lines,
           COALESCE(SUM(s.quantity) FILTER (WHERE s.booking_id IS NULL), 0)     AS counter_units,
           COALESCE(SUM(s.quantity * s.sale_price) FILTER (WHERE s.booking_id IS NULL), 0)::float8 AS counter_value,
           COALESCE(SUM(s.quantity * s.sale_price), 0)::float8                  AS total_value,
           COUNT(DISTINCT s.booking_id)                                        AS invoices
      FROM sales s
     WHERE s.is_deleted = false
     GROUP BY s.sale_date
     ORDER BY s.sale_date DESC
     LIMIT 14`;

  if (byDay.length === 0) console.log("  No sales recorded at all.");
  console.log(
    `  ${"date".padEnd(12)}${"booked".padStart(22)}${"counter".padStart(20)}${"total out".padStart(14)}`,
  );
  for (const r of byDay) {
    const d = iso(r.sale_date);
    const mark = d === today ? " (today)" : "";
    console.log(
      `  ${d.padEnd(12)}` +
        `${`${r.booked_units}u / ${rupees(r.booked_value)}`.padStart(22)}` +
        `${`${r.counter_units}u / ${rupees(r.counter_value)}`.padStart(20)}` +
        `${rupees(r.total_value).padStart(14)}${DIM}${mark}${OFF}`,
    );
  }

  /* ------------------------------------------- bookings that moved nothing */
  const empty = await prisma.$queryRaw<{ invoice_no: string; booking_date: Date }[]>`
    SELECT b.invoice_no, b.booking_date
      FROM bookings b
     WHERE b.is_deleted = false
       AND NOT EXISTS (SELECT 1 FROM sales s WHERE s.booking_id = b.id AND s.is_deleted = false)
     ORDER BY b.booking_date DESC`;
  if (empty.length > 0) {
    heading("Invoices with no lines");
    console.log(`${DIM}An invoice exists but nothing left stock against it.${OFF}`);
    for (const e of empty) console.log(`  ${YELLOW}${e.invoice_no}${OFF}  ${iso(e.booking_date)}`);
  }

  /* ----------------------------------------------------- one day in detail */
  const focus = day ?? (byDay[0] ? iso(byDay[0].sale_date) : today);
  heading(`Every line on ${focus}`);
  const lines = await prisma.$queryRaw<
    {
      id: number;
      invoice_no: string | null;
      shop: string | null;
      area: string;
      product: string;
      packaging: string;
      variant: string;
      quantity: number;
      sale_price: number;
      unit_cost: number;
      created_at: Date;
    }[]
  >`
    SELECT s.id, b.invoice_no, sh.name AS shop, ar.name AS area,
           p.name AS product, p.packaging_type AS packaging, p.variant_value AS variant,
           s.quantity, s.sale_price::float8 AS sale_price, ba.unit_cost::float8 AS unit_cost,
           s.created_at
      FROM sales s
      JOIN products p ON p.id = s.product_id
      JOIN batches ba ON ba.id = s.batch_id
      JOIN areas ar ON ar.id = s.area_id
      LEFT JOIN shops sh ON sh.id = s.shop_id
      LEFT JOIN bookings b ON b.id = s.booking_id
     WHERE s.is_deleted = false AND s.sale_date = ${focus}::date
     ORDER BY s.created_at`;

  if (lines.length === 0) {
    console.log(`  ${GREEN}Nothing was sold on ${focus}.${OFF}`);
  }
  let dayValue = 0;
  let dayProfit = 0;
  for (const l of lines) {
    const value = l.quantity * l.sale_price;
    const profit = (l.sale_price - l.unit_cost) * l.quantity;
    dayValue += value;
    dayProfit += profit;
    console.log(
      `  #${String(l.id).padEnd(4)} ${(l.invoice_no ?? "counter sale").padEnd(15)} ` +
        `${(l.shop ?? `(${l.area})`).padEnd(24)} ${l.quantity} x ${l.product} ${l.packaging} ${l.variant}` +
        ` @ ${l.sale_price} ${DIM}= ${rupees(value)}, profit ${rupees(profit)}${OFF}`,
    );
  }
  if (lines.length > 0) {
    console.log(
      `  ${BOLD}${lines.length} line(s), ${rupees(dayValue)}, profit ${rupees(dayProfit)}${OFF}`,
    );
  }

  /* --------------------------------------------------------- one shop */
  if (shopFilter) {
    heading(`Everything for a shop matching "${shopFilter}"`);
    const rows = await prisma.$queryRaw<
      {
        sale_date: Date;
        invoice_no: string | null;
        shop: string;
        product: string;
        packaging: string;
        variant: string;
        quantity: number;
        sale_price: number;
      }[]
    >`
      SELECT s.sale_date, b.invoice_no, sh.name AS shop,
             p.name AS product, p.packaging_type AS packaging, p.variant_value AS variant,
             s.quantity, s.sale_price::float8 AS sale_price
        FROM sales s
        JOIN products p ON p.id = s.product_id
        JOIN shops sh ON sh.id = s.shop_id
        LEFT JOIN bookings b ON b.id = s.booking_id
       WHERE s.is_deleted = false AND sh.name ILIKE ${`%${shopFilter}%`}
       ORDER BY s.sale_date DESC, s.id DESC
       LIMIT 40`;
    if (rows.length === 0) console.log("  No sales for that shop.");
    for (const r of rows) {
      console.log(
        `  ${iso(r.sale_date)}  ${(r.invoice_no ?? "counter").padEnd(15)} ` +
          `${r.quantity} x ${r.product} ${r.packaging} ${r.variant} @ ${r.sale_price}` +
          `${DIM} = ${rupees(r.quantity * r.sale_price)}${OFF}`,
      );
    }
  }

  /* ------------------------------------------------------ does it add up? */
  heading("Integrity");

  const overAllocated = await prisma.$queryRaw<
    { id: number; product: string; quantity: number; sold: bigint; remaining: number }[]
  >`
    SELECT ba.id, p.name AS product, ba.quantity, ba.remaining_qty AS remaining,
           COALESCE(SUM(s.quantity), 0) AS sold
      FROM batches ba
      JOIN products p ON p.id = ba.product_id
      LEFT JOIN sales s ON s.batch_id = ba.id AND s.is_deleted = false
     WHERE ba.is_deleted = false
     GROUP BY ba.id, p.name, ba.quantity, ba.remaining_qty
    HAVING ba.quantity - COALESCE(SUM(s.quantity), 0) <> ba.remaining_qty`;

  if (overAllocated.length === 0) {
    console.log(`  ${GREEN}[ok]${OFF} every batch's remaining stock equals received minus sold`);
  } else {
    for (const b of overAllocated) {
      console.log(
        `  ${RED}[drift]${OFF} batch #${b.id} ${b.product}: received ${b.quantity}, ` +
          `sold ${b.sold}, remaining says ${b.remaining} ` +
          `(should be ${b.quantity - Number(b.sold)})`,
      );
    }
  }

  const overPaid = await prisma.$queryRaw<{ invoice_no: string; value: number; paid: number }[]>`
    WITH v AS (
      SELECT b.id, b.invoice_no,
             COALESCE(SUM(s.quantity * s.sale_price), 0)::float8 AS value
        FROM bookings b
        LEFT JOIN sales s ON s.booking_id = b.id AND s.is_deleted = false
       WHERE b.is_deleted = false
       GROUP BY b.id, b.invoice_no
    ), p AS (
      SELECT booking_id, COALESCE(SUM(amount), 0)::float8 AS paid
        FROM payments WHERE is_deleted = false GROUP BY booking_id
    )
    SELECT v.invoice_no, v.value, COALESCE(p.paid, 0) AS paid
      FROM v LEFT JOIN p ON p.booking_id = v.id
     WHERE COALESCE(p.paid, 0) > v.value + 0.005`;

  if (overPaid.length === 0) {
    console.log(`  ${GREEN}[ok]${OFF} no invoice is paid more than it is worth`);
  } else {
    for (const o of overPaid) {
      console.log(
        `  ${RED}[overpaid]${OFF} ${o.invoice_no}: worth ${rupees(o.value)}, ` +
          `paid ${rupees(o.paid)}`,
      );
    }
  }

  // Two identical lines on the same day for the same buyer is legal but is
  // often a form submitted twice, and it is invisible on a list view.
  //
  // The invoice numbers are printed with it because they decide the question:
  // the same invoice twice is a duplicate, whereas two invoices with the same
  // order are two customers who bought the same thing. Reporting one as the
  // other would be worse than not looking.
  const dupes = await prisma.$queryRaw<
    {
      sale_date: Date;
      shop: string | null;
      product: string;
      quantity: number;
      sale_price: number;
      times: bigint;
      ids: string;
      invoices: string;
      distinct_sources: bigint;
    }[]
  >`
    SELECT s.sale_date,
           COALESCE(sh.name, 'no shop - ' || ar.name) AS shop,
           p.name AS product, s.quantity,
           s.sale_price::float8 AS sale_price, COUNT(*) AS times,
           string_agg(s.id::text, ', ' ORDER BY s.id) AS ids,
           string_agg(COALESCE(b.invoice_no, 'counter'), ', ' ORDER BY s.id) AS invoices,
           COUNT(DISTINCT COALESCE(s.booking_id, -s.id)) AS distinct_sources
      FROM sales s
      JOIN products p ON p.id = s.product_id
      JOIN areas ar ON ar.id = s.area_id
      LEFT JOIN shops sh ON sh.id = s.shop_id
      LEFT JOIN bookings b ON b.id = s.booking_id
     WHERE s.is_deleted = false
     GROUP BY s.sale_date, COALESCE(sh.name, 'no shop - ' || ar.name), p.name,
              s.quantity, s.sale_price
    HAVING COUNT(*) > 1
     ORDER BY s.sale_date DESC`;

  if (dupes.length === 0) {
    console.log(`  ${GREEN}[ok]${OFF} no two identical lines on the same day for the same shop`);
  } else {
    for (const d of dupes) {
      // One invoice carrying the line twice is a duplicate. Several invoices
      // carrying the same line are several customers, which is normal.
      const oneSource = Number(d.distinct_sources) === 1;
      const tone = oneSource ? RED : YELLOW;
      const label = oneSource ? "[duplicate]" : "[look]";
      console.log(
        `  ${tone}${label}${OFF} ${iso(d.sale_date)} ${d.shop}: ` +
          `${d.times} identical lines of ${d.quantity} x ${d.product} @ ${d.sale_price}`,
      );
      console.log(`      ${DIM}invoices: ${d.invoices}  (sale ids ${d.ids})${OFF}`);
    }
  }

  /* -------------------------------------------------------------- totals */
  heading("All time");
  const [t] = await prisma.$queryRaw<
    { lines: bigint; units: bigint; value: number; cost: number }[]
  >`
    SELECT COUNT(*) AS lines, COALESCE(SUM(s.quantity), 0) AS units,
           COALESCE(SUM(s.quantity * s.sale_price), 0)::float8 AS value,
           COALESCE(SUM(s.quantity * ba.unit_cost), 0)::float8 AS cost
      FROM sales s JOIN batches ba ON ba.id = s.batch_id
     WHERE s.is_deleted = false`;
  const [inv] = await prisma.$queryRaw<{ invoices: bigint; counter: bigint }[]>`
    SELECT COUNT(DISTINCT s.booking_id) AS invoices,
           COUNT(*) FILTER (WHERE s.booking_id IS NULL) AS counter
      FROM sales s WHERE s.is_deleted = false`;
  const [pay] = await prisma.$queryRaw<{ collected: number }[]>`
    SELECT COALESCE(SUM(amount), 0)::float8 AS collected FROM payments WHERE is_deleted = false`;

  console.log(`  sold          ${t.units} units across ${t.lines} lines`);
  console.log(`  on credit     ${inv.invoices} invoice(s)`);
  console.log(`  over counter  ${inv.counter} line(s)`);
  console.log(`  value         ${rupees(t.value)}`);
  console.log(`  cost          ${rupees(t.cost)}`);
  console.log(`  ${BOLD}profit        ${rupees(t.value - t.cost)}${OFF}`);
  console.log(`  collected     ${rupees(pay.collected)}`);
  console.log(`  outstanding   ${rupees(t.value - pay.collected)}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
