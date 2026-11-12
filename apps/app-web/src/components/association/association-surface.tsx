"use client";

/** Native workspace Association surface: task-led staff console shell. [COMP:app-web/association] */
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/client";
import { OperatorTopbar } from "@/components/operator/operator-topbar";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { AssociationOverview } from "./overview";
import { AssociationEventsPanel } from "./events-panel";
import { AssociationMembersPanel } from "./members-panel";
import { AssociationPlansPanel } from "./plans-panel";
import { MembershipPublishingPanel } from "./membership-publishing";
import { PageHeader } from "./ui";
import { AssociationPaymentsPanel } from "./payments-panel";
import { AssociationWaitlistPanel } from "./waitlist-panel";
import { AssociationOrdersPanel } from "./orders-panel";
import { AssociationPromotionsPanel } from "./promotions-panel";
import { AssociationSponsorshipsSection } from "./sponsorships";
import { AssociationWebsiteSection } from "./website-content";
import { AssociationContactsSection } from "./contacts/contacts-section";
import { AdminOnlyPage, useAssociationAccess } from "./access";
import { ASSOCIATION_STAFF_SECTIONS, associationHref, associationNavItem, resolveAssociationSection, type AssociationSection } from "./navigation";

export { associationHref, resolveAssociationSection, type AssociationSection } from "./navigation";

export function AssociationSurface({ workspaceId }: { workspaceId: string }) {
  const t = useT().associationPage, u = t.ux;
  const search = useSearchParams();
  const access = useAssociationAccess(workspaceId);
  const labels: Record<AssociationSection, string> = {
    overview: u.home, website: u.website, events: u.eventsNav, waitlist: t.manage.waitlist, orders: t.orders, promotions: u.promoCodes,
    payments: u.offlinePayments, memberships: u.members, plans: t.manage.plans, sponsorships: u.sponsorship, contacts: t.staff.submissions, admin: u.admin,
  };
  const section = resolveAssociationSection(search);
  const current = associationNavItem(section);
  const items = (["overview", ...ASSOCIATION_STAFF_SECTIONS] as const).map(associationNavItem);
  const href = (id: AssociationSection) => associationHref(workspaceId, id);
  const eventId = search?.get("eventId") ?? "", eventSlug = search?.get("eventSlug") ?? "", wantsNew = search?.get("new") === "1";
  const contactId = search?.get("contactId") ?? "", plan = search?.get("plan") ?? "";
  const view = search?.get("view");
  const eventView = view === "guests" || view === "registration" || view === "tickets" ? view : "event";
  const filter = search?.get("filter");
  const eventFilter = filter === "drafts" || filter === "all" ? filter : "website";
  const publicPlans = section === "plans" && (search?.get("view") === "website" || search?.get("page") === "membership");
  const restricted = Boolean(current.requires || publicPlans);
  const locked = restricted && access.resolved && !access.canManage;
  const waiting = restricted && !access.resolved;
  const CurrentIcon = current.icon;
  return <div className="flex h-full min-h-0 min-w-0 flex-col" data-association-surface>
    <OperatorTopbar app="association"
      center={<DropdownMenu>
        <DropdownMenuTrigger aria-label={u.goTo} className="inline-flex h-11 max-w-48 items-center gap-1.5 rounded-md bg-sidebar-accent/60 px-2 text-[12.5px] text-sidebar-accent-foreground sm:h-7 lg:hidden">
          <CurrentIcon aria-hidden className="size-3.5 shrink-0" /><span className="truncate">{labels[section]}</span><ChevronDown aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {items.map(item => <DropdownMenuItem key={item.id} className="min-h-11 md:min-h-9" render={<Link href={href(item.id)} aria-current={section === item.id ? "page" : undefined} />}>
            <item.icon aria-hidden className="size-4" /><span className="flex-1">{labels[item.id]}</span>
          </DropdownMenuItem>)}
        </DropdownMenuContent>
      </DropdownMenu>} />
    <div className="flex min-h-0 flex-1">
      <nav className="hidden w-56 shrink-0 overflow-y-auto border-r border-border bg-muted/20 px-3 py-6 lg:block" aria-label={t.name}>
        {items.map(({ id, icon: Icon }) => <Link key={id} href={href(id)} aria-current={section === id ? "page" : undefined}
          className={cn("mb-1 flex min-h-11 md:min-h-9 items-center gap-3 rounded-lg px-3 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-ring", section === id ? "bg-accent font-semibold text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground")}>
          <Icon aria-hidden className="size-4 shrink-0" />{labels[id]}</Link>)}
      </nav>
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto bg-muted/10 px-4 pt-5 pb-24 md:px-8 md:py-7">
        <div className="mx-auto max-w-6xl space-y-6">
          {locked ? <AdminOnlyPage workspaceId={workspaceId} title={labels[section]} /> : waiting ? <div className="h-24 animate-pulse rounded-2xl bg-muted/40" aria-busy /> : <>
            {section === "overview" && <AssociationOverview workspaceId={workspaceId} />}
            {section === "website" && <AssociationWebsiteSection key={workspaceId} workspaceId={workspaceId} />}
            {section === "memberships" && <AssociationMembersPanel key={`${workspaceId}:${wantsNew}:${contactId}`} workspaceId={workspaceId} initialNew={wantsNew} initialContactId={contactId} />}
            {section === "plans" && (publicPlans ? <>
              <PageHeader title={t.manage.plans} back={{ label: t.manage.plans, href: href("plans") }} />
              <MembershipPublishingPanel key={`${workspaceId}:${plan}:${wantsNew}`} workspaceId={workspaceId} initialPlan={plan} initialNew={wantsNew} />
            </> : <AssociationPlansPanel key={`${workspaceId}:${wantsNew}`} workspaceId={workspaceId} initialNew={wantsNew} />)}
            {section === "sponsorships" && <AssociationSponsorshipsSection key={workspaceId} workspaceId={workspaceId} />}
            {section === "events" && <AssociationEventsPanel key={`${workspaceId}:${eventId}:${eventSlug}:${wantsNew}:${eventView}:${eventFilter}`} workspaceId={workspaceId} initialEventId={eventId} initialEventSlug={eventSlug} initialNew={wantsNew} initialView={eventView} initialFilter={eventFilter} />}
            {section === "promotions" && <AssociationPromotionsPanel key={`${workspaceId}:${wantsNew}`} workspaceId={workspaceId} initialNew={wantsNew} />}
            {section === "orders" && <AssociationOrdersPanel key={`${workspaceId}:${eventId}`} workspaceId={workspaceId} initialEventId={eventId} />}
            {section === "waitlist" && <AssociationWaitlistPanel key={workspaceId} workspaceId={workspaceId} />}
            {section === "payments" && <AssociationPaymentsPanel key={`${workspaceId}:${wantsNew}:${contactId}:${plan}`} workspaceId={workspaceId} initialNew={wantsNew} initialContactId={contactId} initialPlanId={plan} />}
            {section === "contacts" && <AssociationContactsSection key={workspaceId} workspaceId={workspaceId} />}
          </>}
        </div>
      </div>
    </div>
  </div>;
}
