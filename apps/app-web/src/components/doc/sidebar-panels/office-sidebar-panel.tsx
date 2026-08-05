"use client";

/** Persistent Office-local navigation inside the shared workspace sidebar. [COMP:app-web/office-navigation] */
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import {
  Archive,
  FilePlus2,
  FileText,
  Files,
  Presentation,
  Shapes,
  Trash2,
} from "lucide-react";
import { useT } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

const rowCls = (active: boolean) =>
  cn(
    "flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors",
    active
      ? "doc-nav-active font-medium text-sidebar-accent-foreground"
      : "text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
  );

const sectionHeaderCls =
  "px-1 pb-1.5 text-[11px] font-semibold uppercase tracking-wide text-sidebar-foreground/45";

export function OfficeSidebarNavigation({
  workspaceId,
  pathname,
  searchParams,
}: {
  workspaceId: string;
  pathname: string;
  searchParams: URLSearchParams;
}) {
  const t = useT().office;
  const base = `/w/${workspaceId}/office`;
  const atHome = pathname === base || pathname === `${base}/`;
  const familyParam = searchParams.get("family");
  const family = familyParam === "document" || familyParam === "presentation" ? familyParam : undefined;
  const viewParam = searchParams.get("view");
  const view = viewParam === "archived" || viewParam === "trash" || viewParam === "retained" ? viewParam : undefined;
  const atCreate = pathname === `${base}/new`;
  const atTemplates = pathname.startsWith(`${base}/templates`);

  const familyHref = (nextFamily: "document" | "presentation") => {
    const next = new URLSearchParams();
    if (view) next.set("view", view);
    next.set("family", nextFamily);
    return `${base}?${next.toString()}`;
  };

  const primary = [
    { href: base, label: t.overview, icon: Files, active: atHome && !family && !view },
    { href: `${base}/new`, label: t.create, icon: FilePlus2, active: atCreate },
    { href: `${base}/templates`, label: t.templates, icon: Shapes, active: atTemplates },
  ];
  const library = [
    { href: familyHref("document"), label: t.documents, icon: FileText, active: atHome && family === "document" },
    { href: familyHref("presentation"), label: t.presentations, icon: Presentation, active: atHome && family === "presentation" },
  ];
  const manage = [
    { href: `${base}?view=archived`, label: t.archived, icon: Archive, active: atHome && view === "archived" },
    { href: `${base}?view=trash`, label: t.trash, icon: Trash2, active: atHome && view === "trash" },
    { href: `${base}?view=retained`, label: t.retained, icon: Archive, active: atHome && view === "retained" },
  ];

  const rows = (items: typeof primary) => (
    <div className="flex flex-col gap-0.5">
      {items.map(({ href, label, icon: Icon, active }) => (
        <Link key={href} href={href} aria-current={active ? "page" : undefined} className={rowCls(active)}>
          <Icon className="size-4 shrink-0 text-sidebar-foreground/55" aria-hidden />
          <span className="min-w-0 flex-1 truncate">{label}</span>
        </Link>
      ))}
    </div>
  );

  return (
    <nav aria-label={t.officeNavigation} className="flex flex-col gap-3 px-1 pt-1">
      {rows(primary)}
      <div>
        <div className={sectionHeaderCls}>{t.library}</div>
        {rows(library)}
      </div>
      <div>
        <div className={sectionHeaderCls}>{t.manage}</div>
        {rows(manage)}
      </div>
    </nav>
  );
}

export function OfficeSidebarPanel({ workspaceId }: { workspaceId: string }) {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  return (
    <OfficeSidebarNavigation
      workspaceId={workspaceId}
      pathname={pathname}
      searchParams={new URLSearchParams(searchParams.toString())}
    />
  );
}
