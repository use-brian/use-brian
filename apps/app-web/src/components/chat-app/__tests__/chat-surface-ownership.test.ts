import { readFileSync } from "node:fs";
import ts from "typescript";
import React from "react";
import { renderToString } from "react-dom/server";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import { ja } from "@/lib/i18n/dictionaries/ja";
import { zh } from "@/lib/i18n/dictionaries/zh";
import { zhCN } from "@/lib/i18n/dictionaries/zh-cn";
import { ChatActivityFeed } from "@/components/chrome/chat-activity";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isAuthoritativeRosterDenial } from "@/lib/chat-surface-data";
import { appendReasoning, appendStep, EMPTY_LOG, removeToolSteps, updateStepText, type EventLog } from "@/lib/build-events";
import { describeToolFromInput } from "@/lib/tool-narration";
import {
  createConversationController,
  type ConversationNotice,
  type PresentationCapabilities,
} from "@/lib/chat/conversation-controller";
import type { ClassifiedTurnFrame } from "@/lib/chat/turn-frames";
import {
  SCOPE, TURN_A, TURN_B, deferred as fakeDeferred, fakeScheduler, fakeTransport, settle,
} from "@/lib/chat/__tests__/conversation-fakes";

/**
 * [COMP:app-web/chat-sessions-cache] The full page is a presentation of the
 * conversation controller (M5 WP-B). Two kinds of test live here:
 *
 * - The page's own callbacks (history reads, pending input, the frame
 *   observer, selection before paint, composer props), executed from
 *   production source by AST extraction with controlled refs, without
 *   mounting the 4,000-line surface and its providers.
 * - The turn behaviors the page used to implement itself (send, follow,
 *   reconnect, Stop, queue), now exercised at the controller boundary with
 *   the page profile and fake transports.
 */
const source = readFileSync(new URL("../chat-surface.tsx", import.meta.url), "utf8");
const tree = ts.createSourceFile("chat-surface.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function find(predicate: (node: ts.Node) => boolean): ts.Node {
  let result: ts.Node | undefined;
  function visit(node: ts.Node) {
    if (!result && predicate(node)) result = node;
    if (!result) ts.forEachChild(node, visit);
  }
  visit(tree);
  if (!result) throw new Error("Surface callback not found");
  return result;
}
function declaration(name: string) {
  return find((node) => ts.isVariableDeclaration(node) && node.name.getText(tree) === name) as ts.VariableDeclaration;
}
function callback(name: string) {
  const call = declaration(name).initializer as ts.CallExpression;
  return call.arguments[0].getText(tree);
}
function evaluate<T = (...args: any[]) => any>(expression: string, scope: Record<string, unknown>): T {
  const code = ts.transpileModule(`return (${expression});`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None, jsx: ts.JsxEmit.React },
  }).outputText;
  return new Function(...Object.keys(scope), code)(...Object.values(scope)) as T;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function base() {
  const sessionIdRef = { current: "A" as string | null };
  const sessionEpochRef = { current: 1 };
  return {
    sessionIdRef, sessionEpochRef, isAuthoritativeRosterDenial,
    stream: { inFlight: () => false },
    transcriptRequestRef: { current: 0 }, transcriptAbortRef: { current: null as AbortController | null },
    setTranscriptCold: vi.fn(),
    workspaceId: "fictional-workspace",
    setHistoryRecoverySessionId: vi.fn(), isSessionHistoryUnavailable: () => false,
    reattachPendingRef: { current: false }, transientErrorRef: { current: false }, stoppedTurnRef: { current: false },
    controllerRef: { current: null as unknown },
    switchTo(id: string | null) { sessionEpochRef.current++; sessionIdRef.current = id; },
  };
}
afterEach(() => vi.useRealTimers());

/** A page-profile conversation over fake transports, as the registry builds it. */
function pageConversation(opts: { sessionId?: string | null; room?: boolean; onFrame?: (frame: ClassifiedTurnFrame) => void } = {}) {
  const net = fakeTransport();
  // Production: the default transport carries no mapped history, so the page
  // (which declares no `mapHistoryRows`) owns history reads.
  (net.transport as { loadHistory?: unknown }).loadHistory = undefined;
  const clock = fakeScheduler();
  const controller = createConversationController({
    scope: SCOPE, sessionId: opts.sessionId === undefined ? "s-A" : opts.sessionId, room: opts.room,
    transport: net.transport, scheduler: clock.scheduler,
  });
  const frames: ClassifiedTurnFrame[] = [];
  const capabilities: PresentationCapabilities = {
    profile: "page",
    onFrame: (frame) => { frames.push(frame); opts.onFrame?.(frame); },
  };
  const detach = controller.attach("page", capabilities);
  return { net, clock, controller, frames, capabilities, detach, state: () => controller.getSnapshot() };
}
const pageCopy = { chatApp: en.chatApp, chat: en.chat };
function pageNotice(notices: readonly ConversationNotice[], ownsDirectRun = false, viewerId: string | null = SCOPE.viewerId) {
  const declarationNode = declaration("pageNoticeCopy");
  const mapper = evaluate<(notice: ConversationNotice, copy: typeof pageCopy, context: object) => { slot: string; text: string } | null>(
    declarationNode.initializer!.getText(tree), { format: (template: string, vars: Record<string, string>) => template.replace(/\{(\w+)\}/g, (_m, key) => vars[key] ?? "") },
  );
  return notices.map((notice) => mapper(notice, pageCopy, { viewerId, ownsDirectRun })).filter(Boolean);
}

describe("[COMP:app-web/chat-sessions-cache] surface async ownership", () => {
  it.each(["rows", "failure"])("a new send supersedes a slow same-chat history read (%s)", async outcome => {
    const pending = deferred<unknown[]>();
    const scope = {
      ...base(),
      fetchChatTranscript: vi.fn((_id: string, _options: { signal: AbortSignal }) => pending.promise),
      mapTranscriptRows: (rows: unknown) => rows,
      writeTranscriptCache: vi.fn(), evictTranscriptCache: vi.fn(),
      chat: { loadMessages: vi.fn() }, setError: vi.fn(),
      t: { errorGeneric: "Try again", historyUnavailable: "Unavailable" },
    };
    const load = evaluate(callback("loadTranscript"), scope);
    const supersede = evaluate(callback("supersedeHistoryRead"), scope);
    const read = load("A");
    supersede(); // what every send does before handing the turn to the conversation
    expect(scope.fetchChatTranscript.mock.calls[0][1].signal.aborted).toBe(true);
    expect(scope.setTranscriptCold).toHaveBeenCalledWith(false);
    // A transport may still resolve after abort (e.g. headers already read).
    if (outcome === "rows") pending.resolve(["old prompt", "old answer"]);
    else pending.reject(new Error("chat_history_failed: 403"));
    await read;
    expect(scope.chat.loadMessages).not.toHaveBeenCalled();
    expect(scope.writeTranscriptCache).not.toHaveBeenCalled();
    expect(scope.evictTranscriptCache).not.toHaveBeenCalled();
    expect(scope.setError).not.toHaveBeenCalled();
    scope.fetchChatTranscript.mockResolvedValue(["old prompt", "old answer", "new prompt", "new answer"]);
    await load("A", { force: true });
    expect(scope.chat.loadMessages).toHaveBeenCalledExactlyOnceWith(["old prompt", "old answer", "new prompt", "new answer"]);
  });

  it("hydrates ordinary history once from the primary response", async () => {
    const persisted = [{ id: "human-1" }, { id: "answer-2" }, { id: "human-3" }];
    const canonicalRows = [{ id: "human-1", text: "First prompt" }, { id: "answer-2", text: "Earlier answer" }, { id: "human-3", text: "Next prompt" }];
    const scope = {
      ...base(), fetchChatTranscript: vi.fn().mockResolvedValue(persisted),
      mapTranscriptRows: vi.fn(() => canonicalRows), writeTranscriptCache: vi.fn(), chat: { loadMessages: vi.fn() },
    };
    await evaluate(callback("loadTranscript"), scope)("A");
    expect(scope.fetchChatTranscript).toHaveBeenCalledOnce();
    expect(scope.chat.loadMessages).toHaveBeenCalledExactlyOnceWith(canonicalRows);
    expect(scope.writeTranscriptCache).toHaveBeenCalledExactlyOnceWith("A", canonicalRows);
  });

  it("defers history replacement while the direct reply owns the transcript", async () => {
    const scope = { ...base(), stream: { inFlight: () => true }, fetchChatTranscript: vi.fn() };
    await evaluate(callback("loadTranscript"), scope)("A", { force: true });
    expect(scope.fetchChatTranscript).not.toHaveBeenCalled();
  });

  it("a send started while a read is in flight discards that read's rows", async () => {
    const pending = deferred<unknown[]>();
    let streaming = false;
    const scope = {
      ...base(), stream: { inFlight: () => streaming },
      fetchChatTranscript: vi.fn(() => pending.promise), mapTranscriptRows: (rows: unknown) => rows,
      writeTranscriptCache: vi.fn(), chat: { loadMessages: vi.fn() },
    };
    const read = evaluate(callback("loadTranscript"), scope)("A");
    streaming = true; // a turn another presentation started on this conversation
    pending.resolve(["stale"]);
    await read;
    expect(scope.chat.loadMessages).not.toHaveBeenCalled();
    expect(scope.writeTranscriptCache).not.toHaveBeenCalled();
  });

  it.each([true, false])("reconciles personal history after a saved send only while it still owns the pane (%s)", async current => {
    const reconcile = find(node => ts.isIfStatement(node)
      && node.thenStatement.getText(tree).includes("await loadTranscript(settledSessionId, { force: true })"));
    const scope = {
      sourceMessageId: "saved-input", settledSessionId: "A",
      sessionIdRef: { current: current ? "A" : "B" }, loadTranscript: vi.fn(),
    };
    await evaluate(`async () => { ${reconcile.getText(tree)} }`, scope)();
    expect(scope.loadTranscript).toHaveBeenCalledTimes(current ? 1 : 0);
    if (current) expect(scope.loadTranscript).toHaveBeenCalledWith("A", { force: true });
  });

  it.each([401, 403, 404])("evicts protected history on an authoritative denial (%s)", async (status) => {
    const scope = {
      ...base(), transcriptRequestRef: { current: 0 },
      fetchChatTranscript: vi.fn().mockRejectedValue(new Error(`chat_history_failed: ${status}`)),
      mapTranscriptRows: (rows: unknown) => rows,
      writeTranscriptCache: vi.fn(), evictTranscriptCache: vi.fn(), chat: { loadMessages: vi.fn() },
      setError: vi.fn(), t: { errorGeneric: "Try again", historyUnavailable: "History unavailable. Start a new chat." },
    };
    await evaluate(callback("loadTranscript"), scope)("A");
    expect(scope.evictTranscriptCache).toHaveBeenCalledWith("A");
    expect(scope.chat.loadMessages).toHaveBeenCalledWith([]);
    expect(scope.writeTranscriptCache).not.toHaveBeenCalled();
    expect(scope.setError).toHaveBeenCalledWith("History unavailable. Start a new chat.");
  });

  it.each([false, true])("offers recovery only for the current denied transcript (switched: %s)", async switched => {
    const response = deferred<unknown>();
    const scope = {
      ...base(), transcriptRequestRef: { current: 0 },
      fetchChatTranscript: vi.fn().mockReturnValue(response.promise), mapTranscriptRows: (rows: unknown) => rows,
      writeTranscriptCache: vi.fn(), evictTranscriptCache: vi.fn(), chat: { loadMessages: vi.fn() },
      isSessionHistoryUnavailable: () => true, setError: vi.fn(),
      t: { errorGeneric: "Try again", historyUnavailable: "History unavailable" },
    };
    const pending = evaluate(callback("loadTranscript"), scope)("A");
    if (switched) scope.switchTo("B");
    response.reject(new Error("chat_history_failed: 403"));
    await pending;
    expect(scope.setHistoryRecoverySessionId).toHaveBeenCalledTimes(switched ? 0 : 1);
    if (!switched) expect(scope.setHistoryRecoverySessionId).toHaveBeenCalledWith("A");
  });

  it.each([false, true])("reports failed history without erasing cache or changing another session (switched: %s)", async (switched) => {
    const response = deferred<string[]>();
    const scope = {
      ...base(), transcriptRequestRef: { current: 0 },
      fetchChatTranscript: vi.fn().mockReturnValue(response.promise),
      mapTranscriptRows: (rows: unknown) => rows,
      writeTranscriptCache: vi.fn(), chat: { loadMessages: vi.fn() },
      setError: vi.fn(), t: { errorGeneric: "History unavailable" },
    };
    const load = evaluate(callback("loadTranscript"), scope);
    const loading = load("A");
    if (switched) scope.switchTo("B");
    response.reject(new Error("forbidden"));
    await loading;
    expect(scope.fetchChatTranscript).toHaveBeenCalledWith("A", { signal: expect.any(AbortSignal) });
    expect(scope.writeTranscriptCache).not.toHaveBeenCalled();
    expect(scope.chat.loadMessages).not.toHaveBeenCalled();
    expect(scope.setError).toHaveBeenCalledTimes(switched ? 0 : 1);
  });

  it.each([false, true])("drops late transcript responses after a switch (round trip: %s), including cache writes", async (roundTrip) => {
    const scope = {
      ...base(), transcriptRequestRef: { current: 0 },
      fetchChatTranscript: vi.fn(), mapTranscriptRows: (rows: unknown) => rows,
      writeTranscriptCache: vi.fn(), chat: { loadMessages: vi.fn() },
    };
    const response = deferred<string[]>();
    scope.fetchChatTranscript.mockReturnValue(response.promise);
    const load = evaluate(callback("loadTranscript"), scope);
    const loading = load("A");
    scope.switchTo("B");
    if (roundTrip) scope.switchTo("A");
    response.resolve(["old A"]);
    await loading;
    expect(scope.chat.loadMessages).not.toHaveBeenCalled();
    expect(scope.writeTranscriptCache).not.toHaveBeenCalled();
  });

  it("a newer same-session transcript request supersedes an older hydrate, even when it finishes first", async () => {
    const old = deferred<string[]>();
    const fresh = deferred<string[]>();
    const scope = {
      ...base(), transcriptRequestRef: { current: 0 },
      fetchChatTranscript: vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise),
      mapTranscriptRows: (rows: unknown) => rows,
      writeTranscriptCache: vi.fn(), chat: { loadMessages: vi.fn() },
    };
    const load = evaluate(callback("loadTranscript"), scope);
    const first = load("A");
    const second = load("A", { force: true });
    expect(scope.fetchChatTranscript.mock.calls[0][1].signal.aborted).toBe(true);
    expect(scope.setTranscriptCold).not.toHaveBeenCalled();
    fresh.resolve(["new turn"]);
    await second;
    expect(scope.setTranscriptCold).toHaveBeenCalledExactlyOnceWith(false);
    old.resolve(["before turn"]);
    await first;
    expect(scope.chat.loadMessages.mock.calls).toEqual([[["new turn"]]]);
    expect(scope.writeTranscriptCache.mock.calls).toEqual([["A", ["new turn"]]]);
  });

  it.each([false, true])("re-probes pending input only through the open chat's conversation (switched: %s)", (switched) => {
    const owner = { getSessionId: () => "A", refreshPendingInput: vi.fn(async () => undefined) };
    const scope = { ...base(), controllerRef: { current: owner } };
    const refresh = evaluate(callback("refreshPendingInput"), scope);
    if (switched) scope.switchTo("B");
    refresh("A");
    expect(owner.refreshPendingInput).toHaveBeenCalledTimes(switched ? 0 : 1);
    // A conversation bound to another chat is never probed for this one.
    const other = { getSessionId: () => "other", refreshPendingInput: vi.fn(async () => undefined) };
    evaluate(callback("refreshPendingInput"), { ...base(), controllerRef: { current: other } })("A");
    expect(other.refreshPendingInput).not.toHaveBeenCalled();
  });

  it("paints external confirmations from the conversation's probe only for the open chat", () => {
    const expression = declaration("externalRequests").initializer!.getText(tree);
    const items = [{ approvalId: "ext-1" }];
    expect(evaluate(expression, { pendingInput: { sessionId: "A", externalConfirmations: items }, activeSessionId: "A", workspaceId: "w" }))
      .toEqual({ workspaceId: "w", sessionId: "A", items });
    expect(evaluate(expression, { pendingInput: { sessionId: "A", externalConfirmations: items }, activeSessionId: "B", workspaceId: "w" })).toBeNull();
    expect(evaluate(expression, { pendingInput: null, activeSessionId: "A", workspaceId: "w" })).toBeNull();
  });

  it("keeps external confirmations on an indeterminate read and replaces them on a definitive one", async () => {
    const t = pageConversation({ sessionId: "s-A" });
    t.net.pending.current = { pending: null, toolConfirmation: null, externalConfirmations: [{ approvalId: "ext-1" } as never] };
    await t.controller.refreshPendingInput();
    expect(t.state().pendingInput).toEqual({ sessionId: "s-A", externalConfirmations: [{ approvalId: "ext-1" }] });
    t.net.pending.current = { pending: null, toolConfirmation: null }; // transient: the field is omitted
    await t.controller.refreshPendingInput();
    expect(t.state().pendingInput?.externalConfirmations).toEqual([{ approvalId: "ext-1" }]);
    t.net.pending.current = { pending: null, toolConfirmation: null, externalConfirmations: [] };
    await t.controller.refreshPendingInput();
    expect(t.state().pendingInput?.externalConfirmations).toEqual([]);
  });

  it("restores a pending question and confirmation, and a late probe after disposal changes nothing", async () => {
    const t = pageConversation({ sessionId: "s-A" });
    await settle();
    t.net.pending.current = { pending: { approvalId: "q-1", question: "Continue?", expiresAt: null }, toolConfirmation: null };
    await t.controller.refreshPendingInput();
    expect(t.state().interaction.pending).toMatchObject({ kind: "question", approvalId: "q-1", source: "restored" });
    t.net.pending.current = {
      pending: null,
      toolConfirmation: { toolCallId: "tool-1", approvalId: "appr-1", toolName: "sendEmail", input: {}, sessionId: "s-A", status: "pending" },
    };
    await t.controller.refreshPendingInput();
    expect(t.state().transcript.pendingConfirmations).toEqual([expect.objectContaining({ toolCallId: "tool-1", restored: true })]);
    const late = fakeDeferred<{ pending: null; toolConfirmation: null; externalConfirmations: never[] }>();
    t.net.transport.fetchPending.mockReturnValueOnce(late.promise);
    const probe = t.controller.refreshPendingInput();
    t.controller.dispose(); // identity change: the entry is dropped
    late.resolve({ pending: null, toolConfirmation: null, externalConfirmations: [] });
    await probe;
    expect(t.state().pendingInput).toBeNull();
  });
});

describe("[COMP:app-web/chat-sessions-cache] queued input ownership (controller boundary)", () => {
  it("a chat switch during the deferred flush never sends into the newly selected chat", async () => {
    const a = pageConversation({ sessionId: "s-A" });
    await settle();
    const sent = a.controller.send({ presentationId: "page", text: "First" });
    await settle();
    const turn = a.net.lastChat().sse;
    turn.send("session", { sessionId: "s-A", turnId: TURN_A });
    await settle();
    expect(a.controller.queue("waiting", false)).toBe(true);
    await settle();
    turn.send("done", { turnId: TURN_A });
    turn.close();
    await sent;
    // The page leaves for chat B before the deferred flush runs.
    a.detach();
    const b = pageConversation({ sessionId: "s-B" });
    await a.clock.advance(0);
    await settle();
    expect(b.net.chats).toHaveLength(0);
    // The queued text stays with its own conversation: sent there as its
    // next turn, or handed back as unsent; never forwarded to chat B.
    const flushed = a.net.chats.slice(1).map((chat) => chat.body);
    expect(flushed.every((body) => body.sessionId === "s-A")).toBe(true);
    expect(flushed.length + a.state().unsent.length).toBeGreaterThan(0);
  });

  it("a queued message the running turn takes lands between the segments it split", async () => {
    const t = pageConversation({ sessionId: "s-A" });
    await settle();
    const sent = t.controller.send({ presentationId: "page", text: "Plan it" });
    await settle();
    const turn = t.net.lastChat().sse;
    turn.send("session", { sessionId: "s-A", turnId: TURN_A });
    turn.send("user_message_saved", { id: "row-user" });
    turn.send("text_delta", { text: "Before." });
    await settle();
    t.controller.queue("Also this", false);
    await settle();
    const inputId = String(t.net.sides[0]!.inputId);
    turn.send("input_applied", { inputId, messageId: "row-queued" });
    turn.send("text_delta", { text: "After." });
    turn.send("done", { turnId: TURN_A });
    turn.close();
    expect(await sent).toBe("completed");
    expect(t.state().transcript.messages.map((message) => message.text)).toEqual(["Plan it", "Before.", "Also this", "After."]);
    expect(t.state().queued).toHaveLength(0);
    expect(t.frames.some((frame) => frame.event === "input_applied")).toBe(true);
  });

  it("an uncertain queued message comes back as unsent and is never resent", async () => {
    const t = pageConversation({ sessionId: "s-A" });
    await settle();
    const sent = t.controller.send({ presentationId: "page", text: "Go" });
    await settle();
    const turn = t.net.lastChat().sse;
    turn.send("session", { sessionId: "s-A", turnId: TURN_A });
    await settle();
    t.controller.queue("maybe delivered", false);
    await settle();
    turn.close(); // bare close: the turn is still running server-side
    await sent;
    await settle();
    t.net.lastFollow().sse?.send("status", { status: "running", turnId: TURN_A });
    await settle();
    t.net.status.current = { status: "idle", turnId: TURN_A };
    t.net.lastFollow().sse?.send("done", {});
    await settle();
    await t.clock.advance(0);
    expect(t.net.chats.filter((chat) => chat.body.message === "maybe delivered")).toHaveLength(0);
    expect(t.controller.takeUnsent()).toEqual(["maybe delivered"]);
  });
});

/** The page's frame observer, executed with controlled refs. */
function frameObserver(overrides: Record<string, unknown> = {}) {
  const owner = base();
  const scope: Record<string, any> = {
    ...owner,
    sendContextRef: { current: null }, hydratedRef: { current: owner.sessionIdRef.current },
    sessionAssistantRef: { current: new Map() }, selectSession: vi.fn(), adoptFreshChatPane: vi.fn(),
    cacheCreatedChatSession: vi.fn(), dispatchChatSessionsRefresh: vi.fn(), dispatchChatSessionActivity: vi.fn(),
    t: { newChat: "New chat" }, tChat: { toolNarration: en.chat.toolNarration },
    goalAcceptedNoticeFromPayload: () => null, setAcceptedGoal: vi.fn(), sessionGoalsForRef: { current: null }, reloadSessionGoals: vi.fn(),
    resetEventLog: vi.fn(), turnReasoningRef: { current: "" }, eventLogRef: { current: EMPTY_LOG as EventLog },
    eventSeq: 0, mintEventId: () => `ev-${scope.eventSeq++}`, setStreamingEvents: vi.fn(),
    appendReasoning, appendStep, removeToolSteps, updateStepText, describeToolFromInput,
    isBrowserToolName: (name: string) => name === "browse", openComputerTab: vi.fn(),
    eventToolIdsRef: { current: new Set() }, eventedToolIdsRef: { current: new Set() },
    announceResearchChanged: vi.fn(), openInChatPane: vi.fn(), parsePresentedDocumentPayload: (payload: { id?: string }) => (payload.id ? { id: payload.id } : null),
    setResearchQuota: vi.fn(), setResearchExhausted: vi.fn(), setResearchMode: vi.fn(), setUnreachableNote: vi.fn(),
    FEED_FRAMES: new Set(["input_applied", "reasoning", "tool_start", "tool_dropped", "tool_input", "turn_started", "snapshot", "activity"]),
    controllerRef: { current: { getSnapshot: () => ({ turnId: TURN_A }) } },
    followSeenRef: { current: { running: false, completed: false } }, resetRemoteLog: vi.fn(), markRoomSeen: vi.fn(),
    remoteLogRef: { current: EMPTY_LOG as EventLog }, remoteSeq: 0, mintRemoteId: () => `rev-${scope.remoteSeq++}`, setRemoteEvents: vi.fn(),
    remoteToolIdsRef: { current: new Set() }, remoteNarratedRef: { current: new Set() }, patchSharedChatSessions: vi.fn(),
    reloadShared: vi.fn(), panePolicy: { post: false }, refreshPendingInput: vi.fn(),
    window: { dispatchEvent: vi.fn() }, CustomEvent: class { constructor(public type: string, public init: unknown) {} },
    ...overrides,
  };
  const observe = evaluate<(frame: Partial<ClassifiedTurnFrame>, replay: boolean) => void>(declaration("observePageFrame").initializer!.getText(tree), scope);
  const frame = (stream: "direct" | "follow", event: string, payload: Record<string, unknown> = {}, replay = false) =>
    observe({ stream, event, class: "lifecycle", payload }, replay);
  return { scope, frame };
}
function sending(scope: Record<string, any>, overrides: Record<string, unknown> = {}) {
  scope.sendContextRef.current = {
    epoch: scope.sessionEpochRef.current, owningSessionId: null, text: "Plan a new release", assistantId: "assistant",
    channelId: "fresh-channel", contextGroupId: null, contextProjectId: "project", inputSaved: false,
    localSend: { adopt: vi.fn(), release: vi.fn(), complete: vi.fn() }, rollbackRecency: vi.fn(), ...overrides,
  };
  return scope.sendContextRef.current;
}

describe("[COMP:app-web/chat-sessions-cache] stream completion ownership", () => {
  it("retains send ownership and clears creation busy state for a fresh workspace chat", async () => {
    const owner = base();
    owner.sessionIdRef.current = null;
    const scope = {
      ...owner, view: "workspace", startingShared: false, setStartingShared: vi.fn(),
      beginChatSendFeedback: () => ({ release: vi.fn() }),
      creationContext: { snapshot: () => ({}), isCurrent: () => true, fail: vi.fn() },
      createWorkspaceSession: vi.fn().mockResolvedValue({ id: "minted" }),
      workspaceId: "workspace", interlocutor: { id: "assistant" },
      hydratedRef: { current: null }, cacheCreatedChatSession: vi.fn(),
      sessionAssistantRef: { current: new Map() },
      selectSession: vi.fn(), dispatchChatSessionsRefresh: vi.fn(),
      setError: vi.fn(), t: { newWorkspaceChatFailed: "Failed" },
    };
    const creation = find(node => ts.isIfStatement(node) &&
      node.expression.getText(tree) === 'view === "workspace" && !sessionIdRef.current').getText(tree);
    const continues = await evaluate(`async () => {
      const sendEpoch = sessionEpochRef.current;
      let owningSessionId = sessionIdRef.current;
      const ownsSend = ${declaration("ownsSend").initializer!.getText(tree)};
      ${creation}
      return [ownsSend(), owningSessionId];
    }`, scope)();
    expect(continues).toEqual([true, "minted"]);
    expect(scope.setStartingShared.mock.calls).toEqual([[true], [false]]);
    expect(scope.selectSession).toHaveBeenCalledWith("minted", "workspace");
    expect(scope.hydratedRef.current).toBe("minted");
    expect(scope.sessionAssistantRef.current.get("minted")).toBe("assistant");
  });

  it("adopts a fresh chat's minted session before navigating to it", () => {
    const { scope, frame } = frameObserver();
    scope.sessionIdRef.current = null;
    scope.hydratedRef.current = null;
    const send = sending(scope);
    frame("direct", "session", { sessionId: "minted", turnId: TURN_A });
    expect(scope.sessionIdRef.current).toBe("minted");
    expect(scope.hydratedRef.current).toBe("minted");
    expect(send.owningSessionId).toBe("minted");
    expect(send.localSend.adopt).toHaveBeenCalledWith("minted");
    expect(scope.sessionAssistantRef.current.get("minted")).toBe("assistant");
    expect(scope.selectSession).toHaveBeenCalledWith("minted");
    expect(scope.cacheCreatedChatSession).toHaveBeenCalledWith("fictional-workspace", expect.objectContaining({
      id: "minted", title: "Plan a new release", assistantId: "assistant",
      channelId: "fresh-channel", contextProjectId: "project", appOrigin: "chat",
    }), "personal");
    // The fresh side pane moves onto the session the first turn minted (T6).
    expect(scope.adoptFreshChatPane).toHaveBeenCalledWith("fictional-workspace", "minted");
    frame("direct", "session", { sessionId: "minted", turnId: TURN_A });
    expect(scope.selectSession).toHaveBeenCalledTimes(1);
  });

  it("a late session event cannot adopt the old turn into the newly selected chat", () => {
    const { scope, frame } = frameObserver();
    scope.sessionIdRef.current = null;
    sending(scope);
    scope.switchTo("B");
    frame("direct", "session", { sessionId: "minted" });
    expect(scope.sessionIdRef.current).toBe("B");
    expect(scope.selectSession).not.toHaveBeenCalled();
    expect(scope.cacheCreatedChatSession).not.toHaveBeenCalled();
  });

  it("refreshes the rail on a title update only for the chat the send owns", () => {
    const { scope, frame } = frameObserver();
    sending(scope, { owningSessionId: "A" });
    frame("direct", "title_update", { sessionId: "other" });
    expect(scope.dispatchChatSessionsRefresh).not.toHaveBeenCalled();
    frame("direct", "title_update", { sessionId: "A" });
    expect(scope.dispatchChatSessionsRefresh).toHaveBeenCalledWith("fictional-workspace");
  });

  it.each([false, true])("an error frame releases send feedback and rolls recency back only before the input saved (saved: %s)", saved => {
    const { scope, frame } = frameObserver();
    const send = sending(scope, { owningSessionId: "A" });
    if (saved) frame("direct", "user_message_saved", { id: "row" });
    frame("direct", "error", { code: "research_quota_exhausted" });
    expect(send.localSend.release).toHaveBeenCalled();
    expect(send.rollbackRecency).toHaveBeenCalledTimes(saved ? 0 : 1);
    expect(scope.setResearchExhausted).toHaveBeenCalledWith(true);
    expect(scope.setResearchMode).toHaveBeenCalledWith(false);
  });

  it("opens presented documents and created pages in this chat's pane, and browser steps as a tab", () => {
    const { scope, frame } = frameObserver();
    sending(scope, { owningSessionId: "A" });
    frame("direct", "document_payload", { id: "doc-1" });
    frame("direct", "page_created", { pageId: "page-1" });
    frame("direct", "tool_start", { id: "t-1", name: "browse" });
    frame("direct", "research_saved", { activityId: "r-1", status: "saved" });
    expect(scope.openInChatPane).toHaveBeenCalledWith({ kind: "document", document: { id: "doc-1" } });
    expect(scope.openInChatPane).toHaveBeenCalledWith({ kind: "page", pageId: "page-1" });
    expect(scope.window.dispatchEvent).toHaveBeenCalledTimes(1);
    expect(scope.openComputerTab).toHaveBeenCalledWith("A");
    expect(scope.announceResearchChanged).toHaveBeenCalledOnce();
  });

  it("rebuilds the chronological feed in arrival order and replays it without side effects", () => {
    const { scope, frame } = frameObserver();
    frame("direct", "reasoning", { text: "Thinking about it" });
    frame("direct", "tool_start", { id: "t-1", name: "browse" });
    frame("direct", "tool_start", { id: "t-1", name: "browse" }); // re-emit keeps one row
    frame("direct", "tool_input", { id: "t-1", name: "browse", input: { url: "https://example.com" } });
    const live = scope.eventLogRef.current.events;
    expect(live.map((event: { kind: string }) => event.kind)).toEqual(["reasoning", "step"]);
    expect(scope.openComputerTab).toHaveBeenCalledTimes(2);
    // A replay from the conversation's build log (returning to a running
    // chat) rebuilds the same feed and repeats no side effect.
    const replay = frameObserver();
    for (const [event, payload] of [["reasoning", { text: "Thinking about it" }], ["tool_start", { id: "t-1", name: "browse" }], ["page_created", { pageId: "p" }]] as const) {
      replay.frame("direct", event, payload, true);
    }
    expect(replay.scope.eventLogRef.current.events).toHaveLength(2);
    expect(replay.scope.openComputerTab).not.toHaveBeenCalled();
    expect(replay.scope.openInChatPane).not.toHaveBeenCalled();
  });

  it("never lets a stale idle status erase live direct ownership on the rail", () => {
    const { scope, frame } = frameObserver({ stream: { inFlight: () => true } });
    frame("follow", "status", { status: "idle" });
    expect(scope.dispatchChatSessionActivity).not.toHaveBeenCalled();
    frame("follow", "status", { status: "running", turnId: TURN_A });
    expect(scope.dispatchChatSessionActivity).toHaveBeenCalledWith({ workspaceId: "fictional-workspace", sessionId: "A", turnId: TURN_A, working: true });
  });

  it("a settled followed turn refreshes the rail, room watermark and pending input; a stale one does not", () => {
    const { scope, frame } = frameObserver({ panePolicy: { post: true } });
    frame("follow", "turn_completed", { turnId: TURN_B, reason: "completed" });
    expect(scope.reloadShared).not.toHaveBeenCalled();
    frame("follow", "turn_completed", { turnId: TURN_A, reason: "completed" });
    expect(scope.dispatchChatSessionActivity).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "A", working: false }));
    expect(scope.reloadShared).toHaveBeenCalledOnce();
    expect(scope.markRoomSeen).toHaveBeenCalledWith("fictional-workspace", "A");
    expect(scope.refreshPendingInput).toHaveBeenCalledWith("A");
  });

  it("follow done owes a refetch only after running with no turn_completed", () => {
    const idle = frameObserver();
    idle.frame("follow", "status", { status: "idle" });
    idle.frame("follow", "done", {});
    expect(idle.scope.refreshPendingInput).not.toHaveBeenCalled();
    const recovered = frameObserver();
    recovered.frame("follow", "status", { status: "running" });
    recovered.frame("follow", "done", {});
    expect(recovered.scope.refreshPendingInput).toHaveBeenCalledWith("A");
    expect(recovered.scope.dispatchChatSessionsRefresh).toHaveBeenCalled();
    const settled = frameObserver();
    settled.frame("follow", "status", { status: "running" });
    settled.frame("follow", "turn_completed", { turnId: TURN_A });
    settled.scope.refreshPendingInput.mockClear();
    settled.frame("follow", "done", {});
    expect(settled.scope.refreshPendingInput).not.toHaveBeenCalled();
  });

  it("applies a room's assistant change, including this viewer's own echo", () => {
    const { scope, frame } = frameObserver();
    frame("follow", "assistant_changed", { assistantId: "assistant-2" });
    expect(scope.sessionAssistantRef.current.get("A")).toBe("assistant-2");
    expect(scope.patchSharedChatSessions).toHaveBeenCalledOnce();
  });

  it("A to B to A mid-turn: the turn keeps running in its own conversation and is shown again on return", async () => {
    const a = pageConversation({ sessionId: "s-A" });
    await settle();
    const sent = a.controller.send({ presentationId: "page", text: "Long task" });
    await settle();
    const turn = a.net.lastChat().sse;
    turn.send("session", { sessionId: "s-A", turnId: TURN_A });
    turn.send("text_delta", { text: "Part one. " });
    await settle();
    a.detach(); // switch to B
    const b = pageConversation({ sessionId: "s-B" });
    turn.send("text_delta", { text: "Part two." });
    turn.send("done", { turnId: TURN_A });
    turn.close();
    expect(await sent).toBe("completed");
    a.controller.attach("page", a.capabilities); // back to A
    expect(turn.aborted()).toBe(false);
    expect(a.net.transport.stopTurn).not.toHaveBeenCalled();
    expect(a.state().transcript.messages.map((message) => message.text)).toEqual(["Long task", "Part one. Part two."]);
    expect(b.state().transcript.messages).toHaveLength(0);
  });

  it("keeps the optimistic bubble's quote and attachment previews across the server re-key", async () => {
    const t = pageConversation({ sessionId: "s-A" });
    await settle();
    const accepted = vi.fn();
    const sent = t.controller.send({
      presentationId: "page", text: "Look at this", fileIds: ["file-1"], recordingIds: ["rec-1"],
      userMessage: { userAttachments: [{ id: "file-1", name: "a.png" }], replyTo: { text: "Quoted" } },
      bodyExtras: { appOrigin: "chat", model: "standard", channelId: "fresh-channel" },
      onAccepted: accepted,
    });
    await settle();
    const { body, sse } = t.net.lastChat();
    expect(body).toMatchObject({ message: "Look at this", fileIds: ["file-1"], attachedRecordingIds: ["rec-1"], appOrigin: "chat", channelId: "fresh-channel" });
    sse.send("session", { sessionId: "s-A", turnId: TURN_A });
    sse.send("user_message_saved", { id: "row-user" });
    sse.send("done", { turnId: TURN_A });
    sse.close();
    await sent;
    expect(accepted).toHaveBeenCalled();
    expect(t.state().transcript.messages[0]).toMatchObject({ id: "row-user", userAttachments: [{ id: "file-1", name: "a.png" }], replyTo: { text: "Quoted" } });
  });
});

describe("[COMP:app-web/chat-controller] one Stop entry point", () => {
  it("routes the composer and Work Bench Stop to the conversation", () => {
    const stop = vi.fn(async () => "stopped");
    const owner = { stop };
    let requested: unknown = null;
    const setStopRequestedHere = vi.fn((value: unknown) => { requested = typeof value === "function" ? (value as (v: unknown) => unknown)(requested) : value; });
    evaluate(callback("stopRunningTurn"), { controllerRef: { current: owner }, setStopRequestedHere })();
    expect(stop).toHaveBeenCalledOnce();
    expect(requested).toBe(owner);
    expect(source.match(/onClick=\{stopRunningTurn\}/g)).toHaveLength(1);
    expect(source).toContain("onStopTurn={stopRunningTurn}");
    expect(source).not.toContain("handleAbort");
    expect(source).not.toContain("stopActiveTurn");
  });

  it("compare-and-sets first, keeps reading the direct stream, and aborts only on confirmation", async () => {
    const t = pageConversation({ sessionId: "s-A" });
    await settle();
    const stopped = fakeDeferred<{ stopped: boolean }>();
    t.net.transport.stopTurn.mockReturnValue(stopped.promise);
    const sent = t.controller.send({ presentationId: "page", text: "Write a lot" });
    await settle();
    const turn = t.net.lastChat().sse;
    turn.send("session", { sessionId: "s-A", turnId: TURN_A });
    turn.send("text_delta", { text: "Hello" });
    await settle();
    const stop = t.controller.stop();
    await settle();
    expect(t.net.transport.stopTurn).toHaveBeenCalledWith("s-A", TURN_A);
    turn.send("text_delta", { text: " world" });
    await settle();
    t.clock.runFrames();
    expect(turn.aborted()).toBe(false);
    expect(t.state().transcript.streamingText).toBe("Hello world");
    stopped.resolve({ stopped: true });
    expect(await stop).toBe("stopped");
    expect(await sent).toBe("stopped");
    expect(turn.aborted()).toBe(true);
    expect(t.state().transcript.isStreaming).toBe(false);
    expect(t.state().run.phase).toBe("cancelled");
  });

  it("a failed Stop request leaves the run and stream unchanged and says so in page copy", async () => {
    const t = pageConversation({ sessionId: "s-A" });
    await settle();
    t.net.transport.stopTurn.mockRejectedValue(new Error("stop_failed: 503"));
    void t.controller.send({ presentationId: "page", text: "Keep going" });
    await settle();
    const turn = t.net.lastChat().sse;
    turn.send("session", { sessionId: "s-A", turnId: TURN_A });
    await settle();
    expect(await t.controller.stop()).toBe("failed");
    expect(turn.aborted()).toBe(false);
    expect(t.state().transcript.isStreaming).toBe(true);
    expect(pageNotice(t.state().notices)).toEqual([{ slot: "error", text: en.chatApp.stopTurnFailed }]);
  });
});

function hydrationEffect() {
  return (find(node => ts.isCallExpression(node) && node.expression.getText(tree) === "useLayoutEffect" &&
    node.arguments[0]?.getText(tree).includes("activeSessionId === hydratedRef.current")) as ts.CallExpression).arguments[0].getText(tree);
}
function hydrationScope(overrides: Record<string, unknown> = {}) {
  const leaving = { getSessionId: () => "A", getSnapshot: () => ({ transcript: { messages: [] } }), stop: vi.fn(), dispose: vi.fn() };
  return {
    ...base(), activeSessionId: "B", hydratedRef: { current: "A" as string | null },
    setStartingShared: vi.fn(), resetEventLog: vi.fn(), resetRemoteLog: vi.fn(),
    controllerRef: { current: leaving as { getSessionId: () => string; getSnapshot: () => { transcript: { messages: unknown[] } }; stop: unknown; dispose: unknown } },
    chat: { state: { sessionId: "A", messages: [] as unknown[] }, loadMessages: vi.fn() },
    att: { clear: vi.fn() }, setError: vi.fn(), setReplyTo: vi.fn(), setSelectionQuote: vi.fn(),
    freshChannelIdRef: { current: null }, setFreshPaneKey: vi.fn(), setPickedAssistantId: vi.fn(), handoffAssistantRef: { current: null },
    readCachedTranscript: vi.fn().mockReturnValue(undefined), writeTranscriptCache: vi.fn(),
    loadTranscript: vi.fn(() => new Promise(() => {})),
    ...overrides,
  };
}

describe("[COMP:app-web/chat-sessions-cache] selection before paint", () => {
  it.each([false, true])("finishes cold loading after effect replay (unmount cleanup: %s)", async replayUnmount => {
    const pending = deferred<string[]>();
    const scope = hydrationScope({
      fetchChatTranscript: vi.fn(() => pending.promise), mapTranscriptRows: (rows: unknown) => rows,
      loadTranscript: null as unknown as (id: string) => Promise<unknown>,
    }) as ReturnType<typeof hydrationScope> & { fetchChatTranscript: ReturnType<typeof vi.fn> };
    // The B conversation is bound by the time the layout effect runs.
    scope.controllerRef.current = { ...scope.controllerRef.current, getSessionId: () => "B" };
    scope.loadTranscript = evaluate(callback("loadTranscript"), scope);
    const hydrate = evaluate(hydrationEffect(), scope);
    hydrate();
    if (replayUnmount) {
      const lifecycle = (find(node => ts.isCallExpression(node) && node.expression.getText(tree) === "useLayoutEffect" &&
        node.arguments[0]?.getText(tree).includes("hydratedRef.current = null")) as ts.CallExpression).arguments[0].getText(tree);
      evaluate(lifecycle, scope)()();
      expect(scope.transcriptAbortRef.current?.signal.aborted).toBe(true);
    }
    hydrate();
    expect(scope.fetchChatTranscript).toHaveBeenCalledTimes(replayUnmount ? 2 : 1);
    pending.resolve(["Selected chat"]);
    await pending.promise;
    await Promise.resolve();
    expect(scope.chat.loadMessages).toHaveBeenLastCalledWith(["Selected chat"]);
    expect(scope.setTranscriptCold).toHaveBeenLastCalledWith(false);
    expect(scope.writeTranscriptCache).toHaveBeenCalledExactlyOnceWith("B", ["Selected chat"]);
  });

  it.each([true, false])("installs only the selected transcript synchronously while its read is pending (cached: %s)", async cached => {
    const oldMessages = [{ id: "old-message", text: "Previous chat" }];
    const selectedMessages = [{ id: "selected-message", text: "Selected chat" }];
    const scope = hydrationScope({ readCachedTranscript: vi.fn().mockReturnValue(cached ? selectedMessages : undefined) });
    scope.chat.state = { sessionId: "A", messages: oldMessages };
    const leaving = scope.controllerRef.current;
    scope.controllerRef.current = { ...leaving, getSessionId: () => "B" };
    const cleanup = evaluate(hydrationEffect(), scope)();
    expect(scope.chat.loadMessages).toHaveBeenCalledWith(cached ? selectedMessages : []);
    expect(scope.setTranscriptCold).toHaveBeenCalledWith(!cached);
    expect(scope.sessionIdRef.current).toBe("B");
    // The chat being left keeps its turn: switching never aborts or stops it.
    expect(leaving.stop).not.toHaveBeenCalled();
    expect(leaving.dispose).not.toHaveBeenCalled();
    expect(scope.resetEventLog).toHaveBeenCalled();
    // Layout effects can flush older passive effects before their rerender.
    // The outgoing transcript identity must never write its messages under B.
    const write = (find(node => ts.isCallExpression(node) && node.expression.getText(tree) === "useEffect" &&
      node.arguments[0]?.getText(tree).includes("writeTranscriptCache(activeSessionId")) as ts.CallExpression).arguments[0].getText(tree);
    evaluate(write, scope)();
    expect(scope.writeTranscriptCache).not.toHaveBeenCalled();
    scope.chat.state = { sessionId: "B", messages: selectedMessages };
    evaluate(write, scope)();
    expect(scope.writeTranscriptCache).toHaveBeenCalledWith("B", selectedMessages);
    expect(cleanup).toBeUndefined();
  });

  it("returning to a conversation that kept its turn running paints it, not the stale cache", () => {
    const scope = hydrationScope({ readCachedTranscript: vi.fn().mockReturnValue([{ id: "stale" }]) });
    scope.controllerRef.current = { ...scope.controllerRef.current, getSessionId: () => "B", getSnapshot: () => ({ transcript: { messages: [{ id: "live" }] } }) };
    evaluate(hydrationEffect(), scope)();
    expect(scope.chat.loadMessages).not.toHaveBeenCalled();
    expect(scope.setTranscriptCold).toHaveBeenCalledWith(false);
    expect(scope.loadTranscript).toHaveBeenCalledWith("B");
  });

  it("a fresh pane mints a new provisional conversation and resets the per-chat pick", () => {
    const scope = hydrationScope({ activeSessionId: null, handoffAssistantRef: { current: "handoff-assistant" } });
    evaluate(hydrationEffect(), scope)();
    expect(scope.setFreshPaneKey).toHaveBeenCalledOnce();
    expect(scope.setPickedAssistantId).toHaveBeenCalledWith("handoff-assistant");
    expect(scope.loadTranscript).not.toHaveBeenCalled();
  });
});

describe("main chat live interaction ownership", () => {
  it("appends two canonical job pairs without replacing the typed stream or accepting another session", async () => {
    const { canonicalInteractionAdditions } = await import("@/lib/live-interaction/canonical");
    const t = pageConversation({ sessionId: "s-A" });
    await settle();
    const sent = t.controller.send({ presentationId: "page", text: "typed" });
    await settle();
    t.net.lastChat().sse.send("session", { sessionId: "s-A", turnId: TURN_A });
    t.net.lastChat().sse.send("text_delta", { text: "typed partial answer" });
    await settle();
    t.clock.runFrames();
    const attribute = find((node) => ts.isJsxAttribute(node) && node.name.getText(tree) === "onCanonical") as ts.JsxAttribute;
    const expression = (attribute.initializer as ts.JsxExpression).expression!;
    const message = (id: string, role: "user" | "assistant") => ({ id, role, text: id, timestamp: new Date() });
    const chat = {
      get state() { return t.state().transcript; },
      appendMessage: vi.fn((item) => t.controller.appendMessage(item)),
    };
    const mapTranscriptRows = vi.fn((rows) => rows);
    const onCanonical = evaluate(expression.getText(tree), { chat, sessionIdRef: { current: "main" }, mapTranscriptRows, canonicalInteractionAdditions });
    const rows = [message("q1", "user"), message("q2", "user"), message("a2", "assistant"), message("a1", "assistant")];
    const ids = new Set(["q1", "a1", "q2", "a2"]);
    onCanonical("other", rows, ids);
    expect(chat.appendMessage).not.toHaveBeenCalled();
    onCanonical("main", rows, ids);
    expect(t.state().transcript.messages.slice(1).map((m) => m.id)).toEqual(["q1", "a1", "q2", "a2"]);
    expect(t.state().transcript.streamingText).toBe("typed partial answer");
    expect(t.state().transcript.isStreaming).toBe(true);
    expect(mapTranscriptRows).toHaveBeenCalledWith(rows, false); // no cross-job assistant coalescing
    onCanonical("main", rows, ids);
    expect(chat.appendMessage).toHaveBeenCalledTimes(4);
    t.net.lastChat().sse.close();
    await sent;
  });
});

/** A personal conversation re-attached by its hydrate probe (reload or return). */
async function reattached(opts: { room?: boolean } = {}) {
  const t = pageConversation({ sessionId: "s-A", room: opts.room });
  await settle();
  const follow = t.net.lastFollow().sse!;
  return { ...t, follow };
}

describe("[COMP:app-web/turn-reconnect] returning sender outcomes", () => {
  it("restores elapsed time after navigating away and mounting a fresh chat", async () => {
    const { clock, follow, state } = await reattached();
    const start = clock.scheduler.now() - 45_000;
    follow.send("status", { status: "running", startedAt: start, turnId: TURN_A });
    await settle();
    expect(state().mirror.active).toBe(true);
    expect(state().mirror.startedAt).toBe(start);
    vi.useFakeTimers();
    vi.setSystemTime(start + 45_000);
    const html = renderToString(React.createElement(I18nProvider, { locale: "en", dict: en,
      children: React.createElement(ChatActivityFeed, { events: [], tools: [], startedAt: state().mirror.startedAt, replyStreaming: false }),
    }));
    expect(html).toContain("45s");
    vi.useRealTimers();
    follow.send("snapshot", { text: "" });
    follow.send("status", { status: "running", startedAt: start, turnId: TURN_A });
    await settle();
    expect(state().mirror.startedAt).toBe(start);
  });

  it.each([undefined, null, "invalid", -1, NaN])("falls back safely for missing/invalid start time %s", async startedAt => {
    const { clock, follow, state } = await reattached();
    follow.send("status", { status: "running", startedAt, turnId: TURN_A });
    await settle();
    expect(state().mirror.startedAt).toBe(clock.scheduler.now());
  });

  it("preserves an earlier direct start against a later lease start", async () => {
    const { follow, state, clock } = await reattached();
    const directStart = clock.scheduler.now() - 90_000;
    follow.send("status", { status: "running", startedAt: directStart, turnId: TURN_A });
    await settle();
    follow.send("status", { status: "running", startedAt: directStart + 30_000, turnId: TURN_A });
    await settle();
    expect(state().mirror.startedAt).toBe(directStart);
  });

  it("ignores an idle turn's old timestamp", async () => {
    const { follow, state, net } = await reattached();
    net.status.current = { status: "idle", turnId: null };
    follow.send("status", { status: "idle", startedAt: 60_000, turnId: null });
    await settle();
    expect(state().mirror.active).toBe(false);
    expect(state().mirror.startedAt).toBeNull();
  });

  it("restores text completion on reconnect without treating it as turn completion", async () => {
    const { follow, state, clock } = await reattached();
    follow.send("status", { status: "running", turnId: TURN_A });
    follow.send("snapshot", { text: "Hello", replyPhase: "saving", turnId: TURN_A });
    await settle();
    clock.runFrames();
    expect(state().mirror).toMatchObject({ active: true, text: "Hello", replyPhase: "saving" });
    follow.send("activity", { event: "assistant_message_saved", id: "saved", turnId: TURN_A });
    await settle();
    expect(state().mirror).toMatchObject({ active: true, replyPhase: "finishing" });
    expect(state().run.phase).toBe("running");
  });

  it("reattaches to a running turn and explains its failed outcome", async () => {
    const { follow, state } = await reattached();
    follow.send("status", { status: "running", turnId: TURN_A });
    await settle();
    expect(state().mirror.active).toBe(true);
    const epoch = state().historyEpoch;
    follow.send("turn_completed", { reason: "failed", senderUserId: SCOPE.viewerId, turnId: TURN_A });
    await settle();
    expect(pageNotice(state().notices)).toEqual([{ slot: "turnEnd", text: en.chatApp.turnFailed }]);
    expect(state().mirror.active).toBe(false);
    expect(state().historyEpoch).toBeGreaterThan(epoch);
  });

  it("explains an initial failed or timed-out status when the terminal event was missed", async () => {
    for (const [status, frame, text] of [
      [{ status: "failed", turnId: null }, { status: "failed", turnId: null }, en.chatApp.turnFailed],
      [{ status: "timeout", turnId: null }, { status: "timeout", turnId: null }, en.chatApp.turnReclaimed],
      [{ status: "idle", turnId: null }, { status: "idle", turnEndReason: "timeout", turnId: null }, en.chatApp.turnReclaimed],
    ] as const) {
      const t = await reattached();
      t.net.status.current = { ...status };
      t.follow.send("status", frame);
      await settle();
      expect(pageNotice(t.state().notices)).toEqual([{ slot: "turnEnd", text }]);
      expect(t.state().mirror.active).toBe(false);
    }
  });

  it("explains a DB backstop timeout as recovery rather than success", async () => {
    const { follow, state } = await reattached();
    follow.send("status", { status: "running", turnId: TURN_A });
    follow.send("turn_completed", { reason: "timeout", turnId: TURN_A });
    await settle();
    expect(pageNotice(state().notices)).toEqual([{ slot: "turnEnd", text: en.chatApp.turnReclaimed }]);
    expect(state().mirror.active).toBe(false);
  });

  it("leaves the direct stream's own error handling in control", async () => {
    const t = pageConversation({ sessionId: "s-A", room: true });
    await settle();
    void t.controller.send({ presentationId: "page", text: "Room question" });
    await settle();
    const turn = t.net.lastChat().sse;
    turn.send("session", { sessionId: "s-A", turnId: TURN_A });
    await settle();
    t.net.lastFollow().sse!.send("turn_completed", { reason: "failed", senderUserId: SCOPE.viewerId, turnId: TURN_A });
    await settle();
    expect(pageNotice(t.state().notices, true)).toEqual([]);
    expect(t.state().transcript.isStreaming).toBe(true);
    expect(turn.aborted()).toBe(false);
  });

  it("does not invent a failure on ordinary completion or accept a stale terminal event", async () => {
    const { follow, state, net } = await reattached();
    net.status.current = { status: "running", turnId: TURN_B };
    follow.send("status", { status: "running", turnId: TURN_B });
    follow.send("turn_completed", { turnId: TURN_B });
    await settle();
    expect(pageNotice(state().notices)).toEqual([]);
    net.status.current = { status: "idle", turnId: TURN_B };
    follow.send("turn_completed", { reason: "failed", turnId: TURN_A });
    await settle();
    expect(pageNotice(state().notices)).toEqual([]);
  });

  it("a rejected follow open ends the re-attach without errors or a reopen", async () => {
    const t = pageConversation({ sessionId: null });
    t.net.followPlans.push(() => new Response(null, { status: 403 }));
    const owner = createConversationController({ scope: SCOPE, sessionId: "s-A", transport: t.net.transport, scheduler: t.clock.scheduler });
    owner.attach("page", t.capabilities);
    await settle();
    expect(t.clock.timerDelays()).toEqual([]);
    expect(owner.getSnapshot().notices).toEqual([]);
    expect(t.net.follows).toHaveLength(1);
  });

  it("old turn_completed or done refreshes history without clearing the successor's mirror", async () => {
    const { follow, state, net } = await reattached();
    net.status.current = { status: "running", turnId: TURN_B };
    follow.send("status", { status: "running", turnId: TURN_B });
    follow.send("turn_started", { turnId: TURN_B });
    follow.send("snapshot", { turnId: TURN_B, text: "Current answer" });
    await settle();
    const epoch = state().historyEpoch;
    follow.send("turn_completed", { turnId: TURN_A, reason: "publication_recovered" });
    await settle();
    expect(state().historyEpoch).toBeGreaterThan(epoch);
    expect(state().mirror.active).toBe(true);
    expect(state().turnId).toBe(TURN_B);
    expect(state().run.phase).toBe("running");
    expect(pageNotice(state().notices)).toEqual([]);
  });

  it("system cancellation recovery never attributes Stop to the viewer", async () => {
    const { follow, state } = await reattached();
    follow.send("status", { status: "running", turnId: TURN_A });
    follow.send("turn_completed", { turnId: TURN_A, reason: "stopped_by_user", senderUserId: null });
    await settle();
    expect(pageNotice(state().notices)).toEqual([{ slot: "turnEnd", text: en.chatApp.turnStopped }]);
  });

  it.each([["en", en], ["ja", ja], ["zh", zh], ["zh-CN", zhCN]] as const)(
    "uses the ordinary localized activity feed after returning (%s)", (locale, dict) => {
      const expression = find(node => ts.isBinaryExpression(node) &&
        node.left.getText(tree) === "remoteActive && !chat.state.isStreaming").getText(tree);
      const node = evaluate<React.ReactNode>(expression, {
        React, remoteActive: true, chat: { state: { isStreaming: false } },
        avatarFor: () => null, remoteAssistantId: null, ChatActivityFeed,
        remoteEvents: [], remoteTools: [], remoteText: "", remoteResearchPhase: null, remoteReplyPhase: "generating", remoteStartedAt: null,
      });
      const html = renderToString(React.createElement(I18nProvider, { locale, dict, children: node }));
      expect(html).toContain(dict.chat.thinking);
      expect(html).not.toContain(dict.chatApp.teammateWorking.replaceAll("'", "&#x27;"));
    },
  );
});

describe("[COMP:app-web/chat-activity] reply finalization display", () => {
  it.each(["saving", "finishing"] as const)("restores Send and accepts a queued follow-up during %s", async (replyPhase) => {
    const composer = find(node => ts.isJsxSelfClosingElement(node) && node.tagName.getText(tree) === "ChatComposer"
      && node.attributes.properties.some(prop => ts.isJsxAttribute(prop) && prop.name.getText(tree) === "sendButtonTone")) as ts.JsxSelfClosingElement;
    const prop = (name: string) => {
      const attribute = composer.attributes.properties.find(node => ts.isJsxAttribute(node) && node.name.getText(tree) === name) as ts.JsxAttribute;
      return (attribute.initializer as ts.JsxExpression).expression!.getText(tree);
    };
    const state = { isStreaming: true, replyPhase };
    const sendDuringTurn = vi.fn(() => true), send = vi.fn(), setInput = vi.fn();
    const scope = { chat: { state }, canQueueMidTurn: true, mirrorStopAvailable: false,
      sendDuringTurn, send, setInput, stopRunningTurn: vi.fn() };
    expect(evaluate(prop("sendButtonTone"), scope)).toBe("primary");
    expect(evaluate(prop("slotPostInput"), scope)).toBeNull();
    evaluate<() => void>(prop("onSend"), scope)();
    expect(sendDuringTurn).toHaveBeenCalledExactlyOnceWith(false);
    expect(setInput).toHaveBeenCalledExactlyOnceWith("");
    expect(send).not.toHaveBeenCalled();
    expect(state.isStreaming).toBe(true);
  });

  it.each(["generating", "saving", "finishing"] as const)("renders the actual active reply in phase %s without ending its foreground state", async (replyPhase) => {
    const expression = find(node => ts.isBinaryExpression(node) && node.left.getText(tree) === "chat.state.isStreaming"
      && node.right.getText(tree).includes("data-brian-chat-answer")).getText(tree);
    const state = { isStreaming: true, streamingText: "Hello.", replyPhase };
    const node = evaluate<React.ReactNode>(expression, {
      React, chat: { state }, avatarFor: () => null, convo: { liveAssistantId: "assistant" },
      ChatActivityFeed, streamingEvents: [], toolTimeline: [], researchPhase: null, turnStartedAt: null,
      MARKDOWN_CLS: "answer", ChatMarkdown: ({ text }: { text: string }) => React.createElement("p", null, text),
      CHAT_MARKDOWN_COMPONENTS: {}, REMARK_PLUGINS: [], citations: [],
    });
    const html = renderToString(React.createElement(I18nProvider, { locale: "en", dict: en, children: node }));
    expect(html).toContain("Hello.");
    expect(html.includes("animate-pulse")).toBe(replyPhase === "generating");
    if (replyPhase !== "generating") {
      expect(html).not.toContain("chat-shimmer-text");
      expect(html).not.toContain(en.chat.activity.savingReply);
      expect(html).not.toContain(en.chat.activity.finishingReply);
    }
    expect(state.isStreaming).toBe(true);
  });
});

describe("[COMP:app-web/chat-controller] full Chat correlated callback races", () => {
  it("cannot use a delayed legacy idle read to clear a newer local POST", async () => {
    const { follow, net, controller, state } = await reattached();
    const pending = fakeDeferred<{ status: string; turnId: string | null }>();
    net.transport.readStatus.mockReturnValueOnce(pending.promise);
    follow.send("done", {});
    await settle();
    const sent = controller.send({ presentationId: "page", text: "Newer question" });
    await settle();
    net.lastChat().sse.send("session", { sessionId: "s-A", turnId: TURN_B });
    await settle();
    pending.resolve({ status: "idle", turnId: TURN_A });
    await settle();
    expect(state().run.phase).toBe("running");
    expect(state().transcript.isStreaming).toBe(true);
    net.lastChat().sse.close();
    await sent;
  });
});

describe("[COMP:app-web/chat-surface] browser qualification fixes (M5Q-3, -5, -8, -9)", () => {
  it("M5Q-3: a send during this tab's re-attached personal turn joins it like a direct one", async () => {
    // The page reads the conversation's own `turnLive`, the same test that
    // makes `send` answer busy and `queue` accept, so the two never disagree.
    const live = (state: { isStreaming: boolean; presence: boolean; turnLive: boolean }) => evaluate<boolean>(
      declaration("reattachedTurnLive").initializer!.getText(tree),
      { transcript: { isStreaming: state.isStreaming }, panePolicy: { presence: state.presence }, convo: { turnLive: state.turnLive } },
    );
    expect(live({ isStreaming: false, presence: false, turnLive: true })).toBe(true);
    expect(live({ isStreaming: true, presence: false, turnLive: true })).toBe(false); // a direct turn is already covered
    expect(live({ isStreaming: false, presence: true, turnLive: true })).toBe(false); // a room's teammate turn has its own path
    expect(live({ isStreaming: false, presence: false, turnLive: false })).toBe(false);
    const canQueue = (streaming: boolean, reattached: boolean, route: string) => evaluate<boolean>(
      declaration("canQueueMidTurn").initializer!.getText(tree),
      { chat: { state: { isStreaming: streaming } }, reattachedTurnLive: reattached, midTurnRoute: route },
    );
    expect(canQueue(false, true, "client_queue")).toBe(true);
    expect(canQueue(true, false, "client_queue")).toBe(true);
    expect(canQueue(false, false, "client_queue")).toBe(false);
    expect(canQueue(false, true, "none")).toBe(false);
    // At the controller boundary the re-attached run accepts the queued input.
    const { follow, controller, net, state } = await reattached();
    follow.send("status", { status: "running", turnId: TURN_A });
    await settle();
    expect(state().transcript.isStreaming).toBe(false);
    expect(state().mirror.active).toBe(true);
    expect(state().turnLive).toBe(true);
    expect(await controller.send({ presentationId: "page", text: "Direct send" })).toBe("busy");
    expect(controller.queue("And this too", false, { assistantId: "assistant" })).toBe(true);
    await settle();
    expect(net.sides).toEqual([expect.objectContaining({ message: "And this too", sessionId: "s-A", midTurn: true, assistantId: "assistant" })]);
    expect(state().queued).toHaveLength(1);
  });

  it("M5Q-3: a busy send queues plain text, or says why nothing was sent", () => {
    const busy = find(node => ts.isIfStatement(node) && node.expression.getText(tree).startsWith('result === "busy" || result === "empty"')).getText(tree);
    const run = (opts: { route: string; queued: boolean; fileIds?: string[] }) => {
      const scope = {
        result: "busy", localSend: { release: vi.fn() }, sending: { rollbackRecency: vi.fn() },
        dispatchChatSessionsRefresh: vi.fn(), workspaceId: "w", midTurnRoute: opts.route, usesComposerTray: true,
        turnFileIds: opts.fileIds ?? [], turnRecordingIds: [], trimmed: "Follow-up", override: undefined,
        owner: { queue: vi.fn(() => opts.queued) }, targetIds: ["assistant"], clearDraft: vi.fn(), setReplyTo: vi.fn(), reply: null,
        setError: vi.fn(), t: { sendWhileTurnRunning: "Still working" },
      };
      const outcome = evaluate<() => unknown>(`() => { ${busy} return "fell through"; }`, scope)();
      return { scope, outcome };
    };
    const joined = run({ route: "client_queue", queued: true });
    expect(joined.outcome).toBe(true);
    expect(joined.scope.owner.queue).toHaveBeenCalledWith("Follow-up", false, { assistantId: "assistant" });
    expect(joined.scope.clearDraft).toHaveBeenCalledOnce();
    expect(joined.scope.setError).not.toHaveBeenCalled();
    for (const blocked of [run({ route: "client_queue", queued: false }), run({ route: "room_inbox", queued: true }), run({ route: "client_queue", queued: true, fileIds: ["f"] })]) {
      expect(blocked.outcome).toBe(false);
      expect(blocked.scope.setError).toHaveBeenCalledWith("Still working");
      expect(blocked.scope.clearDraft).not.toHaveBeenCalled();
    }
  });

  it("M5Q-5: a turn split by a taken queued input shows both persisted replies", async () => {
    const { coalesceAssistantRunMessages } = await import("@/components/chat-app/chat-transcript");
    const coalesce = evaluate<(rows: unknown[]) => Array<{ id: string; text: string }>>(
      declaration("coalesceTranscriptReplies").initializer!.getText(tree), { coalesceAssistantRunMessages },
    );
    const at = (n: number) => new Date(Date.UTC(2026, 10, 16, 0, 0, n));
    const rows = [
      { id: "u1", role: "user", text: "Write w1 to w50", timestamp: at(1) },
      { id: "u2", role: "user", text: "Also this", timestamp: at(2) },
      { id: "a1", role: "assistant", text: "w1 ... w50", timestamp: at(3) },
      { id: "a2", role: "assistant", text: "And the follow-up.", timestamp: at(4) },
    ];
    expect(coalesce(rows).map((row) => row.id)).toEqual(["u1", "u2", "a1", "a2"]);
    // Tool rounds of ONE reply still render as one message.
    const rounds = [
      { id: "u1", role: "user", text: "Look it up", timestamp: at(1) },
      { id: "r1", role: "assistant", text: "Checking.", toolsUsed: [{ id: "t1", name: "listTasks", status: "done" }], timestamp: at(2) },
      { id: "r2", role: "assistant", text: "Found it.", timestamp: at(3) },
    ];
    expect(coalesce(rounds).map((row) => [row.id, row.text])).toEqual([["u1", "Look it up"], ["r2", "Found it."]]);
    expect(source).toContain("return coalesce ? coalesceTranscriptReplies(persistedRows) : persistedRows;");
  });

  it("M5Q-8: a Stop this tab asked for reads as the viewer's, whatever name the server attached", async () => {
    const { follow, state } = await reattached();
    follow.send("status", { status: "running", turnId: TURN_A });
    follow.send("turn_completed", { turnId: TURN_A, reason: "stopped_by_user", stoppedByName: "M5 Owner", senderUserId: SCOPE.viewerId });
    await settle();
    const mapper = evaluate<(notice: ConversationNotice, copy: typeof pageCopy, context: object) => { text: string } | null>(
      declaration("pageNoticeCopy").initializer!.getText(tree), { format: (template: string, vars: Record<string, string>) => template.replace("{name}", vars.name ?? "") },
    );
    const notice = state().notices.find((item) => item.code === "turnEnd")!;
    expect(mapper(notice, pageCopy, { viewerId: SCOPE.viewerId, ownsDirectRun: false, stoppedByViewer: true })?.text).toBe(en.chatApp.turnStoppedByYou);
    expect(mapper(notice, pageCopy, { viewerId: SCOPE.viewerId, ownsDirectRun: false, stoppedByViewer: false })?.text).toBe("M5 Owner stopped this turn.");
    expect(source).toContain("stoppedByViewer: !!controller && stopRequestedHere === controller,");
  });

  it("M5Q-9: a Stop failure line is dismissed once the turn has ended", () => {
    const effect = (find(node => ts.isCallExpression(node) && node.expression.getText(tree) === "useEffect"
      && !!node.arguments[0]?.getText(tree).includes('dismissNotice("stopTurnFailed")')) as ts.CallExpression).arguments[0].getText(tree);
    const controller = { dismissNotice: vi.fn() };
    const run = (runLive: boolean, remoteActive: boolean, isStreaming: boolean) => evaluate<() => void>(effect, {
      controller, stopFailureShown: true, runLive, remoteActive, transcript: { isStreaming },
    })();
    run(true, false, true);
    run(true, true, false);
    expect(controller.dismissNotice).not.toHaveBeenCalled();
    run(false, false, false);
    expect(controller.dismissNotice).toHaveBeenCalledExactlyOnceWith("stopTurnFailed");
  });
});

describe("[COMP:app-web/chat-surface] M5Q-4: no generic banner for an outage the conversation is recovering", () => {
  function failingLoad(pending: boolean, error = new Error("Failed to fetch")) {
    const scope = {
      ...base(), fetchChatTranscript: vi.fn().mockRejectedValue(error), mapTranscriptRows: (rows: unknown) => rows,
      writeTranscriptCache: vi.fn(), evictTranscriptCache: vi.fn(), chat: { loadMessages: vi.fn() }, setError: vi.fn(),
      t: { errorGeneric: "Something went wrong. Try again.", historyUnavailable: "History unavailable" },
    };
    scope.reattachPendingRef.current = pending;
    return scope;
  }

  it("a history read failing while the conversation re-attaches shows only the reconnecting line", async () => {
    const pending = failingLoad(true);
    await evaluate(callback("loadTranscript"), pending)("A");
    expect(pending.setError).not.toHaveBeenCalled();
    expect(pending.transientErrorRef.current).toBe(false);
    const idle = failingLoad(false);
    await evaluate(callback("loadTranscript"), idle)("A");
    expect(idle.setError).toHaveBeenCalledWith("Something went wrong. Try again.");
    expect(idle.transientErrorRef.current).toBe(true);
    // Real access denial is never hidden behind a re-attach.
    const denied = failingLoad(true, new Error("chat_history_failed: 403"));
    await evaluate(callback("loadTranscript"), denied)("A");
    expect(denied.setError).toHaveBeenCalledWith("History unavailable");
  });

  it("a successful re-attach clears the page's own transient banner, and only that", () => {
    const effect = (find(node => ts.isCallExpression(node) && node.expression.getText(tree) === "useEffect"
      && !!node.arguments[0]?.getText(tree).includes("seenReattachRef.current")) as ts.CallExpression).arguments[0].getText(tree);
    const controller = {};
    let banner: string | null = "Something went wrong. Try again.";
    const setError = vi.fn((update: (current: string | null) => string | null) => { banner = update(banner); });
    const scope = { controller, seenReattachRef: { current: { controller, epoch: 0 } }, transientErrorRef: { current: true }, setError, t: { errorGeneric: "Something went wrong. Try again." }, reattachEpoch: 0 };
    evaluate<() => void>(effect, scope)(); // same epoch: nothing
    expect(setError).not.toHaveBeenCalled();
    evaluate<() => void>(effect, { ...scope, reattachEpoch: 1 })();
    expect(banner).toBeNull();
    // A different error line (not this page's transient one) is left alone.
    banner = "History unavailable";
    scope.transientErrorRef.current = true;
    evaluate<() => void>(effect, { ...scope, reattachEpoch: 2 })();
    expect(banner).toBe("History unavailable");
  });

  it("the conversation bumps reattachEpoch when a dropped turn re-attaches", async () => {
    const t = pageConversation({ sessionId: "s-A" });
    await settle();
    const sent = t.controller.send({ presentationId: "page", text: "Long" });
    await settle();
    const turn = t.net.lastChat().sse;
    turn.send("session", { sessionId: "s-A", turnId: TURN_A });
    turn.send("user_message_saved", { id: "row-user" });
    await settle();
    const before = t.state().reattachEpoch;
    turn.fail(); // the body errors after acceptance: reconciled, never resent
    await sent;
    await settle();
    t.net.lastFollow().sse?.send("status", { status: "running", turnId: TURN_A });
    await settle();
    expect(t.state().reattachEpoch).toBeGreaterThan(before);
    expect(t.state().notices.some((notice) => notice.code === "error")).toBe(false);
    expect(t.net.chats).toHaveLength(1);
  });
});

describe("[COMP:app-web/chat-surface] M5D-2: history after a confirmed Stop", () => {
  it("replays Stop 200, stream abort, GET messages 500 then 200: no banner, the stopped line, the saved partial", async () => {
    const t = pageConversation({ sessionId: "s-A" });
    await settle();
    const sent = t.controller.send({ presentationId: "page", text: "Write the long list" });
    await settle();
    const turn = t.net.lastChat().sse;
    turn.send("session", { sessionId: "s-A", turnId: TURN_A });
    turn.send("user_message_saved", { id: "row-user" });
    turn.send("text_delta", { text: "w1 w2 w3" });
    await settle();
    t.clock.runFrames();
    t.net.transport.stopTurn.mockResolvedValue({ stopped: true }); // Stop 200
    expect(await t.controller.stop()).toBe("stopped");
    expect(await sent).toBe("stopped");
    expect(turn.aborted()).toBe(true); // stream abort, only after the confirmation
    const epochAfterStop = t.state().historyEpoch;
    expect(epochAfterStop).toBeGreaterThan(0);

    // The page's own history read, as its historyEpoch effect runs it.
    const saved = [{ id: "row-user", role: "user", text: "Write the long list" }, { id: "row-partial", role: "assistant", text: "w1 w2 w3" }];
    const fetchChatTranscript = vi.fn()
      .mockRejectedValueOnce(new Error("chat_history_failed: 500")) // GET messages 500
      .mockResolvedValueOnce(saved); // GET messages 200
    const scope = {
      ...base(), sessionIdRef: { current: "s-A" }, fetchChatTranscript, mapTranscriptRows: (rows: unknown) => rows,
      writeTranscriptCache: vi.fn(), evictTranscriptCache: vi.fn(), setError: vi.fn(),
      chat: { loadMessages: (rows: never[]) => t.controller.loadMessages(rows) },
      stream: { inFlight: () => t.state().transcript.isStreaming },
      controllerRef: { current: t.controller },
      stoppedTurnRef: { current: t.state().notices.some((notice) => notice.code === "turnEnd" && notice.reason === "stopped_by_user") },
      t: { errorGeneric: "Something went wrong. Try again.", historyUnavailable: "History unavailable" },
    };
    expect(scope.stoppedTurnRef.current).toBe(true);
    const load = evaluate(callback("loadTranscript"), scope);
    await load("s-A");
    // No generic banner; the stopped line and the painted partial stay.
    expect(scope.setError).not.toHaveBeenCalled();
    expect(pageNotice(t.state().notices)).toEqual([{ slot: "turnEnd", text: en.chatApp.turnStoppedByYou }]);
    expect(t.state().transcript.messages.map((message) => message.text)).toEqual(["Write the long list", "w1 w2 w3"]);
    // The conversation retries the page's read with its backoff as a bump.
    expect(t.state().historyEpoch).toBe(epochAfterStop);
    await t.clock.advance(3_000);
    expect(t.state().historyEpoch).toBe(epochAfterStop + 1);
    await load("s-A");
    expect(t.state().transcript.messages.map((message) => message.id)).toEqual(["row-user", "row-partial"]);
    expect(scope.setError).not.toHaveBeenCalled();
  });

  it("outside a Stop a transient read failure still raises the page banner", async () => {
    const reportHistoryFailure = vi.fn();
    const scope = {
      ...base(), fetchChatTranscript: vi.fn().mockRejectedValue(new Error("chat_history_failed: 500")), mapTranscriptRows: (rows: unknown) => rows,
      writeTranscriptCache: vi.fn(), evictTranscriptCache: vi.fn(), chat: { loadMessages: vi.fn() }, setError: vi.fn(),
      controllerRef: { current: { reportHistoryFailure } },
      t: { errorGeneric: "Something went wrong. Try again.", historyUnavailable: "History unavailable" },
    };
    await evaluate(callback("loadTranscript"), scope)("A");
    expect(scope.setError).toHaveBeenCalledWith("Something went wrong. Try again.");
    expect(reportHistoryFailure).not.toHaveBeenCalled();
  });
});

describe("[COMP:app-web/chat-surface] assistant_clearance_below_conversation", () => {
  it.each(["assistant_clearance_below_conversation", "assistant_clearance_exceeds_room"])(
    "a mention refused before the message is saved (%s) removes the bubble and hands the text back", async (code) => {
      const t = pageConversation({ sessionId: "room-1", room: true });
      await settle();
      const onRejected = vi.fn();
      const onAccepted = vi.fn();
      const sent = t.controller.send({ presentationId: "page", text: "@Avery Helper read this", assistantId: "assistant-avery", onRejected, onAccepted });
      await settle();
      expect(t.state().transcript.messages.map((message) => message.text)).toEqual(["@Avery Helper read this"]);
      const turn = t.net.lastChat().sse;
      // The server refuses before any `session` or `user_message_saved` frame.
      turn.send("error", { code, error: "Avery Helper is not cleared to read this room, so it cannot answer here." });
      turn.send("done", {});
      turn.close();
      expect(await sent).toBe("failed");
      expect(t.state().transcript.messages).toEqual([]);
      expect(t.state().transcript.isStreaming).toBe(false);
      expect(onRejected).toHaveBeenCalledOnce();
      expect(onAccepted).not.toHaveBeenCalled();
      expect(t.state().notices).toEqual([expect.objectContaining({ code: "error", errorCode: code })]);
      if (code === "assistant_clearance_below_conversation") {
        const mapper = evaluate<(notice: ConversationNotice, copy: typeof pageCopy, context: object) => { text: string } | null>(
          declaration("pageNoticeCopy").initializer!.getText(tree), { format: (template: string, vars: Record<string, string>) => template.replace("{name}", vars.name ?? "") },
        );
        expect(mapper(t.state().notices[0]!, pageCopy, { viewerId: SCOPE.viewerId, ownsDirectRun: false, clearanceNames: { rejected: "Avery Helper", skipped: null }, conversation: "room" })?.text)
          .toBe("Avery Helper is not cleared to read this room, so it cannot answer here. Remove the mention, or ask a workspace admin to raise its clearance.");
      }
    });

  it("the page's rejection hands back text and quote that acceptance had cleared, and undoes recency", () => {
    const rejected = (find(node => ts.isPropertyAssignment(node) && node.name.getText(tree) === "onRejected") as ts.PropertyAssignment).initializer.getText(tree);
    let draft = "";
    let quote: unknown = null;
    const scope = {
      sending: { rollbackRecency: vi.fn() }, trimmed: "@Avery Helper read this", reply: { text: "Quoted" },
      clearDraft: (update: (current: string) => string) => { draft = update(draft); },
      setReplyTo: (update: (current: unknown) => unknown) => { quote = update(quote); },
    };
    evaluate<() => void>(rejected, scope)();
    expect(draft).toBe("@Avery Helper read this");
    expect(quote).toEqual({ text: "Quoted" });
    expect(scope.sending.rollbackRecency).toHaveBeenCalledOnce();
    // Text typed since is never overwritten.
    draft = "Something newer";
    evaluate<() => void>(rejected, scope)();
    expect(draft).toBe("Something newer");
  });

  it("the observer records who a refusal or a skip is about", () => {
    const { scope, frame } = frameObserver({
      assistants: [{ id: "assistant-avery", name: "Avery Helper" }, { id: "assistant-blair", name: "Blair Helper" }],
      clearanceNamesRef: { current: { rejected: null, skipped: null } },
    });
    sending(scope, { assistantId: "assistant-avery" });
    frame("direct", "error", { code: "assistant_clearance_below_conversation", error: "server text" });
    frame("direct", "notice", { code: "assistant_clearance_below_conversation", assistantId: "assistant-blair" });
    expect(scope.clearanceNamesRef.current).toEqual({ rejected: "Avery Helper", skipped: "Blair Helper" });
    frame("direct", "notice", { code: "assistant_clearance_below_conversation", assistantName: "Casey Helper", assistantId: "unknown" });
    expect(scope.clearanceNamesRef.current.skipped).toBe("Casey Helper");
  });
});

describe("[COMP:app-web/chat-surface] M5Q-18: a teammate's restored room approval card", () => {
  it("shows confirmNotAllowed without buttons after a 403, and clears when the owner's approval arrives", async () => {
    const t = pageConversation({ sessionId: "room-1", room: true });
    await settle();
    // The teammate joined after the card was raised: only GET /pending restores it.
    t.net.pending.current = {
      pending: null,
      toolConfirmation: { toolCallId: "approval:appr-1", approvalId: "appr-1", restored: true, toolName: "archiveTasks", input: {}, sessionId: "room-1", status: "pending" },
    };
    await t.controller.refreshPendingInput();
    const card = t.state().transcript.pendingConfirmations[0]!;
    expect(card).toMatchObject({ toolCallId: "approval:appr-1", restored: true, status: "pending" });
    // The restored path answers 403 for a member who is not the approver.
    t.net.transport.respondRestored.mockResolvedValueOnce({ ok: false, status: 403 });
    const refused: string[] = [];
    const scope = {
      controllerRef: { current: t.controller }, workspaceId: "w", requestApprovalsRefresh: vi.fn(),
      setRefusedConfirmations: (update: (current: ReadonlySet<string>) => ReadonlySet<string>) => { refused.splice(0, refused.length, ...update(new Set(refused))); },
    };
    await evaluate(callback("resolveConfirmation"), scope)(card.toolCallId, "approve");
    expect(t.net.transport.respondRestored).toHaveBeenCalledWith("appr-1", "approved", undefined);
    expect(refused).toEqual(["approval:appr-1"]);
    expect(pageNotice(t.state().notices)).toEqual([{ slot: "error", text: en.chatApp.confirmNotAllowed }]);
    expect(scope.requestApprovalsRefresh).not.toHaveBeenCalled();
    // Rendered for this viewer: the not-allowed copy and no Approve/Deny.
    const cards = find(node => ts.isCallExpression(node) && node.getText(tree).startsWith("chat.state.pendingConfirmations\n")
      && node.getText(tree).includes("<ChatConfirmationCard")).getText(tree);
    const { ChatConfirmationCard } = await import("@/components/chrome/chat-confirmation-card");
    const html = renderToString(React.createElement(I18nProvider, { locale: "en", dict: en, children: evaluate<React.ReactNode>(cards, {
      React, ChatConfirmationCard, chat: { state: t.state().transcript }, refusedConfirmations: new Set(refused),
      t: en.chatApp, tChat: en.chat, resolveConfirmation: vi.fn(),
    }) }));
    expect(html).toContain("data-confirm-not-allowed");
    expect(html).toContain(en.chatApp.confirmNotAllowed.replaceAll("'", "&#x27;"));
    expect(html).not.toContain(`>${en.chat.confirmationApprove}<`);
    expect(html).not.toContain(`>${en.chat.confirmationDeny}<`);
    // The owner approves the live card: the room's follow stream carries its
    // resolution with the live toolCallId, which settles the placeholder.
    const follow = t.net.lastFollow().sse!;
    follow.send("status", { status: "running", turnId: TURN_A });
    follow.send("activity", { event: "tool_confirmation_resolved", toolCallId: "call-live-1", decision: "allow", turnId: TURN_A });
    await settle();
    expect(t.state().transcript.pendingConfirmations.filter((item) => item.status === "pending" || item.status === "approving")).toEqual([]);
  });
});
