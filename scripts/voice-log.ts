/**
 * What voice has actually been asked to do, and how it went.
 *
 *     npm run voice:log
 *     npm run voice:log -- --days 7
 *     npm run voice:log -- --failed
 *
 * Read-only.
 *
 * The point of this is to replace opinion with evidence. Everything done to
 * improve the hearing half so far was measured against synthesised speech and
 * a single screenshot, because that is all there was - and the next decisions
 * (a different microphone setting, a paid Urdu model, a different prompt) are
 * not worth making on that.
 *
 * Read it looking for WHERE things failed, because the two halves need
 * opposite fixes:
 *
 *   a transcript that is noise          -> it was never heard. Microphone,
 *                                          room, or the model. Try Raw capture.
 *   a clean transcript read as unknown  -> it was heard and misunderstood.
 *                                          Usually a phrasing worth teaching.
 *   understood but never saved          -> it was understood WRONG. The most
 *                                          useful rows in the table.
 */
import { prisma } from "@/lib/db";

const DIM = "[2m";
const BOLD = "[1m";
const RED = "[31m";
const YELLOW = "[33m";
const GREEN = "[32m";
const OFF = "[0m";

const args = process.argv.slice(2);
const failedOnly = args.includes("--failed");
const days = (() => {
  const i = args.indexOf("--days");
  const n = i >= 0 ? Number.parseInt(args[i + 1] ?? "", 10) : NaN;
  return Number.isInteger(n) && n > 0 ? n : 14;
})();

async function main() {
  const since = new Date(Date.now() - days * 86400000);

  const rows = await prisma.voiceAttempt.findMany({
    where: {
      createdAt: { gte: since },
      ...(failedOnly ? { OR: [{ kind: "unknown" }, { saved: false }] } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: 200,
  });

  /**
   * Which language setting was used, and which script came back.
   *
   * These two were recorded from the start and not shown, which meant the most
   * useful comparison in the whole table had to be done by hand against the
   * database. The first twenty commands said Urdu-script transcripts were
   * understood 47% of the time against 100% for Latin ones - the sort of thing
   * this tool exists to make obvious.
   */
  const script = (text: string) => (/[\u0600-\u06FF]/.test(text) ? "urdu" : "latin");

  if (rows.length === 0) {
    console.log(
      `\nNothing recorded in the last ${days} days.\n` +
        `${DIM}Either voice has not been used, or this is running against a database ` +
        `that is not the one being used.${OFF}`,
    );
    return;
  }

  /* ------------------------------------------------------------ the summary */
  const total = rows.length;
  const unknown = rows.filter((r) => r.kind === "unknown").length;
  const understood = total - unknown;
  const saved = rows.filter((r) => r.saved).length;
  // Only writes can be saved, so a question or a navigation is not a failure
  // for never having been.
  const writable = rows.filter(
    (r) => !["unknown", "query", "navigate", "open"].includes(r.kind),
  ).length;

  const pct = (n: number, of: number) => (of === 0 ? "-" : `${Math.round((n / of) * 100)}%`);

  console.log(`\n${BOLD}Last ${days} days: ${total} spoken commands${OFF}`);
  console.log(`  understood            ${understood}  ${DIM}(${pct(understood, total)})${OFF}`);
  console.log(`  not understood        ${unknown}  ${DIM}(${pct(unknown, total)})${OFF}`);
  if (writable > 0) {
    console.log(
      `  proposed a write      ${writable}, of which ${saved} were saved  ` +
        `${DIM}(${pct(saved, writable)})${OFF}`,
    );
    console.log(`${DIM}  A write proposed and then abandoned was usually understood wrong.${OFF}`);
  }

  const byEngine = new Map<string, number>();
  for (const r of rows) byEngine.set(r.engine, (byEngine.get(r.engine) ?? 0) + 1);
  console.log(`  engines               ${[...byEngine].map(([e, n]) => `${e} ${n}`).join(", ")}`);

  console.log(`\n${BOLD}Which script the transcript came back in${OFF}`);
  console.log(`${DIM}  Whisper mangles Urdu script far more than it mangles Roman, and the`);
  console.log(`  interpreting model reads Roman perfectly well - so this is the number`);
  console.log(`  that decides which language the microphone should be set to.${OFF}`);
  for (const which of ["latin", "urdu"] as const) {
    const group = rows.filter((r) => script(r.transcript) === which);
    if (group.length === 0) continue;
    const got = group.filter((r) => r.kind !== "unknown").length;
    const kept = group.filter((r) => r.saved).length;
    console.log(
      `  ${which.padEnd(6)} ${String(group.length).padStart(3)} commands, ` +
        `understood ${pct(got, group.length).padStart(4)}, saved ${kept}`,
    );
  }

  const withProb = rows.filter((r) => r.noSpeechProb != null);
  if (withProb.length > 0) {
    const avg = withProb.reduce((s, r) => s + (r.noSpeechProb ?? 0), 0) / withProb.length;
    console.log(
      `  average no-speech     ${avg.toFixed(3)}  ` +
        `${DIM}(near 0 means it heard speech clearly)${OFF}`,
    );
  }

  /* -------------------------------------------------------------- the rows */
  console.log(`\n${BOLD}What was said${OFF}`);
  for (const row of rows) {
    const when = row.createdAt.toISOString().slice(5, 16).replace("T", " ");
    const verdict =
      row.kind === "unknown"
        ? `${RED}not understood${OFF}`
        : row.saved
          ? `${GREEN}${row.kind}, saved${OFF}`
          : `${YELLOW}${row.kind}${OFF}`;
    const prob = row.noSpeechProb != null ? ` ${DIM}nsp ${row.noSpeechProb.toFixed(2)}${OFF}` : "";
    console.log(
      `  ${DIM}${when}${OFF}  ${verdict}${prob}` +
        ` ${DIM}[${row.language} -> ${script(row.transcript)}]${OFF}`,
    );
    console.log(`      "${row.transcript}"`);
  }

  console.log(
    `\n${DIM}A noisy transcript is a hearing problem - try the Raw microphone setting.\n` +
      `A clean transcript that was not understood is a phrasing problem.${OFF}`,
  );
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
