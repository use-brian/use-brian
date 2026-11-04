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
  it("isolates recorder saves from the attachment uploader that gates chat", () => {
    expect(source).toContain("const captureUpload = useRecordingUpload(workspaceId, activeAssistantId)");
    const handOff = source.slice(source.indexOf("onMeetingCapture: async"), source.indexOf("// Feed replaces this dock"));
    expect(handOff).toContain("await captureUpload.run(file,");
    expect(handOff).toContain("captureUpload.dismiss()");
    expect(source).toContain("status: captureUpload.status");
    expect(source).toContain("uploadProgress: captureUpload.uploadProgress");
    expect(handOff).toContain("recordingId: outcome.recording.recordingId");
    expect(handOff).not.toContain("await rec.run(");
    expect(source).not.toContain("captureUpload.busy");
  });

  it("renders determinate progress around only the collapsed text launcher", () => {
    expect(source).not.toContain("ring-2 ring-primary/35");
    expect(source).toContain("data-upload-progress-ring");
    expect(source).toContain("conic-gradient(from -90deg");
    expect(source).toContain("uploadProgressPercent");
    expect(source).toContain('aria-busy={rec.status === "uploading"}');
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
