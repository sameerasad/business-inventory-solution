/**
 * Nothing fetches the signed-in user inside a transaction.
 *
 * This is a source check rather than a behavioural one because the behaviour
 * is invisible until it is not: the code reads fine, typechecks, passes every
 * suite that calls actions from a script - where there is no cookie, so the
 * lookup short-circuits and never runs - and then fails in production under a
 * real session, holding a connection while it waits for another.
 *
 * That is exactly how Receive Stock broke. currentActor() had been a pure
 * environment read for the life of the project; giving it the signed-in user
 * turned one line in the middle of three transactions into a database round
 * trip, and no test in the repository could see it.
 *
 * Who is signed in cannot change while a transaction runs, so reading it
 * first costs nothing and is never wrong.
 */
import fs from "node:fs";
import path from "node:path";

const ROOTS = ["src/actions", "src/lib", "src/app"];

/** Every .ts/.tsx file under the roots. */
function sources(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) sources(p, out);
    else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

/**
 * The span of each `$transaction(` call, by brace depth.
 *
 * Crude on purpose: a brace inside a string or a comment would throw the count
 * off, and the answer this gives would then be wrong in the safe direction
 * (reporting more of the file as "inside a transaction" than really is). A
 * false alarm here costs a minute; a miss costs a broken page in production.
 */
function transactionSpans(src) {
  const spans = [];
  const re = /\$transaction\(/g;
  let m;
  while ((m = re.exec(src))) {
    let depth = 0;
    let i = m.index + m[0].length - 1;
    for (; i < src.length; i += 1) {
      if (src[i] === "(") depth += 1;
      else if (src[i] === ")") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    spans.push([m.index, i]);
  }
  return spans;
}

/** Calls that go to the database to find out who is asking. */
const FORBIDDEN = [/\bcurrentUser\(\)/, /\bviewer\(\)/, /\bvisibleAreaIds\(/, /\brequireUser\(\)/, /\brequireAdmin\(\)/];

let failures = 0;
const files = ROOTS.filter((r) => fs.existsSync(r)).flatMap((r) => sources(r));

for (const file of files) {
  const src = fs.readFileSync(file, "utf8");
  if (!src.includes("$transaction(")) continue;

  for (const [start, end] of transactionSpans(src)) {
    const inside = src.slice(start, end);
    for (const pattern of FORBIDDEN) {
      const hit = pattern.exec(inside);
      if (!hit) continue;
      failures += 1;
      const line = src.slice(0, start + hit.index).split("\n").length;
      console.error(
        `  FAIL  ${file}:${line} calls ${hit[0]} inside a transaction.` +
          `\n        Read it before the transaction opens and pass the value in.`,
      );
    }
  }
}

const scanned = files.filter((f) => fs.readFileSync(f, "utf8").includes("$transaction(")).length;
if (failures === 0) {
  console.log(`  PASS  no session lookup inside any transaction (${scanned} file(s) with transactions)`);
}

// A check that scans nothing passes vacuously, which is the failure mode this
// whole file exists to argue against.
if (scanned === 0) {
  console.error("  FAIL  found no transactions at all - this check is not looking at anything");
  failures += 1;
}

console.log(failures === 0 ? "\nTRANSACTIONS OK" : `\n${failures} TRANSACTION FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
