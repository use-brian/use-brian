/**
 * [COMP:app-web/file-attachments] Chat-attachment upload state.
 *
 * app-web vitest has no jsdom, so we test the hook's pure reconciliation
 * helpers directly (the same no-DOM stance breadcrumb/floating-toolbar tests
 * use). These functions hold the only non-trivial logic: matching an upload
 * response back to the staged chips by order, flagging whole-request failures,
 * and projecting the ready file ids that ride the /api/chat turn.
 */

import { describe, expect, it } from "vitest";
import {
  applyUploadResult,
  markStagedError,
  readyFileIds,
  type Attachment,
} from "../use-file-attachments";

function staged(localId: string, fileName = `${localId}.txt`): Attachment {
  return {
    localId,
    fileName,
    mimeType: "text/plain",
    sizeBytes: 10,
    status: "uploading",
  };
}

describe("[COMP:app-web/file-attachments] upload reconciliation", () => {
  it("flips staged chips to done with their server fileId, in order", () => {
    const prev = [staged("a"), staged("b")];
    const next = applyUploadResult(prev, new Set(["a", "b"]), [
      { id: "file_a" },
      { id: "file_b" },
    ]);
    expect(next.map((a) => [a.localId, a.status, a.fileId])).toEqual([
      ["a", "done", "file_a"],
      ["b", "done", "file_b"],
    ]);
  });

  it("marks a per-file error result without a fileId", () => {
    const next = applyUploadResult([staged("a")], new Set(["a"]), [
      { error: "too big" },
    ]);
    expect(next[0].status).toBe("error");
    expect(next[0].error).toBe("too big");
    expect(next[0].fileId).toBeUndefined();
  });

  it("only touches chips from its own staged batch", () => {
    // A concurrent upload left "old" still uploading; this batch is just "b".
    const prev = [staged("old"), staged("b")];
    const next = applyUploadResult(prev, new Set(["b"]), [{ id: "file_b" }]);
    expect(next[0]).toEqual(prev[0]); // untouched
    expect(next[1].status).toBe("done");
    expect(next[1].fileId).toBe("file_b");
  });

  it("leaves a chip untouched when the response is short a row", () => {
    const next = applyUploadResult([staged("a"), staged("b")], new Set(["a", "b"]), [
      { id: "file_a" },
    ]);
    expect(next[0].status).toBe("done");
    expect(next[1].status).toBe("uploading"); // no matching response row
  });

  it("markStagedError fails the whole batch, sparing other chips", () => {
    const prev = [staged("a"), staged("b")];
    const next = markStagedError(prev, new Set(["a"]), "network down");
    expect(next[0]).toMatchObject({ status: "error", error: "network down" });
    expect(next[1].status).toBe("uploading");
  });

  it("readyFileIds returns only done ids, in chip order", () => {
    const list: Attachment[] = [
      { ...staged("a"), status: "done", fileId: "file_a" },
      { ...staged("b"), status: "uploading" },
      { ...staged("c"), status: "error", error: "x" },
      { ...staged("d"), status: "done", fileId: "file_d" },
    ];
    expect(readyFileIds(list)).toEqual(["file_a", "file_d"]);
  });
});
