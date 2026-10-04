import { readFileSync } from "node:fs";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * [COMP:app-web/chat-sessions-cache] Execute the actual surface callbacks with
 * controlled refs/transports. This deliberately avoids mounting the 4,000-line
 * editor and its unrelated providers. AST extraction keeps these behavioral
 * tests tied to production code (not a reimplementation of the guards).
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
function handler(name: string) {
  return (find((node) => ts.isPropertyAssignment(node) && node.name.getText(tree) === name) as ts.PropertyAssignment).initializer.getText(tree);
}
function evaluate<T = (...args: any[]) => any>(expression: string, scope: Record<string, unknown>): T {
  const code = ts.transpileModule(`return (${expression});`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
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
  const chatController = {
    capture: vi.fn(() => ({ sessionId: sessionIdRef.current, generation: sessionEpochRef.current })),
    isCurrent: vi.fn(() => true),
    adoptSession: vi.fn(() => true),
    presentInteraction: vi.fn(() => true),
    beginResponse: vi.fn(() => true),
    responseFailed: vi.fn(() => true),
    resolveInteraction: vi.fn(() => true),
    suspend: vi.fn(() => true),
    disconnect: vi.fn(() => true),
    reconnect: vi.fn(() => true),
    connected: vi.fn(() => true),
    complete: vi.fn(() => true),
    cancel: vi.fn(() => true),
    fail: vi.fn(() => true),
    claimExit: vi.fn(() => true),
    registerCleanup: vi.fn(() => vi.fn()),
  };
  return {
    sessionIdRef, sessionEpochRef, chatController,
    switchTo(id: string | null) { sessionEpochRef.current++; sessionIdRef.current = id; },
  };
}
afterEach(() => vi.useRealTimers());

describe("[COMP:app-web/chat-sessions-cache] surface async ownership", () => {
  it.each([false, true])("drops late transcript responses after a switch (round trip: %s), including cache writes", async (roundTrip) => {
    const scope = {
      ...base(), transcriptRequestRef: { current: 0 },
      fetchSessionMessages: vi.fn(), mapTranscriptRows: (rows: unknown) => rows,
      writeTranscriptCache: vi.fn(), chat: { loadMessages: vi.fn() },
    };
    const response = deferred<string[]>();
    scope.fetchSessionMessages.mockReturnValue(response.promise);
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
      fetchSessionMessages: vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise),
      mapTranscriptRows: (rows: unknown) => rows,
      writeTranscriptCache: vi.fn(), chat: { loadMessages: vi.fn() },
    };
    const load = evaluate(callback("loadTranscript"), scope);
    const first = load("A");
    const second = load("A", { force: true });
    fresh.resolve(["new turn"]);
    await second;
    old.resolve(["before turn"]);
    await first;
    expect(scope.chat.loadMessages.mock.calls).toEqual([[["new turn"]]]);
    expect(scope.writeTranscriptCache.mock.calls).toEqual([["A", ["new turn"]]]);
  });

  it.each([false, true])("ignores pending-question AND confirmation restores from an old visit (round trip: %s)", async (roundTrip) => {
    const response = deferred<unknown>();
    const scope = {
      ...base(), pendingInputRequestRef: { current: 0 },
      fetchPendingSessionInput: vi.fn().mockReturnValue(response.promise),
      setPendingQuestion: vi.fn(), chat: { addConfirmation: vi.fn() },
      toRestoredConfirmation: vi.fn(),
    };
    evaluate(callback("refreshPendingInput"), scope)("A");
    scope.switchTo("B");
    if (roundTrip) scope.switchTo("A");
    response.resolve({ pending: { approvalId: "old" }, toolConfirmation: { id: "old" } });
    await response.promise;
    expect(scope.setPendingQuestion).not.toHaveBeenCalled();
    expect(scope.chat.addConfirmation).not.toHaveBeenCalled();
  });

  it("a late empty pending-input response cannot clear a newer pending question", async () => {
    const old = deferred<unknown>();
    const fresh = deferred<unknown>();
    const scope = {
      ...base(), pendingInputRequestRef: { current: 0 },
      fetchPendingSessionInput: vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise),
      setPendingQuestion: vi.fn(), chat: { addConfirmation: vi.fn() },
      toRestoredConfirmation: vi.fn((confirmation, sessionId) => ({ confirmation, sessionId })),
    };
    const refresh = evaluate(callback("refreshPendingInput"), scope);
    refresh("A"); refresh("A");
    fresh.resolve({ pending: { approvalId: "new", question: "Continue?" }, toolConfirmation: { id: "new" } });
    await fresh.promise;
    old.resolve({ pending: null, toolConfirmation: null });
    await old.promise;
    expect(scope.setPendingQuestion).toHaveBeenCalledTimes(1);
    expect(scope.setPendingQuestion).toHaveBeenCalledWith(expect.objectContaining({ approvalId: "new", sessionId: "A" }));
    expect(scope.chat.addConfirmation).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("switching during a deferred flush preserves the old queue (round trip: %s)", (roundTrip) => {
    vi.useFakeTimers();
    const entries = [{ sessionId: "A", text: "waiting" }];
    const scope = {
      ...base(),
      midTurn: { drain: vi.fn(() => entries.splice(0)) },
      sendRef: { current: vi.fn() }, joinQueuedInputs: (items: typeof entries) => items.map((item) => item.text).join("\n\n"),
    };
    const flush = evaluate(callback("flushQueuedInputs"), scope);
    flush("A");
    expect(scope.midTurn.drain).not.toHaveBeenCalled();
    scope.switchTo("B");
    if (roundTrip) scope.switchTo("A");
    vi.runAllTimers();
    expect(scope.midTurn.drain).not.toHaveBeenCalled();
    expect(scope.sendRef.current).not.toHaveBeenCalled();
    expect(entries).toHaveLength(1);
    if (!roundTrip) scope.switchTo("A");
    flush("A");
    vi.runAllTimers();
    expect(scope.midTurn.drain).toHaveBeenCalledWith("A");
    expect(scope.sendRef.current).toHaveBeenCalledWith("waiting");
  });

  it("takes queued input using the originating stream owner", () => {
    const midTurn = { take: vi.fn().mockReturnValue(null) };
    evaluate(callback("applyQueuedInput"), { midTurn })("input-1", "message-1", "A");
    expect(midTurn.take).toHaveBeenCalledWith("input-1", "A");
  });
});

function directStream(initialSession: string | null = "A") {
  const owner = base();
  owner.sessionIdRef.current = initialSession;
  const scope = {
    ...owner, coercePayload: (data: unknown) => data,
    hydratedRef: { current: initialSession }, directTurnSessionRef: { current: initialSession },
    sessionAssistantRef: { current: new Map() }, target: { id: "assistant" },
    chat: { setSession: vi.fn(), dispatch: vi.fn() }, selectSession: vi.fn(),
    dispatchChatSessionsRefresh: vi.fn(), dispatchChatSessionActivity: vi.fn(), workspaceId: "workspace",
    midTurn: { take: vi.fn() }, applyQueuedInput: vi.fn(), buildStreamedTurnMessage: vi.fn().mockReturnValue(null),
    turnTextRef: { current: "text" }, resetTurnActivity: vi.fn(),
    flushQueuedInputs: vi.fn(), setQueuedNotice: vi.fn(),
    askedQuestionRef: { current: true }, refreshPendingInput: vi.fn(),
    isRoom: true, markRoomSeen: vi.fn(), reloadShared: vi.fn(),
    setError: vi.fn(), t: { errorGeneric: "error" },
  };
  // Keep the same mutable owner closure across the session event and terminal
  // callbacks, just as send() does for a newly minted personal session.
  const handlers = evaluate<Record<string, (...args: any[]) => any>>(`(() => {
    const sendEpoch = sessionEpochRef.current;
    let owningSessionId = sessionIdRef.current;
    const controllerRun = chatController.capture();
    const ownsSend = ${declaration("ownsSend").initializer!.getText(tree)};
    let turnFailed = false;
    let turnDisconnected = false;
    return {
      onEvent: ${handler("onEvent")}, onDone: ${handler("onDone")},
      onError: ${handler("onError")}, onDisconnect: ${handler("onDisconnect")}
    };
  })()`, scope);
  return { scope, handlers };
}

describe("[COMP:app-web/chat-sessions-cache] stream completion ownership", () => {
  it.each(["onDone", "onError", "onDisconnect"])("%s cannot mutate a different session or a new visit to the same session", (name) => {
    const { scope, handlers } = directStream();
    scope.switchTo("B");
    handlers[name]();
    scope.switchTo("A");
    handlers[name]();
    expect(scope.chat.dispatch).not.toHaveBeenCalled();
    expect(scope.flushQueuedInputs).not.toHaveBeenCalled();
    expect(scope.setError).not.toHaveBeenCalled();
    expect(scope.resetTurnActivity).not.toHaveBeenCalled();
    expect(scope.refreshPendingInput).not.toHaveBeenCalled();
  });

  it.each(["onDone", "onError"])("%s flushes the newly minted session, not the null initial owner", (name) => {
    const { scope, handlers } = directStream(null);
    handlers.onEvent({ event: "session", data: { sessionId: "minted" } });
    handlers.onEvent({ event: "input_applied", data: { inputId: "input", messageId: "message" } });
    handlers[name]();
    expect(scope.sessionIdRef.current).toBe("minted");
    expect(scope.applyQueuedInput).toHaveBeenCalledWith("input", "message", "minted");
    expect(scope.flushQueuedInputs).toHaveBeenCalledWith("minted");
    if (name === "onDone") {
      expect(scope.refreshPendingInput).toHaveBeenCalledWith("minted");
      expect(scope.markRoomSeen).toHaveBeenCalledWith("workspace", "minted");
    }
  });

  it("acknowledges old-stream input_applied without painting into a new visit", () => {
    const { scope, handlers } = directStream();
    scope.switchTo("B");
    scope.switchTo("A");
    handlers.onEvent({ event: "input_applied", data: { inputId: "old", messageId: "stored" } });
    expect(scope.midTurn.take).toHaveBeenCalledWith("old", "A");
    expect(scope.applyQueuedInput).not.toHaveBeenCalled();
  });

  it("a late session event cannot adopt the old turn into the newly selected chat", () => {
    const { scope, handlers } = directStream(null);
    scope.switchTo("B");
    handlers.onEvent({ event: "session", data: { sessionId: "minted" } });
    expect(scope.sessionIdRef.current).toBe("B");
    expect(scope.selectSession).not.toHaveBeenCalled();
  });

  it.each([false, true])("Stop's delayed rejection/finally cannot touch another visit (round trip: %s)", async (roundTrip) => {
    const response = deferred<void>();
    const scope = {
      ...base(), responseGroupAbortRef: { current: false }, directTurnSessionRef: { current: "A" },
      stream: { abort: vi.fn() }, chat: { dispatch: vi.fn() }, turnTextRef: { current: "" },
      resetTurnActivity: vi.fn(), stopTurn: vi.fn().mockReturnValue(response.promise),
      flushQueuedInputs: vi.fn(), setError: vi.fn(), t: { stopTurnFailed: "stop failed" },
    };
    evaluate(callback("handleAbort"), scope)();
    expect(scope.stopTurn).toHaveBeenCalledWith("A");
    scope.switchTo("B");
    if (roundTrip) scope.switchTo("A");
    response.reject(new Error("late failure"));
    await response.promise.catch(() => {});
    await Promise.resolve();
    expect(scope.setError).not.toHaveBeenCalled();
    expect(scope.flushQueuedInputs).not.toHaveBeenCalled();
  });
});


describe("[COMP:app-web/chat-sessions-cache] follow-stream ownership", () => {
  it("follow done flushes only its captured session and cannot reset a new visit", () => {
    const scope = {
      ...base(), sessionId: "A", cancelled: false, epoch: 1,
      shouldAcceptRoomMirror: vi.fn().mockReturnValue(true), meId: "viewer",
      directTurnSessionRef: { current: null }, stream: { inFlight: () => false },
      isSharedOpen: false, setReconnectSessionId: vi.fn(), setReconnectNotice: vi.fn(),
      resetRemoteTurn: vi.fn(), setRemoteConfirmation: vi.fn(), chat: { dispatch: vi.fn() },
      loadTranscript: vi.fn(), dispatchChatSessionsRefresh: vi.fn(), workspaceId: "workspace",
      refreshPendingInput: vi.fn(), setQueuedNotice: vi.fn(), flushQueuedInputs: vi.fn(),
    };
    const onEvent = evaluate(`(() => {
      const ownsFollow = ${declaration("ownsFollow").initializer!.getText(tree)};
      const reconnectWanted = true;
      const controllerRun = chatController.capture();
      let sawDone = false;
      let sawRunning = true;
      let sawTurnCompleted = false;
      return ${declaration("handleRoomEvent").initializer!.getText(tree)};
    })()`, scope);
    onEvent("done", {});
    expect(scope.flushQueuedInputs).toHaveBeenCalledWith("A");
    expect(scope.refreshPendingInput).toHaveBeenCalledWith("A");
    vi.clearAllMocks();
    scope.switchTo("B");
    onEvent("done", {});
    scope.switchTo("A");
    onEvent("done", {});
    expect(scope.flushQueuedInputs).not.toHaveBeenCalled();
    expect(scope.resetRemoteTurn).not.toHaveBeenCalled();
    expect(scope.chat.dispatch).not.toHaveBeenCalled();
  });

  it("a rejected late follow open cannot clear reconnect state, show errors, or schedule a reopen", async () => {
    vi.useFakeTimers();
    const response = deferred<unknown>();
    const scope = {
      ...base(), activeSessionId: "A", reconnectSessionId: "A", isSharedOpen: false,
      shouldOpenSessionStream: () => true, reconnectNotice: true,
      setRoomTypers: vi.fn(), refreshPendingInput: vi.fn(), API_URL: "http://test",
      authFetch: vi.fn().mockReturnValue(response.promise),
      setReconnectSessionId: vi.fn(), setReconnectNotice: vi.fn(), setError: vi.fn(),
      t: { errorGeneric: "error" }, shouldReopenSessionStream: vi.fn().mockReturnValue(true),
      setSubscribeEpoch: vi.fn(),
    };
    const effect = find((node) => ts.isCallExpression(node) && node.expression.getText(tree) === "useEffect" &&
      !!node.arguments[0]?.getText(tree).includes("const handleRoomEvent")) as ts.CallExpression;
    const cleanup = evaluate(effect.arguments[0].getText(tree), scope)();
    scope.switchTo("B");
    scope.switchTo("A");
    response.resolve({ ok: false, body: null });
    await response.promise;
    await Promise.resolve();
    vi.runAllTimers();
    expect(scope.setReconnectSessionId).not.toHaveBeenCalled();
    expect(scope.setReconnectNotice).not.toHaveBeenCalled();
    expect(scope.setError).not.toHaveBeenCalled();
    expect(scope.setSubscribeEpoch).not.toHaveBeenCalled();
    cleanup();
  });
});


describe("main chat live interaction ownership", () => {
  it("appends two canonical job pairs without replacing the typed stream or accepting another session", async () => {
    const { canonicalInteractionAdditions } = await import("@/lib/live-interaction/canonical");
    const { chatReducer, initialChatState } = await import("../../../../../../packages/chat-ui/src/chat-reducer");
    const attribute = find((node) => ts.isJsxAttribute(node) && node.name.getText(tree) === "onCanonical") as ts.JsxAttribute;
    const expression = (attribute.initializer as ts.JsxExpression).expression!;
    const message = (id: string, role: "user" | "assistant") => ({ id, role, text: id, timestamp: new Date() });
    let state = { ...initialChatState, messages: [message("typed", "user")], isStreaming: true, streamingText: "typed partial answer" };
    const chat = { get state() { return state; }, dispatch: vi.fn((action) => { state = chatReducer(state, action); }) };
    const mapTranscriptRows = vi.fn((rows) => rows);
    const onCanonical = evaluate(expression.getText(tree), { chat, sessionIdRef: { current: "main" }, mapTranscriptRows, canonicalInteractionAdditions });
    const rows = [message("q1", "user"), message("q2", "user"), message("a2", "assistant"), message("a1", "assistant")];
    const ids = new Set(["q1", "a1", "q2", "a2"]);
    onCanonical("other", rows, ids);
    expect(chat.dispatch).not.toHaveBeenCalled();
    onCanonical("main", rows, ids);
    expect(state.messages.map((m) => m.id)).toEqual(["typed", "q1", "a1", "q2", "a2"]);
    expect(state.streamingText).toBe("typed partial answer"); expect(state.isStreaming).toBe(true);
    expect(mapTranscriptRows).toHaveBeenCalledWith(rows, false); // no cross-job assistant coalescing
    onCanonical("main", rows, ids);
    expect(chat.dispatch).toHaveBeenCalledTimes(4);
  });
});
