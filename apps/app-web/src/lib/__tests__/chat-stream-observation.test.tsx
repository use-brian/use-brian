// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { TextDecoder } from "node:util";
import { resolve } from "node:path";
import ts from "typescript";
import React, { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createChatStreamObserver, needsChatActivityPoll, readObservedChatSessions, useObservedChatSessions } from "../chat-stream-observation";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const owners: ReturnType<typeof createChatStreamObserver>[] = [];
const observe = (workspace = "fictional-workspace") => {
  const owner = createChatStreamObserver(workspace);
  owners.push(owner);
  return owner;
};
const rows = [{ id: "chat-a", status: "running" }];
const polling = (activity: Record<string, { working: boolean }> = {}) =>
  needsChatActivityPoll(rows, activity, readObservedChatSessions("fictional-workspace"));
let root: Root | undefined;
let container: HTMLDivElement | undefined;
afterEach(async () => {
  await act(async () => { root?.unmount(); owners.splice(0).forEach(owner => owner.release()); });
  container?.remove(); root = undefined; container = undefined;
  vi.useRealTimers();
});

// Execute the production lifecycle closures, not a parallel implementation of
// their ownership gates. The full surface also mounts unrelated document tools.
const source = readFileSync(resolve(process.cwd(), "src/components/chat-app/chat-surface.tsx"), "utf8");
const tree = ts.createSourceFile("chat-surface.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function find(predicate: (node: ts.Node) => boolean): ts.Node {
  let result: ts.Node | undefined;
  function visit(node: ts.Node) { if (!result && predicate(node)) result = node; if (!result) ts.forEachChild(node, visit); }
  visit(tree);
  if (!result) throw new Error("Production stream lifecycle not found");
  return result;
}
function evaluate<T = (...args: any[]) => any>(expression: string, scope: Record<string, unknown>): T {
  scope = { localSend: { release: vi.fn(), complete: vi.fn() }, inputSaved: true, ...scope };
  const code = ts.transpileModule(`return (${expression});`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  return new Function(...Object.keys(scope), code)(...Object.values(scope)) as T;
}
function directHandler(name: string) {
  return (find(node => ts.isPropertyAssignment(node) && node.name.getText(tree) === name && node.getText(tree).includes("directObserver")) as ts.PropertyAssignment).initializer.getText(tree);
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
const followExpression = () => find(node => ts.isArrowFunction(node) && !!node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword)
  && node.getText(tree).includes("followObserver.observe(sessionId)")).getText(tree);

describe("[COMP:app-web/chat-stream-observation] activity polling ownership", () => {
  it("keeps polling after selection or request creation until a stream observes the exact chat", () => {
    const owner = observe();
    expect(polling()).toBe(true);
    owner.observe("chat-a");
    expect(polling()).toBe(false);
    expect(needsChatActivityPoll(rows, {}, readObservedChatSessions("other-workspace"))).toBe(true);
  });

  it("keeps the backstop for an unobserved background row or optimistic turn", () => {
    observe().observe("chat-a");
    const known = readObservedChatSessions("fictional-workspace");
    expect(needsChatActivityPoll([...rows, { id: "chat-b", status: "running" }], {}, known)).toBe(true);
    expect(needsChatActivityPoll(rows, { "new-chat": { working: true } }, known)).toBe(true);
    expect(needsChatActivityPoll(rows, { "chat-a": { working: true } }, known)).toBe(false);
  });

  it("releases only its own direct or follow token, including repeated stale cleanup", () => {
    const direct = observe(), follow = observe();
    direct.observe("chat-a"); follow.observe("chat-a");
    direct.release(); direct.release();
    expect(polling()).toBe(false);
    follow.release();
    expect(polling()).toBe(true);
  });

  it("cannot reopen a terminal observer on a late session or metadata event", () => {
    const old = observe(); old.observe("chat-a"); old.release();
    old.observe("chat-a"); old.observe("chat-b");
    expect([...readObservedChatSessions("fictional-workspace")]).toEqual([]);
    const successor = observe(); successor.observe("chat-a");
    old.release();
    expect(polling()).toBe(false);
  });

  it("moves an adopted identity without removing another stream's previous identity", () => {
    const moving = observe(), other = observe();
    moving.observe("chat-a"); other.observe("chat-a"); moving.observe("chat-b");
    expect([...readObservedChatSessions("fictional-workspace")].sort()).toEqual(["chat-a", "chat-b"]);
    other.release();
    expect([...readObservedChatSessions("fictional-workspace")]).toEqual(["chat-b"]);
  });

  it("does not resume polling during post-reply metadata after terminal activity settles", () => {
    const direct = observe(); direct.observe("chat-a");
    direct.release();
    expect(polling({ "chat-a": { working: false } })).toBe(false);
    direct.observe("chat-a");
    expect(polling({ "chat-a": { working: false } })).toBe(false);
    expect(readObservedChatSessions("fictional-workspace").size).toBe(0);
  });

  it("hydrates existing observations and reacts to release and workspace navigation", async () => {
    const first = observe(), second = observe("second-workspace");
    first.observe("chat-a"); second.observe("chat-b");
    function Probe({ workspace }: { workspace: string }) { return <output>{[...useObservedChatSessions(workspace)].join(",")}</output>; }
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    await act(async () => root!.render(<Probe workspace="fictional-workspace" />));
    expect(container.textContent).toBe("chat-a");
    await act(async () => root!.render(<Probe workspace="second-workspace" />));
    expect(container.textContent).toBe("chat-b");
    await act(async () => first.release());
    expect(container.textContent).toBe("chat-b");
    await act(async () => second.release());
    expect(container.textContent).toBe("");
  });

  it("the actual sidebar timer stops for observed work and resumes for disconnect or other work", async () => {
    vi.useFakeTimers();
    const sidebarSource = readFileSync(resolve(process.cwd(), "src/components/doc/sidebar-panels/chat-sidebar-panel.tsx"), "utf8");
    const sidebarTree = ts.createSourceFile("sidebar.tsx", sidebarSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    let effect: ts.CallExpression | undefined;
    function visit(node: ts.Node) {
      if (ts.isCallExpression(node) && node.expression.getText(sidebarTree) === "useEffect"
        && node.arguments[0]?.getText(sidebarTree).includes("ROOM_ACTIVITY_STATUS_POLL_MS")) effect = node;
      ts.forEachChild(node, visit);
    }
    visit(sidebarTree);
    expect(effect).toBeDefined();
    const refresh = vi.fn().mockResolvedValue(undefined), refreshShared = vi.fn().mockResolvedValue(undefined);
    function Probe({ background = false, settled = false }: { background?: boolean; settled?: boolean }) {
      const observed = useObservedChatSessions("fictional-workspace");
      const activity: Record<string, { working: boolean }> = settled ? { "chat-a": { working: false } } : {};
      const hasWorkingRoom = needsChatActivityPoll(background ? [...rows, { id: "chat-b", status: "running" }] : rows, activity, observed);
      useEffect(evaluate(effect!.arguments[0].getText(sidebarTree), {
        hasWorkingRoom, refresh, refreshShared, view: "personal", ROOM_ACTIVITY_STATUS_POLL_MS: 3000, window,
      }), [hasWorkingRoom]);
      return null;
    }
    container = document.createElement("div"); document.body.append(container); root = createRoot(container);
    await act(async () => root!.render(<Probe />));
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(refresh).toHaveBeenCalledTimes(1);
    const token = observe();
    await act(async () => token.observe("chat-a"));
    await act(async () => vi.advanceTimersByTimeAsync(9000));
    expect(refresh).toHaveBeenCalledTimes(1);
    await act(async () => root!.render(<Probe background />));
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(refresh).toHaveBeenCalledTimes(2);
    await act(async () => root!.render(<Probe />));
    await act(async () => token.release());
    await act(async () => vi.advanceTimersByTimeAsync(3000));
    expect(refresh).toHaveBeenCalledTimes(3);
    await act(async () => root!.render(<Probe settled />));
    await act(async () => vi.advanceTimersByTimeAsync(9000));
    expect(refresh).toHaveBeenCalledTimes(3);
    expect(refreshShared).not.toHaveBeenCalled();
  });

  for (const callback of ["onDone", "onDisconnect", "onError"]) it(`releases stale POST coverage in actual ${callback} before the ownership gate`, () => {
    const stale = observe(); stale.observe("chat-a");
    const release = vi.fn();
    evaluate(directHandler(callback), { directObserver: stale, localSend: { release, complete: release }, ownsSend: () => false })();
    expect(release).toHaveBeenCalledOnce();
    expect(polling()).toBe(true);
    const successor = observe(); successor.observe("chat-a");
    evaluate(directHandler(callback), { directObserver: stale, ownsSend: () => false })();
    expect(polling()).toBe(false);
  });

  it("releases stale event ownership while leaving successor observation intact", () => {
    const stale = observe(), successor = observe(); stale.observe("chat-a"); successor.observe("chat-a");
    evaluate(directHandler("onEvent"), { directObserver: stale, ownsSend: () => false, coercePayload: (value: unknown) => value })({ event: "text_delta", data: {} });
    expect(polling()).toBe(false);
    successor.release();
    expect(polling()).toBe(true);
  });

  it("the actual POST finally releases observation even if no terminal callback ran", () => {
    const token = observe(); token.observe("chat-a");
    const statement = find(node => ts.isTryStatement(node) && !!node.finallyBlock?.getText(tree).includes("unregisterDirectObserver")) as ts.TryStatement;
    const unregister = vi.fn();
    evaluate(`() => ${statement.finallyBlock!.getText(tree)}`, { directObserver: token, unregisterDirectObserver: unregister })();
    expect(polling()).toBe(true); expect(unregister).toHaveBeenCalledOnce();
  });

  it.each([false, true])("actual follow connection covers only an accepted body and releases on close (accepted: %s)", async accepted => {
    const token = observe(), read = deferred<{ done: boolean; value?: Uint8Array }>();
    const response = { ok: accepted, body: { getReader: () => ({ read: () => read.promise }) } };
    const scope = {
      authFetch: async () => response, API_URL: "https://api.example", sessionId: "chat-a",
      controller: new AbortController(), ownsFollow: () => true, panePolicy: { presence: true },
      followObserver: token, TextDecoder, createSSEBuffer: () => ({}), parseSSEStream: () => [],
      handleRoomEvent: vi.fn(), coercePayload: (value: unknown) => value, cancelled: false,
      shouldReopenSessionStream: () => false, sawDone: false,
    };
    const running = evaluate(followExpression(), scope)();
    await Promise.resolve(); await Promise.resolve();
    expect(polling()).toBe(!accepted);
    read.resolve({ done: true }); await running;
    expect(polling()).toBe(true);
  });

  it("actual follow cleanup releases immediately on navigation even before the reader unwinds", () => {
    const token = observe(); token.observe("chat-a");
    const controller = new AbortController(), unregister = vi.fn();
    const cleanup = find(node => ts.isArrowFunction(node) && !node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword)
      && node.body.getText(tree).includes("followObserver.release();") && node.body.getText(tree).includes("unregisterControllerCleanup();")
      && !node.body.getText(tree).includes("followObserver.observe(sessionId)"));
    evaluate(cleanup.getText(tree), { followObserver: token, unregisterControllerCleanup: unregister, controller, cancelled: false })();
    expect(controller.signal.aborted).toBe(true); expect(polling()).toBe(true); expect(unregister).toHaveBeenCalledOnce();
  });
});
