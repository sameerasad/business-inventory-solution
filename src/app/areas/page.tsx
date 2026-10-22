import type { Metadata } from "next";

import { PageHeader } from "@/components/page-header";
import { Alert } from "@/components/ui/alert";
import { AreaManager } from "@/components/areas/area-manager";
import { ListFilters, type FilterSpec } from "@/components/list-filters";
import { getAreasWithShops } from "@/lib/queries";
import { getAreaCoverage } from "@/lib/bookers";
import { currentYear } from "@/lib/dates";
import { requireUser, scopeBookerId, visibleAreaIds } from "@/lib/session";

export const metadata: Metadata = { title: "Areas & Shops" };
export const dynamic = "force-dynamic";

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function AreasPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser();
  // A booker may add a shop they just walked into; renaming and deleting are
  // the owner's. The actions refuse them server-side either way.
  const canManage = scopeBookerId(user) == null;
  // A booker sees the areas they were assigned and no others: this page is the
  // customer list, and it is the easiest thing in the business to walk out
  // with.
  const territory = await visibleAreaIds(user);

  const sp = await searchParams;
  const q = (first(sp.q) ?? "").trim();

  const year = currentYear();
  const [allAreas, coverage] = await Promise.all([
    getAreasWithShops(territory),
    getAreaCoverage({ year }),
  ]);

  // One box, two kinds of match, and they behave differently on purpose. A
  // matching AREA keeps all its shops, because you asked for the area. An area
  // that only matched through a shop keeps just the shops that matched, so
  // searching a shop name shows you that shop rather than the fifty it sits
  // among.
  const needle = q.toLowerCase();
  const areas = needle
    ? allAreas.flatMap((area) => {
        if (area.name.toLowerCase().includes(needle)) return [area];
        const shops = area.shops.filter((sh) =>
          [sh.name, sh.address, sh.phone, sh.voiceAlias]
            .filter((v): v is string => typeof v === "string")
            .some((v) => v.toLowerCase().includes(needle)),
        );
        return shops.length > 0 ? [{ ...area, shops }] : [];
      })
    : allAreas;

  const filters: FilterSpec[] = [
    {
      kind: "search",
      key: "q",
      label: "Search",
      value: q,
      placeholder: "Area, shop, address, phone",
      width: "w-[300px]",
    },
  ];
  // Who is responsible for each area. Assignment itself is edited on the
  // Bookers page, next to the booker it belongs to - this is the read-only
  // other half of the same fact.
  const bookersByArea = new Map(coverage.map((c) => [c.areaId, c.bookers]));

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Areas & Shops"
        description="Every sale is attributed to an area, and optionally to a shop inside it. Areas and shops with sales against them cannot be deleted."
      />
      <ListFilters filters={filters} />

      {/* An empty territory and an empty search look identical on screen and
          mean completely different things, so they are answered separately and
          the territory goes first - it is the reason there is nothing here. */}
      {territory != null && territory.length === 0 ? (
        <Alert tone="info">
          No areas have been assigned to you yet, so there is nothing to show here. Ask the owner
          to assign your territory on the Bookers page - until then you cannot take a booking
          either, because every booking needs an area.
        </Alert>
      ) : q && areas.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nothing matches “{q}”. Clear the search to see every area.
        </p>
      ) : (
        <AreaManager areas={areas} bookersByArea={bookersByArea} canManage={canManage} />
      )}
    </div>
  );
}
