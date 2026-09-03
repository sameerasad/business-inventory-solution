"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * The browser's own speech recognition, wrapped.
 *
 * Deliberately behind this hook and nothing else: the rest of the app only ever
 * sees `{ start, stop, transcript, state }`. Swapping this for a server-side
 * engine later - Whisper, Deepgram - means replacing this one file, not touching
 * the parser, the confirmation flow, or any page.
 *
 * The API is only in Chrome, Edge and recent Safari, and only over HTTPS or on
 * localhost. `supported` is false everywhere else, and the UI hides itself
 * rather than showing a button that cannot work.
 */

export type SpeechState = "idle" | "listening" | "denied" | "error";

/** Two engines, one per language, because it cannot auto-detect. */
export type SpeechLang = "en-PK" | "ur-PK";

type SpeechRecognitionLike = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error: string }) => void) | null;
};

type SpeechRecognitionEventLike = {
  resultIndex: number;
  results: {
    length: number;
    [index: number]: { isFinal: boolean; 0: { transcript: string } };
  };
};

type SpeechCtor = new () => SpeechRecognitionLike;

function getCtor(): SpeechCtor | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: SpeechCtor;
    webkitSpeechRecognition?: SpeechCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function useSpeech({
  lang,
  onFinal,
}: {
  lang: SpeechLang;
  /** Called once, with the final transcript, when the person stops talking. */
  onFinal: (transcript: string) => void;
}) {
  const [supported, setSupported] = useState(false);
  const [state, setState] = useState<SpeechState>("idle");
  const [transcript, setTranscript] = useState("");
  const [error, setError] = useState<string | null>(null);

  const recognition = useRef<SpeechRecognitionLike | null>(null);
  // Held in a ref so the recognition callbacks always see the current handler
  // without having to tear down and rebuild the recogniser on every render.
  const finalHandler = useRef(onFinal);
  finalHandler.current = onFinal;

  useEffect(() => {
    setSupported(getCtor() != null);
  }, []);

  const stop = useCallback(() => {
    recognition.current?.stop();
    setState("idle");
  }, []);

  const start = useCallback(() => {
    const Ctor = getCtor();
    if (!Ctor) {
      setSupported(false);
      return;
    }

    // A fresh recogniser per utterance. Reusing one across languages leaves the
    // previous language in place on some builds of Chrome.
    recognition.current?.abort();
    const rec = new Ctor();
    recognition.current = rec;

    rec.lang = lang;
    rec.continuous = false;
    rec.interimResults = true;
    rec.maxAlternatives = 1;

    setTranscript("");
    setError(null);
    setState("listening");

    let finalText = "";

    rec.onresult = (event) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i]!;
        const text = result[0].transcript;
        if (result.isFinal) finalText += text;
        else interim += text;
      }
      // Showing the interim text is what makes a mishearing obvious while it is
      // still happening, instead of after something has been filled in.
      setTranscript((finalText + interim).trim());
    };

    rec.onerror = (event) => {
      if (event.error === "not-allowed" || event.error === "service-not-allowed") {
        setState("denied");
        setError("Microphone access was blocked. Allow it in the browser's address bar.");
        return;
      }
      if (event.error === "no-speech") {
        setState("idle");
        setError("Nothing was heard. Try again, a little closer to the microphone.");
        return;
      }
      // Distinct from "not-allowed": permission was fine, there was simply no
      // microphone to read from - none connected, none selected as the default
      // input, another app holding it exclusively, or Windows blocking
      // microphone access for desktop apps. That last one is the usual culprit
      // and is nowhere near the browser, so the message has to point at it.
      if (event.error === "audio-capture") {
        setState("error");
        setError(
          "No microphone could be used. Check that one is plugged in and selected as the input " +
            "device, that no other app is holding it, and on Windows that Settings > Privacy & " +
            "security > Microphone allows desktop apps.",
        );
        return;
      }
      if (event.error === "network") {
        setState("error");
        setError("Speech recognition needs an internet connection.");
        return;
      }
      if (event.error === "aborted") {
        setState("idle");
        return;
      }
      setState("error");
      setError(`Speech recognition failed (${event.error}).`);
    };

    rec.onend = () => {
      setState((current) => (current === "listening" ? "idle" : current));
      const said = finalText.trim();
      if (said.length > 0) finalHandler.current(said);
    };

    try {
      rec.start();
    } catch {
      // start() throws if called while already running; the existing session
      // is what the person wanted anyway.
      setState("listening");
    }
  }, [lang]);

  useEffect(() => () => recognition.current?.abort(), []);

  return { supported, state, transcript, error, start, stop, setTranscript };
}

/**
 * Reads a sentence aloud.
 *
 * Best-effort by design: if the browser has no Urdu voice installed it will fall
 * back to whatever it has, and the answer is on screen regardless. Speech is the
 * convenience here, not the delivery mechanism.
 */
export function speak(text: string, lang: SpeechLang, onDone?: () => void) {
  if (typeof window === "undefined" || !("speechSynthesis" in window)) {
    onDone?.();
    return;
  }
  try {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = lang === "ur-PK" ? "ur-PK" : "en-US";
    utterance.rate = 1;
    // onDone is what makes hands-free possible: the microphone must not open
    // until the app has stopped talking, or it hears itself and "confirms"
    // whatever it just read out.
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      onDone?.();
    };
    utterance.onend = finish;
    utterance.onerror = finish;
    // A voice that never fires onend - which happens on some Android builds -
    // must not leave the flow stuck waiting forever.
    window.setTimeout(finish, Math.min(15000, 2000 + text.length * 90));
    window.speechSynthesis.speak(utterance);
  } catch {
    // A missing voice is not worth interrupting anything for.
    onDone?.();
  }
}
