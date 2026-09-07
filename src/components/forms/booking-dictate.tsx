"use client";

import { useCallback, useEffect, useState } from "react";
import { Loader2, Mic, Square } from "lucide-react";

import {
  interpretVoiceAction,
  transcribeAndInterpretAction,
  type VoiceResult,
} from "@/actions/voice";
import { useSpeech, type SpeechLang } from "@/components/voice/use-speech";
import { useRecorder } from "@/components/voice/use-recorder";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const LANG_KEY = "voice-lang";
const ENGINE_KEY = "voice-engine";

export type DictatedBooking = Extract<VoiceResult["command"], { kind: "booking" }>;

/**
 * Say the whole order once, and it fills this form in.
 *
 * This replaced a step-by-step version that asked for one field at a time. That
 * design was wrong for the engine underneath it: Whisper needs context to
 * transcribe well, so a one-word answer like "Downtown" is its WORST case -
 * measured directly, a second of near-silence came back as an invented Urdu
 * sentence. Asking for single words gave the parser an easy job and the
 * transcriber its hardest one.
 *
 * A whole sentence is the opposite trade, and the right one: the engine gets
 * the context it wants, and the result lands in real form fields where a
 * mishearing is visible and fixable with the keyboard. There is no conversation
 * loop to go wrong - one recording, one result, then it is an ordinary form
 * again.
 *
 * It never submits. Filling is all it does.
 */
export function BookingDictate({
  whisperAvailable,
  onFilled,
}: {
  whisperAvailable: boolean;
  /** Given the understood order, so the form can write it into its own fields. */
  onFilled: (command: DictatedBooking) => void;
}) {
  const [lang, setLang] = useState<SpeechLang>("en-PK");
  const [useWhisper, setUseWhisper] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [outcome, setOutcome] = useState<{ ok: boolean; message: string } | null>(null);
  const [typed, setTyped] = useState("");

  // The same preferences the Voice page keeps, so a choice made there carries.
  useEffect(() => {
    try {
      const savedLang = window.localStorage.getItem(LANG_KEY);
      if (savedLang === "en-PK" || savedLang === "ur-PK") setLang(savedLang);
      setUseWhisper(whisperAvailable && window.localStorage.getItem(ENGINE_KEY) !== "browser");
    } catch {
      // Blocked storage; the defaults are fine.
    }
  }, [whisperAvailable]);

  // The same two keys the Voice page uses, so a choice made in either place
  // is the choice in both. Without a control here the box was stuck on
  // whatever that page had last been set to - and on English for anyone who
  // had never opened it, which is why Urdu spoken here came back as nonsense.
  const chooseLang = (next: SpeechLang) => {
    setLang(next);
    try {
      window.localStorage.setItem(LANG_KEY, next);
    } catch {
      // Only affects the next visit.
    }
  };

  const chooseEngine = (next: "whisper" | "browser") => {
    setUseWhisper(next === "whisper");
    try {
      window.localStorage.setItem(ENGINE_KEY, next);
    } catch {
      // Only affects the next visit.
    }
  };

  /** Apply an understood result, whichever engine produced it. */
  const apply = useCallback(
    (result: VoiceResult) => {
      // The transcript goes INTO the editable box, not into a read-only line
      // beside it.
      //
      // This is the whole correction loop. "Rajput Dairy" comes back as
      // "Rajpur Daily" and the shop cannot be matched - but with the sentence
      // sitting in a text field, that is one word to fix and Fill again,
      // instead of saying the entire order over and hoping for better luck.
      // Guarded, not assigned blindly. A controlled input handed undefined
      // silently becomes uncontrolled and shows its placeholder, which looks
      // exactly like "the transcript never arrived" while hiding the real
      // fault. And an empty transcript must never wipe a sentence someone
      // typed by hand - that text is the only copy of what they meant.
      if (typeof result.transcript === "string" && result.transcript.trim().length > 0) {
        setTyped(result.transcript);
      }
      if (result.command.kind !== "booking") {
        // Say what it DID understand. A flat "that was not an order" is
        // maddening when the sentence was heard correctly and simply asked for
        // something this box cannot do - and it hides a mishearing too, since
        // the summary is where you would spot it.
        setOutcome({
          ok: false,
          message:
            result.command.kind === "unknown"
              ? `${result.summary} This box only takes orders - use the Voice page for anything else.`
              : `That was understood as: ${result.summary} This box only takes orders - use the Voice page for that.`,
        });
        return;
      }
      onFilled(result.command);
      const line = result.command.lines[0];
      setOutcome({
        ok: true,
        message: [
          line
            ? `Filled ${result.command.lines.length} line(s), starting ${line.quantity} x ${line.label}.`
            : "Filled.",
          ...result.command.warnings,
          result.command.missing.length > 0
            ? `Still needed: ${result.command.missing.join(", ")}.`
            : "Check the fields and press Save.",
        ].join(" "),
      });
    },
    [onFilled],
  );

  /** The browser engine hands back text, so it goes straight to the parser. */
  const handleText = useCallback(
    async (said: string) => {
      setThinking(true);
      setOutcome(null);
      try {
        apply(await interpretVoiceAction(said));
      } finally {
        setThinking(false);
      }
    },
    [apply],
  );

  const { supported, state, transcript, error, start, stop } = useSpeech({
    lang,
    onFinal: handleText,
  });

  /** Whisper needs the audio, transcribed and interpreted server-side. */
  const handleClip = useCallback(
    async (audio: Blob) => {
      setThinking(true);
      setOutcome(null);
      try {
        const form = new FormData();
        form.append("audio", audio, "order.webm");
        form.append("language", lang === "ur-PK" ? "ur" : "en");
        const result = await transcribeAndInterpretAction(form);
        if (!result.ok) {
          setOutcome({ ok: false, message: result.reason });
          return;
        }
        apply(result.result);
      } finally {
        setThinking(false);
      }
    },
    [apply, lang],
  );

  const recorder = useRecorder({ onClip: handleClip });

  const listening = useWhisper ? recorder.state === "recording" : state === "listening";
  const micUsable = useWhisper ? recorder.supported : supported;
  const liveError = useWhisper ? recorder.error : error;

  const begin = () => {
    setOutcome(null);
    if (useWhisper) void recorder.start();
    else start();
  };

  const fillFromTyped = () => {
    const said = typed.trim();
    if (said.length === 0) return;
    void handleText(said);
  };

  return (
    <div className="w-full space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {micUsable ? (
          <Button
            type="button"
            variant={listening ? "destructive" : "outline"}
            onClick={listening ? (useWhisper ? recorder.stop : stop) : begin}
            disabled={thinking}
            className="gap-1.5"
          >
            {listening ? (
              <>
                <Square className="h-4 w-4" />
                {useWhisper ? `Stop (${recorder.seconds}s)` : "Stop"}
              </>
            ) : thinking ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Working
              </>
            ) : (
              <>
                <Mic className="h-4 w-4" />
                Say the order
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
                aria-pressed={useWhisper === (value === "whisper")}
                disabled={listening || thinking}
                title={
                  value === "whisper"
                    ? "Records a clip and transcribes it on the server. Much better at Urdu, takes a second or two."
                    : "The browser's own recognition. Instant, but weak on Urdu."
                }
                className={cn(
                  "rounded-[5px] px-2.5 py-1 text-xs font-medium transition-colors",
                  useWhisper === (value === "whisper")
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {label}
              </button>
            ))}
          </div>
        ) : null}

        {/* Neither engine can tell which language is being spoken, so both
            have to be told. */}
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
                  "rounded-[5px] px-2.5 py-1 text-xs font-medium transition-colors",
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

        {/* Typing the same sentence takes the identical path, which is both the
            fallback when the microphone is unavailable and the quickest way past
            a word it keeps mishearing.

            Deliberately NOT a <form>. This component renders inside the
            booking form, and a nested form is invalid HTML - the browser
            discards the inner one, so a type="submit" button here submitted the
            BOOKING instead of filling it, and pressing Enter did the same. The
            Add-shop dialog nearby gets away with its own form only because
            Radix renders it in a portal, outside the form entirely. */}
        <div className="flex min-w-[240px] flex-1 items-center gap-2">
          <Input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              // Enter must fill, and must not reach the booking form.
              e.preventDefault();
              e.stopPropagation();
              fillFromTyped();
            }}
            placeholder="or type the whole order"
            aria-label="The order, as heard - editable"
            // Urdu is written right to left and the transcript is usually
            // Urdu, so the direction has to follow the text rather than the
            // page. "auto" reads the first strong character and lays the line
            // out the way the person speaking would write it.
            dir="auto"
            disabled={thinking}
          />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={fillFromTyped}
            disabled={thinking || typed.trim().length === 0}
          >
            Fill
          </Button>
        </div>
      </div>

      {listening ? (
        <p className="text-xs text-muted-foreground" aria-live="polite">
          {useWhisper
            ? "Recording - say the whole order, then it stops on its own."
            : transcript || "Listening..."}
        </p>
      ) : null}

      {liveError ? <Alert tone="error">{liveError}</Alert> : null}
      {outcome ? (
        <p className={cn("text-xs", outcome.ok ? "text-muted-foreground" : "text-destructive")}>
          {outcome.message}
        </p>
      ) : null}

      <p className="text-xs text-muted-foreground">
        One sentence: quantity, product, and the shop. What was heard appears in the box above -
        correct any word it got wrong and press Fill again. Nothing is saved until you press Save.
      </p>
    </div>
  );
}
