"use client";

/** Staff landing page. [COMP:app-web/association] */
import Link from "next/link";
import { ArrowRight, CalendarDays, Inbox, Plus, Users, WalletCards } from "lucide-react";
import { useT } from "@/lib/i18n/client";
import { buttonVariants } from "@/components/ui/button";
import { useAssociationAccess } from "./access";
import { associationHref } from "./navigation";
import { PageHeader } from "./ui";

export function AssociationOverview({ workspaceId }: { workspaceId: string }) {
  const t = useT().associationPage;
  const { canManage } = useAssociationAccess(workspaceId);
  const destinations = [
    { section: "events", icon: CalendarDays, title: t.ux.eventsNav, description: t.staff.eventsHelp },
    { section: "plans", icon: WalletCards, title: t.manage.plans, description: t.staff.plansHelp },
    { section: "memberships", icon: Users, title: t.ux.members, description: t.staff.membersHelp },
    { section: "contacts", icon: Inbox, title: t.staff.submissions, description: t.staff.submissionsHelp },
  ] as const;
  return <section className="space-y-6" data-association-overview>
    <PageHeader title={t.name} actions={canManage ? (
      <Link href={associationHref(workspaceId, "events", { new: "1" })} className={buttonVariants({ className: "min-h-11 md:min-h-9" })}>
        <Plus aria-hidden className="size-4" />{t.manage.newEvent}
      </Link>
    ) : undefined} />
    <div className="flex flex-wrap gap-2">
      {canManage && <Link href={associationHref(workspaceId, "events", { filter: "drafts" })}
        className={buttonVariants({ variant: "outline", className: "min-h-11 md:min-h-9" })}>{t.staff.draftEvents}</Link>}
      <Link href={associationHref(workspaceId, "contacts", { status: "new" })}
        className={buttonVariants({ variant: "outline", className: "min-h-11 md:min-h-9" })}>{t.staff.newSubmissions}</Link>
    </div>
    <div className="grid gap-4 sm:grid-cols-2">
      {destinations.map(({ section, icon: Icon, title, description }) => (
        <Link key={section} href={associationHref(workspaceId, section)}
          className="group flex min-w-0 items-start gap-4 rounded-xl border border-border bg-background p-5 transition-colors hover:bg-accent/40 focus-visible:outline-2 focus-visible:outline-ring">
          <span className="rounded-lg bg-muted p-2.5"><Icon aria-hidden className="size-5" /></span>
          <span className="min-w-0 flex-1">
            <span className="block text-base font-semibold">{title}</span>
            <span className="mt-1 block text-sm leading-6 text-muted-foreground">{description}</span>
          </span>
          <ArrowRight aria-hidden className="mt-1 size-4 shrink-0 text-muted-foreground" />
        </Link>
      ))}
    </div>
  </section>;
}
