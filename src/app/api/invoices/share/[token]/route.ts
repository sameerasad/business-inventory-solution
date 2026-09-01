import { NextResponse } from "next/server";

import { prisma } from "@/lib/db";
import { getInvoice } from "@/lib/bookings";
import { invoiceFileName, renderInvoicePdf } from "@/lib/invoice-pdf";

/**
 * The invoice PDF, addressed by its random share token rather than its id.
 *
 * This is the URL that goes to customers (over WhatsApp, email, anywhere). Using
 * the token means a recipient cannot change a number in the URL and read someone
 * else's invoice, which /api/invoices/<id> would allow.
 */
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;

  // Cheap shape check before touching the database.
  if (!token || token.length < 16 || token.length > 64 || !/^[A-Za-z0-9_-]+$/.test(token)) {
    return new NextResponse("Not found", { status: 404 });
  }

  const booking = await prisma.booking.findUnique({
    where: { shareToken: token },
    select: { id: true },
  });
  if (!booking) return new NextResponse("Not found", { status: 404 });

  const invoice = await getInvoice(booking.id);
  if (!invoice) return new NextResponse("Not found", { status: 404 });

  try {
    const pdf = await renderInvoicePdf(invoice);
    return new NextResponse(Buffer.from(pdf), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        // inline: phones preview it in the browser, which is friendlier than a
        // download for someone opening a link from a chat.
        "Content-Disposition": `inline; filename="${invoiceFileName(invoice)}"`,
        "Content-Length": String(pdf.byteLength),
        "Cache-Control": "no-store",
        // A shared invoice should not end up in search results.
        "X-Robots-Tag": "noindex, nofollow",
      },
    });
  } catch (error) {
    console.error(`Failed to render shared invoice ${booking.id}`, error);
    return new NextResponse("Could not generate the invoice PDF", { status: 500 });
  }
}
