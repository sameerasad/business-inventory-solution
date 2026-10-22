"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { SESSION_COOKIE, authConfigured, newSession, passwordMatches } from "@/lib/auth";
import { failure, type ActionState } from "@/lib/validations";

/**
 * A wrong password should cost something.
 *
 * There is no store to count attempts in, so this is not a rate limit - it is
 * a floor on how fast a wrong guess can be tried. At roughly three a second
 * instead of hundreds, guessing an ordinary password stops being a thing
 * somebody does idly from a browser tab.
 */
const WRONG_PASSWORD_DELAY_MS = 350;

export async function signInAction(_prev: ActionState, formData: FormData): Promise<ActionState> {
  if (!authConfigured()) {
    return failure(
      "This server has no password set. AUTH_PASSWORD and AUTH_SECRET have to be set in the environment before anyone can sign in.",
    );
  }

  const given = String(formData.get("password") ?? "");
  const next = String(formData.get("next") ?? "");

  if (!passwordMatches(given)) {
    await new Promise((r) => setTimeout(r, WRONG_PASSWORD_DELAY_MS));
    return failure("That password is not right.", { password: "Try again" });
  }

  const session = await newSession();
  const jar = await cookies();
  jar.set(SESSION_COOKIE, session.value, {
    httpOnly: true,
    sameSite: "lax",
    // Only over HTTPS in production; a plain-http localhost would never
    // receive the cookie back otherwise.
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: session.maxAge,
  });

  // Only ever back into this app. A "next" that could be an absolute URL is
  // an open redirect, and a login page is exactly where that gets used.
  redirect(next.startsWith("/") && !next.startsWith("//") ? next : "/dashboard");
}

export async function signOutAction(): Promise<void> {
  const jar = await cookies();
  jar.delete(SESSION_COOKIE);
  redirect("/login");
}
