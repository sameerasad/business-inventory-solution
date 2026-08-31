import type { Metadata } from "next";

import { PageHeader } from "@/components/page-header";
import { AreaManager } from "@/components/areas/area-manager";
import { getAreasWithShops } from "@/lib/queries";

export const metadata: Metadata = { title: "Areas & Shops" };
export const dynamic = "force-dynamic";

export default async function AreasPage() {
  const areas = await getAreasWithShops();

  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader
        title="Areas & Shops"
        description="Every sale is attributed to an area, and optionally to a shop inside it. Areas and shops with sales against them cannot be deleted."
      />
      <AreaManager areas={areas} />
    </div>
  );
}
