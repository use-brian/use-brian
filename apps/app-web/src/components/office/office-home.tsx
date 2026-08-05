"use client";

/** Permission-filtered Office home and generation state. [COMP:app-web/office-home] */
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { FileText, Presentation, Plus, Shapes } from "lucide-react";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n/format";
import { cn } from "@/lib/utils";
import { listOfficeArtifacts, type OfficeArtifact, type OfficeFamily } from "@/lib/office/api";
import { OfficeImport } from "./office-import";
import { OfficeCardPreview } from "./office-card-preview";
import { OfficeTopbar } from "./office-topbar";

type View = "active" | "archived" | "trash" | "retained";
type Filter = "all" | OfficeFamily;

export function OfficeHome({ workspaceId, initialArtifacts }: { workspaceId: string; initialArtifacts?: OfficeArtifact[] }) {
  const t = useT().office;
  const router = useRouter();
  const searchParams = useSearchParams();
  const viewParam = searchParams.get("view");
  const familyParam = searchParams.get("family");
  const view: View = viewParam === "archived" || viewParam === "trash" || viewParam === "retained" ? viewParam : "active";
  const filter: Filter = familyParam === "document" || familyParam === "presentation" ? familyParam : "all";
  const [artifacts, setArtifacts] = useState<OfficeArtifact[] | null>(initialArtifacts ?? null);
  const [failed, setFailed] = useState(false);
  const base = `/w/${workspaceId}/office`;

  function replaceFilters(nextView: View, nextFilter: Filter) {
    const next = new URLSearchParams(searchParams.toString());
    if (nextView === "active") next.delete("view");
    else next.set("view", nextView);
    if (nextFilter === "all") next.delete("family");
    else next.set("family", nextFilter);
    if (nextView !== view) setArtifacts(null);
    const query = next.toString();
    router.replace(query ? `${base}?${query}` : base, { scroll: false });
  }

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
      <OfficeTopbar
        workspaceId={workspaceId}
        breadcrumbs={[{ label: t.overview }]}
        right={
          <div className="flex items-center gap-1">
            <OfficeImport workspaceId={workspaceId} />
            <Link aria-label={t.templates} title={t.templates} className="inline-flex size-8 items-center justify-center gap-2 rounded-md border text-sm font-medium sm:w-auto sm:px-2.5" href={`${base}/templates`}>
              <Shapes className="size-4" aria-hidden /><span className="hidden sm:inline">{t.templates}</span>
            </Link>
            <Link aria-label={t.create} title={t.create} className="inline-flex size-8 items-center justify-center gap-2 rounded-md bg-primary text-sm font-medium text-primary-foreground sm:w-auto sm:px-2.5" href={`${base}/new`}>
              <Plus className="size-4" aria-hidden /><span className="hidden sm:inline">{t.create}</span>
            </Link>
          </div>
        }
      />
      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 p-4 sm:p-6 lg:p-8">
        <h1 className="sr-only">{t.homeTitle}</h1>

        <div className="flex flex-wrap items-center justify-between gap-3 border-b pb-3">
          <div className="flex gap-1" role="tablist">
            {(["active", "archived", "trash", "retained"] as const).map((item) => (
              <button key={item} type="button" role="tab" aria-selected={view === item} onClick={() => replaceFilters(item, filter)} className={cn("rounded-md px-3 py-1.5 text-sm", view === item ? "bg-muted font-medium" : "text-muted-foreground")}>
                {t[item]}
              </button>
            ))}
          </div>
          <div className="flex gap-1">
            {(["all", "document", "presentation"] as const).map((item) => (
              <button key={item} type="button" onClick={() => replaceFilters(view, item)} className={cn("rounded-full border px-3 py-1 text-xs", filter === item && "border-foreground bg-foreground text-background")}>
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
                <Link key={artifact.artifactId} href={`/w/${workspaceId}/office/${artifact.artifactId}`} className="group overflow-hidden rounded-xl border bg-card transition-colors hover:border-foreground/30">
                  <OfficeCardPreview artifact={artifact} />
                  <div className="p-4">
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Icon className="size-4" aria-hidden />
                      <span>{artifact.family === "document" ? t.document : t.presentation}</span>
                    </div>
                    <h2 className="mt-3 line-clamp-2 font-medium group-hover:underline">{artifact.title}</h2>
                    <div className="mt-2 flex justify-end text-xs text-muted-foreground">
                      <span>{format(t.version, { version: artifact.version })}</span>
                    </div>
                    {artifact.job ? <p className="mt-3 text-xs font-medium">{t[artifact.job.status as keyof Pick<typeof t, "queued" | "running" | "completed" | "failed" | "cancelled">] ?? artifact.job.stage}</p> : null}
                  </div>
                </Link>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}
