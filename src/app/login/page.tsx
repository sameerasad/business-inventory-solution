import type { Metadata } from "next";

import { LoginForm } from "@/components/login-form";
import { authConfigured } from "@/lib/auth";
import { business, businessInitials } from "@/lib/business";

export const metadata: Metadata = { title: "Sign in" };
export const dynamic = "force-dynamic";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const nextRaw = Array.isArray(sp.next) ? sp.next[0] : sp.next;
  // Only ever a path inside this app. An absolute URL here would make the
  // login page a redirector to anywhere, which is where that trick is used.
  const next = nextRaw?.startsWith("/") && !nextRaw.startsWith("//") ? nextRaw : "";

  const biz = business();

  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-sm space-y-6">
        <div className="flex items-center gap-3">
          <span className="flex h-11 w-11 items-center justify-center rounded-lg bg-primary text-sm font-semibold text-primary-foreground">
            {businessInitials(biz.name)}
          </span>
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">{biz.name}</p>
            <p className="text-xs text-muted-foreground">Inventory &amp; profit</p>
          </div>
        </div>

        {authConfigured() ? (
          <LoginForm next={next} />
        ) : (
          /* Said plainly rather than shown as a wrong password. A deploy that
             forgot the environment variables looks exactly like a forgotten
             password otherwise, and that is an hour of the wrong search. */
          <div className="space-y-2 rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm">
            <p className="font-medium text-destructive">This server cannot sign anyone in.</p>
            <p className="text-muted-foreground">
              <code className="font-mono text-xs">AUTH_SECRET</code> is missing from the
              environment. It signs the session cookie, and without it a sign-in cannot be
              remembered. Set it and deploy again.
            </p>
          </div>
        )}
      </div>
    </main>
  );
}
