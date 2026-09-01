"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { MessageCircle } from "lucide-react";

import { getInvoiceShareData } from "@/actions/bookings";
import {
  buildInvoiceMessage,
  buildWhatsAppUrl,
  normalisePhone,
  urlTooLong,
} from "@/lib/whatsapp";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

type ShareData = Awaited<ReturnType<typeof getInvoiceShareData>>;

/**
 * "Send this invoice on WhatsApp".
 *
 * WhatsApp click-to-chat can only pre-fill text, never an attachment, so the
 * message carries the order summary plus a link to the PDF. Pressing the button
 * opens WhatsApp with everything filled in; the user still taps Send, which is
 * a feature rather than a limitation - nothing reaches a customer without a
 * human looking at it first.
 *
 * The link uses the booking's random share token, not its id, so a recipient
 * cannot edit the URL to read someone else's invoice.
 */
export function WhatsAppShareDialog({
  bookingId,
  invoiceNo,
  customerPhone,
  shopPhone,
}: {
  bookingId: number;
  invoiceNo: string;
  customerPhone: string | null;
  shopPhone: string | null;
}) {
  const [open, setOpen] = useState(false);
  // Prefer the number typed on this order; fall back to the shop's stored one.
  const [phone, setPhone] = useState(customerPhone ?? shopPhone ?? "");
  const [data, setData] = useState<ShareData>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, startLoad] = useTransition();

  // Loaded when the dialog opens, not on every row of the page.
  useEffect(() => {
    if (!open || data !== null) return;
    startLoad(async () => {
      const result = await getInvoiceShareData(bookingId);
      if (result) setData(result);
      else setError("Could not prepare a share link for this invoice.");
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const parsedPhone = useMemo(() => normalisePhone(phone), [phone]);

  const message = useMemo(() => {
    if (!data) return "";
    // window.location.origin is whatever host the user is actually on, so this
    // works on localhost and on the deployed domain with no configuration.
    const origin = typeof window === "undefined" ? "" : window.location.origin;
    return buildInvoiceMessage({
      invoiceNo: data.invoiceNo,
      businessName: data.businessName,
      bookingDate: data.bookingDate,
      customerName: data.customerName,
      shopName: data.shopName,
      lines: data.lines,
      total: data.total,
      totalUnits: data.totalUnits,
      pdfUrl: `${origin}/api/invoices/share/${data.token}`,
    });
  }, [data]);

  const waUrl = parsedPhone.ok && message ? buildWhatsAppUrl(parsedPhone.e164, message) : "";
  const tooLong = waUrl ? urlTooLong(waUrl) : false;
  const canSend = Boolean(waUrl) && !tooLong;

  const send = () => {
    if (!canSend) return;
    // A new tab, so the app stays put if WhatsApp Web opens.
    window.open(waUrl, "_blank", "noopener,noreferrer");
    setOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
        aria-label={`Send invoice ${invoiceNo} on WhatsApp`}
      >
        <MessageCircle className="h-3.5 w-3.5" />
        WhatsApp
      </Button>

      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Send {invoiceNo} on WhatsApp</DialogTitle>
          <DialogDescription>
            WhatsApp opens with this message ready and you press Send. The invoice travels as a
            download link, because a WhatsApp link cannot carry an attachment.
          </DialogDescription>
        </DialogHeader>

        {error ? <Alert tone="error">{error}</Alert> : null}

        <Field
          label="Send to"
          htmlFor={`wa-phone-${bookingId}`}
          error={phone.trim() && !parsedPhone.ok ? parsedPhone.reason : undefined}
          hint={
            parsedPhone.ok
              ? `Will open a chat with ${parsedPhone.display}`
              : customerPhone
                ? "From this order. Change it to send elsewhere."
                : shopPhone
                  ? "From the shop record. Change it to send elsewhere."
                  : "No number saved on this order or shop - type one."
          }
        >
          <Input
            id={`wa-phone-${bookingId}`}
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="e.g. 0300-1234567"
            inputMode="tel"
            aria-invalid={phone.trim() && !parsedPhone.ok ? true : undefined}
            autoFocus
          />
        </Field>

        <div className="space-y-1.5">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Message preview
          </span>
          <pre className="max-h-60 overflow-auto whitespace-pre-wrap rounded-md border bg-muted p-3 text-xs leading-relaxed">
            {loading || !message ? "Preparing the share link..." : message}
          </pre>
        </div>

        {tooLong ? (
          <Alert tone="error">
            This order is too long for a WhatsApp link. Download the PDF and attach it manually
            instead.
          </Alert>
        ) : null}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button type="button" onClick={send} disabled={!canSend || loading}>
            <MessageCircle className="h-4 w-4" />
            Open WhatsApp
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
