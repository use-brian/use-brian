import { describe, it, expect } from "vitest";
import {
  mediaKindForMime,
  buildMediaEmbedContent,
  buildEmptyMediaEmbedContent,
} from "../doc-media-paste";
import {
  queueMediaUpload,
  hasPendingMediaUpload,
  takeMediaUpload,
} from "../doc-media-uploads";

/**
 * Pure encoding helpers for the paste/drag-drop media extension. The embed
 * insertion JSON must match what `slash-execute.ts` mints and what
 * `EmbedView` parses, so it round-trips through Yjs and renders.
 *
 * [COMP:app-web/media-paste]
 */
describe("[COMP:app-web/media-paste] media paste encoding", () => {
  it("maps image MIME to the image kind, everything else to file", () => {
    expect(mediaKindForMime("image/png")).toBe("image");
    expect(mediaKindForMime("image/jpeg")).toBe("image");
    expect(mediaKindForMime("application/pdf")).toBe("file");
    expect(mediaKindForMime("text/plain")).toBe("file");
  });

  it("builds an embed node carrying the durable workspace_files ref", () => {
    const ref = {
      bucket: "workspace_files",
      path: "wf_1",
      mimeType: "image/png",
      sizeBytes: 4,
      name: "shot.png",
    };
    const content = buildMediaEmbedContent(ref, "blk_1");

    expect(content.type).toBe("embed");
    expect(content.attrs.blockId).toBe("blk_1");
    expect(JSON.parse(content.attrs.block)).toEqual({
      kind: "image",
      id: "blk_1",
      ref,
    });
  });

  it("encodes a non-image upload as a file block", () => {
    const ref = {
      bucket: "workspace_files",
      path: "wf_2",
      mimeType: "application/pdf",
      sizeBytes: 100,
      name: "spec.pdf",
    };
    const parsed = JSON.parse(buildMediaEmbedContent(ref, "blk_2").attrs.block);
    expect(parsed.kind).toBe("file");
  });

  it("builds an EMPTY placeholder embed (ref: null) for the drop path", () => {
    const content = buildEmptyMediaEmbedContent("file", "blk_3");
    expect(content.type).toBe("embed");
    expect(content.attrs.blockId).toBe("blk_3");
    expect(JSON.parse(content.attrs.block)).toEqual({
      kind: "file",
      id: "blk_3",
      ref: null,
    });
  });

  it("carries the kind through to the empty placeholder (image vs file)", () => {
    expect(JSON.parse(buildEmptyMediaEmbedContent("image", "blk_4").attrs.block).kind).toBe(
      "image",
    );
  });
});

/**
 * In-memory drop → block hand-off. A dropped file is stashed under the new
 * block's id; the block claims it once on mount. `has` lets it paint
 * "Uploading…" on first render; `take` is idempotent (a second claim — e.g. a
 * dev strict-mode remount — gets nothing).
 *
 * [COMP:app-web/media-uploads]
 */
describe("[COMP:app-web/media-uploads] media upload hand-off", () => {
  const fakeFile = (name: string): File =>
    ({ name, type: "text/plain", size: 3 }) as unknown as File;

  it("queues a file the matching block can claim by id", () => {
    const file = fakeFile("a.txt");
    queueMediaUpload("blk_q1", file);
    expect(hasPendingMediaUpload("blk_q1")).toBe(true);
    expect(takeMediaUpload("blk_q1")).toBe(file);
  });

  it("claims exactly once — a second take returns undefined", () => {
    queueMediaUpload("blk_q2", fakeFile("b.txt"));
    expect(takeMediaUpload("blk_q2")).toBeDefined();
    expect(takeMediaUpload("blk_q2")).toBeUndefined();
    expect(hasPendingMediaUpload("blk_q2")).toBe(false);
  });

  it("reports no pending upload for an unknown block id", () => {
    expect(hasPendingMediaUpload("never-queued")).toBe(false);
    expect(takeMediaUpload("never-queued")).toBeUndefined();
  });
});
