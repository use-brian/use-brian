/** Association console navigation: grouped sections, role visibility and old-link aliases. [COMP:app-web/association] */
import { Banknote, CalendarDays, Contact, CreditCard, Globe, HandHeart, Home, ListChecks, ShieldCheck, Tag, Users, WalletCards, type LucideIcon } from "lucide-react";

const ASSOCIATION_SECTIONS = ["overview", "website", "events", "waitlist", "orders", "promotions", "payments", "memberships", "plans", "sponsorships", "contacts", "admin"] as const;
export type AssociationSection = (typeof ASSOCIATION_SECTIONS)[number];
export type AssociationNavGroup = "home" | "website" | "events" | "sales" | "membership" | "contacts" | "admin";
export const ASSOCIATION_NAV_GROUPS: readonly AssociationNavGroup[] = ["home", "website", "events", "sales", "membership", "contacts", "admin"];

/** `requires: "manage"` sections are hidden from workspace members; a direct link explains who manages them. */
export type AssociationNavItem = { id: AssociationSection; group: AssociationNavGroup; icon: LucideIcon; requires?: "manage" };
export const ASSOCIATION_NAV: readonly AssociationNavItem[] = [
  { id: "overview", group: "home", icon: Home },
  { id: "website", group: "website", icon: Globe, requires: "manage" },
  { id: "events", group: "events", icon: CalendarDays },
  { id: "waitlist", group: "events", icon: ListChecks },
  { id: "orders", group: "sales", icon: CreditCard },
  { id: "promotions", group: "sales", icon: Tag, requires: "manage" },
  { id: "payments", group: "sales", icon: Banknote, requires: "manage" },
  { id: "memberships", group: "membership", icon: Users },
  { id: "plans", group: "membership", icon: WalletCards },
  { id: "sponsorships", group: "membership", icon: HandHeart, requires: "manage" },
  { id: "contacts", group: "contacts", icon: Contact },
  { id: "admin", group: "admin", icon: ShieldCheck, requires: "manage" },
];

export function associationNavItem(section: AssociationSection): AssociationNavItem {
  return ASSOCIATION_NAV.find(item => item.id === section) ?? ASSOCIATION_NAV[0]!;
}

/** Old links keep working: Settings and Operations open Admin, its website and sponsorship tabs open their own sections. */
export function resolveAssociationSection(search: URLSearchParams | null): AssociationSection {
  const raw = search?.get("section") ?? "overview", view = search?.get("view"), tab = search?.get("tab");
  if (raw === "memberships" && view === "plans") return "plans";
  if (raw === "memberships" && view === "payments") return "payments";
  if (raw === "settings" || raw === "operations") return tab === "website" ? "website" : tab === "sponsorship" ? "sponsorships" : "admin";
  return (ASSOCIATION_SECTIONS as readonly string[]).includes(raw) ? raw as AssociationSection : "overview";
}

export function associationHref(workspaceId: string, section: AssociationSection, params: Record<string, string> = {}): string {
  const query = new URLSearchParams({ section, ...params });
  return `/w/${workspaceId}/association?${query}`;
}
