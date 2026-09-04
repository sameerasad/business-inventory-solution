/**
 * Speech to text via Groq's Whisper, server-side.
 *
 * Why this exists alongside the browser engine: Chrome's Urdu recognition is
 * weak, and no amount of vocabulary work in the lexicon fixes a transcript that
 * came back as the wrong words. Whisper large-v3 is substantially better on
 * Urdu and on Urdu-English code-switching, which is how this business actually
 * speaks.
 *
 * The API key lives ONLY here. Audio is posted from the browser to our own
 * server action, which then calls Groq - so the key is never in a page, a
 * bundle, or a network request the browser can see. That is the whole reason
 * this is not called directly from the client.
 */

/** Audio Whisper accepts, and the browser can actually produce. */
const ALLOWED_TYPES = new Set([
  "audio/webm",
  "audio/webm;codecs=opus",
  "audio/ogg",
  "audio/ogg;codecs=opus",
  "audio/mp4",
  "audio/mpeg",
  "audio/wav",
  "audio/x-wav",
]);

/**
 * 8 MB. A 30-second Opus clip is under 100 KB, so anything approaching this is
 * not a spoken command - and Vercel rejects request bodies over 4.5 MB anyway,
 * so a smaller ceiling here produces a clear message instead of a platform
 * error with no explanation.
 */
const MAX_BYTES = 8 * 1024 * 1024;

/**
 * Below this a WebM blob is essentially just a container header.
 *
 * A recording stopped a moment after it started produces one, and the service
 * answers 400 with no useful explanation. Refusing it here gives an answer that
 * actually helps: speak for longer.
 */
const MIN_BYTES = 1200;

/**
 * Does this transcript look like something this app can act on?
 *
 * Whisper occasionally answers in a script nobody spoke - Devanagari, Chinese,
 * Cyrillic - or returns one of its well-known filler hallucinations. Passing
 * that to the parser produces "did not match a page", which blames the command
 * when the real problem is the transcription, and sends you rephrasing a
 * sentence that was never heard.
 *
 * Accepted: Latin letters (English and Roman Urdu) and Urdu/Arabic script.
 * Digits and punctuation are neutral.
 */
export function looksUsable(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length === 0) return false;

  const letters = [...trimmed].filter((ch) => /\p{L}/u.test(ch));
  if (letters.length === 0) return false;

  const accepted = letters.filter((ch) => /[\p{Script=Latin}\p{Script=Arabic}]/u.test(ch));
  // A stray accented character is fine; a transcript that is mostly some other
  // script is not what was said.
  return accepted.length / letters.length >= 0.8;
}

/**
 * The service's own explanation, made safe to show.
 *
 * Throwing the response body away was a mistake: a bare "returned an error
 * (400)" gives nobody anything to act on, and 400 is exactly the status that
 * carries a real reason - audio too short, unreadable container, bad parameter.
 *
 * The API key travels in a header, never in the body, so the message itself is
 * safe to display. It is still scrubbed for anything key-shaped, because a
 * message that echoes a request is not worth trusting on that point.
 */
export function readServiceError(body: string): string | null {
  let message: string | null = null;
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } | string };
    if (typeof parsed.error === "string") message = parsed.error;
    else if (parsed.error && typeof parsed.error.message === "string") {
      message = parsed.error.message;
    }
  } catch {
    // Not JSON - a short plain-text body is still better than nothing.
    message = body.trim().length > 0 && body.length < 300 ? body.trim() : null;
  }
  if (!message) return null;
  const scrubbed = message.replace(/gsk_[A-Za-z0-9]+/g, "[key]").trim();
  return scrubbed.length > 0 ? scrubbed.slice(0, 220) : null;
}

/**
 * Whisper's stock hallucinations on silence or noise. It emits these verbatim
 * often enough that they are worth naming rather than passing on as a command.
 */
const HALLUCINATIONS = [
  "thank you for watching",
  "thanks for watching",
  "subscribe",
  "please subscribe",
  "shukriya dekhne ke liye",
  "www.",
  "subtitles by",
  "amara.org",
];

export function isHallucination(text: string): boolean {
  const lower = text.trim().toLowerCase();
  return HALLUCINATIONS.some((h) => lower.includes(h));
}

export type TranscribeResult =
  { ok: true; text: string; model: string } | { ok: false; reason: string; retryable: boolean };

/**
 * Where transcription happens.
 *
 * Groq by default, but any endpoint that speaks the OpenAI transcription API
 * will do - including one running on this machine. That is the whole reason
 * this is configuration rather than a hard-coded URL: a fine-tuned Urdu model
 * from Hugging Face cannot be used through Groq, which serves only its own
 * list, so trying one means running it yourself and pointing here at it.
 *
 * STT_BASE_URL   e.g. http://127.0.0.1:8123/v1  for a local server
 * STT_MODEL      the model that endpoint expects
 * STT_API_KEY    optional; a local server usually needs none
 */
export function sttConfig(): { baseUrl: string; model: string; key: string } {
  const baseUrl = (process.env.STT_BASE_URL ?? "https://api.groq.com/openai/v1").trim();
  const model = (process.env.STT_MODEL ?? process.env.GROQ_STT_MODEL ?? "whisper-large-v3").trim();
  // GROQ_API_KEY stays supported so nothing already deployed has to change.
  const key = (process.env.STT_API_KEY ?? process.env.GROQ_API_KEY ?? "").trim();
  return { baseUrl: baseUrl.replace(/\/+$/, ""), model, key };
}

/**
 * Whether transcription is available at all.
 *
 * A local endpoint needs no key, so having one configured counts as being set
 * up even with no key present.
 */
export function groqConfigured(): boolean {
  const { baseUrl, key } = sttConfig();
  const isLocal = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/.test(baseUrl);
  return key.length > 0 || isLocal;
}

/**
 * Whisper accepts a prompt as context, and it measurably improves recognition
 * of names it would otherwise never guess.
 *
 * Feeding it the actual catalog is the highest-value thing available here:
 * "Rakshani bazar" is not in any general speech model's vocabulary, but given
 * the word in the prompt, Whisper will produce it. Capped because a very long
 * prompt starts to bias the transcript towards listing the vocabulary rather
 * than hearing what was said.
 */
export function buildPrompt(vocabulary: string[]): string {
  const unique = [...new Set(vocabulary.map((v) => v.trim()).filter((v) => v.length > 0))];

  // Kept short deliberately. A long list of proper nouns is a known way to make
  // Whisper INVENT names - it starts producing things that look like the list
  // rather than what was said, which is how "bookings kholo" came back as
  // "Mokin Tukonu". The wording below asks for a transcript and offers the
  // names as possible content, rather than presenting a vocabulary to draw on.
  // Measured, not guessed: one second of silence sent with a long name list
  // came back as an invented Urdu sentence, and with no list at all as a single
  // word. The prompt earns its place on real speech - it is what lets Whisper
  // produce "Rakshani bazar" - but every extra name also gives it more to
  // invent from, so it is kept to a handful.
  const head = "Urdu or English. Transcribe only what is said. Names: ";
  const parts: string[] = [];
  for (const word of unique) {
    if ((head + parts.join(", ") + word).length > 180) break;
    parts.push(word);
  }
  return parts.length === 0
    ? "Urdu or English. Transcribe only what is said."
    : head + parts.join(", ") + ".";
}

/**
 * Send one clip to Groq.
 *
 * `language` is passed explicitly rather than letting Whisper detect it: on a
 * short, code-switched utterance auto-detection flips between Urdu and English
 * from one clip to the next, which is exactly the inconsistency this is meant
 * to remove.
 */
export async function transcribeWithGroq(
  audio: Blob,
  options: { language: "ur" | "en"; prompt?: string; signal?: AbortSignal } = {
    language: "ur",
  },
): Promise<TranscribeResult> {
  // The clip is judged before the configuration is: an empty or oversized
  // recording is wrong whatever the server is set up with, and saying "not
  // configured" when the real problem is a zero-byte clip sends you looking in
  // the wrong place entirely.
  if (audio.size === 0) {
    return { ok: false, reason: "No audio was recorded.", retryable: true };
  }
  if (audio.size < MIN_BYTES) {
    return {
      ok: false,
      reason: "That recording was too short to make out. Speak for a second or two longer.",
      retryable: true,
    };
  }
  if (audio.size > MAX_BYTES) {
    return {
      ok: false,
      reason: "That recording is too long. Keep a command under about 30 seconds.",
      retryable: false,
    };
  }
  // An empty type comes from some browsers; only an explicitly wrong one is
  // rejected, since Whisper sniffs the container itself.
  if (audio.type && !ALLOWED_TYPES.has(audio.type)) {
    return { ok: false, reason: `Unsupported audio format (${audio.type}).`, retryable: false };
  }

  const { baseUrl, model, key } = sttConfig();
  if (!groqConfigured()) {
    return {
      ok: false,
      reason: "No transcription service is configured on the server.",
      retryable: false,
    };
  }

  const form = new FormData();
  // The extension matters: Groq infers the container from the filename.
  const extension = audio.type.includes("ogg")
    ? "ogg"
    : audio.type.includes("mp4")
      ? "m4a"
      : "webm";
  form.append("file", audio, `command.${extension}`);
  form.append("model", model);
  form.append("language", options.language);
  form.append("response_format", "json");
  // Zero temperature: a command is not creative writing, and a deterministic
  // transcript is what makes a misheard word reproducible enough to fix.
  form.append("temperature", "0");
  if (options.prompt) form.append("prompt", options.prompt);

  let response: Response;
  try {
    response = await fetch(`${baseUrl}/audio/transcriptions`, {
      method: "POST",
      // A local server needs no credentials, and sending an empty bearer token
      // makes some of them reject the request outright.
      headers: key.length > 0 ? { Authorization: `Bearer ${key}` } : undefined,
      body: form,
      signal: options.signal,
    });
  } catch (error) {
    console.error("groq transcribe: network failure", error);
    return {
      ok: false,
      reason: "Could not reach the speech service. Check the internet connection.",
      retryable: true,
    };
  }

  if (response.status === 401 || response.status === 403) {
    // Deliberately not echoing the response body: it can contain the key.
    console.error("groq transcribe: auth rejected", response.status);
    return {
      ok: false,
      reason: "The speech service rejected the API key. It may have been revoked.",
      retryable: false,
    };
  }
  if (response.status === 429) {
    return {
      ok: false,
      reason:
        "The free speech quota is exhausted for now. Try again shortly, or switch to the browser engine.",
      retryable: true,
    };
  }
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    const detail = readServiceError(body);
    console.error("groq transcribe: http", response.status, detail ?? body.slice(0, 200));
    return {
      ok: false,
      reason: detail
        ? `The speech service refused that recording: ${detail}`
        : `The speech service returned an error (${response.status}).`,
      retryable: response.status >= 500,
    };
  }

  let text: string;
  try {
    const body = (await response.json()) as { text?: unknown };
    text = typeof body.text === "string" ? body.text.trim() : "";
  } catch {
    return { ok: false, reason: "The speech service sent an unreadable reply.", retryable: true };
  }

  if (text.length === 0) {
    return { ok: false, reason: "Nothing was heard in that recording.", retryable: true };
  }
  if (isHallucination(text)) {
    return {
      ok: false,
      reason: "Nothing recognisable was heard - try again, speaking a little longer.",
      retryable: true,
    };
  }
  if (!looksUsable(text)) {
    return {
      ok: false,
      reason: `That came back as "${text}", which is not Urdu or English. Try again, or switch to the browser engine.`,
      retryable: true,
    };
  }
  return { ok: true, text, model };
}
