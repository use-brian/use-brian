"use client";

/** Permission-filtered Office home and generation state. [COMP:app-web/office-home] */
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { FileSpreadsheet, FileText, Presentation, Plus } from "lucide-react";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n/format";
import { isOfficeStartFailed, listOfficeArtifacts, officeJobFailureKind, type OfficeArtifact, type OfficeFamily } from "@/lib/office/api";
import { OfficeCardPreview } from "./office-card-preview";
import { OfficeTopbar } from "./office-topbar";

type View = "active" | "archived" | "trash" | "retained";
type Filter = "all" | OfficeFamily;

export function OfficeHome({ workspaceId, initialArtifacts }: { workspaceId: string; initialArtifacts?: OfficeArtifact[] }) {
  const t = useT().office;
  const searchParams = useSearchParams();
  const viewParam = searchParams.get("view");
  const familyParam = searchParams.get("family");
  const view: View = viewParam === "archived" || viewParam === "trash" || viewParam === "retained" ? viewParam : "active";
  const filter: Filter = familyParam === "document" || familyParam === "presentation" || familyParam === "spreadsheet" ? familyParam : "all";
  const [artifacts, setArtifacts] = useState<OfficeArtifact[] | null>(initialArtifacts ?? null);
  const [failed, setFailed] = useState(false);
  const base = `/w/${workspaceId}/office`;

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
  const breadcrumbs = [
    { label: view === "active" ? t.files : t[view] },
    ...(filter === "all" ? [] : [{ label: filter === "document" ? t.documents : filter === "presentation" ? t.presentations : t.spreadsheets }]),
  ];
  const filterHref = (next: Filter) => {
    const query = new URLSearchParams();
    if (view !== "active") query.set("view", view);
    if (next !== "all") query.set("family", next);
    const serialized = query.toString();
    return serialized ? `${base}?${serialized}` : base;
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <OfficeTopbar
        workspaceId={workspaceId}
        breadcrumbs={breadcrumbs}
        right={
          <div className="flex items-center gap-1.5">
            <div className="flex max-w-[min(70vw,24rem)] items-center overflow-x-auto rounded-md border p-0.5" aria-label={t.fileFilters}>
              {(["all", "document", "presentation", "spreadsheet"] as const).map((item) => <Link key={item} href={filterHref(item)} aria-current={filter === item ? "page" : undefined} className={filter === item ? "rounded px-2 py-1 text-xs font-medium bg-foreground text-background" : "rounded px-2 py-1 text-xs text-muted-foreground hover:text-foreground"}>{item === "all" ? t.all : item === "document" ? t.documents : item === "presentation" ? t.presentations : t.spreadsheets}</Link>)}
            </div>
            <Link aria-label={t.newArtifact} title={t.newArtifact} className="inline-flex size-8 items-center justify-center gap-2 rounded-md bg-action text-sm font-medium text-action-foreground shadow-sm transition-colors hover:bg-action/85 sm:w-auto sm:px-2.5" href={`${base}/new`}>
              <Plus className="size-4" aria-hidden /><span className="hidden sm:inline">{t.newArtifact}</span>
            </Link>
          </div>
        }
      />
      <main className="mx-auto flex w-full max-w-6xl flex-1 flex-col gap-6 p-4 sm:p-6 lg:p-8">
        <h1 className="sr-only">{t.homeTitle}</h1>

        {artifacts === null ? <p className="py-16 text-center text-sm text-muted-foreground">{t.loading}</p> : failed ? <p className="py-16 text-center text-sm text-destructive">{t.loadFailed}</p> : visible.length === 0 ? view === "active" && filter === "all" ? (
          <section className="rounded-2xl border border-dashed px-6 py-14 text-center">
            <h2 className="font-medium">{t.firstArtifactEmptyTitle}</h2>
            <p className="mx-auto mt-1 max-w-lg text-sm text-muted-foreground">{t.firstArtifactEmptyBody}</p>
            <Link href={`${base}/new`} className="mt-5 inline-flex h-9 items-center rounded-md bg-action px-4 text-sm font-medium text-action-foreground">{t.browseTemplates}</Link>
          </section>
        ) : (
          <div className="rounded-xl border border-dashed px-6 py-16 text-center">
            <p className="font-medium">{t.emptyTitle}</p>
            <p className="mt-1 text-sm text-muted-foreground">{t.emptyBody}</p>
          </div>
        ) : (
          <div data-office-file-grid="true" className="grid grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-4">
            {visible.map((artifact) => {
              const Icon = artifact.family === "document" ? FileText : artifact.family === "presentation" ? Presentation : FileSpreadsheet;
              const startFailed = isOfficeStartFailed(artifact);
              const failureKind = officeJobFailureKind(artifact.job?.errorCode);
              const status = startFailed
                ? t.startFailed
                : artifact.job?.status === "failed"
                  ? failureKind === "presentation_fit" ? t.presentationFitFailed : failureKind === "fit" ? t.fitFailed : t.failed
                : artifact.job
                  ? t[artifact.job.status as keyof Pick<typeof t, "queued" | "running" | "completed" | "failed" | "cancelled">] ?? artifact.job.stage
                  : null;
              return (
                <Link key={artifact.artifactId} data-office-file-card={artifact.family} href={`/w/${workspaceId}/office/${artifact.artifactId}`} className="group min-w-0 overflow-hidden rounded-xl border bg-card shadow-[0_1px_2px_rgb(0_0_0/0.03)] transition-[border-color,box-shadow] hover:border-foreground/25 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
                  <OfficeCardPreview artifact={artifact} />
                  <div className="flex min-h-32 flex-col p-3.5">
                    <div className="flex items-center gap-1.5 text-[11px] font-medium text-muted-foreground">
                      <Icon className={artifact.family === "document" ? "size-3.5 text-blue-600 dark:text-blue-400" : artifact.family === "presentation" ? "size-3.5 text-amber-600 dark:text-amber-400" : "size-3.5 text-emerald-600 dark:text-emerald-400"} aria-hidden />
                      <span>{artifact.family === "document" ? t.document : artifact.family === "presentation" ? t.presentation : t.spreadsheet}</span>
                    </div>
                    <h2 className="mt-2 line-clamp-2 min-h-10 text-sm font-medium leading-5 text-foreground">{artifact.title}</h2>
                    <div data-office-file-card-footer="true" className="mt-auto flex min-h-5 items-center gap-3 pt-3 text-[11px] text-muted-foreground">
                      {status ? <span className={startFailed || artifact.job?.status === "failed" ? "min-w-0 truncate font-medium text-destructive" : "min-w-0 truncate font-medium text-foreground/75"}>{status}</span> : null}
                      <span className="ml-auto shrink-0">{format(t.version, { version: artifact.version })}</span>
                    </div>
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
