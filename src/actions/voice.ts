"use server";

import { answerQuery, getVoiceCatalog, type VoiceAnswer } from "@/lib/voice/answer";
import { parseCommand, type VoiceCommand } from "@/lib/voice/parse";
import { interpretWithLlm, llmConfigured, llmProvider } from "@/lib/voice/llm";
import { buildPrompt, groqConfigured, transcribeWithGroq } from "@/lib/voice/transcribe";
import { speechVocabulary } from "@/lib/voice/names";
import { enrich } from "@/lib/voice/enrich";
import { logVoiceAttempt, markVoiceAttemptSaved } from "@/lib/voice/log";

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
  /**
   * The row this attempt was logged as, so saving it can be attributed back.
   *
   * Null when the log could not be written, which must never stop a command.
   */
  attemptId: number | null;
};

/**
 * Turn a sentence into a command: the model when it is available, the rules
 * when it is not.
 *
 * The model goes first because every failure this feature has had came from the
 * rules' blind spots - an Urdu spelling nobody listed, a word order nobody
 * anticipated, a shop name the transcriber mangled. The rules stay as the
 * fallback rather than being deleted: they are free, instant, work with no
 * network, and have hundreds of tests behind them, so an expired key or a rate
 * limit degrades the feature instead of breaking it.
 */
async function understand(
  /** One reading of the recording, or several of the same one. */
  transcript: string | string[],
  catalog: Awaited<ReturnType<typeof getVoiceCatalog>>,
): Promise<VoiceCommand> {
  const readings = (Array.isArray(transcript) ? transcript : [transcript]).filter(
    (t) => t.trim().length > 0,
  );

  if (llmConfigured()) {
    const outcome = await interpretWithLlm(readings, catalog);
    if (outcome.ok) return enrich(outcome.command);
    // Worth a log: silently falling back hides an expired key for weeks.
    console.error("voice: falling back to the rule parser -", outcome.reason);
  }

  // The rules read one sentence at a time and cannot weigh two against each
  // other, so they get each in turn and the first that means something wins.
  for (const reading of readings) {
    const parsed = parseCommand(reading, catalog);
    if (parsed.kind !== "unknown") return enrich(parsed);
  }
  return enrich(parseCommand(readings[0] ?? "", catalog));
}

export async function interpretVoiceAction(transcript: string): Promise<VoiceResult> {
  const said = transcript.trim().slice(0, 400);
  if (said.length === 0) {
    return {
      transcript: "",
      command: { kind: "unknown", reason: "Nothing was heard." },
      answer: null,
      summary: "Nothing was heard.",
      attemptId: null,
    };
  }

  const catalog = await getVoiceCatalog();
  const command = await understand(said, catalog);

  // Typed or spoken through the browser engine, the text arrived without
  // Whisper - so there is no confidence figure to record.
  const attemptId = await logVoiceAttempt({
    transcript: said,
    engine: "browser",
    language: "unknown",
    kind: command.kind,
    model: llmConfigured() ? llmProvider() : "rules",
  });

  if (command.kind === "query") {
    const answer = await answerQuery(command);
    return { transcript: said, command, answer, summary: answer.speech, attemptId };
  }

  return { transcript: said, command, answer: null, summary: describe(command), attemptId };
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
    case "area":
      return command.name
        ? `Add the area "${command.name}".`
        : "A new area, but the name is missing.";
    case "category":
      return `Add the category "${command.name}".`;
    case "booker":
      return `Add the booker "${command.name}".`;
    case "product":
      return command.missing.length === 0
        ? `Add the product "${command.name}" ${command.packagingType} ${command.variantValue} at ${command.salePrice}.`
        : `A new product, but ${command.missing.join(" and ")} is missing.`;
    case "price":
      return command.newPrice == null
        ? `Change the price of ${command.label}, but to what?`
        : `Change ${command.label} from ${command.oldPrice} to ${command.newPrice}.`;
    case "rename":
      return `Rename the ${command.target} "${command.oldName}" to "${command.newName}".`;
    case "toggle":
      return `${command.wanted ? "Activate" : "Deactivate"} ${command.label}.`;
    case "assign":
      return `Give ${command.bookerName} ${command.addedNames.join(" and ")} to cover.`;
    case "open":
      return `Open ${command.label}.`;
    case "query":
      return "A question.";
    case "unknown":
      return command.reason;
  }
}

/** Whether the better engine is available, so the UI can offer it or not. */
/**
 * Record that a proposal was saved.
 *
 * Called after the write succeeds rather than when the button is pressed: a
 * proposal the server rejected is not evidence that it was understood right.
 */
export async function markVoiceAttemptSavedAction(id: number): Promise<void> {
  await markVoiceAttemptSaved(id);
}

export async function voiceEnginesAvailable(): Promise<{
  groq: boolean;
  llm: boolean;
  llmProvider: "anthropic" | "openai-compatible" | "none";
}> {
  return { groq: groqConfigured(), llm: llmConfigured(), llmProvider: llmProvider() };
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
  // Which microphone settings recorded this. Carried in the engine field
  // rather than a new column: "engine" already means "the thing that heard
  // it", and a Clean/Raw switch nobody can measure is a switch nobody should
  // trust - this was the cheapest way to make the comparison possible.
  const captureRaw = String(formData.get("capture") ?? "");
  const capture = captureRaw === "raw" ? "raw" : "clean";
  const language: "ur" | "en" = langRaw === "en" ? "en" : "ur";

  // Fetched before transcribing: the names go to Whisper as context, which is
  // what lets it produce "Rakshani bazar" instead of something phonetic.
  const catalog = await getVoiceCatalog();
  // What Whisper is told to listen for. The order and the shortening both
  // live in names.ts - see there for why a derived word beats a full name in a
  // budget this small.
  const prompt = buildPrompt(speechVocabulary(catalog));

  // Two passes, and only when the first one fails to mean anything.
  //
  // Whisper has to be told which language to expect, and on a three-word
  // code-switched command that choice is often wrong: "bookings kholo" told to
  // expect Urdu comes back as mangled Roman. So the chosen language is tried
  // first, and if the result parses to nothing, the other one is tried before
  // giving up. The second call only happens on failure, so the normal path
  // stays one round trip.
  /**
   * Heard twice, on purpose, and both readings are kept.
   *
   * Whisper has to be told which language to expect, and on a short
   * code-switched command that choice changes the answer completely: the same
   * sentence comes back as Roman one way and Urdu script the other, mangled in
   * different places. It used to try the chosen language, check whether
   * anything could be made of it, and only then try the other - two round
   * trips end to end, and the loser thrown away.
   *
   * Both now run at once, so this is no slower than one, and both are handed
   * to the interpreter together. That is the trade worth making: transcribing
   * spends a request against an allowance of two thousand a day that this app
   * barely touches, while interpreting spends tokens against one that runs
   * out - and two bad readings of the same sentence are often enough between
   * them, because they are mangled in different places.
   */
  const other: "ur" | "en" = language === "ur" ? "en" : "ur";
  const [chosen, alternate] = await Promise.all([
    transcribeWithGroq(audio, { language, prompt }),
    transcribeWithGroq(audio, { language: other, prompt }),
  ]);

  // Both refused means the recording itself was the problem - no speech, a
  // rejected key, no quota - and that is what to report.
  if (!chosen.ok && !alternate.ok) {
    return { ok: false, reason: chosen.reason, retryable: chosen.retryable };
  }

  // Narrowed once and reused: a ternary over the two leaves TypeScript with
  // the union, and the model name and confidence live only on the ok side.
  const heard = [chosen, alternate].filter((r): r is Extract<typeof r, { ok: true }> => r.ok);
  const readings = heard.map((r) => r.text.slice(0, 400)).filter((text) => text.length > 0);

  if (readings.length === 0) {
    return { ok: false, reason: "Nothing recognisable was heard.", retryable: true };
  }

  const transcribed = heard[0]!;
  const command = await understand(readings, catalog);

  // What to show in the box: the reading in the script the person chose, since
  // that is the one they can read and correct.
  const said = (chosen.ok ? chosen.text : alternate.ok ? alternate.text : "").slice(0, 400);

  const attemptId = await logVoiceAttempt({
    // Every reading, not just the one on screen. Two manglings of the same
    // sentence side by side are what make it obvious where hearing failed.
    transcript: readings.length > 1 ? readings.join("  |  ") : (readings[0] ?? said),
    engine: `whisper:${capture}`,
    language,
    kind: command.kind,
    model: transcribed.model,
    noSpeechProb: transcribed.noSpeechProb,
  });

  if (command.kind === "query") {
    const answer = await answerQuery(command);
    return {
      ok: true,
      model: transcribed.model,
      result: { transcript: said, command, answer, summary: answer.speech, attemptId },
    };
  }

  return {
    ok: true,
    model: transcribed.model,
    result: { transcript: said, command, answer: null, summary: describe(command), attemptId },
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
