import { beforeEach, describe, expect, it } from "vitest";
import { presentationFixture } from "@/components/office/__tests__/editor-fixtures";
import { clearPresentationClipboardForTest, parsePresentationClipboard, readPresentationClipboard, writePresentationClipboard } from "../presentation-clipboard";

describe("[COMP:app-web/office-presentation-editor] Presentation clipboard envelope", () => {
  beforeEach(clearPresentationClipboardForTest);

  it("parses only typed same-artifact slide envelopes", () => {
    const snapshot = presentationFixture();
    const envelope = { version: 1 as const, artifactId: snapshot.artifactId, scope: "slides" as const, slides: [snapshot.slides[0]] };
    expect(parsePresentationClipboard(JSON.stringify(envelope), snapshot.artifactId)).toEqual(envelope);
    expect(parsePresentationClipboard(JSON.stringify(envelope), crypto.randomUUID())).toBeNull();
    expect(parsePresentationClipboard("foreign text", snapshot.artifactId)).toBeNull();
  });

  it("keeps a validated in-tab object fallback when system clipboard is unavailable", async () => {
    const snapshot = presentationFixture();
    const envelope = { version: 1 as const, artifactId: snapshot.artifactId, scope: "objects" as const, sourceSlideId: snapshot.slides[0].id, objects: snapshot.slides[0].objects };
    await writePresentationClipboard(envelope);
    await expect(readPresentationClipboard(snapshot.artifactId)).resolves.toEqual(envelope);
    await expect(readPresentationClipboard(crypto.randomUUID())).resolves.toBeNull();
  });
});
