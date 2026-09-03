/**
 * The words this app understands, in English and Urdu.
 *
 * Two scripts have to work, not one. The browser's speech recognition returns
 * Roman text when it is listening in English ("bees packs mango") and Urdu
 * script when listening in Urdu ("بیس پیک آم"), and people mix the two mid
 * sentence. Rather than build a transliteration engine, both forms of every
 * word are listed here - it is a small, fixed vocabulary and an explicit list is
 * far easier to correct than a fuzzy phonetic guess.
 *
 * Everything in this file is data only. The parsing lives in parse.ts so that
 * adding a word never means touching logic.
 */

/* ------------------------------------------------------------------- numbers */

/** Single tokens that are worth a fixed amount. */
export const NUMBER_WORDS: Record<string, number> = {
  // English
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
  seventy: 70,
  eighty: 80,
  ninety: 90,
  // A dozen is a real unit in this trade.
  dozen: 12,
  darjan: 12,

  // Roman Urdu
  sifar: 0,
  ek: 1,
  aik: 1,
  do: 2,
  teen: 3,
  tin: 3,
  char: 4,
  chaar: 4,
  panch: 5,
  paanch: 5,
  punch: 5,
  che: 6,
  chhe: 6,
  chay: 6,
  cheh: 6,
  saat: 7,
  sat: 7,
  aath: 8,
  ath: 8,
  nau: 9,
  no: 9,
  das: 10,
  dus: 10,
  gyarah: 11,
  gyara: 11,
  barah: 12,
  bara: 12,
  terah: 13,
  tera: 13,
  chodah: 14,
  chauda: 14,
  pandrah: 15,
  pandra: 15,
  solah: 16,
  sola: 16,
  satrah: 17,
  satra: 17,
  atharah: 18,
  athara: 18,
  unnees: 19,
  unnis: 19,
  bees: 20,
  bis: 20,
  ikkees: 21,
  ikkis: 21,
  baees: 22,
  bais: 22,
  teees: 23,
  tees: 30,
  tis: 30,
  chalees: 40,
  chalis: 40,
  pachas: 50,
  pachaas: 50,
  pachees: 25,
  pachis: 25,
  saath: 60,
  sath: 60,
  sattar: 70,
  satar: 70,
  assi: 80,
  asi: 80,
  nabbe: 90,
  nabbay: 90,

  // Urdu script
  صفر: 0,
  ایک: 1,
  دو: 2,
  تین: 3,
  چار: 4,
  پانچ: 5,
  چھ: 6,
  سات: 7,
  آٹھ: 8,
  نو: 9,
  دس: 10,
  گیارہ: 11,
  بارہ: 12,
  تیرہ: 13,
  چودہ: 14,
  پندرہ: 15,
  سولہ: 16,
  سترہ: 17,
  اٹھارہ: 18,
  انیس: 19,
  بیس: 20,
  پچیس: 25,
  تیس: 30,
  چالیس: 40,
  پچاس: 50,
  ساٹھ: 60,
  ستر: 70,
  اسی: 80,
  نوے: 90,
};

/** Words that multiply what came before them. */
export const NUMBER_MULTIPLIERS: Record<string, number> = {
  hundred: 100,
  sau: 100,
  so: 100,
  سو: 100,
  thousand: 1000,
  hazar: 1000,
  hazaar: 1000,
  hazzar: 1000,
  ہزار: 1000,
  lakh: 100_000,
  lac: 100_000,
  لاکھ: 100_000,
  // Written as a word often enough to be worth having.
  million: 1_000_000,
};

/**
 * English tens that a unit word may complete: "twenty five" is 25.
 *
 * Urdu does not work this way - 25 is its own word, "pachees" - so "bees
 * paanch" is twenty and then five, two separate numbers, not 25. Getting this
 * wrong would turn "bees paanch sau" (20 at 500) into 25.
 */
export const ENGLISH_TENS = new Set([
  "twenty",
  "thirty",
  "forty",
  "fifty",
  "sixty",
  "seventy",
  "eighty",
  "ninety",
]);

/** Joins two numbers rather than adding a value: "ek sau bees" = 120. */
export const NUMBER_JOINERS = new Set(["and", "aur", "و", "او"]);

/** Urdu-Arabic digits, mapped to ASCII so one number parser handles both. */
export const DIGIT_MAP: Record<string, string> = {
  "۰": "0",
  "۱": "1",
  "۲": "2",
  "۳": "3",
  "۴": "4",
  "۵": "5",
  "۶": "6",
  "۷": "7",
  "۸": "8",
  "۹": "9",
  "٠": "0",
  "١": "1",
  "٢": "2",
  "٣": "3",
  "٤": "4",
  "٥": "5",
  "٦": "6",
  "٧": "7",
  "٨": "8",
  "٩": "9",
};

/**
 * Multi-word markers, collapsed to one token before anything else runs.
 *
 * "aa gaya" is the ordinary way to say money arrived, but it is two words and
 * the second one ("gaya") is a filler that gets dropped - so without this the
 * phrase vanishes and a payment reads as a request to open the invoice list.
 */
export const PHRASES: [RegExp, string][] = [
  [/\baa\s+g(?:aya|ai|aye|ya)\b/g, "aagaya"],
  [/\bmil\s+g(?:aya|ai|aye|ya)\b/g, "milgaya"],
  [/\bwasool\s+hu(?:a|e|i)\b/g, "wasool"],
  [/\bجمع\s+ہو\s*گیا\b/g, "wasool"],
  [/\bآ\s*گیا\b/g, "aagaya"],
  [/\bمل\s*گیا\b/g, "milgaya"],
  [/\bpaid\s+in\s+full\b/g, "paidinfull"],
  [/\bday\s+before\s+yesterday\b/g, "parson"],
  [/\bhow\s+much\b/g, "howmuch"],
];

/* --------------------------------------------------------------------- dates */

/**
 * Day offsets from today.
 *
 * "kal" means both yesterday and tomorrow in Urdu. This is a record of what has
 * already happened, so it resolves to YESTERDAY - and the resolved date is always
 * shown on the confirmation card, so a wrong guess is visible before saving
 * rather than after.
 */
export const DAY_OFFSETS: Record<string, number> = {
  today: 0,
  aaj: 0,
  aj: 0,
  آج: 0,
  yesterday: -1,
  kal: -1,
  kl: -1,
  کل: -1,
  guzra: -1,
  // Two days either side. "parson" is likewise ambiguous and treated as past.
  parson: -2,
  parsoon: -2,
  پرسوں: -2,
  tomorrow: 1,
  آنے: 1,
};

/* -------------------------------------------------------------------- intents */

/** Words that mean "take me to a page". */
export const NAVIGATE_VERBS = [
  "open",
  "show",
  "go",
  "goto",
  "navigate",
  "take",
  "kholo",
  "kholiye",
  "khol",
  "dikhao",
  "dikhaao",
  "dikha",
  "jao",
  "chalo",
  "کھولو",
  "دکھاؤ",
  "جاؤ",
  "چلو",
];

/** Words that mean "tell me a figure". */
export const QUERY_VERBS = [
  "how",
  "howmuch",
  "what",
  "whats",
  "total",
  "tell",
  "kitna",
  "kitni",
  "kitne",
  "kya",
  "batao",
  "bataao",
  "bata",
  "کتنا",
  "کتنی",
  "کتنے",
  "کیا",
  "بتاؤ",
];

/** Words that mean "record an order / a sale". */
export const SALE_VERBS = [
  "sell",
  "sold",
  "sale",
  "book",
  "booking",
  "order",
  "record",
  "add",
  "deliver",
  "bech",
  "becha",
  "bechna",
  "becho",
  "bech-do",
  "likho",
  "likh",
  "darj",
  "booking",
  "order",
  "بیچ",
  "بیچا",
  "بیچو",
  "لکھو",
  "درج",
  "آرڈر",
];

/** Words that mean "money arrived". */
export const PAYMENT_VERBS = [
  "payment",
  "paid",
  "received",
  "receive",
  "collect",
  "collected",
  "cash",
  "paisa",
  "paise",
  "paisay",
  "rakam",
  "raqam",
  "wasool",
  "mila",
  "milgaya",
  "aagaya",
  "agaya",
  "adaigi",
  "adayegi",
  "paidinfull",
  "پیسہ",
  "پیسے",
  "رقم",
  "وصول",
  "ملا",
  "آگیا",
  "ادائیگی",
];

/**
 * Words that mean "stock came in".
 *
 * Kept narrow on purpose. The noun "stock" is NOT here - "stock kitna hai" is a
 * question, and "batch" is not here either because "batches kholo" is
 * navigation. Only words that actually describe goods arriving.
 */
export const BATCH_VERBS = [
  "aaya", "aaye", "aayi", "aagaye",
  "khareeda", "kharida", "kharidi", "khareede",
  "purchase", "purchased", "stockin", "restock",
  "آیا", "آئے", "خریدا", "خریدے",
];

/**
 * Words that mark a cost price rather than a sale price.
 *
 * A cost is only ever spoken about goods coming IN, so one of these settles
 * "received" - which otherwise means both money arriving and stock arriving.
 */
export const COST_WORDS = new Set([
  "cost", "lagat", "kharch", "kharcha", "purchase",
  "لاگت", "خرچ",
]);

/**
 * Words that mark an over-the-counter cash sale, as opposed to an order booked
 * to a shop on credit. The two are different records in this app, so the
 * distinction has to be spoken.
 */
export const COUNTER_WORDS = new Set([
  "cash", "counter", "nagad", "naqad", "hathon",
  "نقد", "کاؤنٹر",
]);

/** Conjunctions that separate one order line from the next. */
export const LINE_SEPARATORS = new Set(["and", "aur", "plus", "phir", "اور", "پھر"]);

/* ------------------------------------------------------------------ modifiers */

/** Noise words that carry no meaning and are dropped before matching. */
export const STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "of",
  "to",
  "for",
  "in",
  "at",
  "on",
  "is",
  "are",
  "was",
  "please",
  "me",
  "my",
  "it",
  "this",
  "that",
  "ka",
  "ki",
  "ke",
  "ko",
  "se",
  "me",
  "mein",
  "par",
  "hai",
  "hain",
  "tha",
  "thi",
  "the",
  "wala",
  "wali",
  "do",
  "diya",
  "dena",
  "kar",
  "karo",
  "gaya",
  "gai",
  "ho",
  "hua",
  "hui",
  "ji",
  "sahab",
  "bhai",
  "کا",
  "کی",
  "کے",
  "کو",
  "سے",
  "میں",
  "پر",
  "ہے",
  "ہیں",
  "تھا",
  "دو",
  "دیا",
  "کرو",
  "گیا",
  "ہو",
  "جی",
  "صاحب",
  "بھائی",
]);

/**
 * "do" is both the Urdu word for 2 and an English/Urdu filler ("bech do").
 * It only counts as a number when a quantity is actually expected, which the
 * parser decides - so it is deliberately in both lists above.
 */
export const AMBIGUOUS_NUMBER_WORDS = new Set(["do", "no", "so", "me", "the"]);

/** Units of sale. All of them mean "one saleable pack" on an invoice. */
export const UNIT_WORDS = new Set([
  "pack",
  "packs",
  "packet",
  "packets",
  "piece",
  "pieces",
  "pcs",
  "unit",
  "units",
  "bottle",
  "bottles",
  "box",
  "boxes",
  "carton",
  "cartons",
  "peti",
  "petti",
  "dabba",
  "dabbe",
  "danay",
  "dane",
  "adad",
  "پیک",
  "پیکٹ",
  "بوتل",
  "ڈبہ",
  "پیٹی",
  "عدد",
]);

/** Words that introduce a price rather than a quantity. */
export const PRICE_WORDS = new Set([
  "rs",
  "rupee",
  "rupees",
  "rupya",
  "rupay",
  "rupaye",
  "price",
  "rate",
  "each",
  "per",
  "at",
  "روپے",
  "روپیہ",
  "قیمت",
  "ریٹ",
  "فی",
]);

/** Words that introduce a shop or an area. */
export const PLACE_WORDS = new Set([
  "shop",
  "store",
  "area",
  "zone",
  "dukan",
  "dukaan",
  "دکان",
  "علاقہ",
  "ایریا",
]);

/* -------------------------------------------------------- product name aliases */

/**
 * Everyday names for the catalog, mapped to the words that appear in a product
 * name. Resolution is fuzzy, so this only needs the cases fuzzy matching cannot
 * reach - a different word for the same thing, in either language.
 */
export const PRODUCT_ALIASES: Record<string, string> = {
  aam: "mango",
  آم: "mango",
  seb: "apple",
  saib: "apple",
  سیب: "apple",
  aaru: "peach",
  aru: "peach",
  آڑو: "peach",
  lichi: "lychee",
  leechi: "lychee",
  لیچی: "lychee",
  anar: "pomegranate",
  anaar: "pomegranate",
  انار: "pomegranate",
  chocolate: "chocolate",
  chaklet: "chocolate",
  چاکلیٹ: "chocolate",
  juice: "juice",
  ras: "juice",
  جوس: "juice",
  bottle: "bottle",
  botal: "bottle",
  بوتل: "bottle",
  tetra: "tetra",
  ٹیٹرا: "tetra",
  bar: "bar",
};

/* --------------------------------------------------------------- destinations */

/** Pages voice can open, with the words that reach them. */
export const DESTINATIONS: { href: string; label: string; words: string[] }[] = [
  {
    href: "/dashboard",
    label: "Dashboard",
    words: ["dashboard", "home", "summary", "khulasa", "ڈیش بورڈ", "ہوم"],
  },
  {
    href: "/bookings/new",
    label: "New Booking",
    words: ["new booking", "naya order", "naya booking", "booking form", "نیا آرڈر"],
  },
  {
    href: "/bookings",
    label: "Bookings",
    words: ["bookings", "booking", "orders", "invoices", "invoice", "آرڈرز", "آرڈر"],
  },
  {
    href: "/receivables",
    label: "Receivables",
    words: [
      "receivables",
      "receivable",
      "outstanding",
      "udhar",
      "udhaar",
      "baqaya",
      "baqaaya",
      "ادھار",
      "بقایا",
    ],
  },
  {
    href: "/sales/new",
    label: "New Sale",
    words: ["new sale", "naya sale", "counter sale", "نئی سیل"],
  },
  { href: "/sales", label: "Sales", words: ["sales", "sale", "bikri", "بکری", "سیلز"] },
  {
    href: "/batches/new",
    label: "New Batch",
    words: ["new batch", "naya batch", "stock in", "نیا بیچ"],
  },
  {
    href: "/batches",
    label: "Batches",
    words: ["batches", "batch", "stock", "inventory", "maal", "مال", "اسٹاک"],
  },
  {
    href: "/products",
    label: "Products",
    words: ["products", "product", "catalog", "items", "cheezain", "پروڈکٹس", "اشیاء"],
  },
  {
    href: "/bookers",
    label: "Bookers",
    words: ["bookers", "booker", "salesman", "salesmen", "staff", "بکرز", "بکر"],
  },
  {
    href: "/areas",
    label: "Areas & Shops",
    words: ["areas", "area", "shops", "shop", "ilaqa", "ilaqay", "علاقے", "دکانیں"],
  },
];

/* -------------------------------------------------------------- query metrics */

export type QueryMetric =
  | "revenue"
  | "profit"
  | "outstanding"
  | "collected"
  | "stock"
  | "units"
  | "orders"
  /** What one shop or one invoice still owes, as opposed to the whole book. */
  | "balance";

/** What a spoken question is asking for. */
export const METRIC_WORDS: { metric: QueryMetric; words: string[] }[] = [
  {
    metric: "profit",
    words: ["profit", "margin", "munafa", "munafaa", "nafa", "منافع", "نفع"],
  },
  {
    metric: "revenue",
    words: [
      "revenue",
      "sales",
      "sale",
      "income",
      "turnover",
      "bikri",
      "amdani",
      "amdani",
      "بکری",
      "آمدنی",
      "سیل",
    ],
  },
  {
    metric: "outstanding",
    words: [
      "outstanding",
      "receivable",
      "receivables",
      "pending",
      "balance",
      "due",
      "udhar",
      "udhaar",
      "baqaya",
      "baqaaya",
      "ادھار",
      "بقایا",
      "باقی",
    ],
  },
  {
    metric: "collected",
    words: ["collected", "collection", "received", "wasooli", "wasuli", "وصولی"],
  },
  {
    metric: "stock",
    words: ["stock", "inventory", "maal", "bacha", "مال", "اسٹاک"],
  },
  { metric: "units", words: ["units", "packs", "quantity", "tadaad", "تعداد"] },
  {
    metric: "orders",
    words: ["orders", "bookings", "invoices", "order", "booking", "آرڈرز", "آرڈر"],
  },
  {
    metric: "balance",
    words: ["balance", "baqi", "baaqi", "bacha", "بیلنس", "باقی"],
  },
];

/** The period a question is about. */
export type QueryPeriod = "today" | "month" | "year";

export const PERIOD_WORDS: { period: QueryPeriod; words: string[] }[] = [
  { period: "today", words: ["today", "aaj", "aj", "آج"] },
  {
    period: "month",
    words: ["month", "monthly", "mahina", "maheena", "mahine", "مہینہ", "ماہ"],
  },
  { period: "year", words: ["year", "yearly", "saal", "sal", "annual", "سال"] },
];
