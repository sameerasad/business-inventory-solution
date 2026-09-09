/**
 * The interactive bits, rendered for real: the searchable select and the
 * floating voice launcher.
 *
 * This suite replaced the one that tested the dictate box, which was removed
 * from the booking page. Keeping the harness was the point: the select shipped
 * with a bug that only someone clicking it could see - the dashboard's year
 * list showed the current year twice, once as the clear-the-filter row wearing
 * the year as a label and once as itself - and the smoke suite could never have
 * caught it, because it fetches pages without running them and so only ever
 * sees a closed dropdown.
 *
 * So: mount it, open it, type in it, and check what comes back.
 */
import { JSDOM } from "jsdom";

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
function section(name: string) {
  console.log(`\n=== ${name} ===`);
}

/* A DOM has to exist before React is imported. */
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/",
  pretendToBeVisual: true,
});
const g = globalThis as unknown as Record<string, unknown>;
g.window = dom.window;
g.document = dom.window.document;
Object.defineProperty(globalThis, "navigator", {
  value: dom.window.navigator,
  configurable: true,
});
g.HTMLElement = dom.window.HTMLElement;
g.Element = dom.window.Element;
g.Node = dom.window.Node;
g.getComputedStyle = dom.window.getComputedStyle;
g.IS_REACT_ACT_ENVIRONMENT = true;

/**
 * Every browser global jsdom provides, in one pass.
 *
 * Radix builds the dialog out of a focus scope and a dismissable layer, and
 * between them they reach for MutationObserver, CustomEvent, NodeFilter and
 * more. Adding them one at a time is a treadmill - each missing one throws
 * from inside an effect, which surfaces as an unhandled error rather than a
 * failed check, so you learn about exactly one per run. Copying what is
 * missing settles the whole class of it.
 *
 * Guarded on "already present" so Node keeps its own setTimeout, fetch and
 * crypto rather than being handed jsdom versions of them.
 */
for (const key of Object.getOwnPropertyNames(dom.window)) {
  if (key in globalThis) continue;
  try {
    g[key] = (dom.window as unknown as Record<string, unknown>)[key];
  } catch {
    // A few are getter-only on the window; none of those are needed here.
  }
}
/**
 * These three are the exception to the guard above, and have to be forced.
 *
 * Node 22 ships its own Event, CustomEvent and EventTarget, so they are
 * "already present" and the loop skips them - and then jsdom rejects them:
 * document.dispatchEvent checks the object is one of ITS Events and throws
 * "parameter 1 is not of type Event" from inside a Radix effect.
 */
g.Event = dom.window.Event;
g.CustomEvent = dom.window.CustomEvent;
g.EventTarget = dom.window.EventTarget;

g.ResizeObserver =
  dom.window.ResizeObserver ??
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };

// jsdom has no layout, so scrollIntoView is missing and the component calls it
// while arrowing through a list.
dom.window.Element.prototype.scrollIntoView = function scrollIntoView() {};

/**
 * Just enough microphone to mount.
 *
 * Nothing here records anything - the launcher test never presses the button.
 * The hooks inside VoiceBar ask at mount whether recording is possible at all,
 * and answering "no" would render a different component than the one people
 * see.
 */
class StubRecorder {
  static isTypeSupported() {
    return true;
  }
  start() {}
  stop() {}
}
g.MediaRecorder = StubRecorder;
g.Blob = dom.window.Blob;
Object.defineProperty(dom.window.navigator, "mediaDevices", {
  configurable: true,
  value: { getUserMedia: async () => ({ getTracks: () => [] }) },
});

const AREAS = [
  { value: "1", label: "laal market" },
  { value: "2", label: "KHUDA KI BASTI" },
  { value: "3", label: "Khwaja ajmer nagri" },
  { value: "4", label: "Yaro goth" },
  { value: "5", label: "Allah buksh Goth" },
  { value: "6", label: "Punjab Adda" },
  { value: "7", label: "Khamisa Goth" },
  { value: "8", label: "Bashir chowk" },
  { value: "9", label: "Sikander goth" },
];
const YEARS = [
  { value: "2026", label: "2026" },
  { value: "2025", label: "2025" },
];

async function main() {
  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { act } = await import("react");
  const { SearchableSelect } = await import("@/components/ui/searchable-select");

  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);

  const picked: string[] = [];
  let seq = 0;

  /** Render with whatever props, and hand back accessors into the result. */
  async function mount(props: Record<string, unknown>) {
    picked.length = 0;
    await act(async () => {
      root.render(
        React.createElement(SearchableSelect, {
          key: String((seq += 1)),
          value: "all",
          options: AREAS,
          onChange: (v: string) => picked.push(v),
          ...props,
        } as never),
      );
    });
  }

  const trigger = () => container.querySelector("button") as HTMLButtonElement;
  const optionButtons = () =>
    Array.from(container.querySelectorAll('[role="option"]')) as HTMLButtonElement[];
  const optionLabels = () => optionButtons().map((b) => b.textContent?.trim() ?? "");
  const searchBox = () => container.querySelector('input[type="text"]') as HTMLInputElement | null;
  const click = async (el: Element) => {
    await act(async () => {
      el.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
    });
  };
  /**
   * Typing, the way React can see it.
   *
   * Assigning .value directly and firing "input" is not enough: React caches
   * the node value and treats an assignment it did not make as no change, so
   * the keystroke is swallowed. Going through the prototype setter is what
   * makes the tracker notice - the same dance the dictate suite needed.
   */
  const type = async (el: HTMLInputElement, text: string) => {
    const setter = Object.getOwnPropertyDescriptor(
      dom.window.HTMLInputElement.prototype,
      "value",
    )?.set;
    await act(async () => {
      setter?.call(el, text);
      el.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    });
  };

  /* ------------------------------------------------------------- closed */
  section("closed, it shows the current choice");
  await mount({ value: "all", allLabel: "All areas" });
  ok("the trigger shows the all-label", trigger().textContent?.includes("All areas") === true);
  ok("no options are in the document", optionButtons().length === 0);

  await mount({ value: "3", allLabel: "All areas" });
  ok(
    "and the chosen option's label once one is chosen",
    trigger().textContent?.includes("Khwaja ajmer nagri") === true,
    trigger().textContent,
  );

  /* --------------------------------------------------------------- open */
  section("opening it");
  await mount({ value: "all", allLabel: "All areas" });
  await click(trigger());
  ok("every option is listed", optionButtons().length === AREAS.length + 1, optionLabels().length);
  ok("the all-label comes first", optionLabels()[0] === "All areas", optionLabels()[0]);
  ok("a search box appears for a long list", searchBox() !== null);

  /* ------------------------------------------------------------ filtering */
  section("typing filters the list");
  await type(searchBox()!, "goth");
  const filtered = optionLabels();
  // Four areas contain "goth" - Yaro, Allah buksh, Khamisa, Sikander - and the
  // all-row makes five.
  ok("only the matching options remain, plus the all-row", filtered.length === 5, filtered);
  ok(
    "and matching is case-insensitive on the label",
    filtered.includes("Yaro goth") && filtered.includes("Sikander goth"),
    filtered,
  );
  ok(
    "the all-row survives filtering, so the filter can always be cleared",
    filtered[0] === "All areas",
    filtered,
  );

  await type(searchBox()!, "zzzz");
  ok("a search matching nothing says so", container.textContent?.includes("No match.") === true);

  /* ------------------------------------------------------------- picking */
  section("picking an option");
  await type(searchBox()!, "khamisa");
  const match = optionButtons().find((b) => b.textContent?.includes("Khamisa"));
  ok("the match is there to click", match !== undefined);
  await click(match!);
  ok("its value is handed back", picked[0] === "7", picked);
  ok("and the panel closes", optionButtons().length === 0);

  await mount({ value: "3", allLabel: "All areas" });
  await click(trigger());
  const allRow = optionButtons()[0]!;
  await click(allRow);
  ok('picking the all-row reports "all", which clears the filter', picked[0] === "all", picked);

  /* ------------------------------------------------------ short lists */
  section("a short list has no search box");
  await mount({
    value: "all",
    allLabel: "Any status",
    options: [
      { value: "unpaid", label: "Unpaid" },
      { value: "paid", label: "Paid" },
    ],
  });
  await click(trigger());
  ok("no search field above three choices", searchBox() === null);
  ok("but the options are all there", optionLabels().length === 3, optionLabels());

  /* --------------------------------------------- the bug that got through */
  section("includeAll: the duplicate that shipped");
  await mount({ value: "2026", options: YEARS, includeAll: false });
  await click(trigger());
  const yearLabels = optionLabels();
  ok(
    "with includeAll false the list is exactly the options",
    yearLabels.length === YEARS.length,
    yearLabels,
  );
  ok(
    "2026 appears once, not twice",
    yearLabels.filter((l) => l === "2026").length === 1,
    yearLabels,
  );
  ok("and there is no all-row to pick", !yearLabels.includes("All"), yearLabels);

  // The shape the bug took: an all-row wearing a real value as its label.
  await mount({ value: "2026", options: YEARS, allLabel: "2026" });
  await click(trigger());
  ok(
    "whereas faking it with allLabel is what listed it twice",
    optionLabels().filter((l) => l === "2026").length === 2,
    optionLabels(),
  );

  section("keyboard");
  await mount({ value: "all", allLabel: "All areas" });
  await act(async () => {
    trigger().dispatchEvent(
      new dom.window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }),
    );
  });
  ok("arrow down opens it", optionButtons().length > 0);
  await act(async () => {
    searchBox()!.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
  });
  ok("escape closes it", optionButtons().length === 0);

  /* ------------------------------------------------- the voice launcher */
  section("the floating voice button");

  const { VoiceLauncher } = await import("@/components/voice/voice-launcher");

  const launcherHost = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(launcherHost);
  const launcherRoot = createRoot(launcherHost);

  // VoiceBar calls useRouter, which throws outside a Next tree, so the test
  // has to supply the context. Only push is exercised here - and not even
  // that, since the panel is opened but never spoken to.
  const { AppRouterContext } =
    await import("next/dist/shared/lib/app-router-context.shared-runtime");
  const stubRouter = {
    push: () => {},
    replace: () => {},
    refresh: () => {},
    back: () => {},
    forward: () => {},
    prefetch: async () => {},
  };

  await act(async () => {
    launcherRoot.render(
      React.createElement(
        AppRouterContext.Provider,
        { value: stubRouter as never },
        React.createElement(VoiceLauncher, { whisperAvailable: true }),
      ),
    );
  });

  const fab = () =>
    dom.window.document.querySelector(
      '[aria-label="Open voice commands"]',
    ) as HTMLButtonElement | null;
  // Radix puts the panel in a portal on document.body, not inside the host.
  const panel = () => dom.window.document.querySelector('[role="dialog"]');

  ok("the button is there", fab() !== null);
  ok("and nothing is open yet", panel() === null);

  // The reason the panel is mounted conditionally: the microphone hooks should
  // not be alive behind every page in the app, only while the panel is up.
  ok(
    "voice is not mounted while it is closed",
    !dom.window.document.body.textContent?.includes("Say the order"),
    dom.window.document.body.textContent?.slice(0, 120),
  );

  await click(fab()!);
  ok("clicking it opens a dialog", panel() !== null);
  ok(
    "with the voice module inside",
    (panel()?.textContent ?? "").length > 0 && panel()?.textContent?.includes("Voice") === true,
    panel()?.textContent?.slice(0, 160),
  );

  await act(async () => {
    dom.window.document.dispatchEvent(
      new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
  });
  ok("escape closes it again", panel() === null);

  console.log(`\n${checks - failures}/${checks} ui checks passed`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
