"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { AlertTriangle, Check, Loader2, Mic, MicOff, Square, X } from "lucide-react";

import {
  interpretVoiceAction,
  transcribeAndInterpretAction,
  markVoiceAttemptSavedAction,
  type VoiceResult,
} from "@/actions/voice";
import { createBookingAction } from "@/actions/bookings";
import { recordPaymentAction } from "@/actions/payments";
import { createBatchAction } from "@/actions/batches";
import { createSaleAction } from "@/actions/sales";
import {
  createAreaAction,
  createShopAction,
  renameAreaAction,
  renameShopAction,
} from "@/actions/areas";
import { createCategoryAction, renameCategoryAction } from "@/actions/categories";
import {
  createProductAction,
  toggleProductActiveAction,
  updateProductPriceAction,
} from "@/actions/products";
import {
  createBookerAction,
  setBookerAreasAction,
  toggleBookerActiveAction,
} from "@/actions/bookers";

/**
 * Two commands cover more than one table, so the action depends on the target.
 *
 * A thin dispatcher rather than a kind per table: "rename" and "toggle" are one
 * idea each to the person saying them, and splitting them into six kinds would
 * put six more names in the model's schema for no gain.
 */
function renameActionFor(prev: ActionState, formData: FormData): Promise<ActionState> {
  const target = formData.get("target");
  if (target === "shop") return renameShopAction(prev, formData);
  if (target === "category") return renameCategoryAction(prev, formData);
  return renameAreaAction(prev, formData);
}

function toggleActionFor(prev: ActionState, formData: FormData): Promise<ActionState> {
  return formData.get("target") === "booker"
    ? toggleBookerActiveAction(prev, formData)
    : toggleProductActiveAction(prev, formData);
}
import { parseConfirmation } from "@/lib/voice/parse";
import { Input } from "@/components/ui/input";
import { emptyActionState, type ActionState } from "@/lib/validations";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { speak, useSpeech, type SpeechLang } from "@/components/voice/use-speech";
import { useRecorder, type CaptureMode } from "@/components/voice/use-recorder";
import { cn } from "@/lib/utils";

const LANG_KEY = "voice-lang";
const HANDS_FREE_KEY = "voice-hands-free";
const ENGINE_KEY = "voice-engine";
const CAPTURE_KEY = "voice-capture";

/**
 * Which engine turns speech into text.
 *
 * "browser" is instant and free but weak on Urdu. "whisper" records a clip,
 * sends it to our own server, and gets it transcribed by Whisper - noticeably
 * better on Urdu and on Urdu-English mixing, at the cost of a second or two.
 */
type Engine = "browser" | "whisper";

const EXAMPLES: Record<SpeechLang, string[]> = {
  "en-PK": [
    "open receivables",
    "how much profit today",
    "sell twenty packs mango bottle 250 to Corner Store",
    "payment received 5000 from Corner Store",
  ],
  "ur-PK": [
    "bookings kholo",
    "aaj ka munafa kitna hai",
    "bees packs aam bottle 250 Corner Store ko bech do",
    "invoice 12 ka paanch hazar aa gaya",
  ],
};

/**
 * Voice control.
 *
 * The rule that shapes all of this: speaking can NAVIGATE and can ASK, both of
 * which change nothing, and those happen immediately. Anything that writes -
 * an order, a payment - is only ever filled in for you, and you press the
 * button. Speech recognition confuses fifteen and fifty, and this app moves
 * stock and money.
 */
export function VoiceBar({
  whisperAvailable = false,
  embedded = false,
  onNavigate,
}: {
  whisperAvailable?: boolean;
  /** Inside a dialog, the page-level margin below the bar is wrong. */
  embedded?: boolean;
  /**
   * Called once a command has moved the page.
   *
   * The floating panel closes on this. Left open over the page it just opened,
   * it hides the very thing the command was for and leaves you wondering
   * whether anything happened at all.
   */
  onNavigate?: () => void;
}) {
  const router = useRouter();
  const [lang, setLang] = useState<SpeechLang>("en-PK");
  const [result, setResult] = useState<VoiceResult | null>(null);
  const [thinking, setThinking] = useState(false);
  const [typed, setTyped] = useState("");
  const [engine, setEngine] = useState<Engine>("browser");
  /**
   * How the microphone is opened. "clean" is the browser's own processing,
   * which is tuned for phone calls; "raw" turns off the noise suppression that
   * removes the detail telling one consonant from another.
   *
   * Which wins depends on the microphone and the room, so it is a switch
   * rather than a decision made here - and it stays on "clean" until somebody
   * has heard the difference on the machine that matters.
   */
  const [capture, setCapture] = useState<CaptureMode>("clean");
  const [handsFree, setHandsFree] = useState(false);
  const [awaitingYes, setAwaitingYes] = useState(false);
  const [whisperError, setWhisperError] = useState<string | null>(null);

  // The microphone has one channel, so the handler needs to know whether the
  // next thing it hears is a command or the answer to "save karoon?". A ref
  // rather than state because the recogniser's callback must see the current
  // value, not the one captured when it started listening.
  const modeRef = useRef<"command" | "confirm">("command");
  const pendingRef = useRef<WriteCommand | null>(null);
  const startRef = useRef<() => void>(() => {});
  const [saveState, setSaveState] = useState<ActionState | null>(null);
  const [saving, setSaving] = useState(false);

  // Remembered per browser: whoever uses this device mostly speaks one language.
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(LANG_KEY);
      if (saved === "en-PK" || saved === "ur-PK") setLang(saved);
      setHandsFree(window.localStorage.getItem(HANDS_FREE_KEY) === "on");
      // Whisper is the better engine for Urdu, so it is the default when the
      // server has it - but a stored choice always wins.
      const storedCapture = window.localStorage.getItem(CAPTURE_KEY);
      if (storedCapture === "raw" || storedCapture === "clean") setCapture(storedCapture);
      const storedEngine = window.localStorage.getItem(ENGINE_KEY);
      if (storedEngine === "whisper" || storedEngine === "browser") {
        setEngine(whisperAvailable ? storedEngine : "browser");
      } else if (whisperAvailable) {
        setEngine("whisper");
      }
    } catch {
      // Private mode or blocked storage; the default is fine.
    }
  }, []);

  const chooseEngine = (next: Engine) => {
    setEngine(next);
    try {
      window.localStorage.setItem(ENGINE_KEY, next);
    } catch {
      // Only affects the next visit.
    }
  };

  const chooseCapture = (next: CaptureMode) => {
    setCapture(next);
    try {
      window.localStorage.setItem(CAPTURE_KEY, next);
    } catch {
      // Only affects the next visit.
    }
  };

  const chooseLang = (next: SpeechLang) => {
    setLang(next);
    try {
      window.localStorage.setItem(LANG_KEY, next);
    } catch {
      // Not worth surfacing - it only affects the next visit.
    }
  };

  /**
   * What to do with an understood command, whichever engine produced it.
   *
   * Kept in one place so the two engines cannot drift apart on the part that
   * matters - which commands act immediately and which wait for a human.
   */
  const applyResultRef = useRef<(r: VoiceResult) => Promise<void>>(async () => {});
  const applyResult = useCallback(
    (interpreted: VoiceResult) => applyResultRef.current(interpreted),
    [],
  );

  // runSave is memoised and cannot see the latest result through its closure.
  const resultRef = useRef<VoiceResult | null>(null);
  resultRef.current = result;

  const runSave = useCallback(
    async (command: WriteCommand) => {
      setSaving(true);
      try {
        const outcome = await ACTIONS[command.kind](emptyActionState, buildPayload(command));
        setSaveState(outcome);
        if (outcome.ok) {
          // Marked here rather than when the button was pressed: a proposal
          // the server rejected is not evidence that it was understood right,
          // and this figure is only worth keeping if it means that.
          const attemptId = resultRef.current?.attemptId;
          if (attemptId != null) void markVoiceAttemptSavedAction(attemptId);
          router.refresh();
        }
        return outcome;
      } finally {
        setSaving(false);
        setAwaitingYes(false);
        pendingRef.current = null;
      }
    },
    [router],
  );

  const handleFinal = useCallback(
    async (said: string) => {
      // Hands-free: this utterance is the answer to "save karoon?", not a new
      // command. Only an unmistakable yes saves; a no, a mumble, or somebody
      // still talking all cancel, because the alternative is writing a record
      // nobody agreed to.
      if (modeRef.current === "confirm") {
        modeRef.current = "command";
        const pending = pendingRef.current;
        if (parseConfirmation(said) === "confirm" && pending) {
          const outcome = await runSave(pending);
          speak(outcome.ok ? "Saved." : "That did not save.", lang);
        } else {
          setAwaitingYes(false);
          pendingRef.current = null;
          setSaveState({ ok: false, message: "Not saved - nothing was changed.", fieldErrors: {} });
          speak("Cancelled.", lang);
        }
        return;
      }

      setThinking(true);
      setSaveState(null);
      try {
        await applyResult(await interpretVoiceAction(said));
      } finally {
        setThinking(false);
      }
    },
    // applyResult changes with the same dependencies and is defined below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [handsFree, lang, router, runSave],
  );

  const { supported, state, transcript, error, start, stop } = useSpeech({
    lang,
    onFinal: handleFinal,
  });

  // The Whisper path: record, upload, and feed the understood command into the
  // same handler the browser engine uses - so hands-free, the confirmation
  // cards and every safety rule behave identically whichever engine is on.
  const handleClip = useCallback(
    async (audio: Blob) => {
      setThinking(true);
      setSaveState(null);
      try {
        const form = new FormData();
        form.append("audio", audio, "command.webm");
        form.append("language", lang === "ur-PK" ? "ur" : "en");
        const outcome = await transcribeAndInterpretAction(form);
        if (!outcome.ok) {
          setWhisperError(outcome.reason);
          return;
        }
        setWhisperError(null);
        await applyResult(outcome.result);
      } finally {
        setThinking(false);
      }
    },
    // applyResult is stable for the same reasons handleFinal is.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [lang],
  );

  const recorder = useRecorder({ onClip: handleClip, capture });

  startRef.current = engine === "whisper" ? recorder.start : start;

  applyResultRef.current = async (interpreted: VoiceResult) => {
    setResult(interpreted);
    const command = interpreted.command;

    // Safe to act on at once: neither changes anything.
    //
    // "open" is here rather than among the writes on purpose. Editing and
    // deleting act on a row by id, and a misheard id is a real other row - the
    // write would succeed on the wrong record and report nothing wrong. So
    // voice carries you to the record and the change itself stays a hand.
    if (command.kind === "navigate" || command.kind === "open") {
      router.push(command.href);
      onNavigate?.();
      return;
    }
    if (interpreted.answer) {
      speak(interpreted.answer.speech, lang);
      return;
    }

    // A complete write, hands-free: read it back and listen for a yes. The
    // microphone only opens once the app has finished speaking, or it would
    // hear its own voice and confirm itself.
    const writable =
      command.kind === "booking" ||
      command.kind === "payment" ||
      command.kind === "batch" ||
      command.kind === "sale" ||
      command.kind === "shop" ||
      command.kind === "area" ||
      command.kind === "category" ||
      command.kind === "booker" ||
      command.kind === "product" ||
      command.kind === "price" ||
      command.kind === "rename" ||
      command.kind === "toggle" ||
      command.kind === "assign";
    if (handsFree && writable && command.missing.length === 0) {
      pendingRef.current = command;
      modeRef.current = "confirm";
      setAwaitingYes(true);
      speak(`${interpreted.summary} Save?`, lang, () => startRef.current());
    }
  };

  const usingWhisper = engine === "whisper" && whisperAvailable;
  const listening = usingWhisper ? recorder.state === "recording" : state === "listening";
  const micUsable = usingWhisper ? recorder.supported : supported;
  const activeError = usingWhisper ? (whisperError ?? recorder.error) : error;
  const command = result?.command;

  return (
    <Card className={cn("overflow-hidden", embedded ? null : "mb-4")}>
      <div className="flex flex-wrap items-center gap-2.5 px-4 pt-4">
        {micUsable ? (
          <Button
            type="button"
            onClick={
              listening
                ? usingWhisper
                  ? recorder.stop
                  : stop
                : usingWhisper
                  ? () => void recorder.start()
                  : start
            }
            disabled={thinking}
            variant={listening ? "destructive" : "default"}
            className="h-11 min-w-[150px]"
          >
            {listening ? (
              <>
                <Square className="h-4 w-4" />
                {usingWhisper ? `Stop (${recorder.seconds}s)` : "Stop"}
              </>
            ) : thinking ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                {usingWhisper ? "Transcribing" : "Working"}
              </>
            ) : (
              <>
                <Mic className="h-4 w-4" />
                Speak
              </>
            )}
          </Button>
        ) : null}

        {whisperAvailable ? (
          <div role="group" aria-label="Engine" className="inline-flex rounded-md border p-0.5">
            {(
              [
                ["whisper", "Whisper"],
                ["browser", "Browser"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => chooseEngine(value)}
                aria-pressed={engine === value}
                disabled={listening || thinking}
                title={
                  value === "whisper"
                    ? "Records a clip and transcribes it on the server. Much better at Urdu, takes a second or two."
                    : "The browser's own recognition. Instant, but weak on Urdu."
                }
                className={cn(
                  "rounded-[5px] px-3 py-1.5 text-sm font-medium transition-colors",
                  engine === value
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {label}
              </button>
            ))}
          </div>
        ) : null}

        {usingWhisper ? (
          <div role="group" aria-label="Microphone" className="inline-flex rounded-md border p-0.5">
            {(
              [
                ["clean", "Clean"],
                ["raw", "Raw"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => chooseCapture(value)}
                aria-pressed={capture === value}
                disabled={listening || thinking}
                title={
                  value === "clean"
                    ? "The browser's own noise suppression. Tuned for phone calls."
                    : "No noise suppression, mono, higher bitrate. Often clearer for transcription - try both and keep the one that hears you better."
                }
                className={cn(
                  "rounded-[5px] px-3 py-1.5 text-sm font-medium transition-colors",
                  capture === value
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {label}
              </button>
            ))}
          </div>
        ) : null}

        {/* One engine per language: neither engine can detect which is being
            spoken, so both have to be told. */}
        {micUsable ? (
          <div role="group" aria-label="Language" className="inline-flex rounded-md border p-0.5">
            {(
              [
                ["en-PK", "English"],
                ["ur-PK", "اردو"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => chooseLang(value)}
                aria-pressed={lang === value}
                disabled={listening}
                className={cn(
                  "rounded-[5px] px-3 py-1.5 text-sm font-medium transition-colors",
                  lang === value
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {label}
              </button>
            ))}
          </div>
        ) : null}

        {supported ? (
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={handsFree}
              onChange={(e) => {
                setHandsFree(e.target.checked);
                try {
                  window.localStorage.setItem(HANDS_FREE_KEY, e.target.checked ? "on" : "off");
                } catch {
                  // Only affects the next visit.
                }
              }}
              className="h-4 w-4"
            />
            <span className="text-muted-foreground">Hands-free</span>
          </label>
        ) : null}
      </div>

      {/* What was heard, on its own line with the whole width to itself. */}
      <div className="flex items-start gap-2 px-4 pb-4 pt-3">
        <p aria-live="polite" className="min-w-0 flex-1 text-sm leading-relaxed">
          {listening ? (
            <span className="text-muted-foreground">{transcript || "Listening..."}</span>
          ) : result ? (
            <span>
              <span className="text-muted-foreground">
                Heard{usingWhisper ? " (Whisper)" : ""}:{" "}
              </span>
              &ldquo;{result.transcript}&rdquo;
            </span>
          ) : (
            <span className="text-muted-foreground">Try: &ldquo;{EXAMPLES[lang][0]}&rdquo;</span>
          )}
        </p>

        {result ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Clear"
            onClick={() => {
              setResult(null);
              setSaveState(null);
            }}
          >
            <X className="h-4 w-4" />
          </Button>
        ) : null}
      </div>

      {awaitingYes ? (
        <div className="border-t px-4 py-3">
          <Alert tone="info">
            Say <strong>haan</strong> to save, or <strong>nahi</strong> to cancel. Anything else
            cancels.
          </Alert>
        </div>
      ) : null}

      {activeError ? (
        <div className="border-t px-4 py-3">
          <Alert tone="error">{activeError}</Alert>
        </div>
      ) : null}

      {/* Typing goes through exactly the same interpreter as speaking.
          It is here for three reasons: to check a phrasing without fighting a
          microphone, to fix one the microphone misheard, and so the whole
          feature still works in a browser with no speech support at all. */}
      <div className="border-t bg-muted/30 px-4 py-3">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const said = typed.trim();
            if (said.length > 0) void handleFinal(said);
          }}
          className="flex flex-wrap items-center gap-2"
        >
          <label htmlFor="voice-typed" className="text-xs font-medium text-muted-foreground">
            Or type it
          </label>
          <Input
            id="voice-typed"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={EXAMPLES[lang][2]}
            disabled={thinking}
            className="min-w-[220px] flex-1"
          />
          <Button type="submit" variant="outline" disabled={thinking || typed.trim().length === 0}>
            Run
          </Button>
        </form>
        {!micUsable ? (
          <p className="mt-2 text-xs text-muted-foreground">
            This browser cannot use the microphone, so it is hidden. Typing works exactly the same -
            it is the same interpreter.
          </p>
        ) : null}
      </div>

      {/* ----------------------------------------------------------- outcome */}
      {command && !listening ? (
        <div className="space-y-3 border-t bg-muted/40 px-4 py-3">
          {command.kind === "unknown" ? (
            <div>
              <Alert tone="info">{command.reason}</Alert>
              <p className="mt-2 text-xs text-muted-foreground">
                Things that work:{" "}
                {EXAMPLES[lang].map((e, i) => (
                  <span key={e}>
                    {i > 0 ? " · " : ""}
                    <span className="font-medium">&ldquo;{e}&rdquo;</span>
                  </span>
                ))}
              </p>
            </div>
          ) : null}

          {command.kind === "navigate" ? (
            <p className="text-sm">
              Opening <span className="font-medium">{command.label}</span>.
            </p>
          ) : null}

          {result?.answer ? (
            <div className="flex flex-wrap items-baseline gap-x-3">
              <span className="num text-2xl font-semibold">{result.answer.value}</span>
              <span className="text-sm text-muted-foreground">{result.answer.label}</span>
              <Link href={result.answer.href} className="text-sm font-medium underline">
                See the detail
              </Link>
            </div>
          ) : null}

          {command.kind === "booking" ||
          command.kind === "payment" ||
          command.kind === "batch" ||
          command.kind === "sale" ||
          command.kind === "shop" ||
          command.kind === "area" ||
          command.kind === "category" ||
          command.kind === "booker" ||
          command.kind === "product" ||
          command.kind === "price" ||
          command.kind === "rename" ||
          command.kind === "toggle" ||
          command.kind === "assign" ? (
            <ConfirmWrite
              command={command}
              saving={saving}
              saveState={saveState}
              onSave={async () => {
                await runSave(command);
              }}
            />
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}

/**
 * Every write goes through the SAME server action a typed form uses, so voice
 * gets no shortcut around validation, stock checks or the audit trail.
 */
type WriteCommand = Extract<
  VoiceResult["command"],
  {
    kind:
      | "booking"
      | "payment"
      | "batch"
      | "sale"
      | "shop"
      | "area"
      | "category"
      | "booker"
      | "product"
      | "price"
      | "rename"
      | "toggle"
      | "assign";
  }
>;

/**
 * The form payload for a proposal.
 *
 * Module-level so the Save button and a spoken "haan" build the identical
 * FormData - two code paths to the same write would be two chances to drift.
 */
function buildPayload(command: WriteCommand): FormData {
  const form = new FormData();
  if (command.kind === "booking") {
    form.set("bookingDate", command.date);
    form.set("areaId", String(command.areaId ?? ""));
    if (command.shopId != null) form.set("shopId", String(command.shopId));
    if (command.bookerId != null) form.set("bookerId", String(command.bookerId));
    if (command.customerPhone) form.set("customerPhone", command.customerPhone);
    form.set(
      "lines",
      JSON.stringify(
        command.lines.map((l) => ({
          productId: l.productId,
          quantity: l.quantity,
          unitPrice: l.unitPrice,
        })),
      ),
    );
    // A key per proposal, so pressing Save twice cannot book twice.
    form.set(
      "idempotencyKey",
      `voice-${command.date}-${command.lines[0]?.productId}-${command.lines[0]?.quantity}-${command.areaId}`,
    );
  } else if (command.kind === "batch") {
    form.set("productId", String(command.productId));
    form.set("quantity", String(command.quantity));
    form.set("unitCost", String(command.unitCost ?? ""));
    form.set("receivedDate", command.date);
    form.set(
      "idempotencyKey",
      `voice-batch-${command.productId}-${command.quantity}-${command.unitCost}-${command.date}`,
    );
  } else if (command.kind === "sale") {
    form.set("productId", String(command.productId));
    form.set("quantity", String(command.quantity));
    form.set("salePrice", String(command.unitPrice));
    form.set("saleDate", command.date);
    form.set("areaId", String(command.areaId ?? ""));
    if (command.shopId != null) form.set("shopId", String(command.shopId));
    // A counter sale needs a batch, and voice does not choose batches - the
    // oldest one with stock is the same FIFO rule a booking uses.
    form.set("batchId", String(command.batchId ?? ""));
    form.set(
      "idempotencyKey",
      `voice-sale-${command.productId}-${command.quantity}-${command.date}`,
    );
  } else if (command.kind === "shop") {
    form.set("areaId", String(command.areaId ?? ""));
    form.set("name", command.name);
    if (command.phone) form.set("phone", command.phone);
  } else if (command.kind === "category") {
    form.set("name", command.name);
  } else if (command.kind === "booker") {
    form.set("name", command.name);
    if (command.phone) form.set("phone", command.phone);
  } else if (command.kind === "product") {
    form.set("name", command.name);
    form.set("categoryId", String(command.categoryId ?? ""));
    form.set("packagingType", command.packagingType ?? "");
    form.set("variantValue", command.variantValue ?? "");
    form.set("unit", command.unit ?? "piece");
    form.set("defaultSalePrice", String(command.salePrice ?? ""));
  } else if (command.kind === "price") {
    form.set("productId", String(command.productId));
    form.set("defaultSalePrice", String(command.newPrice ?? ""));
  } else if (command.kind === "rename") {
    form.set("target", command.target);
    form.set("id", String(command.id));
    form.set("name", command.newName);
    // Resent, not omitted. renameShopAction takes these alongside the name, so
    // leaving them out would blank the address and phone of the shop.
    if (command.keep.address) form.set("address", command.keep.address);
    if (command.keep.phone) form.set("phone", command.keep.phone);
    if (command.keep.voiceAlias) form.set("voiceAlias", command.keep.voiceAlias);
  } else if (command.kind === "toggle") {
    form.set("target", command.target);
    // The action flips whatever it finds. It is only reached when the current
    // state is the opposite of what was asked for - enrich() refuses the
    // command otherwise, so this can never turn something the wrong way.
    form.set("id", String(command.id));
  } else if (command.kind === "assign") {
    form.set("bookerId", String(command.bookerId));
    // The whole territory, existing areas included: this action replaces the
    // set rather than adding to it.
    form.set("areaIds", JSON.stringify(command.areaIds));
  } else if (command.kind === "area") {
    // An area is a name and nothing else. The action restores a previously
    // removed area of the same name rather than duplicating it, which is the
    // right behaviour here too - saying the name of an area that was deleted
    // brings it back instead of failing on the unique index.
    form.set("name", command.name);
  } else {
    form.set("bookingId", String(command.bookingId ?? ""));
    form.set("amount", String(command.amount ?? ""));
    form.set("paidOn", command.date);
    form.set("method", "Cash");
    form.set("idempotencyKey", `voice-${command.bookingId}-${command.amount}-${command.date}`);
  }
  return form;
}
const ACTIONS = {
  booking: createBookingAction,
  payment: recordPaymentAction,
  batch: createBatchAction,
  sale: createSaleAction,
  shop: createShopAction,
  area: createAreaAction,
  category: createCategoryAction,
  booker: createBookerAction,
  product: createProductAction,
  price: updateProductPriceAction,
  toggle: toggleActionFor,
  rename: renameActionFor,
  assign: setBookerAreasAction,
} as const;

/**
 * The confirmation step for anything that writes.
 *
 * It shows what was understood, what had to be assumed, and what is still
 * missing - then hands off to the SAME server action a typed form would use, so
 * voice gets no shortcut around validation, stock checks or the audit trail.
 */
function ConfirmWrite({
  command,
  saving,
  saveState,
  onSave,
}: {
  command: WriteCommand;
  saving: boolean;
  saveState: ActionState | null;
  onSave: (formData: FormData) => Promise<void>;
}) {
  const blocked = command.missing.length > 0;

  const submit = () => void onSave(buildPayload(command));

  return (
    <div className="space-y-3">
      <div className="rounded-md border bg-card p-3">
        <div className="mb-2 flex items-center gap-2">
          <Badge variant={command.confidence === "high" ? "success" : "outline"}>
            {KIND_LABEL[command.kind]}
          </Badge>
          {command.confidence === "low" ? (
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <AlertTriangle className="h-3.5 w-3.5" />
              Check this before saving
            </span>
          ) : null}
        </div>

        <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
          {command.kind === "booking" ? (
            <>
              {/* One row per line: a two-line order has to show both, or
                  confirming it would be confirming something unseen. */}
              {command.lines.map((line, i) => (
                <Row
                  key={`${line.sku}-${i}`}
                  label={command.lines.length > 1 ? `Line ${i + 1}` : "Product"}
                  value={`${line.quantity || "?"} x ${line.label} at ${line.unitPrice}`}
                  missing={!line.quantity}
                />
              ))}
              <Row
                label="Where"
                value={command.shopName ?? command.areaName ?? "missing"}
                missing={command.areaId == null}
              />
              <Row label="Date" value={command.date} />
              {command.bookerName ? <Row label="Booker" value={command.bookerName} /> : null}
              {command.customerPhone ? (
                <Row label="Customer phone" value={command.customerPhone} />
              ) : null}
              {command.lines.length > 1 ? (
                <Row
                  label="Order total"
                  value={String(
                    command.lines.reduce((sum, l) => sum + l.quantity * l.unitPrice, 0),
                  )}
                />
              ) : null}
            </>
          ) : command.kind === "batch" ? (
            <>
              <Row label="Product" value={command.label} />
              <Row
                label="Quantity"
                value={command.quantity ? String(command.quantity) : "missing"}
                missing={!command.quantity}
              />
              <Row
                label="Unit cost"
                value={command.unitCost == null ? "missing" : String(command.unitCost)}
                missing={command.unitCost == null}
              />
              <Row label="Received on" value={command.date} />
            </>
          ) : command.kind === "shop" ? (
            <>
              <Row
                label="Shop name"
                value={command.name || "missing"}
                missing={command.name.length === 0}
              />
              <Row
                label="In area"
                value={command.areaName ?? "missing"}
                missing={command.areaId == null}
              />
              {command.phone ? <Row label="Phone" value={command.phone} /> : null}
            </>
          ) : command.kind === "category" ? (
            <Row
              label="Category name"
              value={command.name || "missing"}
              missing={command.name.length === 0}
            />
          ) : command.kind === "booker" ? (
            <>
              <Row label="Booker name" value={command.name || "missing"} />
              {command.phone ? <Row label="Phone" value={command.phone} /> : null}
            </>
          ) : command.kind === "product" ? (
            <>
              <Row label="Product name" value={command.name} />
              <Row
                label="Category"
                value={command.categoryName ?? "missing"}
                missing={command.categoryId == null}
              />
              <Row
                label="Packaging"
                value={command.packagingType ?? "missing"}
                missing={command.packagingType == null}
              />
              <Row
                label="Size"
                value={command.variantValue ?? "missing"}
                missing={command.variantValue == null}
              />
              <Row label="Unit" value={command.unit ?? "piece"} />
              <Row
                label="Sale price"
                value={command.salePrice == null ? "missing" : String(command.salePrice)}
                missing={command.salePrice == null}
              />
            </>
          ) : command.kind === "price" ? (
            <>
              <Row label="Product" value={command.label} />
              <Row label="Price now" value={String(command.oldPrice)} />
              <Row
                label="New price"
                value={command.newPrice == null ? "missing" : String(command.newPrice)}
                missing={command.newPrice == null}
              />
            </>
          ) : command.kind === "rename" ? (
            <>
              <Row label={`The ${command.target}`} value={command.oldName} />
              <Row label="New name" value={command.newName} />
            </>
          ) : command.kind === "toggle" ? (
            <>
              <Row
                label={command.target === "product" ? "Product" : "Booker"}
                value={command.label}
              />
              <Row label="Change to" value={command.wanted ? "Active" : "Inactive"} />
            </>
          ) : command.kind === "assign" ? (
            <>
              <Row label="Booker" value={command.bookerName} />
              <Row label="Adding" value={command.addedNames.join(", ") || "nothing new"} />
              {command.keptNames.length > 0 ? (
                <Row label="Keeps" value={command.keptNames.join(", ")} />
              ) : null}
            </>
          ) : command.kind === "area" ? (
            <>
              <Row
                label="Area name"
                value={command.name || "missing"}
                missing={command.name.length === 0}
              />
            </>
          ) : command.kind === "sale" ? (
            <>
              <Row label="Product" value={command.label} />
              <Row
                label="Quantity"
                value={command.quantity ? String(command.quantity) : "missing"}
                missing={!command.quantity}
              />
              <Row label="Price each" value={String(command.unitPrice)} />
              <Row
                label="Where"
                value={command.shopName ?? command.areaName ?? "missing"}
                missing={command.areaId == null}
              />
              <Row label="Date" value={command.date} />
            </>
          ) : (
            <>
              <Row
                label="Invoice"
                value={command.invoiceNo ?? "missing"}
                missing={command.invoiceNo == null}
              />
              <Row
                label="Amount"
                value={command.amount == null ? "missing" : String(command.amount)}
                missing={command.amount == null}
              />
              <Row label="Received on" value={command.date} />
            </>
          )}
        </dl>

        {command.warnings.length > 0 ? (
          <ul className="mt-2 space-y-0.5 border-t pt-2 text-xs text-muted-foreground">
            {command.warnings.map((w) => (
              <li key={w}>· {w}</li>
            ))}
          </ul>
        ) : null}
      </div>

      {saveState?.message ? (
        <Alert tone={saveState.ok ? "success" : "error"}>{saveState.message}</Alert>
      ) : null}

      {blocked ? (
        <Alert tone="info">
          {command.missing.join(" and ")} {command.missing.length === 1 ? "is" : "are"} missing, so
          this cannot be saved from here. Say it again in full, or use the{" "}
          <Link
            href={command.kind === "booking" ? "/bookings/new" : "/bookings"}
            className="font-medium underline"
          >
            {command.kind === "booking" ? "New Booking" : "Bookings"}
          </Link>{" "}
          page.
        </Alert>
      ) : (
        <div className="flex items-center gap-2">
          <Button type="button" onClick={submit} disabled={saving || saveState?.ok === true}>
            {saving ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Saving
              </>
            ) : (
              <>
                <Check className="h-4 w-4" />
                Save this {command.kind === "booking" ? "order" : "payment"}
              </>
            )}
          </Button>
          <span className="text-xs text-muted-foreground">
            Nothing is saved until you press this.
          </span>
        </div>
      )}
    </div>
  );
}

const KIND_LABEL = {
  booking: "Order",
  payment: "Payment",
  batch: "Stock in",
  sale: "Cash sale",
  shop: "New shop",
  area: "New area",
  category: "New category",
  booker: "New booker",
  product: "New product",
  price: "Price change",
  rename: "Rename",
  toggle: "On / off",
  assign: "Territory",
} as const;

function Row({ label, value, missing }: { label: string; value: string; missing?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 sm:justify-start">
      <dt className="shrink-0 text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className={cn("font-medium", missing && "text-destructive")}>
        {missing ? (
          <span className="flex items-center gap-1">
            <MicOff className="h-3.5 w-3.5" />
            {value}
          </span>
        ) : (
          value
        )}
      </dd>
    </div>
  );
}
