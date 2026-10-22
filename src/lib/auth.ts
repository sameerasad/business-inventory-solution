/**
 * Who is allowed in.
 *
 * Until now anybody with the URL could do anything: add a booking, correct a
 * cost, or press "Clear all" and mark every invoice in the business as paid.
 * That was survivable while the address was only in one person's phone, and it
 * stopped being survivable the moment a button existed that rewrites the whole
 * receivables ledger in one press.
 *
 * One shared password, because there is one owner. Not a users table: that
 * needs a migration against production and buys nothing until a second person
 * actually logs in. When bookers get their own accounts, this is the file that
 * grows a lookup and currentActor() starts naming them.
 *
 * No library. The session is a timestamp with an HMAC over it, which is all a
 * single-password cookie needs, and Web Crypto is the only thing available in
 * middleware anyway - node:crypto does not run there.
 */

const COOKIE = "ibt_session";
/** Long enough that a working day never ends with a login screen. */
const DAYS = 30;

function secret(): string {
  return (process.env.AUTH_SECRET ?? "").trim();
}

function password(): string {
  return (process.env.AUTH_PASSWORD ?? "").trim();
}

/**
 * Whether the server is able to authenticate anyone at all.
 *
 * Both are required, and a missing one locks the app rather than opening it.
 * An auth feature that fails open is not an auth feature; the login page says
 * plainly what is missing so a misconfigured deploy is five seconds to
 * diagnose instead of a mystery.
 */
export function authConfigured(): boolean {
  return secret().length >= 16 && password().length > 0;
}

async function sign(value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value));
  return [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Compared byte by byte to the end, so the time taken says nothing. */
function sameString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function passwordMatches(given: string): boolean {
  const want = password();
  return want.length > 0 && sameString(given, want);
}

export const SESSION_COOKIE = COOKIE;

export async function newSession(): Promise<{ value: string; maxAge: number }> {
  const expires = Date.now() + DAYS * 86400_000;
  const body = String(expires);
  return { value: `${body}.${await sign(body)}`, maxAge: DAYS * 86400 };
}

/**
 * Is this cookie one we issued, and still valid?
 *
 * The expiry is inside the signed part, so a cookie cannot be kept alive by
 * editing it - changing the timestamp breaks the signature.
 */
export async function sessionValid(cookie: string | undefined): Promise<boolean> {
  if (!cookie || !authConfigured()) return false;
  const [body, mac] = cookie.split(".");
  if (!body || !mac) return false;
  if (!sameString(mac, await sign(body))) return false;
  const expires = Number.parseInt(body, 10);
  return Number.isFinite(expires) && expires > Date.now();
}
