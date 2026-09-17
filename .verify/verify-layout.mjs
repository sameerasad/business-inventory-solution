/**
 * Does the dialog actually fit on a phone, and does its body actually scroll?
 *
 * This exists because verify-ui.tsx cannot answer either question. jsdom parses
 * markup but has no layout engine: it can confirm that "overflow-y-auto" is
 * written on an element, and nothing at all about whether that element ever
 * scrolls. The voice panel's bottom being unreachable on a phone shipped twice
 * under a green verify:ui for exactly that reason - both times the class was
 * present and the behaviour was still wrong.
 *
 * So this runs a real browser at a real phone size, with the real compiled
 * Tailwind CSS, and measures pixels.
 *
 * The class strings are READ OUT OF dialog.tsx rather than copied here. A
 * fixture with its own copy of the classes tests the fixture, not the product,
 * and goes stale the first time someone edits the component. If the shape of
 * that file changes enough that the strings cannot be found, this fails loudly
 * instead of quietly measuring something that is no longer shipped.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, ".verify", ".layout");
fs.mkdirSync(out, { recursive: true });

/* ------------------------------------------------ the real classes, extracted */
const dialogSrc = fs.readFileSync(path.join(root, "src/components/ui/dialog.tsx"), "utf8");

/** Everything between `cn(` and `className,` in the DialogContent call. */
function contentClasses() {
  const start = dialogSrc.indexOf("DialogPrimitive.Content");
  const cnAt = dialogSrc.indexOf("cn(", start);
  const end = dialogSrc.indexOf("className,", cnAt);
  if (start < 0 || cnAt < 0 || end < 0) {
    throw new Error("could not find the DialogContent cn() call in dialog.tsx");
  }
  const body = dialogSrc.slice(cnAt, end);
  // Only the quoted class strings; comments in between are ignored because a
  // comment cannot contain a double-quoted string in this file.
  const quoted = [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  if (quoted.length === 0) throw new Error("no class strings found in DialogContent");
  return quoted.join(" ");
}

/** The scrolling body: the div that wraps {children}. */
function bodyClasses() {
  const m = dialogSrc.match(/<div className="([^"]*)">\s*\{children\}\s*<\/div>/);
  if (!m) throw new Error("could not find the {children} wrapper div in dialog.tsx");
  return m[1];
}

const PANEL = `${contentClasses()} max-w-2xl`; // max-w-2xl is what VoiceLauncher passes
const BODY = bodyClasses();

/* --------------------------------------------------------------- the fixture */
/** A confirmation card about as tall as a real order with warnings. */
const rows = [
  ["PRODUCT", "Mango Juice Bottle 250ml"],
  ["SHOP", "Saleem General Store"],
  ["AREA", "Khuda Ki Basti"],
  ["QUANTITY", "20 packs"],
  ["UNIT PRICE", "Rs 1,450"],
  ["TOTAL", "Rs 29,000"],
  ["BOOKER", "Muhammad Irfan"],
  ["DATE", "17 September 2026"],
]
  .map(
    ([k, v]) =>
      `<div class="flex flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-3">
         <dt class="shrink-0 text-xs uppercase tracking-wide text-muted-foreground">${k}</dt>
         <dd class="min-w-0 break-words font-medium">${v}</dd>
       </div>`,
  )
  .join("");

const warnings = [
  "Assumed Mango Juice Bottle 250ml from &quot;aam bottle&quot;.",
  "Three shops could match &quot;general store&quot;: Saleem General Store, Ghousia General Store, Grand General Store.",
  "The quantity was heard as twenty; the other reading said two.",
]
  .map((w) => `<li>${w}</li>`)
  .join("");

const html = `<!doctype html>
<html><head><meta name="viewport" content="width=device-width, initial-scale=1"/>
<link rel="stylesheet" href="./out.css"/></head>
<body>
  <div class="fixed inset-0 z-50 bg-black/50"></div>
  <div id="panel" class="${PANEL}">
    <div id="body" class="${BODY}">
      <div class="flex flex-col space-y-1.5">
        <h2 class="text-base font-semibold leading-none tracking-tight">Voice</h2>
        <p class="text-sm text-muted-foreground">Say an order, a payment, a question, or where to go. Nothing is saved until you confirm it.</p>
      </div>
      <div class="overflow-hidden rounded-lg border bg-card text-card-foreground shadow-sm">
        <div class="flex flex-wrap items-center gap-2.5 px-4 pt-4">
          <button class="h-11 min-w-0 flex-1 rounded-md bg-primary px-4 text-primary-foreground sm:min-w-[150px] sm:flex-none">Speak</button>
          <button class="h-9 rounded-md border px-3">Whisper</button>
          <button class="h-9 rounded-md border px-3">Browser</button>
          <button class="h-9 rounded-md border px-3">Clean</button>
          <button class="h-9 rounded-md border px-3">Raw</button>
          <button class="h-9 rounded-md border px-3">Roman</button>
          <button class="h-9 rounded-md border px-3">اردو</button>
        </div>
        <div class="flex items-center gap-2 px-4 pt-2">
          <input type="checkbox" checked/><span class="text-sm">Hands-free</span>
        </div>
        <div class="px-4 py-3">
          <p class="min-w-0 flex-1 break-words text-sm leading-relaxed">
            Heard (Whisper): "بیس پیک آم بوتل ڈھائی سو ایم ایل سلیم جنرل سٹور کو بیچ دو"
          </p>
        </div>
        <div class="mx-4 rounded-md border bg-muted/40 p-3 text-sm">
          Say <b>haan</b> to save, or <b>nahi</b> to cancel. Anything else cancels.
        </div>
        <div class="flex flex-wrap items-center gap-2 px-4 py-3">
          <span class="text-sm text-muted-foreground">Or type it</span>
          <input class="h-10 min-w-0 flex-1 rounded-md border px-3" value="bees packs aam bottle 250 Corne"/>
          <button class="h-10 rounded-md border px-4">Run</button>
        </div>
        <div class="space-y-3 border-t bg-muted/40 px-4 py-3">
          <div class="text-xs font-semibold uppercase">Order</div>
          <dl class="space-y-2">${rows}</dl>
          <ul class="mt-2 space-y-0.5 break-words border-t pt-2 text-xs text-muted-foreground">${warnings}</ul>
          <button id="save" class="h-11 w-full rounded-md bg-primary text-primary-foreground">Save this order</button>
        </div>
      </div>
    </div>
    <button class="absolute right-4 top-4 rounded-sm">x</button>
  </div>
</body></html>`;

fs.writeFileSync(path.join(out, "fixture.html"), html);

/* ----------------------------------------------------------- compile real CSS */
// The CLI's JS entry point, run with this same node - spawning "npx" needs a
// shell on Windows, and a shell is one more thing to get wrong on one platform.
execFileSync(
  process.execPath,
  [
    path.join(root, "node_modules/tailwindcss/lib/cli.js"),
    "-i",
    path.join(root, "src/app/globals.css"),
    "-o",
    path.join(out, "out.css"),
    "--content",
    path.join(out, "fixture.html"),
  ],
  { cwd: root, stdio: ["ignore", "ignore", "pipe"] },
);

/* ------------------------------------------------------------------ measure */
let pass = 0;
let fail = 0;
const ok = (name, condition, detail) => {
  if (condition) {
    pass += 1;
    console.log(`  ok   ${name}`);
  } else {
    fail += 1;
    console.log(`  FAIL ${name}${detail ? ` - ${detail}` : ""}`);
  }
};

const browser = await chromium.launch();

/** A small phone, a tall phone, and a desktop - the bug only showed on small. */
const VIEWPORTS = [
  // What a phone browser actually leaves you once its address bar and toolbar
  // are on screen - not the phone's advertised height. This is the size the
  // reported bug was photographed at, and the only one where it shows.
  { name: "phone 390x560 (browser chrome showing)", width: 390, height: 560 },
  { name: "phone 360x640", width: 360, height: 640 },
  { name: "phone 390x780", width: 390, height: 780 },
  { name: "desktop 1280x800", width: 1280, height: 800 },
];

for (const vp of VIEWPORTS) {
  console.log(`\n${vp.name}`);
  const page = await browser.newPage({ viewport: { width: vp.width, height: vp.height } });
  await page.goto(`file://${path.join(out, "fixture.html").replace(/\\/g, "/")}`);

  const m = await page.evaluate(() => {
    const panel = document.getElementById("panel");
    const body = document.getElementById("body");
    const save = document.getElementById("save");
    const p = panel.getBoundingClientRect();
    return {
      panelTop: p.top,
      panelBottom: p.bottom,
      panelLeft: p.left,
      panelRight: p.right,
      viewH: window.innerHeight,
      viewW: window.innerWidth,
      bodyScrollH: body.scrollHeight,
      bodyClientH: body.clientHeight,
      panelScrollH: panel.scrollHeight,
      panelClientH: panel.clientHeight,
      docScrollW: document.documentElement.scrollWidth,
      saveBottomBefore: save.getBoundingClientRect().bottom,
      maxHeight: getComputedStyle(panel).maxHeight,
    };
  });

  ok(
    "the panel fits inside the screen",
    m.panelTop >= -1 && m.panelBottom <= m.viewH + 1,
    `top ${m.panelTop.toFixed(0)}, bottom ${m.panelBottom.toFixed(0)}, screen ${m.viewH}`,
  );
  ok(
    "the height cap is understood by the browser",
    m.maxHeight !== "none",
    `computed max-height: ${m.maxHeight}`,
  );
  ok("the page never scrolls sideways", m.docScrollW <= m.viewW + 1, `${m.docScrollW} > ${m.viewW}`);

  /**
   * Nothing may hide its own content with no way to reach it.
   *
   * This is the check that catches the real bug, and it has to exist separately
   * because the bug DISGUISES itself: the grid squeezed the card, the card
   * clipped what did not fit, and so the body measured as "everything fits" -
   * which passed a scroll test by never running it. Asking "does the body need
   * to scroll" therefore proves nothing. Asking "is any content unreachable"
   * proves it directly.
   *
   * An element is only allowed to be shorter than its content if it can be
   * scrolled. overflow:visible spills into view rather than hiding, so it is
   * not a failure either - only hidden and clip are.
   */
  const clipped = await page.evaluate(() => {
    const bad = [];
    for (const el of document.getElementById("body").querySelectorAll("*")) {
      const overflowY = getComputedStyle(el).overflowY;
      const scrollable = overflowY === "auto" || overflowY === "scroll";
      const spills = overflowY === "visible";
      if (!scrollable && !spills && el.scrollHeight > el.clientHeight + 4) {
        bad.push({
          tag: el.tagName.toLowerCase(),
          cls: (el.className || "").toString().slice(0, 60),
          shown: el.clientHeight,
          real: el.scrollHeight,
        });
      }
    }
    return bad;
  });
  ok(
    "nothing hides content with no way to reach it",
    clipped.length === 0,
    clipped.map((c) => `<${c.tag} class="${c.cls}"> shows ${c.shown}px of ${c.real}px`).join("; "),
  );

  // The Save button is why anyone opens this panel, so its reachability is
  // checked on every screen rather than only when something else overflows.
  const reach = await page.evaluate(() => {
    const body = document.getElementById("body");
    body.scrollTop = body.scrollHeight;
    const s = document.getElementById("save").getBoundingClientRect();
    const p = document.getElementById("panel").getBoundingClientRect();
    return { saveTop: s.top, saveBottom: s.bottom, panelTop: p.top, panelBottom: p.bottom };
  });
  ok(
    "the Save button can be reached by scrolling",
    reach.saveTop >= reach.panelTop - 1 && reach.saveBottom <= reach.panelBottom + 1,
    `save ${reach.saveTop.toFixed(0)}-${reach.saveBottom.toFixed(0)}, ` +
      `panel ${reach.panelTop.toFixed(0)}-${reach.panelBottom.toFixed(0)}`,
  );

  const bodyCanScroll = m.bodyScrollH > m.bodyClientH + 1;
  const contentOverflows = m.bodyScrollH > m.panelClientH;

  if (contentOverflows) {
    ok(
      "the body can scroll when the content is taller than the screen",
      bodyCanScroll,
      `scrollHeight ${m.bodyScrollH} vs clientHeight ${m.bodyClientH} - nothing to scroll`,
    );
    ok(
      "only the body scrolls, not the whole panel",
      m.panelScrollH <= m.panelClientH + 1,
      `panel scrollHeight ${m.panelScrollH} vs clientHeight ${m.panelClientH}`,
    );

  } else {
    ok("content fits, no scrolling needed", true);
  }

  await page.close();
}

await browser.close();

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exitCode = 1;
