import type { Metadata } from "next";
import Link from "next/link";
import { ChevronLeft, ChevronRight } from "lucide-react";

import { PageHeader } from "@/components/page-header";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { UserManager, type UserAdmin } from "@/components/users/user-manager";
import { TargetBoard, type TargetRow } from "@/components/users/target-board";
import { MONTH_LABELS } from "@/lib/format";
import { currentMonthIndex0, currentYear, monthRange } from "@/lib/dates";
import { getMyMonth } from "@/lib/my";
import { requireAdmin } from "@/lib/session";
import { prisma } from "@/lib/db";

export const metadata: Metadata = { title: "Users" };
export const dynamic = "force-dynamic";

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function readMonth(sp: Record<string, string | string[] | undefined>): {
  year: number;
  month0: number;
} {
  const y = Number.parseInt(first(sp.y) ?? "", 10);
  const m = Number.parseInt(first(sp.m) ?? "", 10);
  const okYear = Number.isInteger(y) && y >= 2000 && y <= 2100;
  const okMonth = Number.isInteger(m) && m >= 1 && m <= 12;
  return okYear && okMonth
    ? { year: y, month0: m - 1 }
    : { year: currentYear(), month0: currentMonthIndex0() };
}

function step(year: number, month0: number, by: number): string {
  const d = new Date(Date.UTC(year, month0 + by, 1));
  return `/users?y=${d.getUTCFullYear()}&m=${d.getUTCMonth() + 1}`;
}

export default async function UsersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const me = await requireAdmin();
  const sp = await searchParams;
  const { year, month0 } = readMonth(sp);
  const label = `${MONTH_LABELS[month0]} ${year}`;
  const monthStart = monthRange(year, month0).start;

  const [userRows, bookers, targets] = await Promise.all([
    prisma.user.findMany({
      orderBy: [{ isActive: "desc" }, { role: "asc" }, { name: "asc" }],
      select: {
        id: true,
        username: true,
        name: true,
        role: true,
        bookerId: true,
        isActive: true,
        booker: { select: { name: true } },
      },
    }),
    prisma.booker.findMany({
      where: { isDeleted: false, isActive: true },
      orderBy: { name: "asc" },
      select: { id: true, name: true },
    }),
    prisma.bookerTarget.findMany({
      where: { month: monthStart },
      select: { bookerId: true, amount: true, packs: true, notes: true },
    }),
  ]);

  // One query per booker, but only for the handful who are active, and only
  // for one month. The alternative is another aggregate that would have to
  // stay in step with the one the booker's own page uses - and two figures
  // claiming to be the same number is worse than a few extra queries.
  const progress = await Promise.all(
    bookers.map(async (b) => ({ id: b.id, month: await getMyMonth(b.id, year, month0) })),
  );
  const byBooker = new Map(progress.map((p) => [p.id, p.month]));
  const targetFor = new Map(targets.map((t) => [t.bookerId, t]));

  const users: UserAdmin[] = userRows.map((u) => ({
    id: u.id,
    username: u.username,
    name: u.name,
    role: u.role === "admin" ? "admin" : "booker",
    bookerId: u.bookerId,
    bookerName: u.booker?.name ?? null,
    isActive: u.isActive,
  }));

  const targetRows: TargetRow[] = bookers.map((b) => {
    const t = targetFor.get(b.id);
    const done = byBooker.get(b.id);
    return {
      bookerId: b.id,
      name: b.name,
      amount: t?.amount == null ? null : Number(t.amount),
      packs: t?.packs ?? null,
      notes: t?.notes ?? null,
      bookedSoFar: done?.booked ?? 0,
      packsSoFar: done?.packs ?? 0,
    };
  });

  return (
    <div>
      <PageHeader
        title="Users"
        description="Who can sign in, what they can see, and what they are working towards."
      />

      {bookers.length === 0 ? (
        <Alert tone="info" className="mb-4">
          There are no bookers yet. Add them on the{" "}
          <Link href="/bookers" className="font-medium underline">
            Bookers
          </Link>{" "}
          page first - an account has to be linked to one before it has any orders of its own.
        </Alert>
      ) : null}

      <UserManager users={users} bookers={bookers} selfId={me.id} />

      <div className="mt-8">
        <PageHeader
          title="Targets"
          description={`What each booker is working to in ${label}. They see this on their own page.`}
          action={
            <div className="flex items-center gap-1.5">
              <Button variant="outline" size="icon" asChild title="Previous month">
                <Link href={step(year, month0, -1)}>
                  <ChevronLeft className="h-4 w-4" />
                  <span className="sr-only">Previous month</span>
                </Link>
              </Button>
              <span className="min-w-[9rem] text-center text-sm font-medium">{label}</span>
              <Button variant="outline" size="icon" asChild title="Next month">
                <Link href={step(year, month0, 1)}>
                  <ChevronRight className="h-4 w-4" />
                  <span className="sr-only">Next month</span>
                </Link>
              </Button>
            </div>
          }
        />

        <TargetBoard month={monthStart.toISOString().slice(0, 10)} rows={targetRows} />
      </div>
    </div>
  );
}
