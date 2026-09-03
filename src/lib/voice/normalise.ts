/**
 * Turning what was heard into something matchable.
 *
 * Speech recognition output is messy in specific, repeatable ways: stray
 * punctuation, digits in either script, "twenty-five" hyphenated, and the same
 * word spelled three ways depending on accent. Everything here is pure string
 * work so it can be tested exhaustively without a microphone.
 */

import {
  AMBIGUOUS_NUMBER_WORDS,
  DIGIT_MAP,
  ENGLISH_TENS,
  PHRASES,
  NUMBER_JOINERS,
  NUMBER_MULTIPLIERS,
  NUMBER_WORDS,
  PRODUCT_ALIASES,
  STOP_WORDS,
} from "@/lib/voice/lexicon";

/** Urdu-Arabic digits to ASCII, so one number parser serves both scripts. */
export function asciiDigits(text: string): string {
  return text.replace(/[۰-۹٠-٩]/g, (d) => DIGIT_MAP[d] ?? d);
}

/**
 * Lowercase, strip punctuation, split hyphenated numbers, collapse whitespace.
 *
 * Urdu script is left intact: it has no case, and its letters must survive for
 * the lexicon to match them.
 */
export function normalise(text: string): string {
  let out = asciiDigits(text)
    .toLowerCase()
    .replace(/[.,!?;:"'()\[\]]/g, " ")
    .replace(/[-–—]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  // Multi-word markers become single tokens before stop words can eat half of
  // them. Applied last so the text is already lowercased and de-punctuated.
  for (const [pattern, replacement] of PHRASES) out = out.replace(pattern, replacement);
  return out.replace(/\s+/g, " ").trim();
}

export function tokenise(text: string): string[] {
  const clean = normalise(text);
  return clean.length === 0 ? [] : clean.split(" ");
}

/** Drops filler words, but never a word that might be a number or a unit. */
export function meaningfulTokens(tokens: string[]): string[] {
  return tokens.filter((t) => !STOP_WORDS.has(t) || AMBIGUOUS_NUMBER_WORDS.has(t));
}

/* -------------------------------------------------------------------- numbers */

export type NumberMatch = {
  value: number;
  /** Index of the first token consumed. */
  start: number;
  /** Index after the last token consumed. */
  end: number;
};

/**
 * Reads a number starting at `from`, in digits or words, in either language.
 *
 * Handles the additive-then-multiplicative shape both languages share:
 * "ek sau bees" and "one hundred twenty" are both 120, "do hazar paanch sau" is
 * 2500. A multiplier with nothing before it means one of it, so "sau" alone is
 * 100 rather than 0.
 *
 * `allowAmbiguous` decides whether "do" counts as the number 2 or as the filler
 * in "bech do". Only the caller knows whether a quantity is expected here, so
 * only the caller can answer that.
 */
export function readNumber(
  tokens: string[],
  from: number,
  allowAmbiguous = true,
): NumberMatch | null {
  let index = from;
  let total = 0;
  let current = 0;
  let consumed = false;
  // Both are needed to know whether the next word continues this number:
  // "sau bees" continues (120), "bees paanch" does not (20, then 5).
  let lastWasMultiplier = false;
  let previousWord: string | null = null;

  while (index < tokens.length) {
    const token = tokens[index]!;

    if (/^\d+$/.test(token)) {
      // A bare numeral ends the run: "20 30" is two numbers, not one.
      if (consumed) break;
      current = Number.parseInt(token, 10);
      consumed = true;
      index += 1;
      continue;
    }

    if (NUMBER_JOINERS.has(token) && consumed) {
      index += 1;
      continue;
    }

    const multiplier = NUMBER_MULTIPLIERS[token];
    if (multiplier != null) {
      // "sau" with nothing in front of it means one hundred.
      const base = current === 0 ? 1 : current;
      if (multiplier >= 1000) {
        total = (total + base) * multiplier;
        current = 0;
      } else {
        current = base * multiplier;
      }
      consumed = true;
      lastWasMultiplier = true;
      previousWord = token;
      index += 1;
      continue;
    }

    const word = NUMBER_WORDS[token];
    if (word != null) {
      if (!allowAmbiguous && AMBIGUOUS_NUMBER_WORDS.has(token)) {
        // "do" is the filler in "bech do" and the number 2 in "do hazar". A
        // multiplier straight after it settles which: nobody says "hazar" as
        // filler. Without this, "do hazar mila" reads as 1000.
        const next = tokens[index + 1];
        const followedByScale = next != null && NUMBER_MULTIPLIERS[next] != null;
        if (!followedByScale) break;
      }
      if (current > 0) {
        // Anything smaller continues a hundred or a thousand: "ek sau bees".
        const continuesScale = lastWasMultiplier && word < 100;
        // An English tens word can be completed by a unit: "twenty five".
        const continuesEnglishTens =
          previousWord != null && ENGLISH_TENS.has(previousWord) && word < 10;
        if (!continuesScale && !continuesEnglishTens) break;
      }
      current += word;
      consumed = true;
      lastWasMultiplier = false;
      previousWord = token;
      index += 1;
      continue;
    }

    break;
  }

  if (!consumed) return null;
  return { value: total + current, start: from, end: index };
}

/** Every number in the utterance, left to right, without overlaps. */
export function allNumbers(tokens: string[], allowAmbiguous = true): NumberMatch[] {
  const found: NumberMatch[] = [];
  let i = 0;
  while (i < tokens.length) {
    const match = readNumber(tokens, i, allowAmbiguous);
    if (match && match.end > match.start) {
      found.push(match);
      i = match.end;
    } else {
      i += 1;
    }
  }
  return found;
}

/* --------------------------------------------------------- fuzzy name matching */

/** Levenshtein distance, iterative and allocation-light. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let row = new Array<number>(b.length + 1);

  for (let i = 1; i <= a.length; i += 1) {
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(row[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
    }
    [prev, row] = [row, prev];
  }
  return prev[b.length]!;
}

/** 1 for identical, 0 for nothing in common. */
export function similarity(a: string, b: string): number {
  if (a.length === 0 && b.length === 0) return 1;
  const longest = Math.max(a.length, b.length);
  return 1 - editDistance(a, b) / longest;
}

/** Expands everyday and Urdu words into the words a product name uses. */
export function applyAliases(tokens: string[]): string[] {
  return tokens.map((t) => PRODUCT_ALIASES[t] ?? t);
}

/**
 * How well the spoken words cover a known name.
 *
 * Token-based rather than whole-string: someone says "corner store" for "Corner
 * Store" but also just "corner", and "mango bottle 250" for "Mango Juice
 * Bottle 250ml". Every word of the name that is spoken - exactly, as a prefix,
 * or close enough to be a mishearing - counts towards the score, and words of
 * the name that were not spoken at all do not count against it as harshly,
 * because people abbreviate.
 */
/** How well one word of a name is covered by anything that was said. */
function partHit(said: string[], part: string): number {
  return said.reduce((acc, word) => {
    if (word === part) return 1;
    // A numeric fragment must match exactly: 250 and 500 are different
    // products, and "similar" is precisely the wrong idea there.
    if (/\d/.test(part) || /\d/.test(word)) {
      return Math.max(acc, part.replace(/\D/g, "") === word.replace(/\D/g, "") ? 1 : 0);
    }
    if (part.startsWith(word) && word.length >= 3) return Math.max(acc, 0.9);
    if (word.startsWith(part) && part.length >= 3) return Math.max(acc, 0.9);
    const sim = similarity(word, part);
    return Math.max(acc, sim >= 0.72 ? sim : 0);
  }, 0);
}

export function nameScore(spoken: string[], name: string): number {
  const nameTokens = applyAliases(tokenise(name)).filter((t) => t.length > 1);
  if (nameTokens.length === 0) return 0;

  const said = applyAliases(spoken).filter((t) => t.length > 1);
  if (said.length === 0) return 0;

  let hits = 0;
  for (const part of nameTokens) hits += partHit(said, part);
  return hits / nameTokens.length;
}

/**
 * The strongest single-word match between what was said and a name.
 *
 * Averaging every word of the name is right for a shop ("Corner Store" is said
 * in full) and wrong for a product: nobody says "Mango Juice", they say "mango",
 * which averages to 0.5 and falls below any threshold worth having. What
 * identifies a product is one distinctive word, so that is what this measures.
 */
export function bestTokenHit(spoken: string[], name: string): number {
  const nameTokens = applyAliases(tokenise(name)).filter((t) => t.length > 1);
  const said = applyAliases(spoken).filter((t) => t.length > 1);
  if (nameTokens.length === 0 || said.length === 0) return 0;
  return Math.max(...nameTokens.map((part) => partHit(said, part)));
}
