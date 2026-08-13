/** Same-artifact Presentation clipboard with a typed MIME envelope. [COMP:app-web/office-presentation-editor] */
import type { PresentationObject, PresentationSnapshot } from "@use-brian/office-model";

type PresentationSlide = PresentationSnapshot["slides"][number];

export const PRESENTATION_CLIPBOARD_MIME = "application/x-use-brian-presentation+json";

export type PresentationClipboardEnvelope = {
  version: 1;
  artifactId: string;
  scope: "objects";
  sourceSlideId: string;
  objects: PresentationObject[];
} | {
  version: 1;
  artifactId: string;
  scope: "slides";
  slides: PresentationSlide[];
};

let fallbackEnvelope: PresentationClipboardEnvelope | null = null;

export function parsePresentationClipboard(value: string, artifactId: string): PresentationClipboardEnvelope | null {
  try {
    const parsed = JSON.parse(value) as Partial<PresentationClipboardEnvelope>;
    if (parsed.version !== 1 || parsed.artifactId !== artifactId) return null;
    if (parsed.scope === "objects" && typeof parsed.sourceSlideId === "string" && Array.isArray(parsed.objects)) return parsed as PresentationClipboardEnvelope;
    if (parsed.scope === "slides" && Array.isArray(parsed.slides)) return parsed as PresentationClipboardEnvelope;
  } catch {
    // Non-Brian clipboard content is ignored.
  }
  return null;
}

export async function writePresentationClipboard(envelope: PresentationClipboardEnvelope): Promise<void> {
  fallbackEnvelope = structuredClone(envelope);
  const value = JSON.stringify(envelope);
  try {
    if (typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
      await navigator.clipboard.write([new ClipboardItem({ [PRESENTATION_CLIPBOARD_MIME]: new Blob([value], { type: PRESENTATION_CLIPBOARD_MIME }) })]);
      return;
    }
    await navigator.clipboard?.writeText?.(value);
  } catch {
    // Permission denial keeps the in-memory copy available for this editor.
  }
}

export async function readPresentationClipboard(artifactId: string): Promise<PresentationClipboardEnvelope | null> {
  try {
    if (navigator.clipboard?.read) {
      const items = await navigator.clipboard.read();
      const item = items.find((candidate) => candidate.types.includes(PRESENTATION_CLIPBOARD_MIME));
      if (item) {
        const parsed = parsePresentationClipboard(await (await item.getType(PRESENTATION_CLIPBOARD_MIME)).text(), artifactId);
        if (parsed) return parsed;
      }
    } else if (navigator.clipboard?.readText) {
      const parsed = parsePresentationClipboard(await navigator.clipboard.readText(), artifactId);
      if (parsed) return parsed;
    }
  } catch {
    // Permission denial falls back to this tab's last Presentation copy.
  }
  return fallbackEnvelope?.artifactId === artifactId ? structuredClone(fallbackEnvelope) : null;
}

export function clearPresentationClipboardForTest(): void {
  fallbackEnvelope = null;
}
