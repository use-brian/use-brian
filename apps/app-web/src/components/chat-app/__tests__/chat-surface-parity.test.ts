/**
 * [COMP:app-web/chat-parity] Full-page Chat ordinary-UX parity.
 *
 * The individual upload/drop/paste primitives have behavioral unit tests in
 * their own components. This source contract guards the integration seam that
 * previously regressed: ChatSurface must actually compose those shared
 * primitives and carry their ids/previews through send + restore.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  fileURLToPath(new URL("../chat-surface.tsx", import.meta.url)),
  "utf8",
);

describe("[COMP:app-web/chat-parity] Chat surface parity", () => {
  it("composes the shared pick, drop, paste, and upload-chip affordances", () => {
    expect(source).toContain("useFileAttachments(");
    expect(source).toContain("useFileDrop(");
    expect(source).toContain("<FileDropOverlay active={drop.isDragging}");
    expect(source).toContain("<AttachmentChips");
    expect(source).toContain("<Paperclip");
    expect(source).toContain("imageFilesFromClipboard(event.clipboardData)");
    expect(source).toContain("allowEmptySend={att.hasReady}");
    expect(source).toContain("att.uploading");
  });

  it("carries ready files and previews through a turn and restored history", () => {
    expect(source).toContain("const turnFileIds = override?.fileIds ?? att.fileIds()");
    expect(source).toContain("{ fileIds: turnFileIds }");
    expect(source).toContain("readyAttachments(att.attachments)");
    expect(source).toContain("type: \"message/rekey\"");
    expect(source).toContain("parseMessageAttachments(r.content)");
    expect(source).toContain("<MessageAttachments attachments={m.userAttachments}");
    expect(source).toContain("<ChatFileAttachments attachments={m.fileAttachments}");
  });

  it("never degrades a file-bearing room send into a text-only post", () => {
    expect(source).toMatch(
      /const addressed =[\s\S]*turnFileIds\.length > 0[\s\S]*override\?\.forceAddress === true/,
    );
    expect(source).toContain("...(isRoom && addressed ? { ask: true } : {})");
  });

  it("shares the dock's research and response affordances", () => {
    expect(source).toContain("showResearch");
    expect(source).toContain('{ mode: "research" as const }');
    expect(source).toContain('case "citation"');
    expect(source).toContain("<ChatCitationList");
    expect(source).toContain("components={CHAT_MARKDOWN_COMPONENTS}");
    expect(source).toContain("retryAssistantMessage");
    expect(source).toContain("retryUserMessage");
  });
});
