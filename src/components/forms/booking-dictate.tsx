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
  const [heard, setHeard] = useState<string | null>(null);
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

  /** Apply an understood result, whichever engine produced it. */
  const apply = useCallback(
    (result: VoiceResult) => {
      setHeard(result.transcript);
      if (result.command.kind !== "booking") {
        setOutcome({
          ok: false,
          message:
            "That did not sound like an order. Try it as one sentence, like “bees aam bottle 250 Corner Store ko bech do”.",
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
    setHeard(null);
    if (useWhisper) void recorder.start();
    else start();
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

        {/* Typing the same sentence takes the identical path, which is both the
            fallback when the microphone is unavailable and the quickest way past
            a word it keeps mishearing. */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const said = typed.trim();
            if (said.length === 0) return;
            void handleText(said);
          }}
          className="flex min-w-[240px] flex-1 items-center gap-2"
        >
          <Input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder="or type the whole order"
            disabled={thinking}
          />
          <Button type="submit" variant="ghost" size="sm" disabled={typed.trim().length === 0}>
            Fill
          </Button>
        </form>
      </div>

      {listening ? (
        <p className="text-xs text-muted-foreground" aria-live="polite">
          {useWhisper
            ? "Recording - say the whole order, then it stops on its own."
            : transcript || "Listening..."}
        </p>
      ) : null}

      {heard ? (
        <p className="text-xs">
          <span className="text-muted-foreground">Heard{useWhisper ? " (Whisper)" : ""}: </span>
          &ldquo;{heard}&rdquo;
        </p>
      ) : null}

      {liveError ? <Alert tone="error">{liveError}</Alert> : null}
      {outcome ? (
        <p className={cn("text-xs", outcome.ok ? "text-muted-foreground" : "text-destructive")}>
          {outcome.message}
        </p>
      ) : null}

      <p className="text-xs text-muted-foreground">
        One sentence: quantity, product, and the shop. Nothing is saved until you press Save.
      </p>
    </div>
  );
}
