/**
 * Who is allowed in, and what they are allowed to see.
 *
 * Two roles. "admin" sees the whole business - cost, profit, every booker.
 * "booker" sees their own areas, their own orders and never a margin, because
 * a booker sits in front of shopkeepers all day and a known margin travels.
 *
 * The session cookie carries the user id and nothing else about them. The role
 * is read from the database on each request rather than carried in the token,
 * which costs one indexed lookup and buys the thing that matters: demoting
 * somebody takes effect now, instead of whenever their cookie happens to
 * expire. A token that remembers an authority the database has taken away is
 * the whole problem with putting roles in tokens.
 *
 * No library. PBKDF2 and HMAC come from Web Crypto, which is the only thing
 * that runs in middleware anyway.
 */

export type Role = "admin" | "booker";

export const SESSION_COOKIE = "ibt_session";
/** Long enough that a working day never ends at a login screen. */
const DAYS = 30;
/** Slow enough to make a stolen hash expensive, fast enough for a login. */
const PBKDF2_ROUNDS = 120_000;

function secret(): string {
  return (process.env.AUTH_SECRET ?? "").trim();
}

/**
 * The break-glass password.
 *
 * Signs in as an admin with no row in the users table. It exists so a mistake
 * in that table - the last admin deactivated, a password lost - is a thing you
 * recover from rather than a locked door. Everyone else is a real user.
 */
export function emergencyPassword(): string {
  return (process.env.AUTH_PASSWORD ?? "").trim();
}

export const EMERGENCY_USER_ID = 0;

/**
 * Does the owner's emergency password apply to this attempt?
 *
 * Only when no username was offered, and that is the whole rule. Checking the
 * emergency password against every attempt meant that naming yourself as a
 * booker and happening to type it signed you in as the owner, with the
 * username silently discarded - the screen then looked exactly as it would
 * have if that booker really could see the whole business.
 *
 * A username therefore means "sign me in as this person, or not at all".
 */
export function emergencyMatches(username: string, password: string): boolean {
  if (username.trim().length > 0) return false;
  const emergency = emergencyPassword();
  return emergency.length > 0 && sameString(password, emergency);
}

export function authConfigured(): boolean {
  return secret().length >= 16;
}

/* ------------------------------------------------------------- passwords */

function toHex(bytes: ArrayBuffer | Uint8Array): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function pbkdf2(password: string, salt: string, rounds: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: new TextEncoder().encode(salt), iterations: rounds, hash: "SHA-256" },
    key,
    256,
  );
  return toHex(bits);
}

/** Stored as "rounds:salt:hash", so the cost can be raised later without a migration. */
export async function hashPassword(password: string): Promise<string> {
  const salt = toHex(crypto.getRandomValues(new Uint8Array(16)));
  return `${PBKDF2_ROUNDS}:${salt}:${await pbkdf2(password, salt, PBKDF2_ROUNDS)}`;
}

export async function passwordMatchesHash(password: string, stored: string): Promise<boolean> {
  const [roundsRaw, salt, want] = stored.split(":");
  const rounds = Number.parseInt(roundsRaw ?? "", 10);
  if (!Number.isInteger(rounds) || !salt || !want) return false;
  return sameString(await pbkdf2(password, salt, rounds), want);
}

/** Compared to the end regardless, so the time taken says nothing. */
export function sameString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* -------------------------------------------------------------- sessions */

async function sign(value: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return toHex(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
}

export async function newSession(userId: number): Promise<{ value: string; maxAge: number }> {
  const body = `${Date.now() + DAYS * 86400_000}:${userId}`;
  return { value: `${body}.${await sign(body)}`, maxAge: DAYS * 86400 };
}

/**
 * The user id inside a cookie we issued, or null.
 *
 * The expiry is part of what is signed, so a cookie cannot be kept alive by
 * editing it - changing the timestamp breaks the signature.
 */
export async function sessionUserId(cookie: string | undefined): Promise<number | null> {
  if (!cookie || !authConfigured()) return null;
  const at = cookie.lastIndexOf(".");
  if (at < 0) return null;
  const body = cookie.slice(0, at);
  const mac = cookie.slice(at + 1);
  if (!sameString(mac, await sign(body))) return null;

  const [expiresRaw, idRaw] = body.split(":");
  const expires = Number.parseInt(expiresRaw ?? "", 10);
  const id = Number.parseInt(idRaw ?? "", 10);
  if (!Number.isFinite(expires) || expires <= Date.now()) return null;
  return Number.isInteger(id) ? id : null;
}
