/**
 * Type a sentence, see what the system understood. No microphone, no browser.
 *
 *     npm run voice:try
 *     npm run voice:try -- "Anum bakery ko bees aam ki chhoti bottle bhej do"
 *
 * This exists because the voice feature is two separate machines wired
 * together, and testing them at the same time is what made every earlier
 * problem so hard to pin down:
 *
 *   1. Whisper turns your voice into text. It mishears names.
 *   2. A language model turns that text into a command against your catalog.
 *
 * When something goes wrong through the microphone you cannot tell which half
 * failed. Here the text is exactly what you typed, so anything wrong is the
 * second half - and if a sentence works here but not through the microphone,
 * the fault was hearing it, not understanding it.
 *
 * Nothing is saved. This only ever prints what WOULD be proposed.
 */
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

import { getVoiceCatalog } from "@/lib/voice/answer";
import { interpretWithLlm, llmProvider } from "@/lib/voice/llm";
import { parseCommand } from "@/lib/voice/parse";

/** The app loads .env through Next; a plain script has to do it itself. */
function loadDotEnv(file = ".env"): void {
  const full = path.join(process.cwd(), file);
  if (!fs.existsSync(full)) return;
  for (const raw of fs.readFileSync(full, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
loadDotEnv();

const DIM = "[2m";
const BOLD = "[1m";
const GREEN = "[32m";
const YELLOW = "[33m";
const RED = "[31m";
const OFF = "[0m";

type Catalog = Awaited<ReturnType<typeof getVoiceCatalog>>;

/**
 * Print a proposal the way the confirmation card does: what it would do, what
 * is still blank, and what you should look at before saving.
 */
function show(command: Awaited<ReturnType<typeof parseCommand>>): void {
  const k = command;
  console.log(`  ${BOLD}${k.kind}${OFF}`);

  switch (k.kind) {
    case "navigate":
      console.log(`    open ${k.href}`);
      break;
    case "query":
      console.log(`    ${k.metric}${k.period ? ` for ${k.period}` : ""}`);
      break;
    case "booking":
      console.log(`    shop:  ${k.shopName ?? `${YELLOW}(not identified)${OFF}`}`);
      console.log(`    area:  ${k.areaName ?? `${YELLOW}(not identified)${OFF}`}`);
      console.log(`    date:  ${k.date}`);
      for (const line of k.lines) {
        console.log(`    line:  ${line.quantity} x ${line.label} @ ${line.unitPrice}`);
      }
      break;
    case "sale":
      console.log(`    ${k.quantity} x ${k.label} @ ${k.unitPrice} - cash`);
      break;
    case "payment":
      console.log(`    invoice ${k.bookingId ?? `${YELLOW}(none)${OFF}`}, amount ${k.amount}`);
      break;
    case "batch":
      console.log(`    ${k.quantity} x ${k.label ?? "?"} at cost ${k.unitCost ?? "?"}`);
      break;
    case "shop":
      console.log(`    new shop "${k.name}" in ${k.areaName ?? "?"}`);
      break;
    case "unknown":
      console.log(`    ${YELLOW}${k.reason}${OFF}`);
      break;
  }

  if ("missing" in k && k.missing.length > 0) {
    console.log(`    ${RED}still blank: ${k.missing.join(", ")}${OFF}`);
  }
  if ("warnings" in k && k.warnings.length > 0) {
    for (const w of k.warnings) console.log(`    ${YELLOW}check: ${w}${OFF}`);
  }
  if ("confidence" in k) {
    const colour = k.confidence === "high" ? GREEN : YELLOW;
    console.log(`    ${colour}confidence: ${k.confidence}${OFF}`);
  }
}

async function run(said: string, catalog: Catalog): Promise<void> {
  const started = Date.now();
  const provider = llmProvider();

  if (provider === "none") {
    console.log(`\n${DIM}rule parser (no model configured)${OFF}`);
    show(parseCommand(said, catalog));
    return;
  }

  const outcome = await interpretWithLlm(said, catalog);
  const took = ((Date.now() - started) / 1000).toFixed(1);

  if (!outcome.ok) {
    // Worth showing both: this is exactly what the app does, and seeing the
    // parser's answer tells you whether the fallback would have coped.
    console.log(`\n${RED}the model could not answer: ${outcome.reason}${OFF}`);
    console.log(`${DIM}falling back to the rule parser, as the app would${OFF}`);
    show(parseCommand(said, catalog));
    return;
  }

  console.log(`\n${DIM}${outcome.model} - ${took}s${OFF}`);
  show(outcome.command);
}

async function main() {
  const catalog = await getVoiceCatalog();
  const provider = llmProvider();

  console.log(`\n${BOLD}What did it understand?${OFF}`);
  console.log(
    `${DIM}engine: ${provider}   catalog: ${catalog.shops.length} shops, ` +
      `${catalog.products.length} products, ${catalog.areas.length} areas${OFF}`,
  );
  console.log(`${DIM}Nothing is saved. Ctrl+C to stop.${OFF}`);

  const asked = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  if (asked.length > 0) {
    for (const said of asked) {
      console.log(`\n${BOLD}> ${said}${OFF}`);
      await run(said, catalog);
    }
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = () =>
    new Promise<string>((resolve) => rl.question(`\n${BOLD}> ${OFF}`, (a) => resolve(a)));

  for (;;) {
    const said = (await ask()).trim();
    if (!said) continue;
    if (said === "exit" || said === "quit") break;
    await run(said, catalog);
  }
  rl.close();
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    const { prisma } = await import("@/lib/db");
    await prisma.$disconnect();
  });
