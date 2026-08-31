import * as React from "react";
import { AlertTriangle, CheckCircle2, Info } from "lucide-react";

import { cn } from "@/lib/utils";

const styles = {
  success: "border-success/30 bg-success/8 text-success",
  error: "border-destructive/30 bg-destructive/8 text-destructive",
  info: "border-border bg-muted text-muted-foreground",
} as const;

const icons = {
  success: CheckCircle2,
  error: AlertTriangle,
  info: Info,
} as const;

export function Alert({
  tone,
  children,
  className,
}: {
  tone: keyof typeof styles;
  children: React.ReactNode;
  className?: string;
}) {
  const Icon = icons[tone];
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={cn(
        "flex items-start gap-2 rounded-md border px-3 py-2 text-sm",
        styles[tone],
        className,
      )}
    >
      <Icon className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed px-6 py-12 text-center">
      <p className="text-sm font-medium">{title}</p>
      {description ? (
        <p className="max-w-md text-sm text-muted-foreground">{description}</p>
      ) : null}
      {action}
    </div>
  );
}
