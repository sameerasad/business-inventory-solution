/**
 * Turning a sentence into a command.
 *
 * The output is a *proposal*, never an action. Navigation and questions are
 * safe to act on immediately because they change nothing; anything that writes
 * (a booking, a payment) comes back as a filled form for a human to confirm.
 * Speech recognition mishears 15 as 50 often enough that auto-saving stock
 * movements would be indefensible.
 *
 * Pure functions over a catalog snapshot, so every phrasing below is testable
 * without a microphone or a database.
 */

import {
  BATCH_VERBS,
  COST_WORDS,
  COUNTER_WORDS,
  DAY_OFFSETS,
  DESTINATIONS,
  LINE_SEPARATORS,
  METRIC_WORDS,
  NAVIGATE_VERBS,
  PAYMENT_VERBS,
  PERIOD_WORDS,
  PRICE_WORDS,
  QUERY_VERBS,
  SALE_VERBS,
  UNIT_WORDS,
  type QueryMetric,
  type QueryPeriod,
} from "@/lib/voice/lexicon";
import {
  allNumbers,
  bestTokenHit,
  meaningfulTokens,
  nameScore,
  normalise,
  readNumber,
  tokenise,
} from "@/lib/voice/normalise";

/* --------------------------------------------------------------------- types */

export type VoiceCatalog = {
  products: {
    id: number;
    sku: string;
    name: string;
    packagingType: string;
    variantValue: string;
    defaultSalePrice: number;
    available: number;
    /**
     * The oldest live batch with stock left - the one a counter sale should
     * draw from. Voice must not pick batches: it is a detail nobody says out
     * loud, and FIFO is the same rule a booking already follows.
     */
    frontBatchId: number | null;
  }[];
  areas: { id: number; name: string }[];
  shops: { id: number; name: string; areaId: number }[];
  bookers: { id: number; name: string }[];
  /** Open invoices, so "invoice 12" and "Corner Store ka payment" both resolve. */
  invoices: { id: number; invoiceNo: string; customerName: string | null; balance: number }[];
};

export type Confidence = "high" | "low";

export type VoiceCommand =
  | { kind: "navigate"; href: string; label: string; confidence: Confidence }
  | {
      kind: "query";
      metric: QueryMetric;
      period: QueryPeriod;
      /** Set when the question was about one product ("mango ka stock"). */
      productId: number | null;
      productLabel: string | null;
      /** Set when it was about one shop or invoice ("Corner Store ka balance"). */
      bookingId: number | null;
      shopId: number | null;
      subjectLabel: string | null;
      confidence: Confidence;
    }
  | {
      kind: "booking";
      lines: {
        productId: number;
        sku: string;
        label: string;
        quantity: number;
        unitPrice: number;
      }[];
      areaId: number | null;
      areaName: string | null;
      shopId: number | null;
      shopName: string | null;
      bookerId: number | null;
      bookerName: string | null;
      date: string;
      /** Things the parser could not fill and a human must. */
      missing: string[];
      warnings: string[];
      confidence: Confidence;
    }
  | {
      kind: "payment";
      bookingId: number | null;
      invoiceNo: string | null;
      amount: number | null;
      date: string;
      missing: string[];
      warnings: string[];
      confidence: Confidence;
    }
  | {
      kind: "batch";
      productId: number;
      sku: string;
      label: string;
      quantity: number;
      unitCost: number | null;
      date: string;
      missing: string[];
      warnings: string[];
      confidence: Confidence;
    }
  | {
      kind: "sale";
      productId: number;
      /** Chosen for you, oldest batch first. */
      batchId: number | null;
      sku: string;
      label: string;
      quantity: number;
      unitPrice: number;
      areaId: number | null;
      areaName: string | null;
      shopId: number | null;
      shopName: string | null;
      date: string;
      missing: string[];
      warnings: string[];
      confidence: Confidence;
    }
  | { kind: "unknown"; reason: string };

/* ------------------------------------------------------------------- helpers */

function hasAny(tokens: string[], words: string[]): boolean {
  const set = new Set(words.map((w) => normalise(w)));
  return tokens.some((t) => set.has(t));
}

/** Best fuzzy match over named rows, with the runner-up so ties can be flagged. */
function bestMatch<T>(
  spoken: string[],
  rows: T[],
  name: (row: T) => string,
  threshold = 0.6,
): { row: T; score: number; ambiguous: boolean } | null {
  if (rows.length === 0) return null;
  const scored = rows
    .map((row) => ({ row, score: nameScore(spoken, name(row)) }))
    .sort((a, b) => b.score - a.score);

  const top = scored[0]!;
  if (top.score < threshold) return null;
  const second = scored[1];
  // Two names scoring the same means the utterance did not distinguish them.
  const ambiguous = second != null && top.score - second.score < 0.05;
  return { row: top.row, score: top.score, ambiguous };
}

function isoDate(offsetDays: number, today = new Date()): string {
  const d = new Date(
    Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + offsetDays),
  );
  return d.toISOString().slice(0, 10);
}

/** An explicit date if one was spoken, otherwise today. */
function readDate(tokens: string[], today: Date): { date: string; spoken: boolean } {
  for (const token of tokens) {
    const offset = DAY_OFFSETS[token];
    if (offset != null) return { date: isoDate(offset, today), spoken: true };
  }
  // A full date is rare in speech but trivial to accept when it appears.
  const explicit = tokens.find((t) => /^\d{4}-\d{2}-\d{2}$/.test(t));
  if (explicit) return { date: explicit, spoken: true };
  return { date: isoDate(0, today), spoken: false };
}

/* --------------------------------------------------------------- the parser */

export function parseCommand(
  transcript: string,
  catalog: VoiceCatalog,
  today = new Date(),
): VoiceCommand {
  const raw = tokenise(transcript);
  if (raw.length === 0) return { kind: "unknown", reason: "Nothing was heard." };

  const tokens = meaningfulTokens(raw);
  if (tokens.length === 0) {
    return { kind: "unknown", reason: "Only filler words were heard." };
  }

  const navigating = hasAny(tokens, NAVIGATE_VERBS);
  const destination = matchDestination(tokens);

  // "open new booking" is navigation, even though "booking" also means "record
  // an order" - an explicit go-there verb settles it. Checked first for exactly
  // that reason.
  if (navigating && destination) {
    return {
      kind: "navigate",
      href: destination.href,
      label: destination.label,
      confidence: "high",
    };
  }

  // Questions come before the writes. Several nouns are shared between the two
  // - "order", "sale", "booking" all appear in "kitne order huye" and in "sell
  // twenty mango" - so an explicit asking word next to a figure this app tracks
  // is the strongest signal there is that nothing is being recorded.
  if (hasAny(tokens, QUERY_VERBS) && matchMetric(tokens)) {
    return parseQuery(tokens, catalog);
  }

  // Then the writes, most specific first.
  //
  // Stock coming in is checked before payments because "received" means both
  // "money arrived" and "goods arrived"; a cost word or an arrival verb settles
  // it, and only stock has a cost.
  const soundsLikeStock = hasAny(tokens, BATCH_VERBS) || tokens.some((t) => COST_WORDS.has(t));
  if (soundsLikeStock) {
    const asBatch = parseBatch(tokens, catalog, today);
    // Only accept it if a product was actually recognised - otherwise "purchase"
    // in some other sentence would swallow the whole utterance.
    if (asBatch.kind === "batch") return asBatch;
  }

  // A cash sale before a payment, because "cash" means both "money" and "not on
  // credit" - and "cash bech diye" is unmistakably a sale.
  if (hasAny(tokens, SALE_VERBS) && tokens.some((t) => COUNTER_WORDS.has(t))) {
    return parseCounterSale(tokens, catalog, today);
  }

  if (hasAny(tokens, PAYMENT_VERBS)) return parsePayment(tokens, catalog, today);
  if (hasAny(tokens, SALE_VERBS)) return parseBooking(tokens, catalog, today);
  if (hasAny(tokens, QUERY_VERBS)) return parseQuery(tokens, catalog);

  if (destination) {
    return {
      kind: "navigate",
      href: destination.href,
      label: destination.label,
      // A bare page name with no verb is still almost certainly navigation,
      // but it is flagged so the UI can show what it is about to do.
      confidence: "low",
    };
  }

  // A metric word on its own ("profit?") is a question worth answering.
  const metric = matchMetric(tokens);
  if (metric) return parseQuery(tokens, catalog);

  return {
    kind: "unknown",
    reason: "That did not match a page, a question, an order or a payment.",
  };
}

/**
 * Which product was meant.
 *
 * Scoring the whole name as one string does not work: "Chocolate Bar 10g" is
 * three words and people say "chocolate", which scores 1/3 and falls below any
 * useful threshold - while "mango" would score the same against all five mango
 * products even though it is unambiguous among chocolates.
 *
 * So the two halves are judged separately. The NAME has to match - that is what
 * identifies the thing. The packaging and volume only narrow the field, and a
 * specifier that was never spoken counts neither for nor against. When the
 * spoken words do not separate two products, the result is flagged ambiguous
 * rather than guessed, because 250ml and 500ml are different money.
 */
function matchProduct(
  spoken: string[],
  products: VoiceCatalog["products"],
): { row: VoiceCatalog["products"][number]; ambiguous: boolean } | null {
  const scored = products
    .map((row) => ({
      row,
      // One distinctive word of the name has to land - "mango", "chocolate".
      name: bestTokenHit(spoken, row.name),
      // Counted as hits only: "mango bottle" must not be penalised for leaving
      // the size out, it just does not distinguish the sizes.
      spec:
        (nameScore(spoken, row.packagingType) >= 0.75 ? 1 : 0) +
        (nameScore(spoken, row.variantValue) >= 0.75 ? 1 : 0),
      coverage: nameScore(spoken, row.name),
    }))
    .filter((c) => c.name >= 0.85)
    .sort((a, b) => b.spec - a.spec || b.coverage - a.coverage || b.name - a.name);

  const top = scored[0];
  if (!top) return null;
  const rivals = scored.filter(
    (c) => c.spec === top.spec && Math.abs(c.coverage - top.coverage) < 0.01,
  );
  return { row: top.row, ambiguous: rivals.length > 1 };
}

/* ---------------------------------------------------------------- navigation */

function matchDestination(tokens: string[]): { href: string; label: string } | null {
  const rows = DESTINATIONS.flatMap((d) => d.words.map((w) => ({ dest: d, phrase: w })));
  const match = bestMatch(tokens, rows, (r) => r.phrase, 0.75);
  return match ? { href: match.row.dest.href, label: match.row.dest.label } : null;
}

/* ------------------------------------------------------------------ questions */

function matchMetric(tokens: string[]): QueryMetric | null {
  const rows = METRIC_WORDS.flatMap((m) => m.words.map((w) => ({ metric: m.metric, word: w })));
  const match = bestMatch(tokens, rows, (r) => r.word, 0.8);
  return match ? match.row.metric : null;
}

function matchPeriod(tokens: string[]): QueryPeriod | null {
  const rows = PERIOD_WORDS.flatMap((p) => p.words.map((w) => ({ period: p.period, word: w })));
  const match = bestMatch(tokens, rows, (r) => r.word, 0.85);
  return match ? match.row.period : null;
}

function parseQuery(tokens: string[], catalog: VoiceCatalog): VoiceCommand {
  let metric = matchMetric(tokens);
  if (!metric) {
    return {
      kind: "unknown",
      reason: "That sounded like a question, but not about a figure this app tracks.",
    };
  }

  // "mango ka stock kitna hai" is a different question from "stock kitna hai".
  const product = matchProduct(tokens, catalog.products);
  const shop = bestMatch(tokens, catalog.shops, (x) => x.name, 0.75);
  const invoice = shop
    ? null
    : bestMatch(tokens, catalog.invoices, (i) => i.customerName ?? i.invoiceNo, 0.75);

  // Naming a shop turns any money question into that shop's balance: nobody
  // asks for "the revenue of Corner Store" and means the whole book.
  if ((shop || invoice) && (metric === "outstanding" || metric === "balance")) {
    metric = "balance";
  }

  return {
    kind: "query",
    metric,
    period: matchPeriod(tokens) ?? "month",
    productId: metric === "stock" && product ? product.row.id : null,
    productLabel:
      metric === "stock" && product
        ? `${product.row.name} ${product.row.packagingType} ${product.row.variantValue}`
        : null,
    bookingId: invoice?.row.id ?? null,
    shopId: shop?.row.id ?? null,
    subjectLabel: shop?.row.name ?? invoice?.row.customerName ?? invoice?.row.invoiceNo ?? null,
    confidence: "high",
  };
}

/* ------------------------------------------------------------------- bookings */

/**
 * A spoken order.
 *
 * The shape people use is quantity-then-product, optionally with a price and a
 * place: "bees packs mango bottle 250 Corner Store ko 450 ka". Only one line is
 * parsed - multi-line orders spoken in one breath are far too easy to mishear,
 * and the confirmation form lets lines be added by hand.
 */
/**
 * One order line: a quantity, a product, and optionally a price.
 *
 * Shared by orders, counter sales and stock receipts, because all three are the
 * same spoken shape - a number, a thing, sometimes another number. The only
 * difference is what the second number means, which is why `priceRole` is a
 * parameter rather than an assumption.
 */
function readLine(
  tokens: string[],
  catalog: VoiceCatalog,
): {
  product: NonNullable<ReturnType<typeof matchProduct>>;
  quantity: number | null;
  price: number | null;
} | null {
  const nameTokens = tokens.filter(
    (t) => !SALE_VERBS.includes(t) && !BATCH_VERBS.includes(t) && DAY_OFFSETS[t] == null,
  );
  const product = matchProduct(nameTokens, catalog.products);
  if (!product) return null;

  // The size in the product's own name is neither a quantity nor a price:
  // "mango bottle 250" says nothing about how many or how much.
  const productDigits = new Set(
    [product.row.variantValue, product.row.sku]
      .join(" ")
      .split(/\D+/)
      .filter((d) => d.length > 0)
      .map((d) => Number.parseInt(d, 10)),
  );

  let quantity: number | null = null;
  let price: number | null = null;

  for (const num of allNumbers(tokens, false)) {
    const before = tokens[num.start - 1];
    const after = tokens[num.end];
    const marked =
      (before != null && (PRICE_WORDS.has(before) || COST_WORDS.has(before))) ||
      (after != null && (PRICE_WORDS.has(after) || COST_WORDS.has(after)));

    if (marked) {
      price ??= num.value;
      continue;
    }
    if (productDigits.has(num.value)) continue;
    if (quantity == null) {
      quantity = num.value;
      continue;
    }
    // A second unmarked number after a quantity is almost always the price.
    price ??= num.value;
  }

  return { product, quantity, price };
}

/**
 * Splits an utterance into order lines on "aur" / "and".
 *
 * Only splits where BOTH sides name a product, because those words also join
 * numbers ("ek sau aur bees") and appear in ordinary speech. A split that
 * cannot produce two real lines is not a split.
 */
function segmentLines(tokens: string[], catalog: VoiceCatalog): string[][] {
  const parts: string[][] = [];
  let current: string[] = [];
  for (const token of tokens) {
    if (LINE_SEPARATORS.has(token)) {
      parts.push(current);
      current = [];
      continue;
    }
    current.push(token);
  }
  parts.push(current);

  const usable = parts.filter((p) => p.length > 0 && matchProduct(p, catalog.products) != null);
  return usable.length >= 2 ? usable : [tokens];
}

/** Where an order is going: a shop wins over an area, being more specific. */
function readPlace(
  nameTokens: string[],
  catalog: VoiceCatalog,
): {
  areaId: number | null;
  areaName: string | null;
  shopId: number | null;
  shopName: string | null;
  warning: string | null;
} {
  const shop = bestMatch(nameTokens, catalog.shops, (s) => s.name, 0.7);
  if (shop) {
    return {
      areaId: shop.row.areaId,
      areaName: catalog.areas.find((a) => a.id === shop.row.areaId)?.name ?? null,
      shopId: shop.row.id,
      shopName: shop.row.name,
      warning: null,
    };
  }
  const area = bestMatch(nameTokens, catalog.areas, (a) => a.name, 0.7);
  if (area) {
    return {
      areaId: area.row.id,
      areaName: area.row.name,
      shopId: null,
      shopName: null,
      warning: area.ambiguous ? "More than one area sounded like that." : null,
    };
  }
  return { areaId: null, areaName: null, shopId: null, shopName: null, warning: null };
}

/**
 * A spoken order, of one line or several.
 *
 * "bees mango bottle 250 aur tees seb bottle 250 Corner Store ko" is two lines
 * to one shop. The place and the date belong to the whole sentence; the
 * quantity and price belong to each line.
 */
function parseBooking(tokens: string[], catalog: VoiceCatalog, today: Date): VoiceCommand {
  const missing: string[] = [];
  const warnings: string[] = [];

  const { date, spoken: dateSpoken } = readDate(tokens, today);
  if (!dateSpoken) warnings.push("No date was said, so today is assumed.");

  const nameTokens = tokens.filter((t) => !SALE_VERBS.includes(t) && DAY_OFFSETS[t] == null);
  const place = readPlace(nameTokens, catalog);
  if (place.warning) warnings.push(place.warning);
  if (place.areaId == null) missing.push("area");

  const booker = bestMatch(nameTokens, catalog.bookers, (b) => b.name, 0.8);

  const segments = segmentLines(tokens, catalog);
  const lines: Extract<VoiceCommand, { kind: "booking" }>["lines"] = [];

  for (const segment of segments) {
    const line = readLine(segment, catalog);
    if (!line) continue;

    if (line.product.ambiguous) {
      warnings.push(
        `That did not say which size, so ${line.product.row.sku} was picked. Check it before saving.`,
      );
    }
    if (line.quantity == null || line.quantity <= 0) {
      missing.push(segments.length > 1 ? `quantity for ${line.product.row.sku}` : "quantity");
    }
    let unitPrice = line.price;
    if (unitPrice == null) {
      unitPrice = line.product.row.defaultSalePrice;
      warnings.push(
        `No price was said for ${line.product.row.sku}, so the catalog price of ${unitPrice} is used.`,
      );
    }
    if (line.quantity != null && line.quantity > line.product.row.available) {
      warnings.push(
        `Only ${line.product.row.available} of ${line.product.row.sku} are in stock; ${line.quantity} was heard.`,
      );
    }

    lines.push({
      productId: line.product.row.id,
      sku: line.product.row.sku,
      label: `${line.product.row.name} ${line.product.row.packagingType} ${line.product.row.variantValue}`,
      quantity: line.quantity ?? 0,
      unitPrice,
    });
  }

  if (lines.length === 0) {
    return {
      kind: "unknown",
      reason:
        'No product in the catalog matched that. Try the flavour with its size, like "mango bottle 250".',
    };
  }

  // The same product twice in one order is a mishearing far more often than an
  // intention, so it is flagged rather than silently merged.
  const skus = lines.map((l) => l.sku);
  if (new Set(skus).size !== skus.length) {
    warnings.push("The same product was heard twice. Check the lines before saving.");
  }

  return {
    kind: "booking",
    lines,
    areaId: place.areaId,
    areaName: place.areaName,
    shopId: place.shopId,
    shopName: place.shopName,
    bookerId: booker?.row.id ?? null,
    bookerName: booker?.row.name ?? null,
    date,
    missing,
    warnings,
    confidence: missing.length === 0 && warnings.length === 0 ? "high" : "low",
  };
}

/**
 * Stock arriving: "das hazar mango bottle 250 aaye, cost do sau".
 *
 * The cost is never guessed. A batch with the wrong cost silently rewrites the
 * margin on every sale that comes out of it, which is the least visible way to
 * get the numbers wrong - so a missing cost blocks the save.
 */
function parseBatch(tokens: string[], catalog: VoiceCatalog, today: Date): VoiceCommand {
  const missing: string[] = [];
  const warnings: string[] = [];

  const { date, spoken: dateSpoken } = readDate(tokens, today);
  if (!dateSpoken) warnings.push("No date was said, so today is assumed.");

  const line = readLine(tokens, catalog);
  if (!line) {
    return {
      kind: "unknown",
      reason:
        'No product in the catalog matched that. Try the flavour with its size, like "mango bottle 250".',
    };
  }
  if (line.product.ambiguous) {
    warnings.push(
      `That did not say which size, so ${line.product.row.sku} was picked. Check it before saving.`,
    );
  }
  if (line.quantity == null || line.quantity <= 0) missing.push("quantity");
  if (line.price == null || line.price <= 0) missing.push("unit cost");

  return {
    kind: "batch",
    productId: line.product.row.id,
    sku: line.product.row.sku,
    label: `${line.product.row.name} ${line.product.row.packagingType} ${line.product.row.variantValue}`,
    quantity: line.quantity ?? 0,
    unitCost: line.price,
    date,
    missing,
    warnings,
    confidence: missing.length === 0 && warnings.length === 0 ? "high" : "low",
  };
}

/**
 * A cash sale over the counter: "paanch chocolate cash bech diye".
 *
 * Recognised as revenue the moment it is saved, unlike an order booked to a
 * shop - the money changed hands there and then. That is why the words "cash"
 * or "nagad" have to be spoken: it is a different record, not a shorthand.
 */
function parseCounterSale(tokens: string[], catalog: VoiceCatalog, today: Date): VoiceCommand {
  const missing: string[] = [];
  const warnings: string[] = [];

  const { date, spoken: dateSpoken } = readDate(tokens, today);
  if (!dateSpoken) warnings.push("No date was said, so today is assumed.");

  const line = readLine(tokens, catalog);
  if (!line) {
    return {
      kind: "unknown",
      reason:
        'No product in the catalog matched that. Try the flavour with its size, like "mango bottle 250".',
    };
  }
  if (line.product.ambiguous) {
    warnings.push(
      `That did not say which size, so ${line.product.row.sku} was picked. Check it before saving.`,
    );
  }
  if (line.quantity == null || line.quantity <= 0) missing.push("quantity");

  const nameTokens = tokens.filter((t) => !SALE_VERBS.includes(t) && DAY_OFFSETS[t] == null);
  const place = readPlace(nameTokens, catalog);
  // A counter sale still has to be attributed to an area, the same as any other
  // sale, because that is what the dashboard groups by.
  if (place.areaId == null) missing.push("area");

  let unitPrice = line.price;
  if (unitPrice == null) {
    unitPrice = line.product.row.defaultSalePrice;
    warnings.push(`No price was said, so the catalog price of ${unitPrice} is used.`);
  }
  if (line.quantity != null && line.quantity > line.product.row.available) {
    warnings.push(
      `Only ${line.product.row.available} of ${line.product.row.sku} are in stock; ${line.quantity} was heard.`,
    );
  }

  if (line.product.row.frontBatchId == null) missing.push("stock");

  return {
    kind: "sale",
    productId: line.product.row.id,
    batchId: line.product.row.frontBatchId,
    sku: line.product.row.sku,
    label: `${line.product.row.name} ${line.product.row.packagingType} ${line.product.row.variantValue}`,
    quantity: line.quantity ?? 0,
    unitPrice,
    areaId: place.areaId,
    areaName: place.areaName,
    shopId: place.shopId,
    shopName: place.shopName,
    date,
    missing,
    warnings,
    confidence: missing.length === 0 && warnings.length === 0 ? "high" : "low",
  };
}

/* ------------------------------------------------------------------- payments */

/**
 * A spoken payment: "invoice 12 ka paanch hazar aa gaya", "Corner Store se
 * 3000 mila".
 *
 * The invoice is found by its number if one was said, otherwise by the customer
 * or shop name on it. The amount is never guessed - a payment with no amount
 * comes back incomplete rather than assuming the balance, because "paid" and
 * "paid in full" are different claims.
 */
function parsePayment(tokens: string[], catalog: VoiceCatalog, today: Date): VoiceCommand {
  const missing: string[] = [];
  const warnings: string[] = [];
  const { date, spoken: dateSpoken } = readDate(tokens, today);
  if (!dateSpoken) warnings.push("No date was said, so today is assumed.");

  // An invoice number spoken as "invoice 12" or in full as "INV-2026-0012".
  let invoice: VoiceCatalog["invoices"][number] | null = null;
  const invoiceWordAt = tokens.findIndex((t) => /^inv/.test(t) || t === "invoice" || t === "بل");
  if (invoiceWordAt >= 0) {
    const num = readNumber(tokens, invoiceWordAt + 1, true);
    if (num) {
      const wanted = num.value;
      invoice =
        catalog.invoices.find((i) => {
          const digits = i.invoiceNo.replace(/\D/g, "");
          return (
            Number.parseInt(digits.slice(-String(wanted).length) || "0", 10) === wanted ||
            Number.parseInt(digits, 10) === wanted
          );
        }) ?? null;
      if (!invoice) warnings.push(`No open invoice matched number ${wanted}.`);
    }
  }
  if (!invoice) {
    const byName = bestMatch(tokens, catalog.invoices, (i) => i.customerName ?? i.invoiceNo, 0.7);
    if (byName) {
      invoice = byName.row;
      if (byName.ambiguous) {
        warnings.push("More than one open invoice matched that name; check it before saving.");
      }
    }
  }
  if (!invoice) missing.push("invoice");

  // The amount is any number that is not the invoice number itself.
  const numbers = allNumbers(tokens, false);
  let amount: number | null = null;
  for (const num of numbers) {
    if (invoiceWordAt >= 0 && num.start === invoiceWordAt + 1) continue;
    amount = num.value;
    break;
  }
  if (amount == null || amount <= 0) missing.push("amount");

  if (invoice && amount != null && amount > invoice.balance + 0.005) {
    warnings.push(
      `${invoice.invoiceNo} only has ${invoice.balance} outstanding; ${amount} was heard.`,
    );
  }

  return {
    kind: "payment",
    bookingId: invoice?.id ?? null,
    invoiceNo: invoice?.invoiceNo ?? null,
    amount,
    date,
    missing,
    warnings,
    confidence: missing.length === 0 && warnings.length === 0 ? "high" : "low",
  };
}
