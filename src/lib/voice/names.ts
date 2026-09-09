/**
 * The short name a person actually says.
 *
 * Whisper is told which proper nouns to expect, and that list is deliberately
 * short - a long one makes it invent names instead of transcribing. Full shop
 * names spend the whole budget: measured on this catalog, eight of twenty-three
 * fit, all of them alphabetically early, so a shop whose name starts with an S
 * was never offered at all. Nobody says "Saleem General Store" anyway; they say
 * "saleem".
 *
 * So the distinctive word is derived here rather than typed in. Nothing is
 * stored: it is computed each time the prompt is built, which means it covers
 * shops that already exist rather than only new ones, and a renamed shop cannot
 * be left with a stale alias.
 *
 * This shapes what WHISPER is told to listen for. The model that interprets the
 * sentence always sees full names, so nothing here narrows what can be matched -
 * it only improves the chance the name survives being heard.
 */

/**
 * Words that say what KIND of business it is, not which one.
 *
 * Half the shops in this trade are something Store or something Kiryana, so
 * these are exactly the words that are useless for telling them apart - and
 * they are what fills the prompt.
 */
const GENERIC = new Set([
  "general",
  "store",
  "stores",
  "shop",
  "kiryana",
  "karyana",
  "medical",
  "medicos",
  "pharmacy",
  "bakery",
  "dairy",
  "bazar",
  "bazaar",
  "market",
  "mart",
  "trader",
  "traders",
  "trading",
  "whole",
  "wholesale",
  "centre",
  "center",
  "point",
  "corner",
  "cabin",
  "and",
  "the",
  "sons",
  "brothers",
  "bros",
  "co",
  "company",
  // Product words, for the same reason. Whisper knows "juice" and "bottle"
  // perfectly well without being told; what it needs from this list is
  // "lychee" and "anaar". "Pomegranate Juice" spent seventeen characters to
  // teach it one word it did not know.
  "juice",
  "water",
  "drink",
  "bottle",
  "pack",
  "tetra",
  "bar",
]);

/**
 * The one word from a name most likely to be said out loud.
 *
 * Falls back to the whole name when every word is generic - "General Store" has
 * nothing distinctive in it, and dropping it from the prompt entirely would be
 * worse than listing a word that does not narrow anything.
 *
 * Non-Latin names come back unchanged: there is nothing to strip, and Whisper
 * is helped as much by the Urdu spelling as by a Latin one.
 */
export function distinctiveName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "";
  if (!/[a-z]/i.test(trimmed)) return trimmed;

  const words = trimmed
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  // Two characters, not three: "5G new Karachi" would otherwise lose the 5G
  // that is the whole of its name.
  const kept = words.filter((w) => !GENERIC.has(w) && w.length >= 2);
  return kept[0] ?? trimmed.toLowerCase();
}

/**
 * The vocabulary for Whisper, in the order it should spend its budget.
 *
 * Flavours first: there are six of them, they are short, and one is needed in
 * almost every sentence about an order. Then the aliases somebody deliberately
 * set, because a deliberate answer beats a derived one. Then the derived names.
 * Full names last, for whatever room is left.
 *
 * Duplicates collapse, and a collision is harmless: two shops beginning "Ali"
 * both contribute "ali", which is all Whisper needs to hear it correctly -
 * working out WHICH Ali is the interpreting model's job, and it sees both.
 */
export function speechVocabulary(catalog: {
  products: { name: string }[];
  areas: { name: string; voiceAlias: string | null }[];
  shops: { name: string; voiceAlias: string | null }[];
  bookers: { name: string; voiceAlias: string | null }[];
}): string[] {
  const named = [...catalog.shops, ...catalog.areas, ...catalog.bookers];

  return [
    ...new Set(catalog.products.map((p) => distinctiveName(p.name))),
    ...named.map((n) => n.voiceAlias ?? "").filter((a) => a.trim().length > 0),
    ...named.map((n) => distinctiveName(n.name)),
    ...named.map((n) => n.name),
  ].filter((word) => word.trim().length > 0);
}
