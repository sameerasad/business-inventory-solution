"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { MessageCircle } from "lucide-react";

import { getInvoiceShareData } from "@/actions/bookings";
import { saveShopPhoneAction } from "@/actions/areas";
import { emptyActionState } from "@/lib/validations";
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

  /**
   * Remembering the number against the shop.
   *
   * Of sixty-five shops not one had a number stored, so this dialog had nothing
   * to fill in and every invoice meant typing it again. The numbers were being
   * typed - forty-eight orders carry one - and then forgotten on the order.
   *
   * Not done automatically from those orders, and the data says why: the same
   * number sits against ten different shops, which is what a test number or the
   * owner's own phone looks like. Copying that onto ten shops would send
   * somebody's invoice to a stranger. So it is a tick, not a rule.
   */
  const [remember, setRemember] = useState(false);
  const [saveNote, setSaveNote] = useState<string | null>(null);

  // Filled from the server copy as well as the row, so a page that forgets to
  // pass the numbers still gets them.
  useEffect(() => {
    if (!data) return;
    setPhone((current) => current.trim() || data.customerPhone || data.shopPhone || "");
  }, [data]);

  const shopAlreadyHasIt = (() => {
    if (!data?.shopPhone || !parsedPhone.ok) return false;
    const stored = normalisePhone(data.shopPhone);
    return stored.ok && stored.e164 === parsedPhone.e164;
  })();
  const canRemember = Boolean(data?.shopId) && parsedPhone.ok && !shopAlreadyHasIt;

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
      paid: data.paid,
      balance: data.balance,
      companyWhatsApp: data.companyWhatsApp,
      pdfUrl: `${origin}/api/invoices/share/${data.token}`,
    });
  }, [data]);

  const waUrl = parsedPhone.ok && message ? buildWhatsAppUrl(parsedPhone.e164, message) : "";
  const tooLong = waUrl ? urlTooLong(waUrl) : false;
  const canSend = Boolean(waUrl) && !tooLong;

  const send = () => {
    if (!canSend) return;

    // Opened first and awaited after. A browser only allows window.open from
    // the click that caused it, so putting a round trip in front of it gets the
    // new tab blocked as a popup - and the person loses the message to save a
    // number they did not ask to save.
    window.open(waUrl, "_blank", "noopener,noreferrer");

    if (remember && canRemember && data?.shopId) {
      const form = new FormData();
      form.set("shopId", String(data.shopId));
      form.set("phone", parsedPhone.e164);
      void saveShopPhoneAction(emptyActionState, form).then((r) => setSaveNote(r.message));
    }
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

        {canRemember ? (
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-0.5"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
            />
            <span>
              Remember this number for{" "}
              <span className="font-medium">{data?.shopName ?? "this shop"}</span>
              <span className="block text-xs text-muted-foreground">
                {data?.shopPhone
                  ? "Replaces the number saved against the shop."
                  : "Nothing is saved against the shop yet, so the next invoice would need it typed again."}
              </span>
            </span>
          </label>
        ) : null}

        {saveNote ? <Alert tone="success">{saveNote}</Alert> : null}

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
