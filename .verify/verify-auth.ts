/**
 * The sign-in rules, on their own.
 *
 * No database and no server: these are the decisions taken before either, and
 * they are the ones where being wrong is quiet. The app looked completely
 * normal while the emergency password was outranking a username - nothing on
 * screen said anything, and the only symptom was a booker apparently seeing
 * the whole business.
 *
 * Both environment variables are set here rather than read from .env, so the
 * checks say the same thing on every machine.
 */
process.env.AUTH_SECRET = "verify-auth-secret-not-a-real-one";
process.env.AUTH_PASSWORD = "the-owners-emergency-password";

import {
  emergencyMatches,
  hashPassword,
  newSession,
  passwordMatchesHash,
  sameString,
  sessionUserId,
} from "@/lib/auth";

const EMERGENCY = "the-owners-emergency-password";

let failures = 0;
function ok(label: string, cond: boolean, detail?: unknown) {
  if (cond) console.log(`  PASS  ${label}`);
  else {
    failures += 1;
    console.error(`  FAIL  ${label}`, detail ?? "");
  }
}
function section(n: string) {
  console.log(`\n=== ${n} ===`);
}

async function main() {
  section("the emergency password");

  ok("works when no username is offered", emergencyMatches("", EMERGENCY));
  ok("and when the field is only whitespace", emergencyMatches("   ", EMERGENCY));

  /**
   * The one that bit.
   *
   * Typing a booker's username together with the emergency password used to
   * sign you in as the owner, discarding the username entirely. Whoever did it
   * then saw the dashboard, the margins and every booker's orders, with
   * nothing to say the name they typed had been thrown away.
   */
  ok(
    "but NOT when a username was typed - a username means that person or nobody",
    !emergencyMatches("sameer_booker", EMERGENCY),
    "a named sign-in fell through to the owner",
  );
  ok("nor for an admin's username", !emergencyMatches("sameerasad", EMERGENCY));
  ok("and a wrong password is still wrong", !emergencyMatches("", "not-it"));

  {
    // With nothing configured there is no emergency way in at all, rather than
    // an empty password matching an empty field.
    const saved = process.env.AUTH_PASSWORD;
    process.env.AUTH_PASSWORD = "";
    ok("no emergency password set means no emergency way in", !emergencyMatches("", ""));
    process.env.AUTH_PASSWORD = saved;
  }

  section("stored passwords");

  const hash = await hashPassword("correct horse battery");
  ok("a hash does not contain the password", !hash.includes("correct horse battery"));
  ok("the right password matches", await passwordMatchesHash("correct horse battery", hash));
  ok("a wrong one does not", !(await passwordMatchesHash("correct horse", hash)));
  ok("and neither does the empty string", !(await passwordMatchesHash("", hash)));
  ok("nor does a mangled hash", !(await passwordMatchesHash("correct horse battery", "rubbish")));

  const again = await hashPassword("correct horse battery");
  // Salted, so two people who chose the same password do not look the same in
  // the table - which is what stops one leak becoming several.
  ok("the same password hashes differently twice", hash !== again);
  ok("and both still verify", await passwordMatchesHash("correct horse battery", again));

  section("the session cookie");

  const session = await newSession(7);
  ok("a fresh cookie names its user", (await sessionUserId(session.value)) === 7);

  // The id sits inside the signed body, so editing it breaks the signature.
  // This is the whole reason the ROLE is not in the token either.
  const at = session.value.lastIndexOf(".");
  const body = session.value.slice(0, at);
  const mac = session.value.slice(at + 1);
  const [expires] = body.split(":");
  ok(
    "editing the user id inside it is refused",
    (await sessionUserId(`${expires}:1.${mac}`)) === null,
    "a booker could rewrite themselves into another account",
  );
  ok(
    "and so is stretching the expiry",
    (await sessionUserId(`${Number(expires) + 86_400_000}:7.${mac}`)) === null,
  );
  ok("a cookie with no signature is refused", (await sessionUserId(body)) === null);
  ok("an absent one is refused", (await sessionUserId(undefined)) === null);
  ok("nonsense is refused", (await sessionUserId("not-a-cookie")) === null);

  const dead = await newSession(7);
  const deadBody = `${Date.now() - 1000}:7`;
  ok(
    "an expired cookie is refused even though it is correctly signed",
    (await sessionUserId(`${deadBody}.${dead.value.slice(dead.value.lastIndexOf(".") + 1)}`)) ===
      null,
  );

  section("constant-time compare");
  ok("equal strings are equal", sameString("abc", "abc"));
  ok("different strings are not", !sameString("abc", "abd"));
  ok("different lengths are not", !sameString("abc", "abcd"));

  console.log(failures === 0 ? "\nAUTH OK" : `\n${failures} AUTH FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

main();
