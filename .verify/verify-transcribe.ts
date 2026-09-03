/**
 * The Whisper transcription layer.
 *
 * Two halves are tested differently. The guards and the vocabulary prompt are
 * pure and checked exhaustively here. The network call is checked against a
 * stub, plus one optional live call - because the only thing that proves an API
 * key works is using it.
 *
 * What is deliberately NOT here: any assertion about transcription accuracy.
 * That depends on a voice, a microphone and a room, and a test that claimed to
 * measure it would be lying.
 */
import fs from "node:fs";
import path from "node:path";

import {
  buildPrompt,
  groqConfigured,
  isHallucination,
  looksUsable,
  readServiceError,
  transcribeWithGroq,
} from "@/lib/voice/transcribe";

/**
 * Next loads .env by itself; a plain tsx run does not.
 *
 * Without this the live check ran with no key, "restored" it to the string
 * "undefined", and then reported the key as rejected - a failure invented
 * entirely by the test.
 */
function loadDotEnv(file = ".env"): void {
  const full = path.join(process.cwd(), file);
  if (!fs.existsSync(full)) return;
  for (const raw of fs.readFileSync(full, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
loadDotEnv();

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
function skip(label: string, why: string) {
  console.log(`  SKIP  ${label} (${why})`);
}
function section(n: string) {
  console.log(`\n=== ${n} ===`);
}

/** A tiny but structurally valid WAV: 0.2s of silence, 8 kHz mono. */
function silentWav(seconds = 0.2): Blob {
  const rate = 8000;
  const samples = Math.floor(rate * seconds);
  const buffer = new ArrayBuffer(44 + samples * 2);
  const view = new DataView(buffer);
  const text = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i));
  };
  text(0, "RIFF");
  view.setUint32(4, 36 + samples * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, samples * 2, true);
  return new Blob([buffer], { type: "audio/wav" });
}

async function main() {
  /* ------------------------------------------------ the vocabulary prompt */
  section("the vocabulary prompt");
  const prompt = buildPrompt(["Rakshani bazar", "Khwaja ajmer nagri", "Anum bakery"]);
  ok("names are included", prompt.includes("Rakshani bazar"), prompt);
  ok("all of them", prompt.includes("Anum bakery") && prompt.includes("Khwaja ajmer nagri"));
  ok("and the context that frames them", prompt.includes("Urdu"), prompt);

  const deduped = buildPrompt(["Anum bakery", "Anum bakery", " Anum bakery "]);
  ok(
    "duplicates and whitespace are collapsed",
    deduped.split("Anum bakery").length - 1 === 1,
    deduped,
  );
  ok("blank entries are dropped", !buildPrompt(["", "   "]).includes(",,"));
  ok(
    "an empty catalog still yields a usable prompt",
    buildPrompt([]).length > 20 && !buildPrompt([]).endsWith(": "),
    buildPrompt([]),
  );
  ok(
    "the prompt asks for a transcript rather than offering a vocabulary",
    buildPrompt(["Anum bakery"]).toLowerCase().includes("only what is said"),
    buildPrompt(["Anum bakery"]),
  );

  // A prompt long enough to bias the transcript towards reciting the list is
  // worse than no prompt, so it has to stop somewhere.
  const many = Array.from({ length: 500 }, (_, i) => `Shop Number ${i} General Store`);
  const capped = buildPrompt(many);
  // Short on purpose: a long list of proper nouns makes Whisper invent names
  // that look like the list, which is what produced "Mokin Tukonu".
  ok("a huge catalog is capped tightly", capped.length < 400, capped.length);
  ok("but still carries the first names", capped.includes("Shop Number 0"), capped.slice(0, 120));

  /* --------------------------------------------------------- input guards */
  section("input guards, before any network call");
  const empty = await transcribeWithGroq(new Blob([], { type: "audio/webm" }), {
    language: "ur",
  });
  ok("an empty clip is refused", !empty.ok, empty);
  ok("and is worth retrying", !empty.ok && empty.retryable);

  const huge = await transcribeWithGroq(
    new Blob([new Uint8Array(9 * 1024 * 1024)], { type: "audio/webm" }),
    { language: "ur" },
  );
  ok("an oversized clip is refused", !huge.ok, huge);
  ok("and is not retryable - it will always be too big", !huge.ok && !huge.retryable);
  ok(
    "the message says what to do",
    !huge.ok && huge.reason.toLowerCase().includes("30 seconds"),
    !huge.ok ? huge.reason : null,
  );

  const wrongType = await transcribeWithGroq(new Blob(["x"], { type: "image/png" }), {
    language: "ur",
  });
  ok("a non-audio type is refused", !wrongType.ok, wrongType);

  /* ---------------------------------------------------- the key never leaks */
  section("the key stays on the server");
  const saved = process.env.GROQ_API_KEY;
  const restore = () => {
    // Assigning undefined would store the STRING "undefined" and make every
    // later call look like a rejected key.
    if (saved === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = saved;
  };
  process.env.GROQ_API_KEY = "";
  ok("no key means not configured", !groqConfigured());
  const unconfigured = await transcribeWithGroq(silentWav(), { language: "ur" });
  ok("and transcription refuses rather than calling out", !unconfigured.ok, unconfigured);
  ok(
    "the refusal never contains a key",
    !unconfigured.ok && !unconfigured.reason.includes("gsk_"),
    unconfigured,
  );
  restore();

  /* ------------------------------------------------- a rejected key is clear */
  section("a rejected key produces a useful message, not a stack trace");
  process.env.GROQ_API_KEY = "gsk_definitely_not_a_real_key_0000000000000000";
  const rejected = await transcribeWithGroq(silentWav(), { language: "ur" });
  if (rejected.ok) {
    ok("a bogus key should not succeed", false, rejected);
  } else {
    ok("refused", true);
    ok(
      "the message mentions the key rather than dumping the response",
      rejected.reason.toLowerCase().includes("key") ||
        rejected.reason.toLowerCase().includes("error"),
      rejected.reason,
    );
    ok("and never echoes the key itself", !rejected.reason.includes("gsk_"), rejected.reason);
  }
  restore();

  /* --------------------------------------------------------- the live check */
  section("the live key");
  if (!groqConfigured()) {
    skip("real call", "GROQ_API_KEY is not set");
  } else if (process.env.SKIP_LIVE_STT === "1") {
    skip("real call", "SKIP_LIVE_STT=1");
  } else {
    // Silence is the point: it proves the key, the endpoint, the model name and
    // the multipart shape are all right, without depending on a recording.
    const live = await transcribeWithGroq(silentWav(1), { language: "en" });
    if (live.ok) {
      ok("the key works and the service answered", true);
      ok("it reports which model ran", live.model.length > 0, live.model);
    } else {
      // A quota refusal is not a broken setup, so it is reported as a skip.
      const quota = live.reason.toLowerCase().includes("quota");
      if (quota) skip("real call", "rate limited right now");
      else if (live.reason.toLowerCase().includes("nothing was heard")) {
        ok("the key works - silence transcribed to nothing, as it should", true);
      } else {
        ok(`the live call failed: ${live.reason}`, false, live);
      }
    }
  }

  /* --------------------------------------------- restricting the output */
  section("only Urdu, English and Roman are accepted");
  for (const good of [
    "bookings kholo",
    "بکنگ کھولو",
    "bees aam bottle 250 Corner Store ko bech do",
    "Rakshani bazar",
    "20 packs",
    // A stray accent is not a different language.
    "café order",
  ]) {
    ok(`"${good}" is usable`, looksUsable(good), good);
  }

  for (const bad of [
    // Whisper does answer in these when it is guessing.
    "बीस आम बोतल",
    "二十个芒果",
    "двадцать",
    "안녕하세요",
    "",
    "   ",
    "123 456",
  ]) {
    ok(`"${bad}" is rejected`, !looksUsable(bad), bad);
  }

  section("known hallucinations are not passed on as commands");
  for (const junk of [
    "Thank you for watching!",
    "thanks for watching",
    "Please subscribe to my channel",
    "Subtitles by the Amara.org community",
  ]) {
    ok(`"${junk}" is caught`, isHallucination(junk), junk);
  }
  for (const real of [
    "bookings kholo",
    "bees aam Corner Store ko bech do",
    "invoice 12 ka paanch hazar aa gaya",
  ]) {
    ok(`"${real}" is not treated as junk`, !isHallucination(real), real);
  }

  /* -------------------------------------------- the service's own reason */
  section("an error from the service is passed on, not swallowed");
  ok(
    "an OpenAI-shaped error is read",
    readServiceError('{"error":{"message":"audio file could not be decoded"}}') ===
      "audio file could not be decoded",
    readServiceError('{"error":{"message":"audio file could not be decoded"}}'),
  );
  ok("a plain-string error is read", readServiceError('{"error":"bad request"}') === "bad request");
  ok(
    "a short non-JSON body is still shown",
    readServiceError("Request Entity Too Large") === "Request Entity Too Large",
  );
  ok("an empty body yields nothing", readServiceError("") === null);
  ok("a huge HTML page is not shown", readServiceError("<html>".repeat(200)) === null);
  // The key travels in a header, never a body - but a message that echoes a
  // request is not worth trusting on that point.
  ok(
    "anything key-shaped is scrubbed before it is shown",
    readServiceError('{"error":{"message":"key gsk_abc123DEF rejected"}}') === "key [key] rejected",
    readServiceError('{"error":{"message":"key gsk_abc123DEF rejected"}}'),
  );

  console.log(`\n${checks - failures}/${checks} transcription checks passed`);
  if (failures > 0) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
