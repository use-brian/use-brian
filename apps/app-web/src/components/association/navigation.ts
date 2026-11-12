/** Association console navigation: grouped sections, role visibility and old-link aliases. [COMP:app-web/association] */
import { Banknote, CalendarDays, Contact, CreditCard, Globe, HandHeart, Home, ListChecks, ShieldCheck, Tag, Users, WalletCards, type LucideIcon } from "lucide-react";

const ASSOCIATION_SECTIONS = ["overview", "website", "events", "waitlist", "orders", "promotions", "payments", "memberships", "plans", "sponsorships", "contacts", "admin"] as const;
export type AssociationSection = (typeof ASSOCIATION_SECTIONS)[number];
export const ASSOCIATION_STAFF_SECTIONS = ["events", "plans", "memberships", "contacts"] as const;

/** `requires: "manage"` sections are hidden from workspace members; a direct link explains who manages them. */
export type AssociationNavItem = { id: AssociationSection; icon: LucideIcon; requires?: "manage" };
const ASSOCIATION_NAV: readonly AssociationNavItem[] = [
  { id: "overview", icon: Home },
  { id: "website", icon: Globe, requires: "manage" },
  { id: "events", icon: CalendarDays },
  { id: "waitlist", icon: ListChecks },
  { id: "orders", icon: CreditCard },
  { id: "promotions", icon: Tag, requires: "manage" },
  { id: "payments", icon: Banknote, requires: "manage" },
  { id: "memberships", icon: Users },
  { id: "plans", icon: WalletCards },
  { id: "sponsorships", icon: HandHeart, requires: "manage" },
  { id: "contacts", icon: Contact },
  { id: "admin", icon: ShieldCheck, requires: "manage" },
];

export function associationNavItem(section: AssociationSection): AssociationNavItem {
  return ASSOCIATION_NAV.find(item => item.id === section) ?? ASSOCIATION_NAV[0]!;
}

/** Keep links to staff workflows. Former system settings return to the staff landing page. */
export function resolveAssociationSection(search: URLSearchParams | null): AssociationSection {
  const raw = search?.get("section") ?? "overview", view = search?.get("view"), tab = search?.get("tab");
  if (raw === "memberships" && view === "plans") return "plans";
  if (raw === "memberships" && view === "payments") return "payments";
  if (raw === "settings" || raw === "operations") return tab === "website" ? "website" : tab === "sponsorship" ? "sponsorships" : "overview";
  if (raw === "admin") return "overview";
  if (raw === "website" && search?.get("page") === "membership") return "plans";
  return (ASSOCIATION_SECTIONS as readonly string[]).includes(raw) ? raw as AssociationSection : "overview";
}

export function associationHref(workspaceId: string, section: AssociationSection, params: Record<string, string> = {}): string {
  const query = new URLSearchParams({ section, ...params });
  return `/w/${workspaceId}/association?${query}`;
}
