"use client";

/** Native workspace Association surface: task-led staff console shell. [COMP:app-web/association] */
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ArrowUpRight, ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/client";
import { OperatorTopbar } from "@/components/operator/operator-topbar";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { AssociationOverview } from "./overview";
import { AssociationEventsPanel } from "./events-panel";
import { AssociationMembersPanel } from "./members-panel";
import { AssociationPlansPanel } from "./plans-panel";
import { AssociationPaymentsPanel } from "./payments-panel";
import { AssociationWaitlistPanel } from "./waitlist-panel";
import { AssociationAdminPanel } from "./admin-panel";
import { AssociationOrdersPanel } from "./orders-panel";
import { AssociationPromotionsPanel } from "./promotions-panel";
import { AssociationSponsorshipsSection } from "./sponsorships";
import { AssociationWebsiteSection } from "./website-content";
import { AssociationContactsSection } from "./contacts/contacts-section";
import { AdminOnlyPage, useAssociationAccess } from "./access";
import { ASSOCIATION_NAV, ASSOCIATION_NAV_GROUPS, associationHref, associationNavItem, resolveAssociationSection, type AssociationNavGroup, type AssociationSection } from "./navigation";

export { associationHref, resolveAssociationSection, type AssociationSection } from "./navigation";

export function AssociationSurface({ workspaceId }: { workspaceId: string }) {
  const t = useT().associationPage, u = t.ux;
  const search = useSearchParams();
  const access = useAssociationAccess(workspaceId);
  const labels: Record<AssociationSection, string> = {
    overview: u.home, website: u.website, events: u.eventsNav, waitlist: t.manage.waitlist, orders: t.orders, promotions: u.promoCodes,
    payments: u.offlinePayments, memberships: u.members, plans: t.manage.plans, sponsorships: u.sponsorship, contacts: u.navContacts, admin: u.admin,
  };
  const groupLabels: Record<AssociationNavGroup, string> = { home: u.navHome, website: u.navWebsite, events: u.navEvents, sales: u.navSales, membership: u.navMembership, contacts: u.navContacts, admin: u.navAdmin };
  const visible = ASSOCIATION_NAV.filter(item => !item.requires || access.canManage);
  const groups = ASSOCIATION_NAV_GROUPS.map(id => ({ id, label: groupLabels[id], items: visible.filter(item => item.group === id) })).filter(group => group.items.length);
  const section = resolveAssociationSection(search);
  const current = associationNavItem(section);
  const href = (id: AssociationSection) => associationHref(workspaceId, id);
  const eventId = search?.get("eventId") ?? "", eventSlug = search?.get("eventSlug") ?? "", wantsNew = search?.get("new") === "1", tab = search?.get("tab") ?? undefined;
  const locked = !!current.requires && access.resolved && !access.canManage;
  const waiting = !!current.requires && !access.resolved;
  const CurrentIcon = current.icon;
  return <div className="flex h-full min-h-0 min-w-0 flex-col" data-association-surface>
    <OperatorTopbar app="association"
      center={<DropdownMenu>
        <DropdownMenuTrigger aria-label={u.goTo} className="inline-flex h-11 max-w-48 items-center gap-1.5 rounded-md bg-sidebar-accent/60 px-2 text-[12.5px] text-sidebar-accent-foreground sm:h-7 lg:hidden">
          <CurrentIcon aria-hidden className="size-3.5 shrink-0" /><span className="truncate">{labels[section]}</span><ChevronDown aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {groups.map((group, index) => <div key={group.id} role="presentation">{index > 0 ? <DropdownMenuSeparator /> : null}
            {group.items.length > 1 ? <p aria-hidden className="px-2 pt-1.5 pb-0.5 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">{group.label}</p> : null}
            {group.items.map(item => <DropdownMenuItem key={item.id} className="min-h-11 sm:min-h-0" render={<Link href={href(item.id)} />}><item.icon aria-hidden className="size-3.5" /><span className="min-w-28 flex-1">{labels[item.id]}</span></DropdownMenuItem>)}
          </div>)}
        </DropdownMenuContent>
      </DropdownMenu>}
      right={<Link className="inline-flex min-h-11 items-center gap-1.5 px-2 text-sm text-primary md:min-h-8" href={`/w/${workspaceId}/crm`}>{t.openCrm}<ArrowUpRight aria-hidden className="size-4" /></Link>} />
    <div className="flex min-h-0 flex-1">
      <nav className="hidden w-56 shrink-0 overflow-y-auto border-r border-border bg-muted/20 p-3 lg:block" aria-label={t.name}>
        {groups.map(group => <div key={group.id} className="mb-3">
          {group.items.length > 1 ? <p className="mt-2 mb-1 px-3 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">{group.label}</p> : null}
          {group.items.map(({ id, icon: Icon }) => <Link key={id} href={href(id)} aria-current={section === id ? "page" : undefined}
            className={cn("flex min-h-9 items-center gap-2.5 rounded-lg px-3 py-1.5 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-ring", section === id ? "bg-primary/10 font-medium text-primary" : "text-muted-foreground hover:bg-accent hover:text-foreground")}>
            <Icon aria-hidden className="size-4 shrink-0" />{labels[id]}</Link>)}
        </div>)}
      </nav>
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-muted/10 px-4 py-5 md:px-8 md:py-7">
        <div className="mx-auto max-w-6xl space-y-6">
          {locked ? <AdminOnlyPage workspaceId={workspaceId} title={labels[section]} /> : waiting ? <div className="h-24 animate-pulse rounded-2xl bg-muted/40" aria-busy /> : <>
            {section === "overview" && <AssociationOverview workspaceId={workspaceId} />}
            {section === "website" && <AssociationWebsiteSection key={workspaceId} workspaceId={workspaceId} />}
            {section === "memberships" && <AssociationMembersPanel key={`${workspaceId}:${wantsNew}`} workspaceId={workspaceId} initialNew={wantsNew} />}
            {section === "plans" && <AssociationPlansPanel key={`${workspaceId}:${wantsNew}`} workspaceId={workspaceId} initialNew={wantsNew} />}
            {section === "sponsorships" && <AssociationSponsorshipsSection key={workspaceId} workspaceId={workspaceId} />}
            {section === "events" && <AssociationEventsPanel key={`${workspaceId}:${eventId}:${eventSlug}:${wantsNew}`} workspaceId={workspaceId} initialEventId={eventId} initialEventSlug={eventSlug} initialNew={wantsNew} />}
            {section === "promotions" && <AssociationPromotionsPanel key={`${workspaceId}:${wantsNew}`} workspaceId={workspaceId} initialNew={wantsNew} />}
            {section === "orders" && <AssociationOrdersPanel key={`${workspaceId}:${eventId}`} workspaceId={workspaceId} initialEventId={eventId} />}
            {section === "waitlist" && <AssociationWaitlistPanel key={workspaceId} workspaceId={workspaceId} />}
            {section === "payments" && <AssociationPaymentsPanel key={`${workspaceId}:${wantsNew}`} workspaceId={workspaceId} initialNew={wantsNew} />}
            {section === "contacts" && <AssociationContactsSection key={workspaceId} workspaceId={workspaceId} />}
            {section === "admin" && <AssociationAdminPanel key={`${workspaceId}:${tab ?? ""}`} workspaceId={workspaceId} tab={tab} />}
          </>}
        </div>
      </div>
    </div>
  </div>;
}
