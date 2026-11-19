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
const floatingChatSource = readFileSync(
  fileURLToPath(new URL("../../chrome/floating-chat.tsx", import.meta.url)),
  "utf8",
);
const feedTuningChatSource = readFileSync(
  fileURLToPath(new URL("../../feed/tuning-chat-panel.tsx", import.meta.url)),
  "utf8",
);
const workspaceChromeSource = readFileSync(
  fileURLToPath(new URL("../../doc/workspace-chrome.tsx", import.meta.url)),
  "utf8",
);
const controllerSource = readFileSync(
  fileURLToPath(new URL("../../../lib/chat/conversation-controller.ts", import.meta.url)),
  "utf8",
);
const registrySource = readFileSync(
  fileURLToPath(new URL("../../../lib/chat/conversation-registry.ts", import.meta.url)),
  "utf8",
);
const transcriptSource = readFileSync(
  fileURLToPath(new URL("../../../../../../packages/chat-ui/src/turn-transcript.ts", import.meta.url)),
  "utf8",
);
const dockSuppressionSource = readFileSync(
  fileURLToPath(new URL("../../../lib/chat-dock-suppress.ts", import.meta.url)),
  "utf8",
);

describe("[COMP:app-web/chat-parity] Chat surface parity", () => {
  it("keeps drafting available while first-send context admission is pending", () => {
    expect(source).toContain("disabled={!!pendingQuestion}");
    expect(source).toMatch(/sendDisabled=\{\s*\(!activeSessionId && !creationContext\.ready\) \|\|/);
    // The dispatch boundary still checks a live authority snapshot, including
    // keyboard and programmatic sends that do not pass through the button.
    expect(source).toContain("if(!sessionIdRef.current&&!creationContext.snapshot())");
  });
  it("composes the shared pick, drop, paste, and upload-chip affordances", () => {
    expect(source).toContain("useFileAttachments(");
    expect(source).toContain("useFileDrop(");
    expect(source).toContain("<FileDropOverlay active={drop.isDragging}");
    expect(source).toContain("<AttachmentChips");
    expect(source).toContain("aria-label={tAttach.attach}");
    expect(source).toContain("imageFilesFromClipboard(event.clipboardData)");
    expect(source).toContain("allowEmptySend={att.hasReady || pendingRecordings.length > 0}");
    expect(source).toContain("att.uploading");
    expect(source).toContain("recordingUpload.stage(file)");
    // The conversation sends them as `attachedRecordingIds` on the first
    // member of the turn (controller boundary test in chat-surface-ownership).
    expect(source).toContain("recordingIds: turnRecordingIds");
    expect(controllerSource).toContain("attachedRecordingIds: recordingIds");
  });

  it("routes fresh uploads with the same stable identity as the first send", () => {
    const upload = source.slice(source.indexOf("getUploadContext: () =>"), source.indexOf("onRouteMedia: activeAssistant"));
    expect(upload).toContain('if (sessionIdRef.current || view !== "personal") return undefined');
    expect(upload).toContain("if (!activeAssistant) throw new Error(t.errorGeneric)");
    expect(upload).toContain("const channelId = freshChannelIdRef.current ??= crypto.randomUUID()");
    for (const field of ["workspaceId,", "assistantId,", "channelId,", "appOrigin: APP_ORIGIN", "contextGroupId: pickedContextGroupId", "contextProjectId: pickedContextProjectId"]) {
      expect(upload).toContain(field);
    }
    expect(source).toMatch(/const channelId = sessionIdRef\.current\s*\? undefined\s*:\s*\(freshChannelIdRef\.current \?\?= crypto\.randomUUID\(\)\)/);
  });

  it("adopts upload sessions before navigation without rehydrating away the draft", () => {
    const adoption = source.slice(source.indexOf("onSessionReady: (id: string) =>"), source.indexOf("onRouteMedia: activeAssistant"));
    expect(adoption).toMatch(/if \(freshChannelIdRef\.current !== channelId\) return;[\s\S]*sessionIdRef\.current = id;[\s\S]*hydratedRef\.current = id;[\s\S]*sessionAssistantRef\.current\.set\(id, assistantId\);[\s\S]*selectSession\(id, "personal", true\);[\s\S]*dispatchChatSessionsRefresh\(workspaceId\)/);
    expect(source).toMatch(/if \(activeSessionId === hydratedRef\.current\) return;[\s\S]*att\.clear\(\)/);
  });

  it("invalidates the upload channel synchronously on user navigation unless preservation is explicit", () => {
    const navigation = source.slice(source.indexOf("const selectSession = useCallback("), source.indexOf("const restoreAttemptedRef"));
    expect(navigation).toContain("(id: string | null, nextView: ChatView = view, preserveUpload = false)");
    expect(navigation).toMatch(/if \(!preserveUpload\) freshChannelIdRef\.current = null;[\s\S]*const href = buildHref\(id, nextView\);[\s\S]*if \(!navigateChatLocation\(href, true\)\) router\.replace\(href/);
  });

  it("invalidates pending uploads on pane changes and freezes routing picks while uploading", () => {
    // Pending fresh-pane adoption is invalidated on every pane change; the
    // chips themselves live in each conversation's own tray (M5 WP-F,
    // chat-app.md -> "Conversation attachment trays"), so a switch shows the
    // destination's tray instead of clearing the one being left.
    expect(source).toMatch(/useEffect\(\(\) => \{\s*freshChannelIdRef\.current = null;\s*\}, \[workspaceId, view\]\)/);
    expect(source).toContain("conversationAttachmentTray(workspaceId, trayPartFor(activeSessionId ?? sessionIdRef.current, view))");
    expect(source).toContain('provisionalConversationKey("page", `fresh:${forView}`)');
    expect(source).toContain('moveConversationAttachments(workspaceId, trayPartFor(null, "personal"), { sessionId: id })');
    const navigation = source.slice(source.indexOf("if (activeSessionId === hydratedRef.current) return;"), source.indexOf("const cached = readCachedTranscript<SurfaceMessage>"));
    expect(navigation).toContain("Each chat keeps its own attachment tray; the one being left stays there.");
    expect(navigation).toContain("freshChannelIdRef.current = null");
    const reset = source.slice(source.indexOf("const resetPane = useCallback("), source.indexOf("const startNewChat = useCallback("));
    expect(reset).toContain("freshChannelIdRef.current = null");
    expect(reset).toContain("att.clear()");
    expect(source).toContain("!att.uploading && isAssistantPickerLive({");
    // One hero picker for both views (chat-parity T5), frozen mid-upload: an
    // upload on a fresh pane mints the conversation with these picks.
    expect(source).toMatch(/<ChatContextBar context=\{creationContext\} disabled=\{att\.uploading\} \/>/);
  });

  it("carries ready files and previews through a turn and restored history", () => {
    expect(source).toContain("const turnFileIds = override?.fileIds ?? att.fileIds()");
    expect(source).toContain("fileIds: turnFileIds,");
    expect(source).toContain("readyAttachments(att.attachments)");
    // The previews ride the optimistic bubble and survive the server re-key.
    expect(source).toContain("...(userAttachments.length > 0 ? { userAttachments } : {})");
    expect(controllerSource).toContain('dispatch({ type: "message/rekey", messageId: run.localUserId, id })');
    expect(source).toContain("parseMessageAttachments(r.content)");
    expect(source).toContain("<MessageAttachments attachments={m.userAttachments}");
    expect(source).toContain("<ChatFileAttachments attachments={m.fileAttachments}");
  });

  it("never degrades a file-bearing room send into a text-only post", () => {
    expect(source).toMatch(
      /const explicitAddress =[\s\S]*turnFileIds\.length > 0[\s\S]*override\?\.forceAddress === true/,
    );
    // The address decision reads the pane's policy and live human count
    // (chat-parity D2), and only an explicit address asks the server.
    expect(source).toContain("const addressed = isAddressedSend({");
    expect(source).toContain("...(panePolicy.post && explicitAddress ? { ask: true } : {})");
  });

  it("addresses slash-shaped room messages through the chat turn route", () => {
    expect(source).toMatch(
      /const explicitAddress =[\s\S]*isSlashCommandShaped\(trimmed\)[\s\S]*mentioned\.length > 0/,
    );
  });

  it("shares the dock's research and response affordances", () => {
    expect(source).not.toContain("showResearch");
    expect(source).toContain('{ mode: "research" as const }');
    // Citations accumulate in the page preset of the turn transcript.
    expect(source).toContain("const citations = activity.citations;");
    expect(transcriptSource).toContain("case 'citation':");
    expect(source).toContain("<ChatCitationList");
    expect(source).toContain("components={CHAT_MARKDOWN_COMPONENTS}");
    expect(source).toContain("retryAssistantMessage");
    expect(source).toContain("retryUserMessage");
  });

  it("surfaces server SSE error messages in full-page Chat", () => {
    // The conversation keeps the server's text next to the code, and the page
    // shows it for codes this build does not translate (pageNoticeCopy, with
    // behavior tests in chat-surface-notices).
    expect(controllerSource).toContain("const message = str(payload.message) ?? str(payload.error);");
    expect(source).toContain('"message" in notice && typeof notice.message === "string"');
    expect(source).toContain("return { slot: \"error\", text: serverText ?? copy.chatApp.errorGeneric };");
  });

  it("surfaces server SSE error messages in universal workspace dock", () => {
    // The dock is a conversation presentation too (WP-C): the server text is
    // read at the controller boundary and the dock shows the notice's text.
    expect(controllerSource).toContain("const message = str(payload.message) ?? str(payload.error);");
    expect(floatingChatSource).toContain("useConversation(");
    expect(floatingChatSource).toMatch(/notice\.message \?\?/);
  });

  it("surfaces server SSE error messages in Feed assistant dock", () => {
    // Feed is a conversation presentation too (M5 WP-E): the server text is
    // read at the controller boundary and the rail shows the notice's text.
    expect(controllerSource).toContain("const message = str(payload.message) ?? str(payload.error);");
    expect(feedTuningChatSource).toContain("useConversation(");
    expect(feedTuningChatSource).toMatch(/errorNotice\.message \?\?/);
  });

  it("restores current-turn tool confirmations and resolves them durably", () => {
    // The conversation runs the one `GET /pending` read (hydrate attach and
    // every re-probe) and restores the current turn's confirmation from it.
    expect(source).toContain("void owner.refreshPendingInput();");
    expect(source).not.toContain("fetchPendingSessionInput(");
    expect(registrySource).toContain("await fetchPendingSessionInput(sessionId)");
    expect(registrySource).toContain("toRestoredConfirmation(toolConfirmation, sessionId)");
    // A restored card resolves through the canonical approval route.
    expect(registrySource).toContain('respondByKind({ id: approvalId, kind: "tool_invocation" }');
    expect(controllerSource).toContain("if (confirmation?.restored && confirmation.approvalId)");
    expect(source).toContain("controllerRef.current?.respondConfirmation(toolCallId, action, comment)");
  });

  it("renders followed room research with the sender's activity chrome", () => {
    // The mirror keeps worker labels and research phases (controller), and
    // the page renders them through the same feed as the sender.
    expect(transcriptSource).toContain("case 'worker_start':");
    expect(controllerSource).toContain('payload.phase === "research_starting" ? "starting"');
    expect(source).toContain("const remoteResearchPhase = mirror?.researchPhase ?? null;");
    expect(source).toContain("researchPhase={remoteResearchPhase}");
    expect(source).toContain("startedAt={remoteStartedAt}");
    expect(source).not.toContain("researchPhase={null}");
  });

  it("keeps the composer footer on one stable row without a dock overlay", () => {
    expect(source).toContain("grid-cols-[minmax(0,1fr)_auto]");
    // The textarea's grid placement moved to the wrapper that carries the
    // mention-chip mirror; the cell it occupies is unchanged.
    expect(source).toContain('inputWrapClassName="order-1 col-span-2 min-w-0"');
    expect(source).toContain("w-full max-h-[min(240px,30dvh,var(--chat-input-max-height,240px))] min-w-0 resize-none");
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
      "...(!trimmed && !usesComposerTray && turnFileIds.length > 0 ? { voiceNote: true } : {})",
    );
    expect(source).toContain("{m.text || t.voiceNote}");
  });

  it("consumes the Home handoff only after Personal-chat roster validation", () => {
    expect(source).toContain("useChatHandoff({");
    expect(source).toContain("async validateAssistant(id)");
    expect(source).toContain("await listWorkspaceAssistants(workspaceId)");
    expect(source).toContain("router.replace(personalChatHandoffPath(");
    expect(source).toContain("return send({text:handoff.text");
    expect(source).toContain("prefill(handoff)");
    expect(source).not.toContain('searchParams?.get("prompt")');
  });
});
