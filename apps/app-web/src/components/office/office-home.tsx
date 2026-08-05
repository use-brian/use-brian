"use client";

/** Permission-filtered Office home and generation state. [COMP:app-web/office-home] */
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { FileText, Presentation, Plus, Shapes } from "lucide-react";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n/format";
import { listOfficeArtifacts, type OfficeArtifact, type OfficeFamily } from "@/lib/office/api";
import { OfficeImport } from "./office-import";
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
  const filter: Filter = familyParam === "document" || familyParam === "presentation" ? familyParam : "all";
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
    ...(view === "active" ? [] : [{ label: t[view] }]),
    ...(filter === "all" ? [] : [{ label: filter === "document" ? t.documents : t.presentations }]),
  ];
  if (breadcrumbs.length === 0) breadcrumbs.push({ label: t.overview });

  return (
    <div className="flex min-h-0 flex-1 flex-col bg-background">
      <OfficeTopbar
        workspaceId={workspaceId}
        breadcrumbs={breadcrumbs}
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
