// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openConnectorAuthorization } from "../connector-authorization-popup";
import { parseConnectorState } from "../connector-oauth-state";

const config = vi.hoisted(() => ({ googleClientId: "fictional-client" }));
vi.mock("@/lib/runtime-public-config", () => ({ publicRuntimeConfig: () => config }));
const sessionId = "11111111-1111-4111-8111-111111111111";
const approvalId = "22222222-2222-4222-8222-222222222222";
const action = { kind: "connector_authorization" as const, provider: "gcal", label: "Google Calendar", connectPath: "/w/workspace/studio/connectors?connect=gcal" };
let channel: { onmessage: ((event: { data: unknown }) => void) | null; close: ReturnType<typeof vi.fn> };
let popup: { location: { href: string }; close: ReturnType<typeof vi.fn>; closed: boolean };
let dispose: (() => void) | undefined;
const onComplete = vi.fn();
const onError = vi.fn();
function start(overrides = {}) {
  dispose = openConnectorAuthorization({ action, sessionId, approvalId, onComplete, onError, ...overrides });
}
function result(ok = true) {
  const state = parseConnectorState(new URL(popup.location.href).searchParams.get("state")!);
  return { type: "connector-authorization", nonce: state.nonce, sessionId, approvalId, ok };
}
beforeEach(() => {
  vi.useFakeTimers();
  config.googleClientId = "fictional-client";
  popup = { location: { href: "" }, close: vi.fn(), closed: false };
  vi.spyOn(window, "open").mockReturnValue(popup as unknown as Window);
  vi.stubGlobal("BroadcastChannel", class {
    onmessage = null;
    close = vi.fn();
    constructor() { channel = this; }
  });
});
afterEach(() => { dispose?.(); dispose = undefined; vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.clearAllMocks(); vi.useRealTimers(); });

describe("[COMP:app-web/connector-authorization] inline Google consent", () => {
  it("opens Google directly, binds the current checkpoint and requests calendar-only access", () => {
    const previous = window.location.href;
    start();
    const url = new URL(popup.location.href);
    expect(url.origin).toBe("https://accounts.google.com");
    expect(url.searchParams.get("scope")).toContain("auth/calendar");
    expect(url.searchParams.get("scope")).not.toContain("tasks");
    expect(url.searchParams.get("scope")).not.toContain("gmail");
    expect(parseConnectorState(url.searchParams.get("state")!)).toMatchObject({ connector: "gcal", workspaceId: "workspace", popup: true, continuation: { sessionId, approvalId } });
    expect(document.cookie).toContain("conn_oauth_state=");
    expect(window.location.href).toBe(previous);
  });
  it("resumes exactly once for the matching callback, including a severed opener", () => {
    start();
    const receive = channel.onmessage!;
    popup.closed = true;
    vi.advanceTimersByTime(2000);
    expect(onComplete).not.toHaveBeenCalled();
    receive({ data: result() }); receive({ data: result() });
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(channel.close).toHaveBeenCalled();
  });
  it("ignores messages for another nonce, session or approval", () => {
    start();
    for (const key of ["nonce", "sessionId", "approvalId"]) channel.onmessage!({ data: { ...result(), [key]: "foreign" } });
    expect(onComplete).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });
  it("rejects foreign-origin and foreign-window opener messages", () => {
    start();
    window.dispatchEvent(new MessageEvent("message", { origin: "https://foreign.example", source: popup as unknown as Window, data: result() }));
    window.dispatchEvent(new MessageEvent("message", { origin: window.location.origin, source: window, data: result() }));
    expect(onComplete).not.toHaveBeenCalled();
  });
  it("keeps failed authorization retryable without resuming", () => {
    start(); channel.onmessage!({ data: result(false) });
    expect(onError).toHaveBeenCalledWith("failed");
    expect(onComplete).not.toHaveBeenCalled();
  });
  it("reports a blocked popup without changing the chat", () => {
    vi.mocked(window.open).mockReturnValue(null); start();
    expect(onError).toHaveBeenCalledWith("blocked");
    expect(onComplete).not.toHaveBeenCalled();
  });
  it("reports missing deployment credentials before opening a window", () => {
    config.googleClientId = ""; start();
    expect(onError).toHaveBeenCalledWith("unconfigured");
    expect(window.open).not.toHaveBeenCalled();
  });
  it.each(["https://foreign.example/w/workspace/studio/connectors", "/unexpected"])("refuses an invalid context path %s", (connectPath) => {
    start({ action: { ...action, connectPath } });
    expect(onError).toHaveBeenCalledWith("failed");
    expect(window.open).not.toHaveBeenCalled();
  });
  it("does not bypass Drive's capability choice", () => {
    start({ action: { ...action, provider: "gdrive" } });
    expect(window.open).not.toHaveBeenCalled();
  });
  it("disposes pending listeners on navigation and ignores late success", () => {
    start(); const receive = channel.onmessage!; const data = result(); dispose!();
    receive({ data });
    expect(onComplete).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("bounds waiting and leaves the original checkpoint unresolved", () => {
    start(); vi.advanceTimersByTime(15 * 60_000);
    expect(onError).toHaveBeenCalledWith("failed");
    expect(onComplete).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
