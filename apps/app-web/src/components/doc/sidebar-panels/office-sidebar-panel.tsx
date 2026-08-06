"use client";

/** Persistent Office-local navigation inside the shared workspace sidebar. [COMP:app-web/office-navigation] */
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import {
  Files,
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
  const viewParam = searchParams.get("view");
  const view = viewParam === "archived" || viewParam === "trash" || viewParam === "retained" ? viewParam : undefined;
  const atTemplates = pathname.startsWith(`${base}/templates`);
  const rows = [
    { href: base, label: t.files, icon: Files, active: (atHome && view !== "trash") || pathname === `${base}/new` },
    { href: `${base}/templates`, label: t.templates, icon: Shapes, active: atTemplates },
    { href: `${base}?view=trash`, label: t.trash, icon: Trash2, active: atHome && view === "trash" },
  ];

  return (
    <nav aria-label={t.officeNavigation} className="flex flex-col gap-0.5 px-1 pt-1">
      {rows.map(({ href, label, icon: Icon, active }) => (
        <Link key={href} href={href} aria-current={active ? "page" : undefined} className={rowCls(active)}>
          <Icon className="size-4 shrink-0 text-sidebar-foreground/55" aria-hidden />
          <span className="min-w-0 flex-1 truncate">{label}</span>
        </Link>
      ))}
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
