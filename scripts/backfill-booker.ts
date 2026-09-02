/**
 * Attribute historical bookings to a booker.
 *
 * The booker field was added to a business that had already been trading, so
 * every booking taken before it existed has no booker and is excluded from the
 * performance figures. This assigns that whole backlog to one person.
 *
 *   npm run db:backfill-booker                       # list bookers + show the backlog
 *   npm run db:backfill-booker -- --booker "Imran"   # dry run, changes nothing
 *   npm run db:backfill-booker -- --booker "Imran" --apply
 *   npm run db:backfill-booker -- --booker "Imran" --apply --assign-areas
 *
 * Dry run is the default on purpose: this writes to whatever DATABASE_URL points
 * at, which is the live database.
 *
 * Safe to run more than once. It only ever fills rows where booker_id is NULL,
 * so an attribution made deliberately in the app is never overwritten.
 */
import { prisma } from "../src/lib/db";
import {
  attributeUnattributedBookings,
  getUnattributedBookings,
} from "../src/lib/bookers";
import { money } from "../src/lib/format";

/**
 * Reads --name and everything after it up to the next flag.
 *
 * npm strips the quotes from `-- --booker "Saifullah Khan"`, so the name arrives
 * as two separate arguments; taking only the first would silently search for
 * "Saifullah" and match the wrong person if a second one is ever hired.
 */
function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return null;
  const words: string[] = [];
  for (let j = i + 1; j < process.argv.length; j += 1) {
    if (process.argv[j]!.startsWith("--")) break;
    words.push(process.argv[j]!);
  }
  return words.join(" ");
}
const has = (name: string) => process.argv.includes(`--${name}`);

function date(d: Date | null): string {
  return d ? d.toISOString().slice(0, 10) : "-";
}

async function main() {
  const apply = has("apply");
  const assignAreas = has("assign-areas");
  const wanted = arg("booker");

  const summary = await getUnattributedBookings();

  console.log("\nBookings with no booker");
  console.log("-----------------------");
  if (summary.bookings === 0) {
    console.log("None. Every booking is already attributed - nothing to do.\n");
    return;
  }
  console.log(`  Bookings : ${summary.bookings}${
    summary.cancelled > 0 ? ` (${summary.cancelled} of them cancelled)` : ""
  }`);
  console.log(`  Value    : ${money(summary.value)}`);
  console.log(`  Dated    : ${date(summary.firstDate)} to ${date(summary.lastDate)}`);
  console.log(`  Areas    : ${summary.areas.map((a) => a.name).join(", ") || "-"}`);

  const bookers = await prisma.booker.findMany({
    where: { isDeleted: false },
    orderBy: { name: "asc" },
    select: { id: true, name: true, isActive: true, _count: { select: { bookings: true } } },
  });

  if (bookers.length === 0) {
    console.error("\nThere are no bookers yet. Add one on the Bookers page first.\n");
    process.exitCode = 1;
    return;
  }

  if (wanted === null) {
    console.log("\nBookers");
    console.log("-------");
    for (const b of bookers) {
      console.log(
        `  ${String(b.id).padStart(3)}  ${b.name}${b.isActive ? "" : "  (retired)"}` +
          `  - ${b._count.bookings} booking(s) already`,
      );
    }
    console.log(
      `\nTo attribute the ${summary.bookings} booking(s) above, re-run with:\n` +
        `  npm run db:backfill-booker -- --booker "${bookers[0]!.name}" --apply\n` +
        "Add --assign-areas to also make those areas their territory.\n",
    );
    return;
  }

  // Matched on name so the command reads like a sentence; an id also works.
  const needle = wanted.trim().toLowerCase();
  const matches = bookers.filter(
    (b) => b.name.toLowerCase() === needle || String(b.id) === needle,
  );
  const loose =
    matches.length > 0 ? matches : bookers.filter((b) => b.name.toLowerCase().includes(needle));

  if (loose.length === 0) {
    console.error(`\nNo booker matches "${wanted}". Run with no arguments to list them.\n`);
    process.exitCode = 1;
    return;
  }
  if (loose.length > 1) {
    console.error(
      `\n"${wanted}" matches ${loose.length} bookers: ${loose
        .map((b) => b.name)
        .join(", ")}. Be more specific, or pass the id.\n`,
    );
    process.exitCode = 1;
    return;
  }
  const booker = loose[0]!;

  if (!apply) {
    console.log(
      `\nDRY RUN - nothing was changed.\n` +
        `  Would attribute ${summary.bookings} booking(s) worth ${money(summary.value)} to ${booker.name}.` +
        (assignAreas
          ? `\n  Would also add ${summary.areas.length} area(s) to their territory.`
          : "\n  Territory would be left alone (add --assign-areas to set it from those bookings).") +
        `\n\nRe-run with --apply to do it.\n`,
    );
    return;
  }

  const result = await attributeUnattributedBookings({
    bookerId: booker.id,
    assignAreas,
  });

  console.log(
    `\nDone. ${result.bookings} booking(s) are now attributed to ${booker.name}` +
      (result.areasAssigned > 0 ? `, and ${result.areasAssigned} area(s) added to their territory` : "") +
      `.`,
  );

  const left = await getUnattributedBookings();
  console.log(
    left.bookings === 0
      ? "Nothing is unattributed any more.\n"
      : `${left.bookings} booking(s) still have no booker.\n`,
  );
}

main()
  .catch((error) => {
    console.error("\nBackfill failed:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
