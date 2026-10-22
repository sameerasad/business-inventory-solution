import { NextResponse, type NextRequest } from "next/server";

import { SESSION_COOKIE, authConfigured, sessionValid } from "@/lib/auth";

/**
 * The gate.
 *
 * Everything is closed except the few things that have to be open, rather than
 * the other way round - a list of protected pages is a list somebody forgets
 * to add to, and the page they forget is the one that moves money.
 *
 * The one genuinely public thing is the invoice share link. A customer opens
 * it from a WhatsApp message and has no account and never will; breaking that
 * would quietly stop every invoice this business sends from being readable.
 * It is safe to leave open because it is addressed by a random token rather
 * than an invoice number, so it cannot be walked.
 */
const PUBLIC = [
  "/login",
  // Sent to customers. Random token, not an id - see getInvoiceShareToken.
  "/api/invoices/share/",
];

export function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  if (PUBLIC.some((p) => pathname === p || pathname.startsWith(p))) {
    return NextResponse.next();
  }

  return guard(request, pathname, search);
}

async function guard(request: NextRequest, pathname: string, search: string) {
  // A server with no password set cannot let anyone in. Locked, not open: an
  // auth gate that fails open is decoration.
  if (!authConfigured()) return redirectToLogin(request, pathname, search);

  const ok = await sessionValid(request.cookies.get(SESSION_COOKIE)?.value);
  if (ok) return NextResponse.next();

  // An API call gets a status, not a login page: a fetch following a redirect
  // into HTML is a confusing failure to debug.
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Not signed in." }, { status: 401 });
  }
  return redirectToLogin(request, pathname, search);
}

function redirectToLogin(request: NextRequest, pathname: string, search: string) {
  const url = request.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  // Where they were going, so signing in does not dump them on the dashboard
  // when they clicked a link to one invoice.
  if (pathname !== "/") url.searchParams.set("next", pathname + search);
  return NextResponse.redirect(url);
}

export const config = {
  /**
   * Everything except Next's own assets and the favicon. Written as an
   * exclusion so a new page is protected the day it is added rather than the
   * day somebody notices it was not.
   */
  matcher: ["/((?!_next/static|_next/image|favicon.ico|icon.png|apple-icon.png).*)"],
};
