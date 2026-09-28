"use client";

/** Home: honest first-page counts, a needs-attention list and quick actions. [COMP:app-web/association] */
import Link from "next/link";
import { ArrowUpRight, Banknote, CalendarDays, Tag, UserPlus, Users } from "lucide-react";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n/format";
import { listAssociationOrders } from "@/lib/api/association";
import { associationOrdersCacheKey } from "@/lib/surface-prefetch";
import { useCachedResource } from "@/lib/surface-cache";
import { buttonVariants } from "@/components/ui/button";
import { useAssociationModule } from "./module-controls";
import { useAssociationPage } from "./operator-controls";
import { associationHref } from "./navigation";
import { WebsiteStatusCard } from "./website/website-status";
import { EmptyState, InlineNotice, PageHeader, StatTile, type AssociationTone } from "./ui";

function tally<T>(page: { data?: { items: T[]; nextCursor: string | null } | undefined; error?: unknown } | undefined, keep: (row: T) => boolean): { value: string; suffix?: string; count: number } {
  if (!page?.data) return { value: page?.error ? "?" : "…", count: 0 };
  const count = page.data.items.filter(keep).length;
  return { value: String(count), suffix: page.data.nextCursor ? "+" : undefined, count };
}

export function AssociationOverview({ workspaceId }: { workspaceId: string }) {
  const t = useT().associationPage, u = t.ux, module = useAssociationModule(workspaceId);
  const canManage = !!module.data?.canManage && !module.error, now = Date.now();
  // The server filters upcoming events: the first page of all events is the oldest ones.
  const events = useAssociationPage(workspaceId, "events", { status: "published", when: "upcoming" }), waitlist = useAssociationPage(workspaceId, "waitlist");
  const rescues = useAssociationPage(workspaceId, "rescues", {}, canManage), receipts = useAssociationPage(workspaceId, "receipts", {}, canManage);
  const pendingScope = JSON.stringify({ status: "pending" });
  const pending = useCachedResource(associationOrdersCacheKey(workspaceId, null, pendingScope), () => listAssociationOrders(workspaceId, undefined, { status: "pending" }));
  const pendingPage = pending.data ? { data: { items: pending.data.orders, nextCursor: pending.data.nextCursor } } : { error: pending.error };
  const upcoming = tally(events, row => row.status === "published" && Date.parse(row.endsAt || row.startsAt) >= now);
  const pendingOrders = tally(pendingPage, () => true);
  const waiting = tally(waitlist, row => row.waitlistState === "waiting");
  const outstanding = tally(rescues, row => row.status === "outstanding");
  const overdue = tally(rescues, row => row.status === "outstanding" && row.overdue);
  const issues = tally(receipts, row => row.state === "needs_reconciliation");
  const expiredHolds = tally(pendingPage, row => !!row.reservationExpiresAt && Date.parse(row.reservationExpiresAt) < now);
  const attention: { key: string; text: string; href: string; tone: AssociationTone }[] = [];
  if (canManage && module.data && module.data.module.state !== "enabled") attention.push({ key: "module", text: u.moduleOffRow, href: associationHref(workspaceId, "admin", { tab: "general" }), tone: "warning" });
  if (overdue.count) attention.push({ key: "overdue", text: format(u.overdueRow, { count: overdue.value + (overdue.suffix ?? "") }), href: associationHref(workspaceId, "payments"), tone: "danger" });
  if (expiredHolds.count) attention.push({ key: "holds", text: format(u.expiredHoldsRow, { count: expiredHolds.value + (expiredHolds.suffix ?? "") }), href: associationHref(workspaceId, "orders"), tone: "warning" });
  if (issues.count) attention.push({ key: "sync", text: format(u.syncIssuesRow, { count: issues.value + (issues.suffix ?? "") }), href: associationHref(workspaceId, "admin", { tab: "sync" }), tone: "danger" });
  const quick = [
    ...(canManage ? [{ label: t.manage.newEvent, icon: CalendarDays, href: associationHref(workspaceId, "events", { new: "1" }) }] : []),
    { label: u.addMember, icon: UserPlus, href: associationHref(workspaceId, "memberships", { new: "1" }) },
    ...(canManage ? [{ label: u.newPromoCode, icon: Tag, href: associationHref(workspaceId, "promotions", { new: "1" }) },
      { label: u.recordOfflinePayment, icon: Banknote, href: associationHref(workspaceId, "payments", { new: "1" }) }] : []),
    { label: u.navContacts, icon: Users, href: associationHref(workspaceId, "contacts") },
  ];
  const settled = events.data !== undefined || events.error;
  return <div className="space-y-6" data-association-overview>
    <PageHeader eyebrow={t.name} title={u.workspace} description={u.homeHelp} />
    <div className={`grid grid-cols-2 gap-3 ${canManage ? "lg:grid-cols-3 xl:grid-cols-5" : "xl:grid-cols-3"}`}>
      <StatTile label={u.upcomingEvents} value={upcoming.value} suffix={upcoming.suffix} href={associationHref(workspaceId, "events")} />
      <StatTile label={u.pendingOrdersTile} value={pendingOrders.value} suffix={pendingOrders.suffix} href={associationHref(workspaceId, "orders")} tone={pendingOrders.count ? "warning" : "neutral"} />
      <StatTile label={u.waitingTile} value={waiting.value} suffix={waiting.suffix} href={associationHref(workspaceId, "waitlist")} />
      {canManage ? <StatTile label={u.outstandingPayments} value={outstanding.value} suffix={outstanding.suffix} href={associationHref(workspaceId, "payments")} tone={overdue.count ? "danger" : outstanding.count ? "warning" : "neutral"} /> : null}
      {canManage ? <StatTile label={u.syncIssues} value={issues.value} suffix={issues.suffix} href={associationHref(workspaceId, "admin", { tab: "sync" })} tone={issues.count ? "danger" : "neutral"} /> : null}
    </div>
    <section className="space-y-3" aria-labelledby="association-attention">
      <h2 id="association-attention" className="text-lg font-semibold">{u.attention}</h2>
      {attention.length === 0 ? (settled ? <EmptyState title={u.nothingAttention} /> : null) : attention.map(row => <InlineNotice key={row.key} tone={row.tone} action={<Link href={row.href} className="inline-flex min-h-11 items-center gap-1 text-sm font-medium md:min-h-8">{u.viewAll}<ArrowUpRight aria-hidden className="size-4" /></Link>}>{row.text}</InlineNotice>)}
    </section>
    <WebsiteStatusCard workspaceId={workspaceId} canManage={canManage} />
    <section className="space-y-3" aria-labelledby="association-quick">
      <h2 id="association-quick" className="text-lg font-semibold">{u.quickActions}</h2>
      <div className="flex flex-wrap gap-2">{quick.map(({ label, icon: Icon, href }) => <Link key={label} href={href} className={buttonVariants({ variant: "outline", className: "min-h-11 md:min-h-9" })}><Icon aria-hidden className="size-4" />{label}</Link>)}</div>
    </section>
  </div>;
}
