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
  LogOut,
  Mic,
  Target,
  ShoppingCart,
  UserCog,
  Users,
  Wallet,
  type LucideIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { signOutAction } from "@/actions/auth";
import { Button } from "@/components/ui/button";

type NavLink = {
  href: string;
  label: string;
  /** Shown instead of `label` on narrow screens, where "New " is just noise. */
  short?: string;
  icon: LucideIcon;
  /**
   * Hidden from a booker.
   *
   * Everything marked here either shows what stock cost and what the business
   * earned on it, or changes something only the owner should change. The pages
   * themselves turn a booker away as well; this list only decides whether a
   * link is drawn, and a link that would bounce is worse than no link.
   */
  admin?: true;
  /** Only drawn for somebody who is a booker, or who is also one. */
  booker?: true;
};

/**
 * Two groups, on two tiers, because a dozen flat links read as noise.
 *
 * "Record" is what a booker touches all day, so it sits top-right as buttons -
 * the shape people already read as "do something". "Browse" is everything you
 * look at afterwards, so it sits underneath as tabs. Every page in the app
 * appears here; if you add a route, add it to one of these lists.
 */
const RECORD: NavLink[] = [
  { href: "/bookings/new", label: "New Booking", short: "Booking", icon: ClipboardList },
  { href: "/sales/new", label: "New Sale", short: "Sale", icon: ShoppingCart, admin: true },
  { href: "/batches/new", label: "New Batch", short: "Batch", icon: PackagePlus, admin: true },
];

const BROWSE: NavLink[] = [
  { href: "/dashboard", label: "Dashboard", icon: BarChart3, admin: true },
  { href: "/my", label: "My Target", short: "Target", icon: Target, booker: true },
  { href: "/bookings", label: "Bookings", icon: FileText },
  { href: "/receivables", label: "Receivables", icon: Wallet },
  { href: "/sales", label: "Sales", icon: Receipt, admin: true },
  { href: "/batches", label: "Batches", icon: Layers, admin: true },
  { href: "/products", label: "Products", icon: Boxes, admin: true },
  { href: "/bookers", label: "Bookers", icon: Users, admin: true },
  { href: "/users", label: "Users", icon: UserCog, admin: true },
  { href: "/voice", label: "Voice", icon: Mic },
  { href: "/areas", label: "Areas & Shops", short: "Areas", icon: MapPin },
];

/** Who the links are being drawn for. */
export type NavRole = {
  admin: boolean;
  isBooker: boolean;
  /** Shown in the header, so the app always says whose session this is. */
  name: string;
  /**
   * Signed in with the owner's emergency password rather than as an account.
   *
   * Worth saying out loud. That password ignores whatever username was typed,
   * so without this the screen looks identical to being the person you named -
   * and "why can a booker see the dashboard" is a frightening question to have
   * to ask about your own books.
   */
  emergency: boolean;
};

function allowed(link: NavLink, who: NavRole): boolean {
  if (link.admin && !who.admin) return false;
  if (link.booker && !who.isBooker) return false;
  return true;
}

/**
 * "/sales/new" must not also light up "/sales", so the create routes are matched
 * exactly and the list routes match their own subtree.
 */
function useIsActive() {
  const pathname = usePathname();
  return (href: string) =>
    href.endsWith("/new")
      ? pathname === href
      : pathname === href || pathname.startsWith(`${href}/`);
}

/** The three create actions. Top row, right-aligned. */
export function NavActions({ who }: { who: NavRole }) {
  const isActive = useIsActive();

  return (
    <div className="flex items-center gap-1.5" role="group" aria-label="Record">
      {RECORD.filter((link) => allowed(link, who)).map((link, index) => {
        const active = isActive(link.href);
        const Icon = link.icon;
        // New Booking is the one action taken dozens of times a day, so it is the
        // only filled button. Three filled buttons would rank nothing.
        const primary = index === 0;
        return (
          <Button
            key={link.href}
            asChild
            variant={primary ? "default" : "outline"}
            className={cn(
              "h-9 gap-1.5 px-2.5 sm:px-3",
              !primary && active && "border-primary/60 bg-accent text-accent-foreground",
            )}
          >
            <Link href={link.href} aria-current={active ? "page" : undefined}>
              <Icon />
              <span className="hidden lg:inline">{link.label}</span>
              <span className="lg:hidden">{link.short ?? link.label}</span>
            </Link>
          </Button>
        );
      })}

      {/* Who this is. The role is the part that matters and is shown at every
          width; the name is detail and folds away on a phone. */}
      <span className="ml-1 flex min-w-0 items-center gap-1.5 border-l pl-2">
        <span className="hidden min-w-0 truncate text-xs font-medium sm:block">{who.name}</span>
        <span
          className={cn(
            "rounded-full px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
            who.emergency
              ? "bg-destructive/12 text-destructive"
              : who.admin
                ? "bg-primary/10 text-primary"
                : "bg-secondary text-secondary-foreground",
          )}
          title={
            who.emergency
              ? "Signed in with the emergency password, not as an account. Any username you typed was ignored."
              : who.admin
                ? "Admin - the whole business"
                : "Booker - your own orders"
          }
        >
          {who.emergency ? "Emergency" : who.admin ? "Admin" : "Booker"}
        </span>
      </span>

      {/* A way out, because there is now a way in. Its own small form rather
          than a link: signing out clears a cookie, and a GET that changes
          something gets fired by anything that prefetches links. */}
      <form action={signOutAction}>
        <Button type="submit" variant="ghost" size="icon" className="h-9 w-9" title="Sign out">
          <LogOut className="h-4 w-4" />
          <span className="sr-only">Sign out</span>
        </Button>
      </form>
    </div>
  );
}

/**
 * The list pages, as tabs sitting on the header's bottom border.
 *
 * flex-wrap, never overflow-x-auto: with this many tabs a scrolling row silently
 * hides the last few, which is indistinguishable from those pages not existing.
 */
export function NavTabs({ who }: { who: NavRole }) {
  const isActive = useIsActive();

  return (
    <nav className="-mb-px flex flex-wrap items-center gap-x-0.5" aria-label="Main">
      {BROWSE.filter((link) => allowed(link, who)).map((link) => {
        const active = isActive(link.href);
        const Icon = link.icon;
        return (
          <Link
            key={link.href}
            href={link.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex shrink-0 items-center gap-1.5 border-b-2 px-2.5 py-2.5 text-sm font-medium transition-colors",
              active
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:border-border hover:text-foreground",
            )}
          >
            <Icon className="hidden h-4 w-4 sm:block" />
            <span className="hidden sm:inline">{link.label}</span>
            <span className="sm:hidden">{link.short ?? link.label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
