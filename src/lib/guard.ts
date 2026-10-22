import { prisma } from "@/lib/db";
import { currentUser, insideRequest, scopeBookerId, type SignedIn } from "@/lib/session";
import { failure, type ActionState } from "@/lib/validations";

/**
 * The gate on the actions, as opposed to the gate on the pages.
 *
 * Hiding a button is not security. A server action is an HTTP endpoint with a
 * generated name, and anything the browser can reach, a person who reads the
 * page source can call directly with whatever arguments they like. So every
 * action that an admin alone may take says so in its own first two lines,
 * rather than trusting that the only way in was a button we chose not to draw.
 *
 * Two shapes, because the actions have two shapes. Forms get a failure they
 * can render; everything else throws, since there is no sensible value to
 * return and a silent empty result reads as "there is nothing here" rather
 * than "you may not look".
 */
const NOT_ALLOWED = "You do not have access to that. Ask the owner.";

/**
 * A script is not a visitor.
 *
 * The seed, the sample-data builder and the repair scripts call these same
 * actions directly, with no request and so no cookie. Refusing them would be
 * security theatre: a process holding DATABASE_URL can already write anything
 * these actions write, and more besides. What this file actually guards is the
 * browser, so that is the only thing it checks.
 */
async function isScript(): Promise<boolean> {
  return !(await insideRequest());
}

/** For an action that returns ActionState. Null means: carry on. */
export async function denyNonAdmin(): Promise<ActionState | null> {
  if (await isScript()) return null;
  const user = await currentUser();
  return user?.role === "admin" ? null : failure(NOT_ALLOWED);
}

/** For an action that returns something else. Throws rather than returning. */
export async function adminOnly(): Promise<SignedIn> {
  const user = await currentUser();
  if (user?.role !== "admin" && !(await isScript())) throw new Error(NOT_ALLOWED);
  return user ?? SCRIPT;
}

/** For an action any signed-in person may take. Throws if nobody is. */
export async function signedInOnly(): Promise<SignedIn> {
  const user = await currentUser();
  if (!user && !(await isScript())) throw new Error("Not signed in.");
  return user ?? SCRIPT;
}

/**
 * The caller, or null when a signed-out browser is asking.
 *
 * For actions that are open to everyone signed in but still need to know WHO,
 * and that want to answer a signed-out caller with a message rather than an
 * exception. A script gets SCRIPT and carries on, for the reason in isScript.
 */
export async function viewer(): Promise<SignedIn | null> {
  const user = await currentUser();
  if (user) return user;
  return (await isScript()) ? SCRIPT : null;
}

/** Stands in for the caller when there is no caller. Named, so audit rows say so. */
const SCRIPT: SignedIn = { id: 0, name: "script", role: "admin", bookerId: null };

/**
 * May this caller act on this one booking?
 *
 * Several things take a booking id straight from the client - the invoice PDF,
 * the WhatsApp share, the payment history. An id is a small integer, so for a
 * booker an unguarded one of those is a way to walk the whole business's
 * invoices from a browser console. An admin passes; a booker passes only for
 * an order they took.
 *
 * Callers answer false the same way they answer a missing booking, so trying
 * ids tells you nothing about which ones exist.
 */
export async function mayTouchBooking(bookingId: number): Promise<boolean> {
  const user = await viewer();
  if (!user) return false;
  const mine = scopeBookerId(user);
  if (mine == null) return true;
  const booking = await prisma.booking.findUnique({
    where: { id: bookingId },
    select: { bookerId: true },
  });
  return booking?.bookerId === mine;
}
