"use client";

/** Lazy shared-renderer thumbnail for an Office library card. [COMP:app-web/office-card-preview] */
import { useEffect, useMemo, useRef, useState } from "react";
import { FileSpreadsheet, FileText, Presentation } from "lucide-react";
import type { OfficeArtifactSnapshot } from "@use-brian/office-model";
import { layoutOfficeArtifact, renderOfficePreviewSvg } from "@use-brian/office-renderer";
import { getOfficeSnapshot, type OfficeArtifact } from "@/lib/office/api";
import { useOptionalWorkspaceContext } from "@/lib/workspace-context";
import { useOfficeMetadataResource } from "@/lib/office/surface-cache";
import { officePreviewCacheKey } from "@/lib/surface-prefetch";
import { useOfficeResourceUrls } from "@/lib/use-doc-media";
import { PresentationSlideVisual } from "./presentation-slide-visual";

export function OfficeCardPreview({ artifact, workspaceId }: { artifact: OfficeArtifact; workspaceId?: string }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const workspace = useOptionalWorkspaceContext();
  const wid = workspaceId ?? workspace?.workspaceId;
  const viewerId = wid && workspace?.workspaceId === wid ? workspace.me.id : '';
  const identity = `${wid}:${viewerId}:${artifact.artifactId}:${artifact.version}`;
  const [visible, setVisible] = useState<string | null>(null);
  useEffect(() => {
    if (!canLoadOfficeCardPreview(artifact)) return;
    const host = hostRef.current;
    if (!host || typeof IntersectionObserver === "undefined") {setVisible(identity);return;}
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) {setVisible(identity);observer.disconnect();}
    }, {rootMargin: "240px"});
    observer.observe(host);
    return () => observer.disconnect();
  }, [identity, artifact.artifactId, artifact.family, artifact.mode, artifact.version]);
  const key = wid && viewerId && visible === identity && canLoadOfficeCardPreview(artifact) ? officePreviewCacheKey(wid, viewerId, artifact.artifactId, artifact.version) : null;
  const read = useOfficeMetadataResource(key, viewerId, () => getOfficeSnapshot(artifact.artifactId));
  const snapshot = read.data?.snapshot;

  return (
    <div
      ref={hostRef}
      data-office-card-preview-shell={artifact.family}
      data-office-card-preview-crop={artifact.family === "presentation" ? "contain" : "top"}
      className={artifact.family !== "presentation"
        ? "relative flex aspect-[16/10] items-start justify-center overflow-hidden border-b bg-muted/45"
        : "relative flex aspect-[16/10] items-center justify-center overflow-hidden border-b bg-muted/45 p-3"}
      aria-hidden="true"
    >
      {snapshot ? <OfficeCardPreviewCanvas snapshot={snapshot} /> : <OfficePreviewPlaceholder family={artifact.family} />}
    </div>
  );
}

export function canLoadOfficeCardPreview(artifact: OfficeArtifact): boolean {
  return artifact.artifactId.length > 0 && (Number(artifact.version) > 0 || artifact.mode === "template");
}

export function OfficeCardPreviewCanvas({ snapshot }: { snapshot: OfficeArtifactSnapshot }) {
  if (snapshot.family === "pdf") return null;
  if (snapshot.family === "presentation") {
    const slide = snapshot.slides[0];
    return (
      <div
        data-office-card-preview="presentation"
        className="h-full max-w-full overflow-hidden rounded-[3px] bg-white text-slate-950 shadow-sm ring-1 ring-black/10"
        style={{ aspectRatio: `${snapshot.slideSize.widthPt}/${snapshot.slideSize.heightPt}` }}
      >
        <PresentationSlideVisual
          artifactId={snapshot.artifactId}
          slide={slide}
          slideSize={snapshot.slideSize}
          className="h-full w-full"
        />
      </div>
    );
  }

  return snapshot.family === "spreadsheet" ? <SpreadsheetCardPreview snapshot={snapshot} /> : <DocumentCardPreview snapshot={snapshot} />;
}

function SpreadsheetCardPreview({ snapshot }: { snapshot: Extract<OfficeArtifactSnapshot, { family: "spreadsheet" }> }) {
  const page = useMemo(() => {
    const pages = layoutOfficeArtifact(snapshot).pages;
    return pages.find((candidate) => candidate.id === snapshot.activeSheetId) ?? pages[0];
  }, [snapshot]);
  const resourceIds = useMemo(() => [...new Set(page.primitives.flatMap((primitive) => primitive.kind === "image" && primitive.resourceId ? [primitive.resourceId] : []))], [page]);
  const {urls:resourceUrls} = useOfficeResourceUrls(snapshot.artifactId,resourceIds);

  const svg = useMemo(() => renderOfficePreviewSvg(page, { resourceUrls }), [page, resourceUrls]);
  return (
    <div data-office-card-preview="spreadsheet" data-office-card-preview-fit="width" className="w-full flex-none overflow-hidden bg-white text-slate-950 shadow-sm ring-1 ring-black/10" style={{ aspectRatio: `${page.widthPt}/${page.heightPt}` }}>
      <div className="h-full w-full [&_foreignObject_div]:box-border [&_foreignObject_div]:h-full [&_foreignObject_div]:overflow-hidden [&_foreignObject_div]:font-sans [&_foreignObject_div]:leading-tight [&_line]:stroke-slate-300 [&_rect]:stroke-slate-300 [&_svg]:h-full [&_svg]:w-full" dangerouslySetInnerHTML={{ __html: svg }} />
    </div>
  );
}

function DocumentCardPreview({ snapshot }: { snapshot: Extract<OfficeArtifactSnapshot, { family: "document" }> }) {
  const page = useMemo(() => layoutOfficeArtifact(snapshot).pages[0], [snapshot]);
  const resourceIds = useMemo(() => [...new Set(page.primitives.flatMap((primitive) => primitive.kind === "image" && primitive.resourceId ? [primitive.resourceId] : []))], [page]);
  const {urls:resourceUrls} = useOfficeResourceUrls(snapshot.artifactId,resourceIds);

  const svg = useMemo(() => renderOfficePreviewSvg(page, { resourceUrls }), [page, resourceUrls]);

  return (
    <div
      data-office-card-preview="document"
      data-office-card-preview-fit="width"
      className="w-full flex-none overflow-hidden bg-white text-slate-950 shadow-sm ring-1 ring-black/10"
      style={{ aspectRatio: `${page.widthPt}/${page.heightPt}` }}
    >
      <div
        className="h-full w-full [&_foreignObject_div]:box-border [&_foreignObject_div]:h-full [&_foreignObject_div]:overflow-hidden [&_foreignObject_div]:font-sans [&_foreignObject_div]:leading-tight [&_rect]:fill-slate-100 [&_rect]:stroke-slate-300 [&_svg]:h-full [&_svg]:w-full"
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    </div>
  );
}

function OfficePreviewPlaceholder({ family }: { family: OfficeArtifact["family"] }) {
  const Icon = family === "document" ? FileText : family === "presentation" ? Presentation : FileSpreadsheet;
  return (
    <div className={family === "document"
      ? "flex w-full flex-none aspect-[612/792] items-start justify-center bg-background/80 pt-12 shadow-sm ring-1 ring-border"
      : family === "presentation" ? "flex aspect-video w-full items-center justify-center bg-background/80 shadow-sm ring-1 ring-border" : "flex w-full flex-none aspect-[595/842] items-start justify-center bg-background/80 pt-12 shadow-sm ring-1 ring-border"}
    >
      <Icon className="size-7 text-muted-foreground/40" />
    </div>
  );
}
