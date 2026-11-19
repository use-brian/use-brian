// @vitest-environment jsdom
import { readFileSync } from "node:fs";
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

  // The full page is a conversation presentation (M5 WP-B): it observes the
  // open chat for exactly as long as the conversation streams its turn,
  // paints a mirrored turn, or holds a room's follow stream, and releases on
  // any change or navigation.
  const pageObservation = () => (find(node => ts.isCallExpression(node) && node.expression.getText(tree) === "useEffect"
    && !!node.arguments[0]?.getText(tree).includes("createChatStreamObserver(workspaceId)")) as ts.CallExpression).arguments[0].getText(tree);
  const observingTurn = (state: { isStreaming: boolean; remoteActive: boolean; presence: boolean; activeSessionId: string | null }) =>
    evaluate<boolean>((declarationOf("observingTurn").initializer!).getText(tree), {
      activeSessionId: state.activeSessionId, transcript: { isStreaming: state.isStreaming },
      remoteActive: state.remoteActive, panePolicy: { presence: state.presence },
    });
  function declarationOf(name: string) {
    return find(node => ts.isVariableDeclaration(node) && node.name.getText(tree) === name) as ts.VariableDeclaration;
  }

  it.each([
    [{ isStreaming: true, remoteActive: false, presence: false }, true],
    [{ isStreaming: false, remoteActive: true, presence: false }, true],
    [{ isStreaming: false, remoteActive: false, presence: true }, true],
    [{ isStreaming: false, remoteActive: false, presence: false }, false],
  ] as const)("observes the open chat only while its turn or room stream is live (%o)", (state, expected) => {
    expect(observingTurn({ ...state, activeSessionId: "chat-a" })).toBe(expected);
    expect(observingTurn({ ...state, activeSessionId: null })).toBe(false);
  });

  it("the actual page observation covers the open chat and releases on settle or navigation", () => {
    const run = (observing: boolean, sessionId: string | null) => evaluate<() => (() => void) | undefined>(pageObservation(), {
      observingTurn: observing, activeSessionId: sessionId, workspaceId: "fictional-workspace", createChatStreamObserver: observe,
    })();
    expect(run(false, "chat-a")).toBeUndefined();
    expect(polling()).toBe(true);
    const cleanup = run(true, "chat-a")!;
    expect(polling()).toBe(false);
    cleanup(); // the turn settled, or the user moved to another chat
    expect(polling()).toBe(true);
    // A stale cleanup leaves a successor's observation intact.
    const successor = run(true, "chat-a")!;
    cleanup();
    expect(polling()).toBe(false);
    successor();
    expect(polling()).toBe(true);
  });
});
