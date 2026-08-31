import type { Metadata } from "next";
import Link from "next/link";

import "./globals.css";
import { SiteNav } from "@/components/site-nav";

export const metadata: Metadata = {
  title: {
    default: "Inventory & Profit Tracking",
    template: "%s · Inventory & Profit",
  },
  description:
    "Batch-level inventory, sales and dynamically calculated profit for a juice and chocolate manufacturing business.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-screen antialiased">
        <header className="border-b bg-card">
          <div className="mx-auto flex max-w-[1400px] flex-col gap-3 px-4 py-3 sm:px-6 lg:flex-row lg:items-center lg:justify-between">
            <Link href="/dashboard" className="flex items-center gap-2">
              <span className="grid h-7 w-7 place-items-center rounded-md bg-primary text-xs font-bold text-primary-foreground">
                IP
              </span>
              <span className="text-sm font-semibold tracking-tight">Inventory &amp; Profit</span>
            </Link>
            <SiteNav />
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
