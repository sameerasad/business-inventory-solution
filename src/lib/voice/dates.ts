/**
 * Reading a date out of something spoken.
 *
 * Salvaged from the guided flow that was removed: the date handling was the one
 * part of it worth keeping, because the whole-sentence parser only understood
 * "today" and "kal" and refused every other way a date is actually said.
 *
 * The one rule that shapes this: a BARE number is never a date. In an open
 * sentence like "bees aam bottle 250 Corner Store ko bech do", the numbers are
 * a quantity and a size - reading one of them as a day would silently date the
 * order wrongly, which is far worse than not understanding it. So a date has to
 * announce itself: a day word, a month name, or digits with a separator between
 * them.
 */

import { asciiDigits, readNumber, tokenise } from "@/lib/voice/normalise";
import { DAY_OFFSETS } from "@/lib/voice/lexicon";

/** Month names as they are said, in both languages. */
const MONTHS: Record<string, number> = {
  january: 1,
  jan: 1,
  february: 2,
  feb: 2,
  march: 3,
  mar: 3,
  april: 4,
  apr: 4,
  may: 5,
  june: 6,
  jun: 6,
  july: 7,
  jul: 7,
  august: 8,
  aug: 8,
  september: 9,
  sept: 9,
  sep: 9,
  october: 10,
  oct: 10,
  november: 11,
  nov: 11,
  december: 12,
  dec: 12,
  janwari: 1,
  farwari: 2,
  aprail: 4,
  joon: 6,
  julai: 7,
  agast: 8,
  sitambar: 9,
  aktobar: 10,
  navambar: 11,
  disambar: 12,
  جنوری: 1,
  فروری: 2,
  مارچ: 3,
  اپریل: 4,
  مئی: 5,
  جون: 6,
  جولائی: 7,
  اگست: 8,
  ستمبر: 9,
  اکتوبر: 10,
  نومبر: 11,
  دسمبر: 12,
};

/** A real calendar date, or nothing. Never rolls the 31st into the next month. */
function iso(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return d.toISOString().slice(0, 10);
}

function offsetFromToday(days: number, today: Date): string {
  const d = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + days),
  );
  return d.toISOString().slice(0, 10);
}

export type SpokenDate = { date: string; explicit: boolean };

/**
 * The date in an utterance, if it announces itself as one.
 *
 * `explicit` says whether a date was actually found, so the caller can tell the
 * difference between "they said today" and "they said nothing, so today is
 * assumed" - a distinction that belongs on the confirmation card.
 */
export function readSpokenDate(transcript: string, today = new Date()): SpokenDate | null {
  const tokens = tokenise(transcript);

  // 1. Day words. Unambiguous, and by far the commonest thing people say.
  for (const token of tokens) {
    const offset = DAY_OFFSETS[token];
    if (offset != null) return { date: offsetFromToday(offset, today), explicit: true };
  }

  // 2. A full ISO date, checked against the RAW text.
  //
  // normalise() turns hyphens into spaces - it must, so "twenty-five" reads as
  // a number - so by the time this sees tokens, "2026-08-15" is already three
  // of them. The original string is the only place the pattern survives.
  const isoMatch = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(transcript);
  if (isoMatch) {
    const found = iso(
      Number.parseInt(isoMatch[1]!, 10),
      Number.parseInt(isoMatch[2]!, 10),
      Number.parseInt(isoMatch[3]!, 10),
    );
    if (found) return { date: found, explicit: true };
  }

  // 3. Digits with a separator: 15/08/2026, 15.8.26, 15-8-26.
  //
  // The separator is what makes this safe in an open sentence - no quantity or
  // price is ever written with one - so it is required, and read from the raw
  // text where those characters still exist.
  const raw = asciiDigits(transcript);
  const separated = /(\d{1,4})\s*[/.\-]\s*(\d{1,2})(?:\s*[/.\-]\s*(\d{2,4}))?/.exec(raw);
  if (separated) {
    const first = Number.parseInt(separated[1]!, 10);
    const second = Number.parseInt(separated[2]!, 10);
    const thirdRaw = separated[3] ? Number.parseInt(separated[3], 10) : today.getUTCFullYear();
    const year = thirdRaw < 100 ? 2000 + thirdRaw : thirdRaw;
    // A leading four-digit number can only be a year; otherwise day comes
    // first, which is how a date is both written and said here.
    const found =
      separated[1]!.length === 4
        ? iso(first, second, thirdRaw)
        : (iso(year, second, first) ?? iso(year, first, second));
    if (found) return { date: found, explicit: true };
  }

  // 4. A month by name, with a day: "3 September", "September 3", "1 ستمبر".
  //    Also unambiguous - a month name cannot be mistaken for anything else.
  const monthIndex = tokens.findIndex((t) => MONTHS[t] != null);
  if (monthIndex >= 0) {
    const month = MONTHS[tokens[monthIndex]!]!;
    const yearToken = tokens.find((t) => /^\d{4}$/.test(t));
    const year = yearToken ? Number.parseInt(yearToken, 10) : today.getUTCFullYear();

    // The day has to sit NEXT TO the month, not merely somewhere in the
    // sentence. "sell 20 mango bottle 250 to Corner Store on 15 august" holds
    // three numbers, and taking the first gave the 20th of August - a quantity
    // wearing a date's clothes.
    const day = [monthIndex - 1, monthIndex + 1]
      .map((at) => {
        const token = tokens[at];
        if (token == null) return null;
        if (/^\d{1,2}$/.test(token)) return Number.parseInt(token, 10);
        // A day said as a word: "teen September", "September paanch".
        const spoken = readNumber(tokens, at, false);
        return spoken && spoken.end === at + 1 ? spoken.value : null;
      })
      .find((value) => value != null && value >= 1 && value <= 31);

    if (day != null) {
      const found = iso(year, month, day);
      if (found) return { date: found, explicit: true };
    }
  }

  return null;
}

/** The date in an utterance, or today when none was said. */
export function readDateOrToday(transcript: string, today = new Date()): SpokenDate {
  return readSpokenDate(transcript, today) ?? { date: offsetFromToday(0, today), explicit: false };
}
