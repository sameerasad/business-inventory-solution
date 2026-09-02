import type { Metadata } from "next";
import Link from "next/link";

import "./globals.css";
import { NavActions, NavTabs } from "@/components/site-nav";
import { business, businessInitials } from "@/lib/business";

const { name: BUSINESS } = business();

export const metadata: Metadata = {
  title: {
    default: `${BUSINESS} · Inventory & Profit`,
    template: `%s · ${BUSINESS}`,
  },
  description:
    "Batch-level inventory, sales and dynamically calculated profit for a juice and chocolate manufacturing business.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    // suppressHydrationWarning covers attributes on THIS element only, not the
    // tree below it. Browser extensions (page rulers, dark-mode injectors,
    // translators) commonly stamp style variables onto <html> before React
    // hydrates, which React then reports as a mismatch even though the app
    // rendered correctly. Suppressing it here silences that class of false
    // positive while leaving real hydration errors in the app itself visible.
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-screen antialiased">
        {/* Two tiers: identity and the create actions on top, the list pages as
            tabs on the bottom border. One row could not hold eleven links
            without squeezing them, and a squeezed nav is where links go
            missing. Sticky, because the tables below are long. */}
        <header className="sticky top-0 z-40 border-b bg-card/90 backdrop-blur supports-[backdrop-filter]:bg-card/75">
          <div className="mx-auto max-w-[1400px] px-4 sm:px-6">
            <div className="flex h-14 items-center gap-3">
              <Link
                href="/dashboard"
                className="flex min-w-0 shrink items-center gap-2.5 rounded-md py-1 transition-opacity hover:opacity-80"
              >
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-primary text-[11px] font-bold tracking-tight text-primary-foreground">
                  {businessInitials(BUSINESS)}
                </span>
                {/* Truncated, not wrapped: a long business name must never push
                    the buttons around or split onto two lines. */}
                <span className="hidden min-w-0 leading-tight sm:block">
                  <span className="block truncate text-sm font-semibold tracking-tight">
                    {BUSINESS}
                  </span>
                  <span className="block text-[11px] text-muted-foreground">
                    Inventory &amp; profit
                  </span>
                </span>
              </Link>

              <div className="ml-auto shrink-0">
                <NavActions />
              </div>
            </div>

            <NavTabs />
          </div>
        </header>

        <main className="mx-auto max-w-[1400px] px-4 py-6 sm:px-6">{children}</main>

        <footer className="mx-auto max-w-[1400px] px-4 pb-8 text-xs text-muted-foreground sm:px-6">
          Profit is calculated on read as (sale price - batch unit cost) x quantity. It is never
          stored.
        </footer>
      </body>
    </html>
  );
}
