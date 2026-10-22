import { cache } from "react";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { prisma } from "@/lib/db";
import { EMERGENCY_USER_ID, SESSION_COOKIE, sessionUserId, type Role } from "@/lib/auth";

/**
 * The signed-in person, as the database currently describes them.
 *
 * Read per request rather than carried in the cookie. Memoised with cache(),
 * so the half-dozen callers in one render share a single query. One indexed
 * lookup, and
 * in exchange a user who is demoted or deactivated loses the access now rather
 * than whenever their cookie happens to expire.
 *
 * Server-only. Middleware runs on the edge with no database, so it checks that
 * a cookie is signed and nothing more; ROLE is decided here, where the truth
 * is. That split is deliberate - a gate that guesses at authority from a token
 * is a gate that stays open after the authority is gone.
 */
export type SignedIn = {
  id: number;
  name: string;
  role: Role;
  /** The booker they record orders as, when they are one. */
  bookerId: number | null;
};

/** The break-glass admin, for when the users table itself is the problem. */
const EMERGENCY: SignedIn = {
  id: EMERGENCY_USER_ID,
  name: "Owner",
  role: "admin",
  bookerId: null,
};

/**
 * The request's cookies, or null when there is no request.
 *
 * The seed, the sample-data builder and the CLI scripts all call straight into
 * the same code the app uses, and cookies() throws outside a request rather
 * than coming back empty. Null here means "nobody is signed in because nobody
 * is asking", which is a different thing from "a signed-out browser" - see
 * guard.ts, which treats the two differently on purpose.
 */
async function requestCookies() {
  try {
    return await cookies();
  } catch {
    return null;
  }
}

/** True when this code is answering an HTTP request rather than running in a script. */
export async function insideRequest(): Promise<boolean> {
  return (await requestCookies()) != null;
}

export const currentUser = cache(async function currentUser(): Promise<SignedIn | null> {
  const jar = await requestCookies();
  if (!jar) return null;
  const id = await sessionUserId(jar.get(SESSION_COOKIE)?.value);
  if (id == null) return null;
  if (id === EMERGENCY_USER_ID) return EMERGENCY;

  const row = await prisma.user.findUnique({
    where: { id },
    select: { id: true, name: true, role: true, bookerId: true, isActive: true },
  });
  if (!row || !row.isActive) return null;

  return {
    id: row.id,
    name: row.name,
    // Anything that is not "admin" is a booker. A role column holding a typo
    // must not become an administrator.
    role: row.role === "admin" ? "admin" : "booker",
    bookerId: row.bookerId,
  };
});

/** For a page that any signed-in person may open. */
export async function requireUser(): Promise<SignedIn> {
  const user = await currentUser();
  if (!user) redirect("/login");
  return user;
}

/**
 * For a page only an admin may open.
 *
 * Sent to the booker's own page rather than to the login screen: they ARE
 * signed in, and a login form in front of somebody already signed in reads as
 * a broken app rather than as a locked door.
 */
export async function requireAdmin(): Promise<SignedIn> {
  const user = await requireUser();
  if (user.role !== "admin") redirect("/my");
  return user;
}

/**
 * Matches nothing.
 *
 * A booker whose account is not linked to a booker row has no orders of their
 * own, and the honest answer to "show me mine" is an empty page. Returning
 * null for that case would mean "no filter", which hands them the whole
 * business - the one wrong answer that still looks like a working app.
 */
export const NO_BOOKER = -1;

/**
 * The booker whose rows this person may see, or null for an admin.
 *
 * Scoped by booker rather than by area on purpose. Two bookers can work the
 * same area, and an area filter would show each of them the other's orders and
 * the other's collections. The booking row already carries the booker who took
 * it, so that is what "mine" means here.
 *
 * Null means no restriction, and is only ever returned for an admin.
 */
export function scopeBookerId(user: SignedIn): number | null {
  if (user.role === "admin") return null;
  return user.bookerId ?? NO_BOOKER;
}

/**
 * The areas this person may see, or null for an admin.
 *
 * The shop list is this business's customer list - seventy-odd names with the
 * area each one sits in - and it is the most portable thing it owns. A margin
 * seen once is a loss once; a customer list that walks out is a loss every
 * month after. So a booker sees the territory they were assigned, and that
 * assignment is a decision the owner already makes on the Bookers page.
 *
 * Null means no restriction and is only ever returned for an admin. An EMPTY
 * array means exactly that - no areas - and callers must not read it as "no
 * filter", which is the same mistake NO_BOOKER exists to prevent.
 */
export async function visibleAreaIds(user: SignedIn): Promise<number[] | null> {
  if (user.role === "admin") return null;
  if (user.bookerId == null) return [];
  const rows = await prisma.bookerArea.findMany({
    where: { bookerId: user.bookerId, area: { isDeleted: false } },
    select: { areaId: true },
  });
  return rows.map((r) => r.areaId);
}
