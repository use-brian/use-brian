"use client";

/** Lazy shared-renderer thumbnail for an Office library card. [COMP:app-web/office-card-preview] */
import { useEffect, useMemo, useRef, useState } from "react";
import { FileText, Presentation } from "lucide-react";
import type { OfficeArtifactSnapshot } from "@use-brian/office-model";
import { layoutOfficeArtifact, renderOfficePreviewSvg } from "@use-brian/office-renderer";
import { getOfficeSnapshot, type OfficeArtifact } from "@/lib/office/api";

export function OfficeCardPreview({ artifact }: { artifact: OfficeArtifact }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [snapshot, setSnapshot] = useState<OfficeArtifactSnapshot | null>(null);

  useEffect(() => {
    if (!canLoadOfficeCardPreview(artifact)) return;
    const host = hostRef.current;
    let live = true;
    let started = false;

    const load = () => {
      if (started) return;
      started = true;
      void getOfficeSnapshot(artifact.artifactId)
        .then((result) => { if (live) setSnapshot(result.snapshot); })
        .catch(() => undefined);
    };

    if (!host || typeof IntersectionObserver === "undefined") {
      load();
      return () => { live = false; };
    }

    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      observer.disconnect();
      load();
    }, { rootMargin: "240px" });
    observer.observe(host);
    return () => {
      live = false;
      observer.disconnect();
    };
  }, [artifact.artifactId, artifact.mode, artifact.version]);

  return (
    <div ref={hostRef} data-office-card-preview-shell={artifact.family} className="relative flex aspect-[16/10] items-center justify-center overflow-hidden border-b bg-muted/45 p-3" aria-hidden="true">
      {snapshot ? <OfficeCardPreviewCanvas snapshot={snapshot} /> : <OfficePreviewPlaceholder family={artifact.family} />}
    </div>
  );
}

export function canLoadOfficeCardPreview(artifact: OfficeArtifact): boolean {
  return artifact.artifactId.length > 0 && (Number(artifact.version) > 0 || artifact.mode === "template");
}

export function OfficeCardPreviewCanvas({ snapshot }: { snapshot: OfficeArtifactSnapshot }) {
  const page = useMemo(() => layoutOfficeArtifact(snapshot).pages[0], [snapshot]);
  const svg = useMemo(() => renderOfficePreviewSvg(page), [page]);
  const presentation = snapshot.family === "presentation";

  return (
    <div
      data-office-card-preview={snapshot.family}
      className={presentation
        ? "w-full overflow-hidden rounded-[2px] bg-white text-slate-950 shadow-sm ring-1 ring-black/10"
        : "h-full overflow-hidden bg-white text-slate-950 shadow-sm ring-1 ring-black/10"}
      style={{ aspectRatio: `${page.widthPt}/${page.heightPt}` }}
    >
      <div
        className="h-full w-full [&_foreignObject_div]:box-border [&_foreignObject_div]:h-full [&_foreignObject_div]:overflow-hidden [&_foreignObject_div]:font-sans [&_foreignObject_div]:leading-tight [&_line]:stroke-slate-500 [&_rect]:fill-slate-100 [&_rect]:stroke-slate-300 [&_svg]:h-full [&_svg]:w-full"
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    </div>
  );
}

function OfficePreviewPlaceholder({ family }: { family: OfficeArtifact["family"] }) {
  const Icon = family === "document" ? FileText : Presentation;
  return (
    <div className={family === "document"
      ? "flex h-full aspect-[612/792] items-center justify-center bg-background/80 shadow-sm ring-1 ring-border"
      : "flex aspect-video w-full items-center justify-center bg-background/80 shadow-sm ring-1 ring-border"}
    >
      <Icon className="size-7 text-muted-foreground/40" />
    </div>
  );
}
