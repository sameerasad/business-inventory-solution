/**
 * A record of what was said, and what came of it.
 *
 * Everything done to improve the hearing half so far was measured against
 * synthesised speech and one screenshot, because that is all there was. This
 * exists so the next decision - whether to pay for a microphone setup, an Urdu
 * model, a different prompt - can be made on what actually happens in the shop.
 *
 * Two fields carry most of the value:
 *
 *  - the transcript beside the kind it was understood as, which says WHERE a
 *    command failed. A shop name mangled into noise is a hearing problem; a
 *    clean transcript read as the wrong kind is an understanding problem, and
 *    they have nothing in common.
 *  - `saved`, which is the only honest verdict available. Nobody grades their
 *    own voice assistant, but a proposal that was abandoned was usually wrong,
 *    and one that was saved was usually right.
 *
 * Logging must never be the reason a command fails, so every call here
 * swallows its own errors.
 */
import { prisma } from "@/lib/db";

export type VoiceAttemptRecord = {
  transcript: string;
  engine: "whisper" | "browser";
  language: string;
  kind: string;
  model?: string | null;
  noSpeechProb?: number | null;
};

/** Returns the row id, so a later save can be attributed to it. */
export async function logVoiceAttempt(record: VoiceAttemptRecord): Promise<number | null> {
  try {
    const row = await prisma.voiceAttempt.create({
      data: {
        // Capped: a transcript is one spoken sentence, and anything much
        // longer is a runaway recording rather than a command.
        transcript: record.transcript.slice(0, 500),
        engine: record.engine,
        language: record.language,
        kind: record.kind,
        model: record.model ?? null,
        noSpeechProb: record.noSpeechProb ?? null,
      },
      select: { id: true },
    });
    return row.id;
  } catch (error) {
    console.error("voice log: could not record the attempt", error);
    return null;
  }
}

/**
 * Mark an attempt as having been saved.
 *
 * Called after the write succeeds, not when the button is pressed: a proposal
 * the server rejected is not evidence that it was understood correctly.
 */
export async function markVoiceAttemptSaved(id: number): Promise<void> {
  try {
    await prisma.voiceAttempt.update({ where: { id }, data: { saved: true } });
  } catch (error) {
    console.error("voice log: could not mark the attempt saved", error);
  }
}
