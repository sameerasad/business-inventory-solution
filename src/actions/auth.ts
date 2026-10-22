"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { prisma } from "@/lib/db";
import {
  EMERGENCY_USER_ID,
  SESSION_COOKIE,
  authConfigured,
  emergencyMatches,
  newSession,
  passwordMatchesHash,
} from "@/lib/auth";
import { failure, type ActionState } from "@/lib/validations";

/**
 * A wrong password should cost something.
 *
 * There is no store to count attempts in, so this is not a rate limit - it is
 * a floor on how fast a wrong guess can be tried. PBKDF2 already spends real
 * time on every attempt; this covers the paths that fail before it, so a
 * username that does not exist cannot be told apart from one that does by how
 * quickly it comes back.
 */
const WRONG_DELAY_MS = 350;

export async function signInAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  if (!authConfigured()) {
    return failure(
      "This server has no AUTH_SECRET set, so nobody can sign in. It has to be set in the environment first.",
    );
  }

  const username = String(formData.get("username") ?? "").trim().toLowerCase();
  const password = String(formData.get("password") ?? "");
  const next = String(formData.get("next") ?? "");

  const userId = await identify(username, password);
  if (userId == null) {
    await new Promise((r) => setTimeout(r, WRONG_DELAY_MS));
    // One message for both halves. "No such user" tells somebody which
    // usernames are real, which is the first thing worth knowing.
    return failure("That username and password do not match.", { password: "Try again" });
  }

  const session = await newSession(userId);
  const jar = await cookies();
  jar.set(SESSION_COOKIE, session.value, {
    httpOnly: true,
    sameSite: "lax",
    // HTTPS only in production; a plain-http localhost would never get it back.
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: session.maxAge,
  });

  // Only ever back into this app. A "next" that could be an absolute URL is an
  // open redirect, and a login page is exactly where one gets used.
  redirect(next.startsWith("/") && !next.startsWith("//") ? next : "/dashboard");
}

/**
 * Who this is, or null.
 *
 * The break-glass password belongs to no row. It exists so that a mistake in
 * the users table - the last admin deactivated, a password lost - is something
 * you recover from rather than a locked door.
 *
 * It is only offered when NO username is given, and that restriction is the
 * whole point. Checking it against every attempt meant that naming yourself as
 * a booker and happening to type the emergency password signed you in as the
 * owner, with the username silently ignored. Nothing on screen said so, and
 * the gap between "who I said I was" and "who the app thinks I am" is the last
 * place a surprise belongs.
 *
 * So: a username means "sign me in as this person, or not at all".
 */
async function identify(username: string, password: string): Promise<number | null> {
  if (emergencyMatches(username, password)) return EMERGENCY_USER_ID;
  if (!username) return null;

  const user = await prisma.user.findUnique({
    where: { username },
    select: { id: true, passwordHash: true, isActive: true },
  });
  if (!user || !user.isActive) return null;
  return (await passwordMatchesHash(password, user.passwordHash)) ? user.id : null;
}

export async function signOutAction(): Promise<void> {
  const jar = await cookies();
  jar.delete(SESSION_COOKIE);
  redirect("/login");
}
