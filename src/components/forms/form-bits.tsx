"use client";

import { useEffect, useState } from "react";
import { Loader2 } from "lucide-react";

import { Button, type ButtonProps } from "@/components/ui/button";

export function SubmitButton({
  pending,
  children,
  pendingLabel = "Saving...",
  ...props
}: ButtonProps & { pending: boolean; pendingLabel?: string }) {
  return (
    <Button type="submit" disabled={pending || props.disabled} {...props}>
      {pending ? (
        <>
          <Loader2 className="h-4 w-4 animate-spin" />
          {pendingLabel}
        </>
      ) : (
        children
      )}
    </Button>
  );
}

/**
 * Mints a fresh idempotency key for the form and returns a rotate() to call after
 * a successful save.
 *
 * The key is generated in an effect rather than during render on purpose: a value
 * generated during render would differ between the server and client passes and
 * trip a hydration mismatch. Until the effect runs the hidden field is empty,
 * which the server action tolerates - the key is a safety net for double
 * submits, not a requirement.
 */
export function useIdempotencyKey(): { key: string; rotate: () => void } {
  const [key, setKey] = useState("");

  useEffect(() => {
    setKey(newKey());
  }, []);

  return { key, rotate: () => setKey(newKey()) };
}

function newKey(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
}
