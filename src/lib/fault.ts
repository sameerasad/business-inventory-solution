/**
 * A short, safe tag for an error the user is being asked to report.
 *
 * "Could not save the batch. Please try again." is honest and completely
 * useless: the person reading it cannot try anything different, and the one
 * piece of information that would identify the fault is sitting in a server
 * log they have no access to. Trying again is also the worst advice available
 * if the cause is deterministic.
 *
 * So the message carries a tag. It is deliberately not the error text - that
 * can contain table names, connection strings and row values, and this string
 * is rendered in a browser and read out over the phone. A Prisma error code
 * (P2002, P2003, P2024) or an error class name is enough to find the cause in
 * seconds and gives nothing away.
 */
export function faultTag(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const e = error as { code?: unknown; name?: unknown };
    // Prisma's own codes are the most useful thing here: P2002 is a duplicate,
    // P2003 a missing reference, P2024 a connection pool that ran dry.
    if (typeof e.code === "string" && /^P\d{4}$/.test(e.code)) return e.code;
    if (typeof e.name === "string" && e.name.length > 0 && e.name.length <= 40) {
      return e.name;
    }
  }
  return "unknown";
}

/** "Could not save the batch." -> "Could not save the batch. (P2024)" */
export function withTag(message: string, error: unknown): string {
  return `${message} (${faultTag(error)})`;
}
