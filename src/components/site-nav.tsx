"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  BarChart3,
  Boxes,
  ClipboardList,
  FileText,
  Layers,
  MapPin,
  PackagePlus,
  Receipt,
  ShoppingCart,
  Wallet,
  type LucideIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";

type NavLink = { href: string; label: string; icon: LucideIcon };

/**
 * Two groups, because nine flat links read as noise.
 *
 * "Record" is what a booker touches all day; "Browse" is everything you look at
 * afterwards. Every page in the app appears here - if you add a route, add it to
 * one of these lists.
 */
const RECORD: NavLink[] = [
  { href: "/bookings/new", label: "New Booking", icon: ClipboardList },
  { href: "/sales/new", label: "New Sale", icon: ShoppingCart },
  { href: "/batches/new", label: "New Batch", icon: PackagePlus },
];

const BROWSE: NavLink[] = [
  { href: "/dashboard", label: "Dashboard", icon: BarChart3 },
  { href: "/bookings", label: "Bookings", icon: FileText },
  { href: "/receivables", label: "Receivables", icon: Wallet },
  { href: "/sales", label: "Sales", icon: Receipt },
  { href: "/batches", label: "Batches", icon: Layers },
  { href: "/products", label: "Products", icon: Boxes },
  { href: "/areas", label: "Areas & Shops", icon: MapPin },
];

export function SiteNav() {
  const pathname = usePathname();

  // "/sales/new" must not also light up "/sales", so the create routes are
  // matched exactly and the list routes match their own subtree.
  const isActive = (href: string) =>
    href.endsWith("/new")
      ? pathname === href
      : pathname === href || pathname.startsWith(`${href}/`);

  const item = (link: NavLink, emphasis: boolean) => {
    const active = isActive(link.href);
    const Icon = link.icon;
    return (
      <Link
        key={link.href}
        href={link.href}
        aria-current={active ? "page" : undefined}
        className={cn(
          "flex shrink-0 items-center gap-1.5 rounded-md px-2.5 py-2 text-sm font-medium transition-colors",
          active
            ? "bg-primary text-primary-foreground"
            : emphasis
              ? "text-foreground hover:bg-accent"
              : "text-muted-foreground hover:bg-accent hover:text-foreground",
        )}
      >
        <Icon className="h-4 w-4" />
        {link.label}
      </Link>
    );
  };

  return (
    // flex-wrap, never overflow-x-auto: with nine links a scrolling row silently
    // hides the last few, which is indistinguishable from them not existing.
    <nav className="flex flex-wrap items-center gap-x-1 gap-y-1.5" aria-label="Main">
      <span className="flex flex-wrap items-center gap-1">
        {RECORD.map((link) => item(link, true))}
      </span>

      <span aria-hidden className="mx-1 hidden h-5 w-px bg-border sm:block" />

      <span className="flex flex-wrap items-center gap-1">
        {BROWSE.map((link) => item(link, false))}
      </span>
    </nav>
  );
}
