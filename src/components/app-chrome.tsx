"use client";

import { usePathname } from "next/navigation";

/**
 * The header, footer and voice button - everywhere except the sign-in page.
 *
 * A login screen carrying a full navigation bar is a row of links that all
 * bounce straight back to it, and a microphone button for an app nobody is
 * signed in to. The page is also the only one in the app that wants the whole
 * viewport rather than the padded column every table sits in, so the main
 * wrapper is decided here too.
 *
 * A client component only because the root layout cannot see the path. It
 * renders nothing of its own beyond that decision.
 */
export function AppChrome({
  header,
  footer,
  voice,
  children,
}: {
  header: React.ReactNode;
  footer: React.ReactNode;
  voice: React.ReactNode;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  if (pathname === "/login") return <>{children}</>;

  return (
    <>
      {header}
      <main className="mx-auto max-w-[1400px] px-4 py-6 sm:px-6">{children}</main>
      {voice}
      {footer}
    </>
  );
}
