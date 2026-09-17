/**
 * What voice keeps mishearing, and what it should be taught to expect.
 *
 *     npm run voice:learn
 *     npm run voice:learn -- --days 60
 *     npm run voice:learn -- --apply        (the only form that writes)
 *
 * Read-only unless --apply is passed.
 *
 * The idea this replaced was to add columns recording which shop and product
 * each command resolved to, so that a saved command would be a confirmed pair
 * of "this mangled text" and "this row". That was a schema change reaching for
 * evidence the database already holds: the transcripts are logged in full, and
 * a name mangled by Whisper is still close enough to the real one to be
 * recognised - "راجپوٹیری" against "Rajput Dairy" is a near miss, not a
 * different string. The live matcher refuses it only because it sits under a
 * threshold chosen so that a wrong shop is never picked silently.
 *
 * So this runs the same comparison OFFLINE, where being wrong costs nothing,
 * with the threshold lowered - and replaces the certainty it gives up with two
 * rules that do not need it:
 *
 *   repetition   a mangling counts only if the same one turned up in several
 *                separate recordings. Once is a bad recording; five times is
 *                how the microphone hears that word in this shop, in this
 *                room, in this accent.
 *   no collision a mangling that sits near two different rows teaches nothing
 *                and is dropped. Only a clear winner is proposed.
 *
 * What it proposes is a voiceAlias: a word the engine actually produces,
 * pointed at the record it means. That feeds both halves at once - the alias
 * joins the vocabulary Whisper is primed with, and it is matched against
 * directly when a command is read.
 *
 * It cannot make anything save by itself. Every write still passes the
 * confirmation card, which is the reason a lowered threshold is affordable
 * here at all.
 */
import { prisma } from "@/lib/db";
import { getVoiceCatalog } from "@/lib/voice/answer";
import { distinctiveName } from "@/lib/voice/names";
import { normalise, similarity, tokenise } from "@/lib/voice/normalise";
import {
  BATCH_VERBS,
  CANCEL_WORDS,
  CONFIRM_WORDS,
  COUNTER_WORDS,
  LOCALITY_WORDS,
  NAVIGATE_VERBS,
  NEW_AREA_VERBS,
  NEW_SHOP_VERBS,
  NUMBER_WORDS,
  PAYMENT_VERBS,
  PHONE_WORDS,
  PLACE_WORDS,
  PRICE_WORDS,
  QUERY_VERBS,
  SALE_VERBS,
  STOP_WORDS,
  UNIT_WORDS,
} from "@/lib/voice/lexicon";

/**
 * Words that are part of the language, not part of a name.
 *
 * The first run of this proposed teaching the app that Saleem General Store is
 * called "ml saleem" - seen five times, and wrong: "ml" is the tail of "250 ml"
 * and simply happens to sit before the shop every time an order is spoken. It
 * also offered "karo" for Yaro goth and "stand" for Grand Pa Bakery. Repetition
 * alone cannot tell a mishearing from a word that is always there.
 */
const ORDINARY = new Set<string>([
  ...STOP_WORDS,
  ...UNIT_WORDS,
  ...PRICE_WORDS,
  ...COUNTER_WORDS,
  ...LOCALITY_WORDS,
  ...PLACE_WORDS,
  ...PHONE_WORDS,
  ...CONFIRM_WORDS,
  ...CANCEL_WORDS,
  ...Object.keys(NUMBER_WORDS),
  ...NAVIGATE_VERBS,
  ...QUERY_VERBS,
  ...SALE_VERBS,
  ...PAYMENT_VERBS,
  ...BATCH_VERBS,
  ...NEW_SHOP_VERBS,
  ...NEW_AREA_VERBS,
].map((w) => normalise(String(w))));

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const OFF = "\x1b[0m";

const argv = process.argv.slice(2);
const apply = argv.includes("--apply");
const days = (() => {
  const i = argv.indexOf("--days");
  const n = i >= 0 ? Number.parseInt(argv[i + 1] ?? "", 10) : NaN;
  return Number.isInteger(n) && n > 0 ? n : 30;
})();

/** Close enough to be the same word misheard. Deliberately under the live one. */
const FLOOR = 0.55;
/** At or above this it is not a mishearing, it is the name. Nothing to teach. */
const ALREADY_FINE = 0.9;
/** How far ahead of the runner-up row the winner must be to count as clear. */
const CLEAR_BY = 0.08;
/** Separate recordings the same mangling must appear in before it is proposed. */
const TIMES = 3;

type Target = { kind: "shop" | "area" | "booker"; id: number; name: string; alias: string | null };

async function main() {
  const catalog = await getVoiceCatalog();
  const targets: Target[] = [
    ...catalog.shops.map((s) => ({ kind: "shop" as const, id: s.id, name: s.name, alias: s.voiceAlias })),
    ...catalog.areas.map((a) => ({ kind: "area" as const, id: a.id, name: a.name, alias: a.voiceAlias })),
    ...catalog.bookers.map((b) => ({ kind: "booker" as const, id: b.id, name: b.name, alias: b.voiceAlias })),
  ];

  const rows = await prisma.voiceAttempt.findMany({
    where: { createdAt: { gte: new Date(Date.now() - days * 86400000) } },
    orderBy: { createdAt: "desc" },
  });

  if (rows.length === 0) {
    console.log(`\nNothing recorded in the last ${days} days.`);
    return;
  }

  /**
   * The forms of each name worth comparing against.
   *
   * Both the whole name and its distinctive word, because a mangling can land
   * near either: "راجپوٹیری" is close to the whole of "Rajput Dairy", while
   * "سلیم" is close only to the distinctive part of "Saleem General Store".
   */
  const formsOf = (t: Target) => {
    const forms = [normalise(t.name), normalise(distinctiveName(t.name))];
    return [...new Set(forms.filter((f) => f.length >= 3))];
  };

  /**
   * How many recordings each single word turns up in.
   *
   * A name belongs to the handful of commands that are about that shop. A word
   * that shows up in a quarter of everything said is part of how orders are
   * phrased, whatever it happens to resemble - and no word list will ever name
   * them all, since half of these transcripts are English translations.
   */
  const everywhere = new Set<string>();
  {
    const appearances = new Map<string, number>();
    for (const row of rows) {
      const words = new Set(row.transcript.split("|").flatMap((r) => tokenise(r)));
      for (const w of words) appearances.set(w, (appearances.get(w) ?? 0) + 1);
    }
    const tooCommon = Math.max(3, Math.ceil(rows.length * 0.2));
    for (const [w, n] of appearances) if (n >= tooCommon) everywhere.add(w);
  }

  /** A run of words that could plausibly BE a name. */
  const couldBeAName = (gram: string) =>
    gram.split(" ").every((w) => !ORDINARY.has(w) && !everywhere.has(w));

  /** token → target id → how many separate recordings it appeared in. */
  const seen = new Map<string, Map<number, { target: Target; score: number; count: number }>>();
  const keyOf = (t: Target) => `${t.kind}:${t.id}`;

  for (const row of rows) {
    // One recording may carry several readings of itself; a mangling repeated
    // across them is still one sighting, not two.
    const grams = new Set<string>();
    for (const reading of row.transcript.split("|")) {
      const tokens = tokenise(reading);
      for (let i = 0; i < tokens.length; i += 1) {
        // One, two and three words: Whisper runs names together as often as it
        // splits them - "راج پوٹیری" and "راجپوٹیری" are the same miss.
        for (let n = 1; n <= 3 && i + n <= tokens.length; n += 1) {
          const gram = tokens.slice(i, i + n).join(" ");
          if (gram.length >= 4 && couldBeAName(gram)) grams.add(gram);
        }
      }
    }

    for (const gram of grams) {
      // Best and runner-up ACROSS ROWS, so a gram near two shops is dropped.
      let best: { target: Target; score: number } | null = null;
      let second = 0;
      for (const target of targets) {
        const score = Math.max(...formsOf(target).map((f) => similarity(gram, f)));
        if (!best || score > best.score) {
          if (best) second = Math.max(second, best.score);
          best = { target, score };
        } else if (score > second) {
          second = score;
        }
      }
      if (!best) continue;
      if (best.score < FLOOR || best.score >= ALREADY_FINE) continue;
      if (best.score - second < CLEAR_BY) continue;

      const perTarget = seen.get(gram) ?? new Map();
      const key = best.target.id * 10 + ["shop", "area", "booker"].indexOf(best.target.kind);
      const entry = perTarget.get(key) ?? { target: best.target, score: best.score, count: 0 };
      entry.count += 1;
      entry.score = Math.max(entry.score, best.score);
      perTarget.set(key, entry);
      seen.set(gram, perTarget);
    }
  }

  /* Gather by target, so the report reads as "this shop is heard as these". */
  const byTarget = new Map<string, { target: Target; grams: { gram: string; count: number; score: number }[] }>();
  for (const [gram, perTarget] of seen) {
    for (const entry of perTarget.values()) {
      const k = keyOf(entry.target);
      const bucket = byTarget.get(k) ?? { target: entry.target, grams: [] };
      bucket.grams.push({ gram, count: entry.count, score: entry.score });
      byTarget.set(k, bucket);
    }
  }

  console.log(`\n${BOLD}Mishearings over the last ${days} days, from ${rows.length} recordings${OFF}`);
  console.log(
    `${DIM}A word has to turn up in ${TIMES} separate recordings, and sit clearly nearer\n` +
      `one record than any other, before it is worth teaching.${OFF}`,
  );

  const proposals: { target: Target; gram: string; count: number }[] = [];

  for (const { target, grams } of [...byTarget.values()].sort((a, b) =>
    Math.max(...b.grams.map((g) => g.count)) - Math.max(...a.grams.map((g) => g.count)),
  )) {
    const strong = grams.filter((g) => g.count >= TIMES).sort((a, b) => b.count - a.count);
    const weak = grams.filter((g) => g.count < TIMES).sort((a, b) => b.count - a.count);
    if (strong.length === 0 && weak.filter((w) => w.count > 1).length === 0) continue;

    console.log(`\n  ${BOLD}${target.name}${OFF} ${DIM}(${target.kind})${OFF}`);
    if (target.alias) console.log(`    ${DIM}already taught: "${target.alias}"${OFF}`);
    for (const g of strong) {
      console.log(`    ${GREEN}${String(g.count).padStart(2)}x${OFF}  "${g.gram}"  ${DIM}${g.score.toFixed(2)}${OFF}`);
    }
    for (const g of weak.filter((w) => w.count > 1).slice(0, 3)) {
      console.log(`    ${DIM}${String(g.count).padStart(2)}x  "${g.gram}"  ${g.score.toFixed(2)} - too few to trust${OFF}`);
    }
    if (strong.length > 0 && strong[0]!.gram !== target.alias) {
      proposals.push({ target, gram: strong[0]!.gram, count: strong[0]!.count });
    }
  }

  /* ------------------------------------------------------------- what to do */
  if (proposals.length === 0) {
    console.log(`\n${DIM}Nothing repeated often enough to propose yet.${OFF}`);
    return;
  }

  console.log(`\n${BOLD}Proposed${OFF}`);
  console.log(
    `${DIM}One alias per record is all the column holds, so this is the most\n` +
      `frequent mishearing for each - not all of them.${OFF}`,
  );
  for (const p of proposals) {
    const replacing = p.target.alias ? ` ${YELLOW}(replaces "${p.target.alias}")${OFF}` : "";
    console.log(`  ${p.target.name} ${DIM}→${OFF} "${p.gram}"  ${DIM}seen ${p.count}x${OFF}${replacing}`);
  }

  if (!apply) {
    console.log(`\n${DIM}Nothing was written. Run again with --apply to teach these.${OFF}`);
    return;
  }

  for (const p of proposals) {
    const data = { voiceAlias: p.gram };
    if (p.target.kind === "shop") await prisma.shop.update({ where: { id: p.target.id }, data });
    else if (p.target.kind === "area") await prisma.area.update({ where: { id: p.target.id }, data });
    else await prisma.booker.update({ where: { id: p.target.id }, data });
    console.log(`  taught: ${p.target.name} → "${p.gram}"`);
  }
  console.log(`\n${GREEN}${proposals.length} written.${OFF} ${DIM}Undo by clearing the alias on the record.${OFF}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
