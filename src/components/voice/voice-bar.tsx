"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { AlertTriangle, Check, Loader2, Mic, MicOff, Square, X } from "lucide-react";

import { interpretVoiceAction, type VoiceResult } from "@/actions/voice";
import { createBookingAction } from "@/actions/bookings";
import { recordPaymentAction } from "@/actions/payments";
import { createBatchAction } from "@/actions/batches";
import { createSaleAction } from "@/actions/sales";
import { Input } from "@/components/ui/input";
import { emptyActionState, type ActionState } from "@/lib/validations";
import { Alert } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { speak, useSpeech, type SpeechLang } from "@/components/voice/use-speech";
import { cn } from "@/lib/utils";

const LANG_KEY = "voice-lang";

const EXAMPLES: Record<SpeechLang, string[]> = {
  "en-PK": [
    "open receivables",
    "how much profit today",
    "sell twenty packs mango bottle 250 to Corner Store",
    "payment received 5000 from Corner Store",
  ],
  "ur-PK": [
    "bookings kholo",
    "aaj ka munafa kitna hai",
    "bees packs aam bottle 250 Corner Store ko bech do",
    "invoice 12 ka paanch hazar aa gaya",
  ],
};

/**
 * Voice control.
 *
 * The rule that shapes all of this: speaking can NAVIGATE and can ASK, both of
 * which change nothing, and those happen immediately. Anything that writes -
 * an order, a payment - is only ever filled in for you, and you press the
 * button. Speech recognition confuses fifteen and fifty, and this app moves
 * stock and money.
 */
export function VoiceBar() {
  const router = useRouter();
  const [lang, setLang] = useState<SpeechLang>("en-PK");
  const [result, setResult] = useState<VoiceResult | null>(null);
  const [thinking, setThinking] = useState(false);
  const [typed, setTyped] = useState("");
  const [saveState, setSaveState] = useState<ActionState | null>(null);
  const [saving, setSaving] = useState(false);

  // Remembered per browser: whoever uses this device mostly speaks one language.
  useEffect(() => {
    try {
      const saved = window.localStorage.getItem(LANG_KEY);
      if (saved === "en-PK" || saved === "ur-PK") setLang(saved);
    } catch {
      // Private mode or blocked storage; the default is fine.
    }
  }, []);

  const chooseLang = (next: SpeechLang) => {
    setLang(next);
    try {
      window.localStorage.setItem(LANG_KEY, next);
    } catch {
      // Not worth surfacing - it only affects the next visit.
    }
  };

  const handleFinal = useCallback(
    async (said: string) => {
      setThinking(true);
      setSaveState(null);
      try {
        const interpreted = await interpretVoiceAction(said);
        setResult(interpreted);

        // Safe to act on at once: neither changes anything.
        if (interpreted.command.kind === "navigate") {
          router.push(interpreted.command.href);
        } else if (interpreted.answer) {
          speak(interpreted.answer.speech, lang);
        }
      } finally {
        setThinking(false);
      }
    },
    [lang, router],
  );

  const { supported, state, transcript, error, start, stop } = useSpeech({
    lang,
    onFinal: handleFinal,
  });

  const listening = state === "listening";
  const command = result?.command;

  return (
    <Card className="mb-4 overflow-hidden">
      <div className="flex flex-wrap items-center gap-3 p-4">
        {supported ? (
          <Button
            type="button"
            onClick={listening ? stop : start}
            disabled={thinking}
            variant={listening ? "destructive" : "default"}
            className="h-11 min-w-[150px]"
          >
            {listening ? (
              <>
                <Square className="h-4 w-4" />
                Stop
              </>
            ) : thinking ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Working
              </>
            ) : (
              <>
                <Mic className="h-4 w-4" />
                Speak
              </>
            )}
          </Button>
        ) : null}

        {/* One engine per language: the browser cannot detect which is being
            spoken, so it has to be told. */}
        {supported ? (
          <div role="group" aria-label="Language" className="inline-flex rounded-md border p-0.5">
            {(
              [
                ["en-PK", "English"],
                ["ur-PK", "اردو"],
              ] as const
            ).map(([value, label]) => (
              <button
                key={value}
                type="button"
                onClick={() => chooseLang(value)}
                aria-pressed={lang === value}
                disabled={listening}
                className={cn(
                  "rounded-[5px] px-3 py-1.5 text-sm font-medium transition-colors",
                  lang === value
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {label}
              </button>
            ))}
          </div>
        ) : null}

        <p aria-live="polite" className="min-w-0 flex-1 text-sm">
          {listening ? (
            <span className="text-muted-foreground">{transcript || "Listening..."}</span>
          ) : result ? (
            <span>
              <span className="text-muted-foreground">Heard: </span>
              &ldquo;{result.transcript}&rdquo;
            </span>
          ) : (
            <span className="text-muted-foreground">Try: &ldquo;{EXAMPLES[lang][0]}&rdquo;</span>
          )}
        </p>

        {result ? (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            aria-label="Clear"
            onClick={() => {
              setResult(null);
              setSaveState(null);
            }}
          >
            <X className="h-4 w-4" />
          </Button>
        ) : null}
      </div>

      {error ? (
        <div className="border-t px-4 py-3">
          <Alert tone="error">{error}</Alert>
        </div>
      ) : null}

      {/* Typing goes through exactly the same interpreter as speaking.
          It is here for three reasons: to check a phrasing without fighting a
          microphone, to fix one the microphone misheard, and so the whole
          feature still works in a browser with no speech support at all. */}
      <div className="border-t bg-muted/30 px-4 py-3">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const said = typed.trim();
            if (said.length > 0) void handleFinal(said);
          }}
          className="flex flex-wrap items-center gap-2"
        >
          <label htmlFor="voice-typed" className="text-xs font-medium text-muted-foreground">
            Or type it
          </label>
          <Input
            id="voice-typed"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={EXAMPLES[lang][2]}
            disabled={thinking}
            className="min-w-[220px] flex-1"
          />
          <Button type="submit" variant="outline" disabled={thinking || typed.trim().length === 0}>
            Run
          </Button>
        </form>
        {!supported ? (
          <p className="mt-2 text-xs text-muted-foreground">
            This browser has no speech recognition, so the microphone is hidden. Typing works
            exactly the same - it is the same interpreter.
          </p>
        ) : null}
      </div>

      {/* ----------------------------------------------------------- outcome */}
      {command && !listening ? (
        <div className="space-y-3 border-t bg-muted/40 px-4 py-3">
          {command.kind === "unknown" ? (
            <div>
              <Alert tone="info">{command.reason}</Alert>
              <p className="mt-2 text-xs text-muted-foreground">
                Things that work:{" "}
                {EXAMPLES[lang].map((e, i) => (
                  <span key={e}>
                    {i > 0 ? " · " : ""}
                    <span className="font-medium">&ldquo;{e}&rdquo;</span>
                  </span>
                ))}
              </p>
            </div>
          ) : null}

          {command.kind === "navigate" ? (
            <p className="text-sm">
              Opening <span className="font-medium">{command.label}</span>.
            </p>
          ) : null}

          {result?.answer ? (
            <div className="flex flex-wrap items-baseline gap-x-3">
              <span className="num text-2xl font-semibold">{result.answer.value}</span>
              <span className="text-sm text-muted-foreground">{result.answer.label}</span>
              <Link href={result.answer.href} className="text-sm font-medium underline">
                See the detail
              </Link>
            </div>
          ) : null}

          {command.kind === "booking" ||
          command.kind === "payment" ||
          command.kind === "batch" ||
          command.kind === "sale" ? (
            <ConfirmWrite
              command={command}
              saving={saving}
              saveState={saveState}
              onSave={async (formData) => {
                setSaving(true);
                try {
                  const action = ACTIONS[command.kind];
                  const outcome = await action(emptyActionState, formData);
                  setSaveState(outcome);
                  if (outcome.ok) router.refresh();
                } finally {
                  setSaving(false);
                }
              }}
            />
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}

/**
 * Every write goes through the SAME server action a typed form uses, so voice
 * gets no shortcut around validation, stock checks or the audit trail.
 */
const ACTIONS = {
  booking: createBookingAction,
  payment: recordPaymentAction,
  batch: createBatchAction,
  sale: createSaleAction,
} as const;

/**
 * The confirmation step for anything that writes.
 *
 * It shows what was understood, what had to be assumed, and what is still
 * missing - then hands off to the SAME server action a typed form would use, so
 * voice gets no shortcut around validation, stock checks or the audit trail.
 */
function ConfirmWrite({
  command,
  saving,
  saveState,
  onSave,
}: {
  command: Extract<VoiceResult["command"], { kind: "booking" | "payment" | "batch" | "sale" }>;
  saving: boolean;
  saveState: ActionState | null;
  onSave: (formData: FormData) => Promise<void>;
}) {
  const blocked = command.missing.length > 0;

  const submit = () => {
    const form = new FormData();
    if (command.kind === "booking") {
      form.set("bookingDate", command.date);
      form.set("areaId", String(command.areaId ?? ""));
      if (command.shopId != null) form.set("shopId", String(command.shopId));
      if (command.bookerId != null) form.set("bookerId", String(command.bookerId));
      form.set(
        "lines",
        JSON.stringify(
          command.lines.map((l) => ({
            productId: l.productId,
            quantity: l.quantity,
            unitPrice: l.unitPrice,
          })),
        ),
      );
      // A key per proposal, so pressing Save twice cannot book twice.
      form.set(
        "idempotencyKey",
        `voice-${command.date}-${command.lines[0]?.productId}-${command.lines[0]?.quantity}-${command.areaId}`,
      );
    } else if (command.kind === "batch") {
      form.set("productId", String(command.productId));
      form.set("quantity", String(command.quantity));
      form.set("unitCost", String(command.unitCost ?? ""));
      form.set("receivedDate", command.date);
      form.set(
        "idempotencyKey",
        `voice-batch-${command.productId}-${command.quantity}-${command.unitCost}-${command.date}`,
      );
    } else if (command.kind === "sale") {
      form.set("productId", String(command.productId));
      form.set("quantity", String(command.quantity));
      form.set("salePrice", String(command.unitPrice));
      form.set("saleDate", command.date);
      form.set("areaId", String(command.areaId ?? ""));
      if (command.shopId != null) form.set("shopId", String(command.shopId));
      // A counter sale needs a batch, and voice does not choose batches - the
      // oldest one with stock is the same FIFO rule a booking uses.
      form.set("batchId", String(command.batchId ?? ""));
      form.set(
        "idempotencyKey",
        `voice-sale-${command.productId}-${command.quantity}-${command.date}`,
      );
    } else {
      form.set("bookingId", String(command.bookingId ?? ""));
      form.set("amount", String(command.amount ?? ""));
      form.set("paidOn", command.date);
      form.set("method", "Cash");
      form.set("idempotencyKey", `voice-${command.bookingId}-${command.amount}-${command.date}`);
    }
    void onSave(form);
  };

  return (
    <div className="space-y-3">
      <div className="rounded-md border bg-card p-3">
        <div className="mb-2 flex items-center gap-2">
          <Badge variant={command.confidence === "high" ? "success" : "outline"}>
            {KIND_LABEL[command.kind]}
          </Badge>
          {command.confidence === "low" ? (
            <span className="flex items-center gap-1 text-xs text-muted-foreground">
              <AlertTriangle className="h-3.5 w-3.5" />
              Check this before saving
            </span>
          ) : null}
        </div>

        <dl className="grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
          {command.kind === "booking" ? (
            <>
              {/* One row per line: a two-line order has to show both, or
                  confirming it would be confirming something unseen. */}
              {command.lines.map((line, i) => (
                <Row
                  key={`${line.sku}-${i}`}
                  label={command.lines.length > 1 ? `Line ${i + 1}` : "Product"}
                  value={`${line.quantity || "?"} x ${line.label} at ${line.unitPrice}`}
                  missing={!line.quantity}
                />
              ))}
              <Row
                label="Where"
                value={command.shopName ?? command.areaName ?? "missing"}
                missing={command.areaId == null}
              />
              <Row label="Date" value={command.date} />
              {command.bookerName ? <Row label="Booker" value={command.bookerName} /> : null}
              {command.lines.length > 1 ? (
                <Row
                  label="Order total"
                  value={String(
                    command.lines.reduce((sum, l) => sum + l.quantity * l.unitPrice, 0),
                  )}
                />
              ) : null}
            </>
          ) : command.kind === "batch" ? (
            <>
              <Row label="Product" value={command.label} />
              <Row
                label="Quantity"
                value={command.quantity ? String(command.quantity) : "missing"}
                missing={!command.quantity}
              />
              <Row
                label="Unit cost"
                value={command.unitCost == null ? "missing" : String(command.unitCost)}
                missing={command.unitCost == null}
              />
              <Row label="Received on" value={command.date} />
            </>
          ) : command.kind === "sale" ? (
            <>
              <Row label="Product" value={command.label} />
              <Row
                label="Quantity"
                value={command.quantity ? String(command.quantity) : "missing"}
                missing={!command.quantity}
              />
              <Row label="Price each" value={String(command.unitPrice)} />
              <Row
                label="Where"
                value={command.shopName ?? command.areaName ?? "missing"}
                missing={command.areaId == null}
              />
              <Row label="Date" value={command.date} />
            </>
          ) : (
            <>
              <Row
                label="Invoice"
                value={command.invoiceNo ?? "missing"}
                missing={command.invoiceNo == null}
              />
              <Row
                label="Amount"
                value={command.amount == null ? "missing" : String(command.amount)}
                missing={command.amount == null}
              />
              <Row label="Received on" value={command.date} />
            </>
          )}
        </dl>

        {command.warnings.length > 0 ? (
          <ul className="mt-2 space-y-0.5 border-t pt-2 text-xs text-muted-foreground">
            {command.warnings.map((w) => (
              <li key={w}>· {w}</li>
            ))}
          </ul>
        ) : null}
      </div>

      {saveState?.message ? (
        <Alert tone={saveState.ok ? "success" : "error"}>{saveState.message}</Alert>
      ) : null}

      {blocked ? (
        <Alert tone="info">
          {command.missing.join(" and ")} {command.missing.length === 1 ? "is" : "are"} missing, so
          this cannot be saved from here. Say it again in full, or use the{" "}
          <Link
            href={command.kind === "booking" ? "/bookings/new" : "/bookings"}
            className="font-medium underline"
          >
            {command.kind === "booking" ? "New Booking" : "Bookings"}
          </Link>{" "}
          page.
        </Alert>
      ) : (
        <div className="flex items-center gap-2">
          <Button type="button" onClick={submit} disabled={saving || saveState?.ok === true}>
            {saving ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Saving
              </>
            ) : (
              <>
                <Check className="h-4 w-4" />
                Save this {command.kind === "booking" ? "order" : "payment"}
              </>
            )}
          </Button>
          <span className="text-xs text-muted-foreground">
            Nothing is saved until you press this.
          </span>
        </div>
      )}
    </div>
  );
}

const KIND_LABEL = {
  booking: "Order",
  payment: "Payment",
  batch: "Stock in",
  sale: "Cash sale",
} as const;

function Row({ label, value, missing }: { label: string; value: string; missing?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 sm:justify-start">
      <dt className="shrink-0 text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className={cn("font-medium", missing && "text-destructive")}>
        {missing ? (
          <span className="flex items-center gap-1">
            <MicOff className="h-3.5 w-3.5" />
            {value}
          </span>
        ) : (
          value
        )}
      </dd>
    </div>
  );
}
