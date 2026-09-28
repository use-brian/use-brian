"use client";

/** Presentation-only role split: owner/admin sections and actions are hidden from members; the server still enforces every write. [COMP:app-web/association] */
import Link from "next/link";
import { ShieldCheck } from "lucide-react";
import { useT } from "@/lib/i18n/client";
import { buttonVariants } from "@/components/ui/button";
import { useAssociationModule } from "./module-controls";
import { associationHref } from "./navigation";
import { EmptyState, InlineNotice } from "./ui";

/** `resolved` is false until the role is known, so owner/admin items never flash in and out. */
export function useAssociationAccess(workspaceId: string) {
  const module = useAssociationModule(workspaceId);
  const resolved = module.data !== undefined || module.error !== undefined;
  return { canManage: !!module.data?.canManage && !module.error, resolved, module };
}

export function ReadOnlyNotice() {
  return <InlineNotice tone="neutral">{useT().associationPage.ux.readOnly}</InlineNotice>;
}

export function AdminOnlyPage({ workspaceId, title }: { workspaceId: string; title: string }) {
  const u = useT().associationPage.ux;
  return <section className="space-y-5" data-admin-only>
    <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
    <EmptyState icon={ShieldCheck} title={u.adminOnlyTitle} description={u.adminOnlyBody}
      action={<Link href={associationHref(workspaceId, "overview")} className={buttonVariants({ variant: "outline", className: "min-h-11 md:min-h-9" })}>{u.backHome}</Link>} />
  </section>;
}
