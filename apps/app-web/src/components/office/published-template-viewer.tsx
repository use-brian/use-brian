"use client";

/** Full immutable template preview. [COMP:app-web/office-published-template] */
import { useMemo } from "react";
import { layoutOfficeArtifact, renderOfficePreviewSvg } from "@use-brian/office-renderer";
import { getPublishedOfficeTemplate } from "@/lib/office/api";
import { useOfficeMetadataResource } from "@/lib/office/surface-cache";
import { officePublishedTemplateCacheKey } from "@/lib/surface-prefetch";
import { useOfficeResourceUrls } from "@/lib/use-doc-media";
import { useT } from "@/lib/i18n/client";
import { Button } from "@/components/ui/button";

export function PublishedTemplateViewer({ workspaceId, viewerId, templateId, versionId }: { workspaceId: string; viewerId: string; templateId: string; versionId: string }) {
  const t = useT();
  const resource = useOfficeMetadataResource(viewerId ? officePublishedTemplateCacheKey(workspaceId, viewerId, templateId, versionId) : null, viewerId, () => getPublishedOfficeTemplate(templateId, versionId));
  const snapshot = resource.data;
  const pages = useMemo(() => snapshot ? layoutOfficeArtifact(snapshot).pages : [], [snapshot]);
  const ids = useMemo(() => [...new Set(pages.flatMap(page => page.primitives.flatMap(primitive => primitive.kind === "image" && primitive.resourceId ? [primitive.resourceId] : [])))], [pages]);
  const { urls } = useOfficeResourceUrls(snapshot?.artifactId ?? "", ids, { templateId, versionId });
  if (!snapshot) return resource.error ? <div role="alert"><p>{t.office.loadFailed}</p><Button onClick={() => void resource.refresh()}>{t.chat.retry}</Button></div> : <div className="h-64 animate-pulse rounded-xl bg-muted" aria-busy="true" />;
  return <div data-office-published-template="true" className="flex max-h-[65dvh] min-h-0 gap-3 overflow-hidden">
    <nav aria-label={t.office.pdf.pages} className="w-20 shrink-0 space-y-2 overflow-y-auto p-1">
      {pages.map((page, index) => <button type="button" key={page.id} className="min-h-11 md:min-h-8 w-full rounded border p-2 text-sm hover:bg-muted" onClick={() => document.getElementById(`published-template-page-${templateId}-${index}`)?.scrollIntoView({ block: "nearest" })}>{index + 1}</button>)}
    </nav>
    <div className="min-w-0 flex-1 space-y-4 overflow-auto bg-muted/40 p-2">
      {pages.map((page, index) => <div key={page.id} id={`published-template-page-${templateId}-${index}`} className="bg-white text-slate-950 shadow-sm [&_svg]:h-auto [&_svg]:w-full" dangerouslySetInnerHTML={{ __html: renderOfficePreviewSvg(page, { resourceUrls: urls }) }} />)}
    </div>
  </div>;
}
