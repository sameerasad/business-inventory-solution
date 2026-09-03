"use client";

import { useActionState, useEffect, useState, useTransition } from "react";
import { Pencil, Trash2, Wallet } from "lucide-react";

import {
  deletePaymentAction,
  getPaymentDetails,
  recordPaymentAction,
  updatePaymentAction,
} from "@/actions/payments";
import { emptyActionState } from "@/lib/validations";
import { dateOnly, money, todayInputValue } from "@/lib/format";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
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
import { SubmitButton, useIdempotencyKey } from "@/components/forms/form-bits";

type Details = Awaited<ReturnType<typeof getPaymentDetails>>;

export function PaymentStatusBadge({
  total,
  paid,
}: {
  total: number;
  paid: number;
}) {
  const CENT = 0.005;
  if (paid <= CENT) return <Badge variant="destructive">Unpaid</Badge>;
  if (paid >= total - CENT) return <Badge variant="success">Paid</Badge>;
  return <Badge variant="default">Partial</Badge>;
}

/**
 * Record money received against a booking, and see what has come in so far.
 *
 * Payments never touch stock or revenue - the sale happened when the goods went
 * out. This is only the cash arriving, which is why a booking can be delivered
 * and unpaid at the same time.
 */
export function PaymentDialog({
  bookingId,
  invoiceNo,
  total,
  paid,
}: {
  bookingId: number;
  invoiceNo: string;
  total: number;
  paid: number;
}) {
  const [open, setOpen] = useState(false);
  const [details, setDetails] = useState<Details>(null);
  const [loading, startLoad] = useTransition();

  const [amount, setAmount] = useState("");
  const [paidOn, setPaidOn] = useState(todayInputValue);
  const [method, setMethod] = useState("");

  const [state, formAction, isPending] = useActionState(recordPaymentAction, emptyActionState);
  const { key: idempotencyKey, rotate } = useIdempotencyKey();

  const load = () => {
    startLoad(async () => {
      const result = await getPaymentDetails(bookingId);
      setDetails(result);
    });
  };

  useEffect(() => {
    if (open && details === null) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // After a successful save, clear the form and reload the history so the new
  // balance is on screen rather than a stale one.
  useEffect(() => {
    if (state.ok) {
      setAmount("");
      setMethod("");
      rotate();
      load();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  const balance = details ? details.balance : Math.max(0, total - paid);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
        aria-label={`Payments for ${invoiceNo}`}
      >
        <Wallet className="h-3.5 w-3.5" />
        Payment
      </Button>

      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Payments for {invoiceNo}</DialogTitle>
          <DialogDescription>
            Recording a payment does not change stock or revenue - the sale was recorded when the
            goods went out. This is the cash arriving.
          </DialogDescription>
        </DialogHeader>

        {state.message ? (
          <Alert tone={state.ok ? "success" : "error"}>{state.message}</Alert>
        ) : null}

        <div className="grid grid-cols-3 gap-3 rounded-md bg-muted p-3 text-sm">
          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Invoice total</p>
            <p className="num font-semibold">{money(details?.total ?? total)}</p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Paid</p>
            <p className="num font-semibold" style={{ color: "#006300" }}>
              {money(details?.paid ?? paid)}
            </p>
          </div>
          <div>
            <p className="text-xs uppercase tracking-wide text-muted-foreground">Balance</p>
            <p
              className="num font-semibold"
              style={{ color: balance > 0.005 ? "#d03b3b" : "#006300" }}
            >
              {money(balance)}
            </p>
          </div>
        </div>

        {/* ------------------------------------------------------ history */}
        <div className="space-y-1.5">
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Received so far
          </span>
          {loading && details === null ? (
            <p className="text-sm text-muted-foreground">Loading...</p>
          ) : details && details.payments.length > 0 ? (
            <ul className="divide-y rounded-md border">
              {details.payments.map((p) => (
                <li key={p.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                  <span className="flex min-w-0 flex-col">
                    <span className="num font-medium">{money(p.amount)}</span>
                    <span className="text-xs text-muted-foreground">
                      {dateOnly(p.paidOn)}
                      {p.method ? ` · ${p.method}` : ""}
                      {p.notes ? ` · ${p.notes}` : ""}
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-0.5">
                    <EditPaymentButton
                      payment={{
                        id: p.id,
                        amount: p.amount,
                        paidOn: dateOnly(p.paidOn),
                        method: p.method,
                        notes: p.notes,
                      }}
                      // Room for this payment is the invoice value less the
                      // OTHER payments, which is the balance plus its own
                      // amount - not the balance, or it could never be raised.
                      maxAmount={balance + p.amount}
                      onDone={load}
                    />
                    <ReversePaymentButton paymentId={p.id} onDone={load} />
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">
              Nothing received yet - this invoice is unpaid.
            </p>
          )}
        </div>

        {/* ------------------------------------------------- record a payment */}
        {balance > 0.005 ? (
          <form action={formAction} className="space-y-3 border-t pt-4">
            <input type="hidden" name="bookingId" value={bookingId} />
            <input type="hidden" name="idempotencyKey" value={idempotencyKey} />

            <div className="grid gap-3 sm:grid-cols-3">
              <Field
                label="Amount"
                htmlFor={`pay-amount-${bookingId}`}
                required
                error={state.fieldErrors.amount}
                hint={`Up to ${money(balance)}`}
              >
                <Input
                  id={`pay-amount-${bookingId}`}
                  name="amount"
                  type="number"
                  inputMode="decimal"
                  min={0}
                  step="0.01"
                  max={balance}
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="0"
                  disabled={isPending}
                  required
                />
              </Field>

              <Field
                label="Received on"
                htmlFor={`pay-date-${bookingId}`}
                required
                error={state.fieldErrors.paidOn}
              >
                <Input
                  id={`pay-date-${bookingId}`}
                  name="paidOn"
                  type="date"
                  value={paidOn}
                  onChange={(e) => setPaidOn(e.target.value)}
                  disabled={isPending}
                  required
                />
              </Field>

              <Field label="Method" htmlFor={`pay-method-${bookingId}`} error={state.fieldErrors.method}>
                <Input
                  id={`pay-method-${bookingId}`}
                  name="method"
                  list={`pay-methods-${bookingId}`}
                  value={method}
                  onChange={(e) => setMethod(e.target.value)}
                  placeholder="Cash"
                  disabled={isPending}
                />
                <datalist id={`pay-methods-${bookingId}`}>
                  <option value="Cash" />
                  <option value="Bank transfer" />
                  <option value="Cheque" />
                  <option value="Easypaisa" />
                  <option value="JazzCash" />
                </datalist>
              </Field>
            </div>

            <div className="flex items-center gap-2">
              <SubmitButton pending={isPending} pendingLabel="Recording...">
                Record payment
              </SubmitButton>
              <Button
                type="button"
                variant="outline"
                onClick={() => setAmount(balance.toFixed(2))}
                disabled={isPending}
              >
                Paid in full
              </Button>
            </div>
          </form>
        ) : (
          <Alert tone="success">This invoice is fully paid.</Alert>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => setOpen(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ReversePaymentButton({
  paymentId,
  onDone,
}: {
  paymentId: number;
  onDone: () => void;
}) {
  const [state, formAction, isPending] = useActionState(deletePaymentAction, emptyActionState);

  useEffect(() => {
    if (state.ok) onDone();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  return (
    <form action={formAction}>
      <input type="hidden" name="id" value={paymentId} />
      <Button
        type="submit"
        variant="ghost"
        size="sm"
        disabled={isPending}
        aria-label="Reverse this payment"
        title="Reverse this payment (mistyped amount, bounced cheque)"
      >
        <Trash2 className="h-3.5 w-3.5" />
      </Button>
    </form>
  );
}

/**
 * Correct a recorded payment: amount, date, method, note.
 *
 * The date is as important as the amount. Revenue is recognised when the money
 * arrives, dated by the payment, so fixing a date moves that revenue between
 * months on the dashboard - which is the point.
 *
 * Reversing and re-recording would also work, but it leaves two entries for one
 * event and makes a mistyped amount look like a refund.
 */
function EditPaymentButton({
  payment,
  maxAmount,
  onDone,
}: {
  payment: {
    id: number;
    amount: number;
    paidOn: string;
    method: string | null;
    notes: string | null;
  };
  maxAmount: number;
  onDone: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [state, formAction, isPending] = useActionState(updatePaymentAction, emptyActionState);

  useEffect(() => {
    if (state.ok) {
      setOpen(false);
      onDone();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state]);

  if (!open) {
    return (
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => setOpen(true)}
        aria-label="Edit this payment"
        title="Edit this payment (wrong amount or wrong date)"
      >
        <Pencil className="h-3.5 w-3.5" />
      </Button>
    );
  }

  return (
    <form action={formAction} className="w-full space-y-2 py-1">
      <input type="hidden" name="id" value={payment.id} />

      {state.message && !state.ok ? <Alert tone="error">{state.message}</Alert> : null}

      <div className="grid gap-2 sm:grid-cols-3">
        <Field
          label="Amount"
          htmlFor={`pe-amt-${payment.id}`}
          required
          error={state.fieldErrors.amount}
          hint={`Up to ${money(maxAmount)}`}
        >
          <Input
            id={`pe-amt-${payment.id}`}
            name="amount"
            type="number"
            min={0}
            step="0.01"
            defaultValue={payment.amount.toFixed(2)}
            disabled={isPending}
            required
          />
        </Field>
        <Field
          label="Received on"
          htmlFor={`pe-date-${payment.id}`}
          required
          error={state.fieldErrors.paidOn}
        >
          <Input
            id={`pe-date-${payment.id}`}
            name="paidOn"
            type="date"
            defaultValue={payment.paidOn}
            disabled={isPending}
            required
          />
        </Field>
        <Field label="Method" htmlFor={`pe-method-${payment.id}`} error={state.fieldErrors.method}>
          <Input
            id={`pe-method-${payment.id}`}
            name="method"
            defaultValue={payment.method ?? ""}
            placeholder="Cash"
            disabled={isPending}
          />
        </Field>
      </div>

      <Field label="Note" htmlFor={`pe-notes-${payment.id}`} error={state.fieldErrors.notes}>
        <Input
          id={`pe-notes-${payment.id}`}
          name="notes"
          defaultValue={payment.notes ?? ""}
          disabled={isPending}
        />
      </Field>

      <div className="flex items-center gap-2">
        <SubmitButton pending={isPending}>Save payment</SubmitButton>
        <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </form>
  );
}
