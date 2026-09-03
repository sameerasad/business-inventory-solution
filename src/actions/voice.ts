"use server";

import { answerQuery, getVoiceCatalog, type VoiceAnswer } from "@/lib/voice/answer";
import { parseCommand, type VoiceCommand } from "@/lib/voice/parse";
import { buildPrompt, groqConfigured, transcribeWithGroq } from "@/lib/voice/transcribe";

/**
 * Interpret a spoken command.
 *
 * This action NEVER writes. It reads the catalog, works out what was meant, and
 * hands back a proposal. Navigation and questions are safe for the client to act
 * on straight away because nothing changes; a booking or a payment comes back as
 * a filled form that a person still has to confirm through the normal action,
 * with the normal validation.
 *
 * That split is the whole safety model. Speech recognition confuses 15 and 50,
 * and this app moves stock and money.
 */
export type VoiceResult = {
  transcript: string;
  command: VoiceCommand;
  /** Present only for questions. */
  answer: VoiceAnswer | null;
  /** One line describing what will happen, for the confirmation card. */
  summary: string;
};

export async function interpretVoiceAction(transcript: string): Promise<VoiceResult> {
  const said = transcript.trim().slice(0, 400);
  if (said.length === 0) {
    return {
      transcript: "",
      command: { kind: "unknown", reason: "Nothing was heard." },
      answer: null,
      summary: "Nothing was heard.",
    };
  }

  const catalog = await getVoiceCatalog();
  const command = parseCommand(said, catalog);

  if (command.kind === "query") {
    const answer = await answerQuery(command);
    return { transcript: said, command, answer, summary: answer.speech };
  }

  return { transcript: said, command, answer: null, summary: describe(command) };
}

function describe(command: VoiceCommand): string {
  switch (command.kind) {
    case "navigate":
      return `Open ${command.label}.`;
    case "booking": {
      const line = command.lines[0];
      const where = command.shopName ?? command.areaName ?? "an area not yet chosen";
      return line
        ? `Book ${line.quantity} x ${line.label} at ${line.unitPrice} for ${where} on ${command.date}.`
        : "An order, but no product was recognised.";
    }
    case "payment":
      return command.invoiceNo && command.amount != null
        ? `Record ${command.amount} received against ${command.invoiceNo} on ${command.date}.`
        : "A payment, but the invoice or the amount is missing.";
    case "batch":
      return command.unitCost != null
        ? `Receive ${command.quantity} x ${command.label} at cost ${command.unitCost} on ${command.date}.`
        : "Stock arriving, but the unit cost is missing.";
    case "sale":
      return `Cash sale of ${command.quantity} x ${command.label} at ${command.unitPrice} on ${command.date}.`;
    case "shop":
      return command.name && command.areaName
        ? `Add the shop "${command.name}" in ${command.areaName}.`
        : "A new shop, but the name or the area is missing.";
    case "query":
      return "A question.";
    case "unknown":
      return command.reason;
  }
}

/** Whether the better engine is available, so the UI can offer it or not. */
export async function voiceEnginesAvailable(): Promise<{ groq: boolean }> {
  return { groq: groqConfigured() };
}

export type TranscribeAndInterpret =
  | { ok: true; result: VoiceResult; model: string }
  | { ok: false; reason: string; retryable: boolean };

/**
 * The Groq path: audio in, understood command out.
 *
 * Transcription and interpretation happen in one round trip on purpose. The
 * alternative - transcribe, return, then interpret - doubles the latency for no
 * benefit, and the catalog is needed on the server for both halves anyway: once
 * as Whisper's vocabulary prompt, and again to resolve the names it produced.
 *
 * Still writes nothing. It returns the same proposal the browser engine
 * produces, and a human still confirms anything that touches stock or money.
 */
export async function transcribeAndInterpretAction(
  formData: FormData,
): Promise<TranscribeAndInterpret> {
  if (!groqConfigured()) {
    return { ok: false, reason: "Groq is not configured on the server.", retryable: false };
  }

  const audio = formData.get("audio");
  if (!(audio instanceof Blob)) {
    return { ok: false, reason: "No audio was received.", retryable: false };
  }
  const langRaw = String(formData.get("language") ?? "ur");
  const language: "ur" | "en" = langRaw === "en" ? "en" : "ur";

  // Fetched before transcribing: the names go to Whisper as context, which is
  // what lets it produce "Rakshani bazar" instead of something phonetic.
  const catalog = await getVoiceCatalog();
  const vocabulary = [
    ...catalog.shops.flatMap((sh) => [sh.name, sh.voiceAlias ?? ""]),
    ...catalog.areas.flatMap((ar) => [ar.name, ar.voiceAlias ?? ""]),
    ...catalog.bookers.flatMap((b) => [b.name, b.voiceAlias ?? ""]),
    ...catalog.products.map((p) => p.name),
  ];

  const prompt = buildPrompt(vocabulary);

  // Two passes, and only when the first one fails to mean anything.
  //
  // Whisper has to be told which language to expect, and on a three-word
  // code-switched command that choice is often wrong: "bookings kholo" told to
  // expect Urdu comes back as mangled Roman. So the chosen language is tried
  // first, and if the result parses to nothing, the other one is tried before
  // giving up. The second call only happens on failure, so the normal path
  // stays one round trip.
  const other: "ur" | "en" = language === "ur" ? "en" : "ur";
  let transcribed = await transcribeWithGroq(audio, { language, prompt });
  let said = transcribed.ok ? transcribed.text.slice(0, 400) : "";
  let command = transcribed.ok ? parseCommand(said, catalog) : null;

  if (!transcribed.ok || command?.kind === "unknown") {
    const retry = await transcribeWithGroq(audio, { language: other, prompt });
    if (retry.ok) {
      const retrySaid = retry.text.slice(0, 400);
      const retryCommand = parseCommand(retrySaid, catalog);
      // Only prefer the retry if it actually understood something - otherwise
      // the first transcript is the more honest thing to show.
      if (retryCommand.kind !== "unknown" || !transcribed.ok) {
        transcribed = retry;
        said = retrySaid;
        command = retryCommand;
      }
    }
  }

  if (!transcribed.ok || command == null) {
    const reason = transcribed.ok ? "Nothing recognisable was heard." : transcribed.reason;
    const retryable = transcribed.ok ? true : transcribed.retryable;
    return { ok: false, reason, retryable };
  }

  if (command.kind === "query") {
    const answer = await answerQuery(command);
    return {
      ok: true,
      model: transcribed.model,
      result: { transcript: said, command, answer, summary: answer.speech },
    };
  }

  return {
    ok: true,
    model: transcribed.model,
    result: { transcript: said, command, answer: null, summary: describe(command) },
  };
}

/**
 * Transcription with no interpretation.
 *
 * The guided form needs the raw words: it already knows which field it asked
 * for, so it parses the answer itself against a catalog it was given as props.
 * Interpreting here as well would be the wrong question answered twice.
 */
export async function transcribeOnlyAction(
  formData: FormData,
): Promise<{ ok: true; text: string } | { ok: false; reason: string }> {
  if (!groqConfigured()) {
    return { ok: false, reason: "Groq is not configured on the server." };
  }
  const audio = formData.get("audio");
  if (!(audio instanceof Blob)) return { ok: false, reason: "No audio was received." };
  const language = String(formData.get("language") ?? "ur") === "en" ? "en" : "ur";

  // The same catalog vocabulary, because a field answer is exactly where a
  // shop or product name shows up.
  const catalog = await getVoiceCatalog();
  const vocabulary = [
    ...catalog.shops.flatMap((sh) => [sh.name, sh.voiceAlias ?? ""]),
    ...catalog.areas.flatMap((ar) => [ar.name, ar.voiceAlias ?? ""]),
    ...catalog.bookers.flatMap((b) => [b.name, b.voiceAlias ?? ""]),
    ...catalog.products.map((p) => p.name),
  ];

  const result = await transcribeWithGroq(audio, {
    language,
    prompt: buildPrompt(vocabulary),
  });
  return result.ok ? { ok: true, text: result.text } : { ok: false, reason: result.reason };
}
