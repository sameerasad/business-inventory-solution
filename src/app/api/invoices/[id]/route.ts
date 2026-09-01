import { NextResponse } from "next/server";

import { getInvoice } from "@/lib/bookings";
import { invoiceFileName, renderInvoicePdf } from "@/lib/invoice-pdf";

// The PDF is built from live data on every request, so a corrected price or a
// cancelled booking is reflected immediately.
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const bookingId = Number.parseInt(id, 10);
  if (!Number.isInteger(bookingId) || bookingId <= 0) {
    return new NextResponse("Invalid invoice id", { status: 400 });
  }

  const invoice = await getInvoice(bookingId);
  if (!invoice) {
    return new NextResponse("Invoice not found", { status: 404 });
  }

  try {
    const pdf = await renderInvoicePdf(invoice);
    return new NextResponse(Buffer.from(pdf), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        // attachment => the browser downloads it instead of previewing.
        "Content-Disposition": `attachment; filename="${invoiceFileName(invoice)}"`,
        "Content-Length": String(pdf.byteLength),
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    console.error(`Failed to render invoice ${bookingId}`, error);
    return new NextResponse("Could not generate the invoice PDF", { status: 500 });
  }
}
