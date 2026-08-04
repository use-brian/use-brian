"use client";

/** Permission-filtered Office home and generation state. [COMP:app-web/office-home] */
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { FileText, Presentation, Plus, Shapes } from "lucide-react";
import { OperatorTopbar } from "@/components/operator/operator-topbar";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n/format";
import { cn } from "@/lib/utils";
import { listOfficeArtifacts, type OfficeArtifact, type OfficeFamily } from "@/lib/office/api";
import { OfficeImport } from "./office-import";

type View = "active" | "archived" | "trash";
type Filter = "all" | OfficeFamily;

export function OfficeHome({ workspaceId, initialArtifacts }: { workspaceId: string; initialArtifacts?: OfficeArtifact[] }) {
  const t = useT().office;
  const [view, setView] = useState<View>("active");
  const [filter, setFilter] = useState<Filter>("all");
  const [artifacts, setArtifacts] = useState<OfficeArtifact[] | null>(initialArtifacts ?? null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (initialArtifacts && view === "active") return;
    let live = true;
    setFailed(false);
    void listOfficeArtifacts(workspaceId, view)
      .then((rows) => { if (live) setArtifacts(rows); })
      .catch(() => { if (live) { setArtifacts([]); setFailed(true); } });
    return () => { live = false; };
  }, [initialArtifacts, view, workspaceId]);

  const visible = useMemo(
    () => (artifacts ?? []).filter((artifact) => filter === "all" || artifact.family === filter),
    [artifacts, filter],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <OperatorTopbar app="office" />
      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 p-4 sm:p-6 lg:p-8">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">{t.homeTitle}</h1>
            <p className="mt-1 text-sm text-muted-foreground">{t.homeDescription}</p>
          </div>
          <div className="flex gap-2">
            <OfficeImport workspaceId={workspaceId} />
            <Link className="inline-flex h-9 items-center gap-2 rounded-md border px-3 text-sm font-medium" href={`/w/${workspaceId}/office/templates`}>
              <Shapes className="size-4" aria-hidden />{t.templates}
            </Link>
            <Link className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground" href={`/w/${workspaceId}/office/new`}>
              <Plus className="size-4" aria-hidden />{t.create}
            </Link>
          </div>
        </header>

        <div className="flex flex-wrap items-center justify-between gap-3 border-b pb-3">
          <div className="flex gap-1" role="tablist">
            {(["active", "archived", "trash"] as const).map((item) => (
              <button key={item} type="button" role="tab" aria-selected={view === item} onClick={() => { setArtifacts(null); setView(item); }} className={cn("rounded-md px-3 py-1.5 text-sm", view === item ? "bg-muted font-medium" : "text-muted-foreground")}>
                {t[item]}
              </button>
            ))}
          </div>
          <div className="flex gap-1">
            {(["all", "document", "presentation"] as const).map((item) => (
              <button key={item} type="button" onClick={() => setFilter(item)} className={cn("rounded-full border px-3 py-1 text-xs", filter === item && "border-foreground bg-foreground text-background")}>
                {item === "all" ? t.all : item === "document" ? t.documents : t.presentations}
              </button>
            ))}
          </div>
        </div>

        {artifacts === null ? <p className="py-16 text-center text-sm text-muted-foreground">{t.loading}</p> : failed ? <p className="py-16 text-center text-sm text-destructive">{t.loadFailed}</p> : visible.length === 0 ? (
          <div className="rounded-xl border border-dashed px-6 py-16 text-center">
            <p className="font-medium">{t.emptyTitle}</p>
            <p className="mt-1 text-sm text-muted-foreground">{t.emptyBody}</p>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {visible.map((artifact) => {
              const Icon = artifact.family === "document" ? FileText : Presentation;
              return (
                <Link key={artifact.artifactId} href={`/w/${workspaceId}/office/${artifact.artifactId}`} className="group rounded-xl border bg-card p-4 transition-colors hover:border-foreground/30">
                  <Icon className="size-5 text-muted-foreground" aria-hidden />
                  <h2 className="mt-8 line-clamp-2 font-medium group-hover:underline">{artifact.title}</h2>
                  <div className="mt-2 flex justify-between text-xs text-muted-foreground">
                    <span>{artifact.family === "document" ? t.document : t.presentation}</span>
                    <span>{format(t.version, { version: artifact.version })}</span>
                  </div>
                  {artifact.job ? <p className="mt-3 text-xs font-medium">{t[artifact.job.status as keyof Pick<typeof t, "queued" | "running" | "completed" | "failed" | "cancelled">] ?? artifact.job.stage}</p> : null}
                </Link>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}
