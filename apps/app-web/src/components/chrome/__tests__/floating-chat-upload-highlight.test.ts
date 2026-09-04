/** [COMP:web/recording-upload] Floating composer pending-upload treatment. */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = readFileSync(
  fileURLToPath(new URL("../floating-chat.tsx", import.meta.url)),
  "utf8",
);
const composerSources = [
  "../../chat-app/chat-surface.tsx",
  "../floating-chat.tsx",
  "../../doc/comment-thread-body.tsx",
  "../../doc/empty-page-landing.tsx",
  "../../doc/new-comment-popover.tsx",
  "../../doc/page-comments.tsx",
].map((relative) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8"));

describe("[COMP:web/recording-upload] floating composer upload progress", () => {
  it("keeps the expanded frame neutral and gives the status row breathing room", () => {
    expect(source).not.toContain("border-primary/60 ring-2 ring-primary/25");
    expect(source).toContain('className="space-y-2 px-1 py-2"');
  });

  it("renders determinate progress around only the collapsed text launcher", () => {
    expect(source).not.toContain("ring-2 ring-primary/35");
    expect(source).toContain("data-upload-progress-ring");
    expect(source).toContain("conic-gradient(from -90deg");
    expect(source).toContain("uploadProgressPercent");
    expect(source).toContain('aria-busy={rec.status === "uploading"}');
    expect(source).toContain('<div className="flex items-center gap-2">');
  });

  it("renders shared byte progress in every recording-capable composer", () => {
    for (const composerSource of composerSources) {
      expect(composerSource).toContain("<RecordingUploadStatus");
    }
  });

  it("locks every recording-capable composer's file input while its operation is busy", () => {
    expect(composerSources[0]).toContain("disabled={recordingUpload.busy}");
    for (const composerSource of composerSources.slice(1)) {
      expect(composerSource).toContain("disabled={rec.busy}");
    }
  });
});
