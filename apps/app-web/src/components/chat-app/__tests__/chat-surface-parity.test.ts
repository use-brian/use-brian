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
const workspaceChromeSource = readFileSync(
  fileURLToPath(new URL("../../doc/workspace-chrome.tsx", import.meta.url)),
  "utf8",
);
const dockSuppressionSource = readFileSync(
  fileURLToPath(new URL("../../../lib/chat-dock-suppress.ts", import.meta.url)),
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
    expect(source).toContain("allowEmptySend={att.hasReady || pendingRecordings.length > 0}");
    expect(source).toContain("att.uploading");
    expect(source).toContain("recordingUpload.stage(file)");
    expect(source).toContain("attachedRecordingIds: turnRecordingIds");
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

  it("addresses slash-shaped room messages through the chat turn route", () => {
    expect(source).toMatch(
      /const addressed =[\s\S]*isSlashCommandShaped\(trimmed\)[\s\S]*mentioned\.length > 0/,
    );
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

  it("restores current-turn tool confirmations and resolves them durably", () => {
    expect(source).toContain("fetchPendingSessionInput(sessionId)");
    expect(source).toContain("toRestoredConfirmation(toolConfirmation, sessionId)");
    expect(source).toContain('{ id: confirmation.approvalId, kind: "tool_invocation" }');
    expect(source).toContain("respondByKind(");
  });

  it("renders followed room research with the sender's activity chrome", () => {
    expect(source).toContain('kind === "worker_start"');
    expect(source).toContain('phase === "research_starting"');
    expect(source).toContain("researchPhase={remoteResearchPhase}");
    expect(source).toContain("startedAt={remoteStartedAt}");
    expect(source).not.toContain("researchPhase={null}");
  });

  it("keeps the composer footer on one stable row without a dock overlay", () => {
    expect(source).toContain("grid-cols-[minmax(0,1fr)_auto]");
    // The textarea's grid placement moved to the wrapper that carries the
    // mention-chip mirror; the cell it occupies is unchanged.
    expect(source).toContain('inputWrapClassName="order-1 col-span-2 min-w-0"');
    expect(source).toContain("w-full max-h-[240px] min-w-0 resize-none");
    expect(source).not.toContain('rowClassName="flex flex-wrap');
    expect(workspaceChromeSource).toContain("workspaceChatDockSuppressed(");
    expect(dockSuppressionSource).toContain(
      'embeddedChatSuppressed || activeSurface === "chat"',
    );
  });

  it("rehosts the global dock recorder while the dock is hidden", () => {
    // The route hides the ambient dock, so the recorder must ride this
    // composer instead: button beside the paperclip, strip/notice/recovery
    // above the box, and short-capture delivery into THIS visible thread.
    expect(source).toContain("useGlobalDockRecorder()");
    expect(source).toContain("<DockRecorderButton");
    expect(source).toContain("<DockRecorderStrip");
    expect(source).toContain("<DockRecorderNotice");
    expect(source).toContain("<DockRecorderRecovery");
    expect(source).toContain(
      'sendVoiceClip: (fileId) => send({ text: "", fileIds: [fileId] })',
    );
    // The hand-off relies on send's dispatched/dropped verdict: a dropped
    // clip must report false so the recorder keeps the audio.
    expect(source).toMatch(/pendingQuestion\s*\)\s*\{\s*return false;/);
    // A files-only voice send paints the voice-note marker, never a blank
    // bubble.
    expect(source).toContain(
      "(!usesComposerTray && turnFileIds.length > 0 ? t.voiceNote : \"\")",
    );
  });

  it("consumes the Home handoff only after Personal-chat roster validation", () => {
    expect(source).toContain("takeChatHandoff(workspaceId, Date.now())");
    expect(source).toContain("resolveChatHandoffAction({");
    expect(source).toContain("assistantIds: assistants.map((row) => row.id)");
    expect(source).toContain('if (action === "prefill")');
    expect(source).toContain("void send({ text })");
    expect(source).not.toContain('searchParams?.get("prompt")');
  });
});
