/**
 * What only the database knows, filled in before anything is shown or saved.
 *
 * Deliberately NOT in the actions module. Every export from a "use server"
 * file becomes an endpoint the browser can call, and this needs to be a plain
 * function that tests can reach without also making it one.
 */
import { prisma } from "@/lib/db";
import type { VoiceCommand } from "@/lib/voice/parse";

/**
 * Fill in what only the database knows, before anything is shown or saved.
 *
 * Three of the administrative commands are dangerous precisely because the
 * actions behind them are blunt instruments, and the model cannot see the state
 * they act on:
 *
 *  - renameShopAction posts the address and phone back alongside the name, so
 *    a rename that sends them empty ERASES them.
 *  - the toggle actions only flip. Acting on "band kar do" without knowing the
 *    current state turns something ON when the instruction was to turn it off.
 *  - setBookerAreasAction REPLACES a booker's whole territory, so saving only
 *    the area named in one sentence takes every other area away from them.
 *
 * None of that can be fixed in the prompt, and none of it should be sent to the
 * model either - the current address of every shop on every command would be
 * paid for by every booking. So it is read here, once, for the one record the
 * command actually names.
 */
export async function enrich(command: VoiceCommand): Promise<VoiceCommand> {
  switch (command.kind) {
    case "rename": {
      if (command.target === "shop") {
        const shop = await prisma.shop.findUnique({
          where: { id: command.id },
          select: { address: true, phone: true, voiceAlias: true },
        });
        return {
          ...command,
          keep: {
            address: shop?.address ?? null,
            phone: shop?.phone ?? null,
            voiceAlias: shop?.voiceAlias ?? null,
          },
        };
      }
      if (command.target === "area") {
        const area = await prisma.area.findUnique({
          where: { id: command.id },
          select: { voiceAlias: true },
        });
        return {
          ...command,
          keep: { address: null, phone: null, voiceAlias: area?.voiceAlias ?? null },
        };
      }
      return command; // A category is only a name; there is nothing to preserve.
    }

    case "toggle": {
      const row =
        command.target === "product"
          ? await prisma.product.findUnique({
              where: { id: command.id },
              select: { isActive: true },
            })
          : await prisma.booker.findUnique({
              where: { id: command.id },
              select: { isActive: true },
            });

      if (!row) return { kind: "unknown", reason: `${command.label} was not found.` };

      // Already in the state that was asked for. The action would flip it to
      // the opposite of the instruction, so this is refused rather than saved -
      // a no-op the person asked for must never become the reverse.
      if (row.isActive === command.wanted) {
        return {
          kind: "unknown",
          reason: `${command.label} is already ${command.wanted ? "active" : "inactive"}.`,
        };
      }
      return { ...command, current: row.isActive };
    }

    case "assign": {
      const held = await prisma.bookerArea.findMany({
        where: { bookerId: command.bookerId },
        select: { areaId: true, area: { select: { name: true } } },
      });
      const already = held.filter((h) => command.areaIds.includes(h.areaId));
      const kept = held.filter((h) => !command.areaIds.includes(h.areaId));
      const warnings = [...command.warnings];
      for (const dup of already) {
        warnings.push(`${command.bookerName} already covers ${dup.area.name}.`);
      }
      return {
        ...command,
        areaIds: [...new Set([...held.map((h) => h.areaId), ...command.areaIds])],
        addedNames: command.addedNames.filter((n) => !already.some((d) => d.area.name === n)),
        keptNames: kept.map((h) => h.area.name),
        warnings,
      };
    }

    default:
      return command;
  }
}
