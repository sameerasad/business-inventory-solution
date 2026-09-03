"use server";

import { answerQuery, getVoiceCatalog, type VoiceAnswer } from "@/lib/voice/answer";
import { parseCommand, type VoiceCommand } from "@/lib/voice/parse";

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
    case "query":
      return "A question.";
    case "unknown":
      return command.reason;
  }
}
