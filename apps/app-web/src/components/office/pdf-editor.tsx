"use client";

/** Canonical PDF session editor. The immutable source paints through PDF.js;
 * every editable surface is a DOM projection of the Office PDF snapshot.
 * [COMP:app-web/office-pdf-editor] */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import type { OfficeCommand, PdfField, PdfOverlay, PdfPage, PdfRect, PdfSnapshot } from "@use-brian/office-model";
import { CalendarPlus, Check, ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Download, FileImage, List, PenLine, RotateCw, Save, Trash2, Type } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { useT } from "@/lib/i18n/client";
import { getUserInfo } from "@/lib/user";
import {
  admitPdfSessionImage,
  readOfficePdfSource,
  readOfficeReleasedFile,
  releaseOfficeArtifact,
  saveOfficePdfToFiles,
  submitOfficeCommand,
  uploadPdfSessionImage,
} from "@/lib/office/api";
import { cn } from "@/lib/utils";
import { clampPdfRect, cssDeltaToPdf, pdfRectToCss } from "./pdf/geometry";
import { PdfPageCanvas } from "./pdf/page-canvas";

type PdfEditorProps = {
  workspaceId: string;
  snapshot: PdfSnapshot;
  seq: number;
  baseVersion: number;
  artifactVersion: number;
  expiresAt: string;
  role: "view" | "comment" | "edit";
  onCommand(command: OfficeCommand): Promise<void> | void;
  onReadback(): Promise<void>;
  onSelectTargets(ids: string[]): void;
};

type Tool = "text" | "date" | "checkmark" | "image" | "signature";
type Drag = { overlay: PdfOverlay; x: number; y: number; mode: "move" | "resize" };

const button = "inline-flex min-h-11 items-center justify-center gap-1.5 rounded-md border bg-background px-3 text-xs font-medium hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50 sm:min-h-9";

function safePdfName(title: string): string {
  const stem = title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-").trim().slice(0, 120) || "edited-pdf";
  return stem.toLowerCase().endsWith(".pdf") ? stem : `${stem}.pdf`;
}

function common(snapshot: PdfSnapshot, baseVersion: number, actorId: string) {
  return { commandId: crypto.randomUUID(), artifactId: snapshot.artifactId, baseVersion, actor: { type: "user" as const, id: actorId }, origin: "manual" as const };
}

function defaultRect(page: PdfPage, kind: Tool): PdfRect {
  const width = kind === "checkmark" ? 24 : kind === "signature" || kind === "image" ? 160 : 140;
  const height = kind === "checkmark" ? 24 : kind === "signature" || kind === "image" ? 54 : 28;
  return clampPdfRect(page, { x: 24, y: Math.max(24, page.cropBox.height - height - 24), width, height });
}

function overlayText(overlay: PdfOverlay): string {
  if (overlay.kind === "text") return overlay.text;
  if (overlay.kind === "date") return overlay.date;
  if (overlay.kind === "checkmark") return overlay.mark === "x" ? "×" : "✓";
  return overlay.kind === "signature" ? "Signature" : "Image";
}

function useProtectedPdf(artifactId: string) {
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "failed">("loading");
  const generation = useRef(0);
  const refresh = useCallback(() => {
    generation.current += 1;
    setDocument((current) => { void current?.destroy(); return null; });
    setState("loading");
  }, []);

  useEffect(() => {
    const owner = generation.current;
    let loaded: PDFDocumentProxy | null = null;
    let timer = 0;
    void readOfficePdfSource(artifactId).then(async (source) => {
      const pdfjs = await import("pdfjs-dist");
      pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
      const task = pdfjs.getDocument({ data: new Uint8Array(source.bytes.slice(0)), isEvalSupported: false });
      loaded = await task.promise;
      if (generation.current !== owner) { await loaded.destroy(); return; }
      setDocument(loaded);
      setState("ready");
      timer = window.setTimeout(refresh, Math.max(1_000, source.validForMs - 250));
    }).catch(() => { if (generation.current === owner) setState("failed"); });
    return () => { window.clearTimeout(timer); void loaded?.destroy(); };
  }, [artifactId, refresh, generation.current]);

  useEffect(() => {
    const purge = () => refresh();
    const visible = () => { if (window.document.visibilityState === "visible") purge(); };
    window.addEventListener("focus", purge);
    window.document.addEventListener("visibilitychange", visible);
    return () => { window.removeEventListener("focus", purge); window.document.removeEventListener("visibilitychange", visible); };
  }, [refresh]);

  return { document, state, refresh };
}

export function PdfEditor(props: PdfEditorProps) {
  const { workspaceId, snapshot, seq, baseVersion, artifactVersion, expiresAt, role, onCommand, onReadback, onSelectTargets } = props;
  const t = useT().office.pdf;
  const actorId = getUserInfo()?.id ?? "";
  const [pageId, setPageId] = useState(snapshot.pages[0]?.id ?? "");
  const [selectedOverlayId, setSelectedOverlayId] = useState<string | null>(null);
  const [phoneSheet, setPhoneSheet] = useState<"pages" | "fields" | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [seconds, setSeconds] = useState(() => Math.max(0, Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 1_000)));
  const [ghost, setGhost] = useState<{ kind: "signature"; rect: PdfRect } | null>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const pendingImageKind = useRef<"image" | "signature">("image");
  const drag = useRef<Drag | null>(null);
  const pageSurface = useRef<HTMLDivElement>(null);
  const protectedPdf = useProtectedPdf(snapshot.artifactId);
  const pageIndex = Math.max(0, snapshot.pages.findIndex((page) => page.id === pageId));
  const page = snapshot.pages[pageIndex] ?? snapshot.pages[0];
  const allFields = useMemo(() => snapshot.pages.flatMap((candidate, index) => candidate.fields.map((field) => ({ field, page: candidate, index }))), [snapshot.pages]);
  const resource = snapshot.resources.find((candidate) => candidate.kind === "image" && /^image\/(?:png|jpeg)$/.test(candidate.mime));
  const canEdit = role === "edit" && seconds > 0 && Boolean(actorId);

  useEffect(() => {
    const timer = window.setInterval(() => setSeconds(Math.max(0, Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 1_000))), 1_000);
    return () => window.clearInterval(timer);
  }, [expiresAt]);
  useEffect(() => { if (!snapshot.pages.some((candidate) => candidate.id === pageId)) setPageId(snapshot.pages[0]?.id ?? ""); }, [pageId, snapshot.pages]);
  useEffect(() => { onSelectTargets(selectedOverlayId ? [selectedOverlayId] : [page.id]); }, [onSelectTargets, page.id, selectedOverlayId]);

  const run = useCallback(async (command: OfficeCommand) => {
    if (!canEdit || busy) return;
    setBusy(true); setNotice(null);
    try { await onCommand(command); }
    catch { setNotice(t.commandFailed); }
    finally { setBusy(false); }
  }, [busy, canEdit, onCommand, t.commandFailed]);

  function fieldCommand(field: PdfField, value: PdfField["value"]): OfficeCommand {
    return { ...common(snapshot, baseVersion, actorId), kind: "setPdfFieldValue", fieldId: field.id, value };
  }

  function addOverlay(kind: Exclude<Tool, "image" | "signature">) {
    const rect = defaultRect(page, kind);
    const base = { id: crypto.randomUUID(), pageId: page.id, rect, rotation: 0, zOrder: Math.max(0, ...page.overlays.map((overlay) => overlay.zOrder + 1)), creator: { type: "user" as const, id: actorId } };
    const overlay: PdfOverlay = kind === "text"
      ? { ...base, kind, text: t.newText, appearance: { fontSizePt: 11, color: "#111111", alignment: "start" } }
      : kind === "date"
        ? { ...base, kind, date: new Date().toISOString().slice(0, 10), appearance: { fontSizePt: 11, color: "#111111", alignment: "start" } }
        : { ...base, kind, mark: "check", color: "#111111", strokeWidthPt: 2 };
    void run({ ...common(snapshot, baseVersion, actorId), kind: "addPdfOverlay", pageId: page.id, overlay });
    setSelectedOverlayId(overlay.id);
  }

  async function admitImage(file: File, kind: "image" | "signature") {
    if (!canEdit || busy) return;
    setBusy(true); setNotice(null);
    try {
      const sourceAttachmentId = await uploadPdfSessionImage(workspaceId, file);
      const admitted = await admitPdfSessionImage(snapshot.artifactId, seq, sourceAttachmentId);
      const rect = defaultRect(page, kind);
      if (kind === "signature") {
        setGhost({ kind, rect });
        const confirmed = await confirmDialog({ title: t.confirmSignatureTitle, description: t.confirmSignatureBody, confirmLabel: t.placeSignature, cancelLabel: t.cancel });
        if (confirmed) {
          const targetId = crypto.randomUUID();
          const command: OfficeCommand = {
            ...common(snapshot, baseVersion, actorId), kind: "batch", commands: [
              { ...common(snapshot, baseVersion, actorId), kind: "createPdfPlacementTarget", pageId: page.id, target: { id: targetId, purpose: "signature", pageId: page.id, rect, creatorUserId: actorId, creationVersion: baseVersion } },
              { ...common(snapshot, baseVersion, actorId), kind: "placePdfSignature", targetId, signatureResourceId: admitted.signatureResourceId },
            ],
          };
          await submitOfficeCommand(snapshot.artifactId, admitted.seq, command, "apply");
        }
        setGhost(null);
      } else {
        const overlay: PdfOverlay = { id: crypto.randomUUID(), pageId: page.id, rect, rotation: 0, zOrder: Math.max(0, ...page.overlays.map((item) => item.zOrder + 1)), creator: { type: "user", id: actorId }, kind: "image", resourceId: admitted.signatureResourceId };
        await submitOfficeCommand(snapshot.artifactId, admitted.seq, { ...common(snapshot, baseVersion, actorId), kind: "addPdfOverlay", pageId: page.id, overlay }, "apply");
      }
      await onReadback();
    } catch { setGhost(null); setNotice(t.imageFailed); }
    finally { setBusy(false); if (imageInput.current) imageInput.current.value = ""; }
  }

  async function addSignature() {
    const rect = defaultRect(page, "signature");
    if (!resource) { pendingImageKind.current = "signature"; imageInput.current?.click(); return; }
    setGhost({ kind: "signature", rect });
    const confirmed = await confirmDialog({ title: t.confirmSignatureTitle, description: t.confirmSignatureBody, confirmLabel: t.placeSignature, cancelLabel: t.cancel });
    if (!confirmed) { setGhost(null); return; }
    const targetId = crypto.randomUUID();
    await run({ ...common(snapshot, baseVersion, actorId), kind: "batch", commands: [
      { ...common(snapshot, baseVersion, actorId), kind: "createPdfPlacementTarget", pageId: page.id, target: { id: targetId, purpose: "signature", pageId: page.id, rect, creatorUserId: actorId, creationVersion: baseVersion } },
      { ...common(snapshot, baseVersion, actorId), kind: "placePdfSignature", targetId, signatureResourceId: resource.id },
    ] });
    setGhost(null);
  }

  async function removePage() {
    if (snapshot.pages.length <= 1) return;
    const confirmed = await confirmDialog({ title: t.deletePage, description: t.deletePageBody.replace("{page}", String(pageIndex + 1)), confirmLabel: t.deletePage, cancelLabel: t.cancel, variant: "destructive" });
    if (confirmed) void run({ ...common(snapshot, baseVersion, actorId), kind: "deletePdfPage", pageId: page.id });
  }

  function changeOverlay(overlay: PdfOverlay, rect: PdfRect) {
    void run({ ...common(snapshot, baseVersion, actorId), kind: "transformPdfOverlay", overlayId: overlay.id, rect: clampPdfRect(page, rect), rotation: overlay.rotation });
  }

  function beginDrag(event: React.PointerEvent, overlay: PdfOverlay, mode: "move" | "resize") {
    if (!canEdit) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { overlay, x: event.clientX, y: event.clientY, mode };
    event.preventDefault();
  }

  function finishDrag(event: React.PointerEvent) {
    const active = drag.current;
    drag.current = null;
    if (!active || !pageSurface.current) return;
    const bounds = pageSurface.current.getBoundingClientRect();
    const delta = cssDeltaToPdf(page, event.clientX - active.x, event.clientY - active.y, bounds.width, bounds.height);
    const rect = active.mode === "move"
      ? { ...active.overlay.rect, x: active.overlay.rect.x + delta.x, y: active.overlay.rect.y + delta.y }
      : { ...active.overlay.rect, width: Math.max(8, active.overlay.rect.width + delta.x), height: Math.max(8, active.overlay.rect.height + delta.y) };
    changeOverlay(active.overlay, rect);
  }

  async function release(download: boolean) {
    if (!canEdit || busy) return;
    setBusy(true); setNotice(null);
    try {
      const result = await releaseOfficeArtifact(snapshot.artifactId, { expectedVersion: artifactVersion, action: "export", destination: { sensitivity: "confidential", external: false }, format: "pdf" });
      if (result.receipt.status !== "ready" || !result.fileId || !result.receipt.pdf) throw new Error("pdf_release_failed");
      if (download) {
        const blob = await readOfficeReleasedFile(workspaceId, result.fileId);
        const url = URL.createObjectURL(blob);
        const anchor = window.document.createElement("a");
        anchor.href = url; anchor.download = safePdfName(snapshot.title); anchor.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
        setNotice(t.downloadReady);
      } else {
        await saveOfficePdfToFiles(snapshot.artifactId, { expectedSeq: seq, releaseHash: result.receipt.pdf.sha256, path: `/PDF exports/${safePdfName(snapshot.title)}` });
        setNotice(t.savedToFiles);
      }
    } catch { setNotice(t.releaseFailed); }
    finally { setBusy(false); }
  }

  if (!page) return null;
  const selectedOverlay = page.overlays.find((overlay) => overlay.id === selectedOverlayId) ?? null;
  const expiry = seconds <= 0 ? t.expired : t.expiresIn.replace("{time}", `${Math.floor(seconds / 3600)}:${String(Math.floor(seconds / 60) % 60).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`);
  const canvasWidth = page.rotation === 90 || page.rotation === 270 ? Math.min(760, page.cropBox.height) : Math.min(760, page.cropBox.width);

  return <div className="flex min-h-0 w-full flex-col" data-pdf-editor data-phone-single-page="true">
    <div className="hidden min-h-12 flex-wrap items-center gap-2 border-b bg-background px-3 md:flex" aria-label={t.toolbar}>
      <ToolButton label={t.addText} icon={<Type />} disabled={!canEdit || busy} onClick={() => addOverlay("text")} />
      <ToolButton label={t.addDate} icon={<CalendarPlus />} disabled={!canEdit || busy} onClick={() => addOverlay("date")} />
      <ToolButton label={t.addCheckmark} icon={<Check />} disabled={!canEdit || busy} onClick={() => addOverlay("checkmark")} />
      <ToolButton label={t.addImage} icon={<FileImage />} disabled={!canEdit || busy} onClick={() => { pendingImageKind.current = "image"; imageInput.current?.click(); }} />
      <ToolButton label={t.addSignature} icon={<PenLine />} disabled={!canEdit || busy} onClick={() => void addSignature()} />
      <span className={cn("ml-auto rounded-full px-2 py-1 text-xs", seconds <= 300 ? "bg-amber-100 text-amber-950" : "bg-muted text-muted-foreground")}>{expiry}</span>
      <button type="button" className={button} disabled={!canEdit || busy} onClick={() => void release(true)}><Download className="size-4" />{t.download}</button>
      <button type="button" className={button} disabled={!canEdit || busy} onClick={() => void release(false)}><Save className="size-4" />{t.saveToFiles}</button>
    </div>
    {notice ? <p className="border-b bg-background px-3 py-2 text-xs" role="status">{notice}</p> : null}
    <div className="flex min-h-0 flex-1 overflow-hidden">
      <aside className="hidden w-36 shrink-0 overflow-y-auto border-r bg-background p-2 md:block" aria-label={t.pages}>
        {snapshot.pages.map((candidate, index) => <button key={candidate.id} type="button" onClick={() => { setPageId(candidate.id); setSelectedOverlayId(null); }} className={cn("mb-2 w-full rounded border p-1 text-xs", candidate.id === page.id && "border-primary ring-2 ring-primary/20")} aria-current={candidate.id === page.id ? "page" : undefined}>
          {protectedPdf.document ? <PdfPageCanvas document={protectedPdf.document} sourcePageIndex={candidate.sourcePageIndex} rotation={candidate.rotation} width={112} className="mx-auto bg-white shadow-sm" /> : <span className="block aspect-[3/4] animate-pulse bg-muted" />}
          <span className="mt-1 block">{t.page.replace("{page}", String(index + 1))}</span>
        </button>)}
      </aside>
      <main className="min-w-0 flex-1 overflow-auto p-2 pb-24 md:p-6 md:pb-6">
        <div className="mx-auto w-fit max-w-full">
          <div ref={pageSurface} className="relative overflow-hidden bg-white shadow-lg" style={{ width: canvasWidth, maxWidth: "calc(100vw - 1rem)" }} data-pdf-selected-page={pageIndex + 1}>
            {protectedPdf.document ? <PdfPageCanvas document={protectedPdf.document} sourcePageIndex={page.sourcePageIndex} rotation={page.rotation} width={canvasWidth} className="block max-w-full bg-white" /> : <div className="aspect-[3/4] w-[min(760px,calc(100vw-1rem))] animate-pulse bg-muted" aria-label={protectedPdf.state === "failed" ? t.sourceFailed : t.sourceLoading} />}
            <div className="absolute inset-0" data-pdf-overlay-layer>
              {page.fields.flatMap((field) => field.widgets.filter((widget) => widget.pageId === page.id).map((widget) => <Position key={widget.id} page={page} rect={widget.rect}><FieldControl field={field} disabled={!canEdit || busy} t={t} onChange={(value) => void run(fieldCommand(field, value))} onFocus={() => onSelectTargets([field.id])} /></Position>))}
              {page.overlays.map((overlay) => <Position key={overlay.id} page={page} rect={overlay.rect} className={cn("group border-2 bg-blue-50/50 text-[10px] text-blue-950", selectedOverlayId === overlay.id ? "border-blue-600" : "border-transparent hover:border-blue-400")}>
                <button type="button" className="flex size-full min-h-8 max-sm:min-h-11 cursor-move items-center justify-center overflow-hidden px-1 touch-none" onClick={() => setSelectedOverlayId(overlay.id)} onPointerDown={(event) => beginDrag(event, overlay, "move")} onPointerUp={finishDrag}>{overlayText(overlay)}</button>
                {selectedOverlayId === overlay.id ? <button type="button" aria-label={t.resizeOverlay} className="absolute -bottom-2 -right-2 size-11 rounded-full bg-blue-600 touch-none md:size-4" onPointerDown={(event) => beginDrag(event, overlay, "resize")} onPointerUp={finishDrag} /> : null}
              </Position>)}
              {ghost ? <Position page={page} rect={ghost.rect} className="border-2 border-dashed border-violet-600 bg-violet-200/35"><span className="flex size-full items-center justify-center text-xs font-semibold text-violet-950">{t.signatureGhost}</span></Position> : null}
            </div>
          </div>
          <div className="mt-3 flex flex-wrap justify-center gap-2">
            <button type="button" className={button} disabled={!canEdit || busy} onClick={() => void run({ ...common(snapshot, baseVersion, actorId), kind: "rotatePdfPage", pageId: page.id, rotation: ((page.rotation + 90) % 360) as 0 | 90 | 180 | 270 })}><RotateCw className="size-4" />{t.rotatePage}</button>
            <button type="button" className={button} disabled={!canEdit || busy || pageIndex === 0} onClick={() => void run({ ...common(snapshot, baseVersion, actorId), kind: "reorderPdfPage", pageId: page.id, toIndex: pageIndex - 1 })}><ChevronUp className="size-4" />{t.movePageUp}</button>
            <button type="button" className={button} disabled={!canEdit || busy || pageIndex === snapshot.pages.length - 1} onClick={() => void run({ ...common(snapshot, baseVersion, actorId), kind: "reorderPdfPage", pageId: page.id, toIndex: pageIndex + 1 })}><ChevronDown className="size-4" />{t.movePageDown}</button>
            <button type="button" className={button} disabled={!canEdit || busy || snapshot.pages.length <= 1} onClick={() => void removePage()}><Trash2 className="size-4" />{t.deletePage}</button>
          </div>
          {selectedOverlay ? <OverlayNudges t={t} overlay={selectedOverlay} disabled={!canEdit || busy} onChange={(rect) => changeOverlay(selectedOverlay, rect)} onDelete={() => void run({ ...common(snapshot, baseVersion, actorId), kind: "removePdfOverlay", overlayId: selectedOverlay.id })} /> : null}
        </div>
      </main>
      <aside className="hidden w-56 shrink-0 overflow-y-auto border-l bg-background p-3 xl:block" aria-label={t.fields}>
        <p className="mb-2 text-xs font-semibold">{t.fields}</p>
        {allFields.length ? allFields.map(({ field, page: fieldPage, index }) => <button type="button" key={field.id} className="mb-1 flex min-h-8 max-sm:min-h-11 w-full items-center rounded px-2 text-left text-xs hover:bg-muted" onClick={() => { setPageId(fieldPage.id); onSelectTargets([field.id]); }}>{index + 1}. {field.label}</button>) : <p className="text-xs text-muted-foreground">{t.noFields}</p>}
      </aside>
    </div>
    <div className="fixed inset-x-2 bottom-[calc(.5rem+env(safe-area-inset-bottom))] z-30 grid grid-cols-5 gap-1 rounded-xl border bg-background/95 p-1 shadow-lg backdrop-blur md:hidden" aria-label={t.mobileActions}>
      <button type="button" className={button} onClick={() => setPageId(snapshot.pages[Math.max(0, pageIndex - 1)].id)} disabled={pageIndex === 0}><ChevronLeft className="size-4" /><span className="sr-only">{t.previousPage}</span></button>
      <button type="button" className={button} onClick={() => setPhoneSheet(phoneSheet === "pages" ? null : "pages")}><List className="size-4" />{pageIndex + 1}/{snapshot.pages.length}</button>
      <button type="button" className={button} onClick={() => setPhoneSheet(phoneSheet === "fields" ? null : "fields")}>{t.fields}</button>
      <button type="button" className={button} disabled={!canEdit || busy} onClick={() => addOverlay("text")}><Type className="size-4" /><span className="sr-only">{t.addText}</span></button>
      <button type="button" className={button} onClick={() => setPageId(snapshot.pages[Math.min(snapshot.pages.length - 1, pageIndex + 1)].id)} disabled={pageIndex === snapshot.pages.length - 1}><ChevronRight className="size-4" /><span className="sr-only">{t.nextPage}</span></button>
    </div>
    {phoneSheet ? <div className="fixed inset-x-2 bottom-[calc(4rem+env(safe-area-inset-bottom))] z-20 max-h-[45dvh] overflow-y-auto rounded-xl border bg-background p-3 shadow-lg md:hidden" data-pdf-phone-sheet={phoneSheet}>
      {phoneSheet === "pages" ? snapshot.pages.map((candidate, index) => <button type="button" key={candidate.id} className="flex min-h-8 max-sm:min-h-11 w-full items-center rounded px-3 text-left hover:bg-muted" onClick={() => { setPageId(candidate.id); setPhoneSheet(null); }}>{t.page.replace("{page}", String(index + 1))}</button>) : allFields.length ? allFields.map(({ field, page: fieldPage, index }) => <button type="button" key={field.id} className="flex min-h-8 max-sm:min-h-11 w-full items-center rounded px-3 text-left hover:bg-muted" onClick={() => { setPageId(fieldPage.id); onSelectTargets([field.id]); setPhoneSheet(null); }}>{index + 1}. {field.label}</button>) : <p className="text-sm text-muted-foreground">{t.noFields}</p>}
      <div className="mt-2 grid grid-cols-2 gap-2 border-t pt-2"><button type="button" className={button} disabled={!canEdit || busy} onClick={() => void release(true)}>{t.download}</button><button type="button" className={button} disabled={!canEdit || busy} onClick={() => void release(false)}>{t.saveToFiles}</button></div>
      <div className="mt-2 grid grid-cols-2 gap-2"><button type="button" className={button} disabled={!canEdit || busy} onClick={() => { pendingImageKind.current = "image"; imageInput.current?.click(); }}>{t.addImage}</button><button type="button" className={button} disabled={!canEdit || busy} onClick={() => void addSignature()}>{t.addSignature}</button></div>
    </div> : null}
    <input ref={imageInput} className="hidden" type="file" accept="image/png,image/jpeg" onChange={(event) => { const file = event.target.files?.[0]; if (file) void admitImage(file, pendingImageKind.current); }} />
  </div>;
}

function Position({ page, rect, className, children }: { page: PdfPage; rect: PdfRect; className?: string; children: React.ReactNode }) {
  const css = pdfRectToCss(page, rect);
  return <div className={cn("absolute", className)} style={{ left: `${css.left * 100}%`, top: `${css.top * 100}%`, width: `${css.width * 100}%`, height: `${css.height * 100}%` }}>{children}</div>;
}

function ToolButton({ label, icon, disabled, onClick }: { label: string; icon: React.ReactNode; disabled: boolean; onClick(): void }) {
  return <button type="button" className={button} disabled={disabled} onClick={onClick}>{<span className="[&>svg]:size-4">{icon}</span>}{label}</button>;
}

function FieldControl({ field, disabled, onChange, onFocus, t }: { field: PdfField; disabled: boolean; onChange(value: PdfField["value"]): void; onFocus(): void; t: ReturnType<typeof useT>["office"]["pdf"] }) {
  if (field.kind === "signature") return <button type="button" disabled className="size-full border border-dashed border-violet-500 bg-violet-50/70 px-1 text-[10px] text-violet-950">{field.label}</button>;
  if (field.kind === "checkbox") return <label className="flex size-full min-h-8 max-sm:min-h-11 items-center justify-center gap-1 bg-white/85 text-[10px]"><Checkbox checked={field.value === true} disabled={disabled || field.readOnly} aria-label={field.label} onCheckedChange={(checked) => onChange(checked)} /><span className="sr-only">{field.label}</span></label>;
  if (field.kind === "radio" || field.kind === "dropdown") return <Select value={typeof field.value === "string" ? field.value : ""} onValueChange={(value) => onChange(value)} disabled={disabled || field.readOnly}>
    <SelectTrigger className="h-full max-sm:min-h-11 w-full rounded-none bg-white/90 px-1 text-[16px] md:text-sm" aria-label={field.label} onFocus={onFocus}><SelectValue placeholder={field.label} /></SelectTrigger>
    <SelectContent>{(field.allowedOptions ?? []).map((option) => <SelectItem value={option} key={option}>{option}</SelectItem>)}</SelectContent>
  </Select>;
  if (field.kind === "option-list") return <button type="button" disabled={disabled || field.readOnly} className="size-full min-h-8 max-sm:min-h-11 overflow-hidden border bg-white/90 px-1 text-[10px]" onFocus={onFocus} onClick={() => { const options = field.allowedOptions ?? []; const current = Array.isArray(field.value) ? field.value : []; const next = options.find((option) => !current.includes(option)); onChange(next ? [...current, next] : []); }}>{Array.isArray(field.value) && field.value.length ? field.value.join(", ") : field.label}</button>;
  return <input aria-label={field.label} title={field.label} disabled={disabled || field.readOnly} required={field.required} className="size-full min-h-11 border bg-white/90 px-1 text-base md:min-h-0 md:text-xs" defaultValue={typeof field.value === "string" ? field.value : ""} onFocus={onFocus} onBlur={(event) => { if (event.target.value !== (field.value ?? "")) onChange(event.target.value || null); }} />;
}

function OverlayNudges({ t, overlay, disabled, onChange, onDelete }: { t: ReturnType<typeof useT>["office"]["pdf"]; overlay: PdfOverlay; disabled: boolean; onChange(rect: PdfRect): void; onDelete(): void }) {
  const move = (x: number, y: number) => onChange({ ...overlay.rect, x: overlay.rect.x + x, y: overlay.rect.y + y });
  const resize = (delta: number) => onChange({ ...overlay.rect, width: Math.max(8, overlay.rect.width + delta), height: Math.max(8, overlay.rect.height + delta) });
  return <div className="mt-3 flex flex-wrap justify-center gap-2" aria-label={t.overlayActions}>
    <button type="button" className={button} disabled={disabled} onClick={() => move(-4, 0)}>{t.moveLeft}</button><button type="button" className={button} disabled={disabled} onClick={() => move(4, 0)}>{t.moveRight}</button><button type="button" className={button} disabled={disabled} onClick={() => move(0, 4)}>{t.moveUp}</button><button type="button" className={button} disabled={disabled} onClick={() => move(0, -4)}>{t.moveDown}</button><button type="button" className={button} disabled={disabled} onClick={() => resize(4)}>{t.grow}</button><button type="button" className={button} disabled={disabled} onClick={() => resize(-4)}>{t.shrink}</button><button type="button" className={button} disabled={disabled} onClick={onDelete}><Trash2 className="size-4" />{t.deleteOverlay}</button>
  </div>;
}
