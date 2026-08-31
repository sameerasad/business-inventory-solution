"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  BarChart3,
  Boxes,
  Layers,
  MapPin,
  PackagePlus,
  Receipt,
  ShoppingCart,
} from "lucide-react";

import { cn } from "@/lib/utils";

const LINKS = [
  { href: "/dashboard", label: "Dashboard", icon: BarChart3 },
  { href: "/sales/new", label: "New Sale", icon: ShoppingCart, accent: true },
  { href: "/batches/new", label: "New Batch", icon: PackagePlus, accent: true },
  { href: "/sales", label: "Sales", icon: Receipt },
  { href: "/batches", label: "Batches", icon: Layers },
  { href: "/products", label: "Products", icon: Boxes },
  { href: "/areas", label: "Areas & Shops", icon: MapPin },
];

export function SiteNav() {
  const pathname = usePathname();

  return (
    <nav className="flex gap-1 overflow-x-auto pb-px" aria-label="Main">
      {LINKS.map((link) => {
        // /sales/new must not light up /sales, so exact-match the "new" routes.
        const active = link.href.endsWith("/new")
          ? pathname === link.href
          : pathname === link.href || pathname.startsWith(`${link.href}/`);
        const Icon = link.icon;
        return (
          <Link
            key={link.href}
            href={link.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex shrink-0 items-center gap-1.5 rounded-md px-3 py-2 text-sm font-medium transition-colors",
              active
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:bg-accent hover:text-foreground",
              !active && link.accent && "text-foreground",
            )}
          >
            <Icon className="h-4 w-4" />
            {link.label}
          </Link>
        );
      })}
    </nav>
  );
}
