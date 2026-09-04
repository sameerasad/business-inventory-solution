/**
 * The dictate box, rendered for real.
 *
 * Two bugs have now shipped in this one component, and neither was visible in
 * any other kind of test:
 *
 *   1. It was a <form> nested inside the booking <form>, so the browser
 *      discarded the inner one and "Fill" submitted the booking.
 *   2. The transcript did not reach the editable box, which is the whole
 *      correction loop - seeing what was heard and fixing one word.
 *
 * Both are behaviour you can only catch by mounting it and clicking. The server
 * actions are stubbed, so this tests the component's own wiring and nothing
 * else: what goes into the box, what comes out of it, and what it hands to the
 * form.
 */
import path from "node:path";

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

/* A DOM has to exist before React or Testing Library are imported. */
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost/",
  pretendToBeVisual: true,
});
const g = globalThis as unknown as Record<string, unknown>;
g.window = dom.window;
g.document = dom.window.document;
// navigator is a getter-only global in Node 22, so it has to be redefined
// rather than assigned.
Object.defineProperty(globalThis, "navigator", {
  value: dom.window.navigator,
  configurable: true,
  writable: true,
});
g.HTMLElement = dom.window.HTMLElement;
g.HTMLInputElement = dom.window.HTMLInputElement;
g.Element = dom.window.Element;
g.Node = dom.window.Node;
g.Event = dom.window.Event;
g.KeyboardEvent = dom.window.KeyboardEvent;
g.MouseEvent = dom.window.MouseEvent;
g.getComputedStyle = dom.window.getComputedStyle;
g.requestAnimationFrame = (cb: FrameRequestCallback) => setTimeout(() => cb(0), 0);
g.cancelAnimationFrame = (id: number) => clearTimeout(id);
g.IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The transcript the stubbed action returns, and the calls it received.
 *
 * Stubbing the server action is the point: this is about what the component
 * does with an answer, not about whether the model produces one.
 */
const TRANSCRIPT = "سلیم جنرل اسٹور کو بیس چھوٹی آم کی بوتل";
const seen: { said: string }[] = [];
const filled: unknown[] = [];

/**
 * Enough of a microphone to drive the recording path.
 *
 * The dictate box has two ways in - typing and speaking - and they take
 * different routes through the component. Only one of them can be tested
 * without a microphone, which is exactly why the untested one is where a bug
 * survived. These fakes are small on purpose: a recorder that produces one
 * blob, a stream that can be stopped, and an analyser that reports a voice, so
 * the silence detector believes someone spoke.
 */
type FakeRec = {
  start: () => void;
  stop: () => void;
  mimeType: string;
  ondataavailable: ((e: { data: { size: number } }) => void) | null;
  onstop: (() => void) | null;
  onerror: (() => void) | null;
};
let liveRecorder: FakeRec | null = null;

function installMicrophone() {
  class FakeMediaRecorder implements FakeRec {
    mimeType = "audio/webm";
    ondataavailable: ((e: { data: { size: number } }) => void) | null = null;
    onstop: (() => void) | null = null;
    onerror: (() => void) | null = null;
    static isTypeSupported() {
      return true;
    }
    constructor() {
      liveRecorder = this;
    }
    start() {}
    stop() {
      // A real recorder hands over the audio and then reports the stop.
      this.ondataavailable?.({ data: { size: 4096 } });
      this.onstop?.();
    }
  }
  g.MediaRecorder = FakeMediaRecorder;
  g.Blob = dom.window.Blob;

  Object.defineProperty(dom.window.navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: async () => ({ getTracks: () => [{ stop: () => {} }] }),
    },
  });

  class FakeAnalyser {
    fftSize = 1024;
    connect() {}
    // Loud enough to count as speech, so the clip is not discarded as silence.
    getFloatTimeDomainData(out: Float32Array) {
      out.fill(0.25);
    }
  }
  class FakeAudioContext {
    createAnalyser() {
      return new FakeAnalyser();
    }
    createMediaStreamSource() {
      return { connect: () => {} };
    }
    close() {
      return Promise.resolve();
    }
  }
  g.AudioContext = FakeAudioContext;
}

function bookingResult(transcript: string) {
  return {
    transcript,
    command: {
      kind: "booking" as const,
      lines: [
        {
          productId: 1,
          sku: "MNG-BTL-250",
          label: "Mango Juice Bottle 250ml",
          quantity: 20,
          unitPrice: 450,
        },
      ],
      areaId: 8,
      areaName: "Bashir chowk",
      shopId: 9,
      shopName: "Saleem General Store",
      bookerId: null,
      bookerName: null,
      customerPhone: null,
      date: "2026-09-04",
      missing: [] as string[],
      warnings: [] as string[],
      confidence: "high" as const,
    },
    answer: null,
    summary: "Book 20 x Mango Juice Bottle 250ml for Saleem General Store.",
  };
}

async function main() {
  /**
   * Replace the server actions before the component can import them.
   *
   * An ES module namespace object is frozen, so assigning over its exports
   * silently does nothing - the first attempt did exactly that, the real
   * action ran without a server to run in, and the test passed while
   * exercising none of the code it was written for. Seeding the CommonJS
   * module cache under the resolved path works because tsx loads TypeScript
   * through the CJS loader.
   */
  const actionsPath = path.resolve("src/actions/voice.ts");
  const stub = {
    interpretVoiceAction: async (said: string) => {
      seen.push({ said });
      return bookingResult(said);
    },
    transcribeAndInterpretAction: async () => ({
      ok: true as const,
      model: "stub",
      result: bookingResult(TRANSCRIPT),
    }),
    transcribeOnlyAction: async () => ({ ok: true as const, text: TRANSCRIPT, model: "stub" }),
  };
  require.cache[actionsPath] = {
    id: actionsPath,
    filename: actionsPath,
    loaded: true,
    exports: stub,
  } as unknown as NodeModule;

  installMicrophone();

  const React = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { act } = await import("react");
  const { BookingDictate } = await import("@/components/forms/booking-dictate");

  const container = dom.window.document.createElement("div");
  dom.window.document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(
      React.createElement(BookingDictate, {
        whisperAvailable: true,
        onFilled: (command: unknown) => filled.push(command),
      }),
    );
  });

  const input = () => container.querySelector("input") as HTMLInputElement | null;
  const fillButton = () =>
    Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === "Fill",
    ) as HTMLButtonElement | undefined;

  console.log("\n=== the box exists and starts empty ===");
  ok("there is a text input", input() !== null);
  ok("it starts empty", input()?.value === "");
  ok("Fill is disabled while it is empty", fillButton()?.disabled === true);

  console.log("\n=== typing a sentence and pressing Fill ===");
  const typedSentence = "Saleem general store ko bees chhoti aam ki bottle";
  await act(async () => {
    const el = input()!;
    // React tracks the value on the DOM node, so a plain assignment is ignored
    // unless the tracker is bypassed the way Testing Library does it.
    const setter = Object.getOwnPropertyDescriptor(
      dom.window.HTMLInputElement.prototype,
      "value",
    )!.set!;
    setter.call(el, typedSentence);
    el.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  ok("the box holds what was typed", input()?.value === typedSentence, input()?.value);
  ok("Fill is now enabled", fillButton()?.disabled === false);

  await act(async () => {
    fillButton()!.click();
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 30));
  });

  ok(
    "the sentence reached the action",
    seen.some((s) => s.said === typedSentence),
    seen,
  );
  ok("the form was filled", filled.length === 1, filled.length);

  console.log("\n=== THE BUG: what is in the box after filling ===");
  ok(
    "the box still shows the sentence, so a wrong word can be corrected",
    input()?.value === typedSentence,
    { inBox: input()?.value, expected: typedSentence },
  );

  console.log("\n=== speaking, which is the path a microphone takes ===");

  // Clear the box first, so anything in it afterwards came from the recording.
  await act(async () => {
    const el = input()!;
    const setter = Object.getOwnPropertyDescriptor(
      dom.window.HTMLInputElement.prototype,
      "value",
    )!.set!;
    setter.call(el, "");
    el.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  });
  ok("the box is empty before speaking", input()?.value === "");

  const micButton = () =>
    Array.from(container.querySelectorAll("button")).find((b) =>
      /Say the order|Stop/.test(b.textContent ?? ""),
    ) as HTMLButtonElement | undefined;

  ok("there is a microphone button", micButton() !== undefined);

  await act(async () => {
    micButton()!.click();
  });
  // The level check runs on a 100ms interval, so it has to be given at least
  // one tick to notice that someone is speaking. An earlier version waited
  // 40ms, the check never ran, and the clip was discarded as silence - which
  // looked like the bug under investigation and was not.
  await act(async () => {
    await new Promise((r) => setTimeout(r, 260));
  });
  ok("it is recording", /Stop/.test(micButton()?.textContent ?? ""), micButton()?.textContent);

  // Stop the way the recorder itself would when the talking stops.
  await act(async () => {
    liveRecorder!.stop();
  });
  await act(async () => {
    await new Promise((r) => setTimeout(r, 60));
  });

  console.log(
    "      what the component says now:",
    JSON.stringify(container.textContent?.replace(/s+/g, " ").trim().slice(0, 200)),
  );
  ok("the spoken order filled the form", filled.length === 2, filled.length);
  ok(
    "THE TRANSCRIPT IS IN THE BOX, so a misheard word can be fixed",
    input()?.value === TRANSCRIPT,
    { inBox: input()?.value, expected: TRANSCRIPT },
  );

  console.log(`\n${checks - failures}/${checks} dictate checks passed`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
