"use client";

/** Shared web/desktop task navigation. [COMP:app-web/studio-programmatic-access] */
import type { ReactNode } from "react";
import Link from "next/link";
import { useWorkspaces } from "@/contexts/workspace-context";
import { useT } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

export function ProgrammaticAccessShell({ active, children }: {
  active: "connections" | "capture" | "applications";
  children: ReactNode;
}) {
  const { activeId } = useWorkspaces();
  const t = useT();
  const labels = t.programmaticAccess.navigation;
  const base = `/w/${activeId}/studio/programmatic-access`;
  return <div className="mx-auto flex w-full min-w-0 max-w-5xl flex-col gap-5">
    <p className="text-sm text-muted-foreground">{labels.description}</p>
    {activeId && <nav aria-label={t.studioPage.sections.programmaticAccess} className="flex flex-wrap gap-1 border-b border-border pb-2">
      {(["connections", "capture", "applications"] as const).map(destination => <Link
        key={destination}
        href={destination === "connections" ? base : `${base}/${destination}`}
        aria-current={active === destination ? "page" : undefined}
        className={cn("inline-flex min-h-8 max-sm:min-h-11 items-center justify-center rounded-lg px-3 text-sm font-medium transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring", active === destination ? "bg-muted text-foreground" : "text-muted-foreground hover:bg-muted/60 hover:text-foreground")}
      >{labels[destination]}</Link>)}
    </nav>}
    {children}
  </div>;
}
