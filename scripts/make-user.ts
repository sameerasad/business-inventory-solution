/**
 * Create or update one sign-in account, from the command line.
 *
 *   npx tsx scripts/make-user.ts <username> <name> <password> [admin|booker] [bookerName]
 *
 * This exists because of a chicken and egg: the Users page is admin-only, and
 * before anyone is an admin there is nobody to open it. The break-glass
 * AUTH_PASSWORD covers that too, but it signs you in as a nameless owner, so
 * every row you write while using it is attributed to nobody in particular.
 * Making the first real admin here means the audit log is honest from the
 * first action onwards.
 *
 * Re-running it for an existing username changes that account's password,
 * name and role rather than failing, which is what you want at 9pm when
 * somebody cannot get in.
 *
 * DATABASE_URL decides which database this writes to, and in this project that
 * usually points at production. Check it before running.
 */
import { PrismaClient } from "@prisma/client";

import { hashPassword } from "../src/lib/auth";

const prisma = new PrismaClient();

async function main() {
  const [rawUsername, name, password, rawRole = "booker", bookerName] = process.argv.slice(2);

  if (!rawUsername || !name || !password) {
    console.error(
      "Usage: npx tsx scripts/make-user.ts <username> <name> <password> [admin|booker] [bookerName]",
    );
    process.exit(1);
  }

  const username = rawUsername.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{2,31}$/.test(username)) {
    console.error(
      `"${username}" is not a usable username: 3-32 characters, letters, numbers, dot, dash or underscore.`,
    );
    process.exit(1);
  }
  if (password.length < 8) {
    console.error("The password must be at least 8 characters.");
    process.exit(1);
  }
  const role = rawRole === "admin" ? "admin" : "booker";

  // An account that records orders has to point at a real booker, and a typo
  // here would silently create an account that sees nothing at all.
  let bookerId: number | null = null;
  if (bookerName) {
    const booker = await prisma.booker.findFirst({
      where: { name: { equals: bookerName, mode: "insensitive" }, isDeleted: false },
      select: { id: true, name: true },
    });
    if (!booker) {
      const all = await prisma.booker.findMany({
        where: { isDeleted: false },
        select: { name: true },
        orderBy: { name: "asc" },
      });
      console.error(`No booker called "${bookerName}".`);
      console.error(`Bookers: ${all.map((b) => b.name).join(", ") || "(none yet)"}`);
      process.exit(1);
    }
    bookerId = booker.id;
    console.log(`Linked to booker "${booker.name}" (#${booker.id}).`);
  } else if (role === "booker") {
    console.warn(
      "No booker name given, so this account will sign in but see none of its own orders.",
    );
  }

  const passwordHash = await hashPassword(password);

  const saved = await prisma.user.upsert({
    where: { username },
    create: { username, name, passwordHash, role, bookerId },
    update: { name, passwordHash, role, bookerId, isActive: true },
    select: { id: true, username: true, role: true },
  });

  console.log(`\nAccount ready: ${saved.username} (${saved.role}), id ${saved.id}.`);
  console.log("Sign in with that username and the password you just set.");
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
