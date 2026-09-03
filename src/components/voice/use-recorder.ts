"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Records a short clip of audio and hands it over as a Blob.
 *
 * This is the other half of the engine choice: the browser's own recogniser
 * needs no recording at all - it listens and returns text - while Whisper needs
 * actual audio to send. So this hook exists purely to capture a clip, and knows
 * nothing about what happens to it.
 *
 * Opus in a WebM container, because it is what Chrome produces natively, and
 * a 30-second command is well under 100 KB - small enough that uploading it
 * costs nothing noticeable.
 */

export type RecorderState = "idle" | "recording" | "denied" | "error";

/** Beyond this a command is not a command; it also keeps the upload small. */
const MAX_SECONDS = 30;

/**
 * Stop once the talking stops.
 *
 * Without this the recorder runs until the 30-second cap or a manual click,
 * which is fine for a single command and useless in a guided conversation: the
 * app asks "which area?", opens the microphone, and then just sits there. The
 * browser's own recogniser ends on silence, so Whisper has to as well or the
 * two engines behave nothing alike.
 */
const SILENCE_MS = 1400;
/**
 * Root-mean-square below this counts as room noise rather than speech.
 *
 * Low on purpose. A built-in laptop microphone is quiet, and a threshold set
 * for a headset simply never registers speech at all - which leaves the
 * recording running to its cap and produces either a 30-second clip or, if
 * stopped by hand, one too short to transcribe.
 */
const SILENCE_RMS = 0.006;
/** Never cut someone off before they have had a chance to start. */
const MIN_MS = 900;
/**
 * If nothing above the threshold is ever heard, stop anyway.
 *
 * Better to end and say "nothing was heard" than to sit recording silence for
 * half a minute while the person waits for something to happen.
 */
const NO_SPEECH_MS = 6000;

function pickMimeType(): string {
  if (typeof MediaRecorder === "undefined") return "";
  for (const type of [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/mp4",
  ]) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return "";
}

export function useRecorder({ onClip }: { onClip: (audio: Blob) => void }) {
  const [supported, setSupported] = useState(false);
  const [state, setState] = useState<RecorderState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [seconds, setSeconds] = useState(0);

  const recorder = useRef<MediaRecorder | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const chunks = useRef<Blob[]>([]);
  const timer = useRef<number | null>(null);
  const cap = useRef<number | null>(null);
  const audioContext = useRef<AudioContext | null>(null);
  const vad = useRef<number | null>(null);
  /**
   * Whether anything above the noise floor was actually heard.
   *
   * This decides whether the clip is worth uploading at all. Sending silence is
   * worse than sending nothing: Whisper does not return an empty string for it,
   * it invents a plausible sentence - measured directly, one second of silence
   * came back as a full Urdu sentence about a competition. A hallucination that
   * parses is far more dangerous than an error.
   */
  const heardSpeech = useRef(false);
  const clipHandler = useRef(onClip);
  clipHandler.current = onClip;

  useEffect(() => {
    setSupported(
      typeof navigator !== "undefined" &&
        typeof navigator.mediaDevices?.getUserMedia === "function" &&
        typeof MediaRecorder !== "undefined",
    );
  }, []);

  const cleanup = useCallback(() => {
    if (timer.current != null) window.clearInterval(timer.current);
    if (cap.current != null) window.clearTimeout(cap.current);
    if (vad.current != null) window.clearInterval(vad.current);
    timer.current = null;
    cap.current = null;
    vad.current = null;
    // An AudioContext left open keeps the audio hardware awake.
    void audioContext.current?.close().catch(() => {});
    audioContext.current = null;
    // Releasing the tracks is what turns off the browser's recording indicator.
    // Leaving them open would keep the microphone light on between commands.
    stream.current?.getTracks().forEach((track) => track.stop());
    stream.current = null;
  }, []);

  const stop = useCallback(() => {
    if (recorder.current?.state === "recording") recorder.current.stop();
    else {
      cleanup();
      setState("idle");
    }
  }, [cleanup]);

  const start = useCallback(async () => {
    setError(null);
    setSeconds(0);
    chunks.current = [];
    heardSpeech.current = false;

    let media: MediaStream;
    try {
      media = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      const name = err instanceof DOMException ? err.name : "";
      if (name === "NotAllowedError" || name === "SecurityError") {
        setState("denied");
        setError("Microphone access was blocked. Allow it in the browser's address bar.");
        return;
      }
      if (name === "NotFoundError" || name === "DevicesNotFoundError") {
        setState("error");
        setError(
          "No microphone was found. Check that one is connected and that Windows allows " +
            "desktop apps to use it.",
        );
        return;
      }
      setState("error");
      setError("The microphone could not be opened.");
      return;
    }

    stream.current = media;
    const mimeType = pickMimeType();
    const rec = new MediaRecorder(media, mimeType ? { mimeType } : undefined);
    recorder.current = rec;

    rec.ondataavailable = (event) => {
      if (event.data.size > 0) chunks.current.push(event.data);
    };

    rec.onstop = () => {
      const blob = new Blob(chunks.current, { type: rec.mimeType || "audio/webm" });
      const spoke = heardSpeech.current;
      chunks.current = [];
      cleanup();
      setState("idle");

      if (blob.size === 0) return;
      if (!spoke) {
        setError("Nothing was heard. Try again, a little closer to the microphone.");
        return;
      }
      clipHandler.current(blob);
    };

    rec.onerror = () => {
      cleanup();
      setState("error");
      setError("Recording failed.");
    };

    rec.start();
    setState("recording");
    timer.current = window.setInterval(() => setSeconds((s) => s + 1), 1000);
    // A hard stop, so a forgotten session cannot record for ten minutes and
    // then be rejected for size on the server.
    cap.current = window.setTimeout(() => stop(), MAX_SECONDS * 1000);

    // Listen to the level and stop when the talking does.
    try {
      const context = new AudioContext();
      audioContext.current = context;
      const analyser = context.createAnalyser();
      analyser.fftSize = 1024;
      context.createMediaStreamSource(media).connect(analyser);
      const samples = new Float32Array(analyser.fftSize);

      const began = Date.now();
      let quietSince: number | null = null;

      vad.current = window.setInterval(() => {
        analyser.getFloatTimeDomainData(samples);
        let sum = 0;
        for (const sample of samples) sum += sample * sample;
        const rms = Math.sqrt(sum / samples.length);

        if (rms >= SILENCE_RMS) {
          heardSpeech.current = true;
          quietSince = null;
          return;
        }
        // Nothing audible at all, for long enough that waiting is pointless.
        if (!heardSpeech.current && Date.now() - began >= NO_SPEECH_MS) {
          stop();
          return;
        }
        // Silence only counts once something has actually been said, so a
        // slow start never ends the recording before it begins.
        if (!heardSpeech.current || Date.now() - began < MIN_MS) return;
        if (quietSince == null) quietSince = Date.now();
        else if (Date.now() - quietSince >= SILENCE_MS) stop();
      }, 100);
    } catch {
      // No AudioContext: no level to measure, so there is no way to tell speech
      // from silence. The clip has to be trusted, and the manual Stop button
      // and the hard cap are the only limits left.
      heardSpeech.current = true;
    }
  }, [cleanup, stop]);

  useEffect(
    () => () => {
      if (recorder.current?.state === "recording") recorder.current.stop();
      cleanup();
    },
    [cleanup],
  );

  return { supported, state, error, seconds, start, stop, maxSeconds: MAX_SECONDS };
}
