import * as React from "react";

import { cn } from "@/lib/utils";
import { Label } from "@/components/ui/label";

/**
 * Label + control + inline error, so every form row in the app has the same
 * spacing and the same place for a validation message.
 */
export function Field({
  label,
  htmlFor,
  error,
  hint,
  required,
  className,
  children,
}: {
  label: string;
  htmlFor?: string;
  error?: string;
  hint?: React.ReactNode;
  required?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <Label htmlFor={htmlFor}>
        {label}
        {required ? <span className="ml-0.5 text-destructive">*</span> : null}
      </Label>
      {children}
      {error ? (
        <p className="text-xs font-medium text-destructive">{error}</p>
      ) : hint ? (
        <p className="text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

/** Read-only derived value, e.g. the auto-populated SKU. */
export function ReadOnlyField({
  label,
  value,
  mono,
}: {
  label: string;
  value: React.ReactNode;
  mono?: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <div
        className={cn(
          "flex h-10 items-center rounded-md border border-dashed border-input bg-muted px-3 text-sm",
          mono && "font-mono",
          value ? "text-foreground" : "text-muted-foreground",
        )}
      >
        {value || "-"}
      </div>
    </div>
  );
}
