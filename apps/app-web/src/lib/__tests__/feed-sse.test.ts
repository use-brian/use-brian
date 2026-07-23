import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getAccessToken = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth-fetch", () => ({ getAccessToken }));

import { openFeedStream, type FeedEventRow } from "@/lib/feed-sse";

/** Minimal EventSource stub capturing the URL + listeners. */
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  url: string;
  withCredentials: boolean;
  closed = false;
  listeners = new Map<string, (ev: MessageEvent) => void>();
  onerror: ((err: Event) => void) | null = null;
  constructor(url: string, init?: { withCredentials?: boolean }) {
    this.url = url;
    this.withCredentials = init?.withCredentials ?? false;
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: (ev: MessageEvent) => void) {
    this.listeners.set(type, fn);
  }
  close() {
    this.closed = true;
  }
  emit(type: string, data: string) {
    this.listeners.get(type)?.({ data } as MessageEvent);
  }
}

beforeEach(() => {
  FakeEventSource.instances = [];
  vi.stubGlobal("EventSource", FakeEventSource);
  getAccessToken.mockReturnValue("tok-1");
});

afterEach(() => {
  vi.unstubAllGlobals();
  getAccessToken.mockReset();
});

function row(id: string): string {
  return JSON.stringify({ id, eventType: "drafted" } as Partial<FeedEventRow>);
}

describe("[COMP:app-web/feed-sse] openFeedStream", () => {
  it("connects with an absolute API URL and the access_token query param", () => {
    const handle = openFeedStream({ workspaceId: "ws-1", onEvent: () => {} });
    const source = FakeEventSource.instances[0];
    const url = new URL(source.url);
    // Absolute against NEXT_PUBLIC_API_URL — never window.location.origin
    // (the desktop bundle runs on file://).
    expect(url.pathname).toBe("/api/distribution/t/ws-1/events");
    expect(url.searchParams.get("access_token")).toBe("tok-1");
    expect(url.searchParams.has("lastEventId")).toBe(false);
    // Auth rides the URL token, not cookies — a credentialed cross-origin
    // EventSource would demand `Access-Control-Allow-Credentials: true` (the
    // API doesn't send it) and reconnect-storm. Must stay uncredentialed.
    expect(source.withCredentials).toBe(false);
    handle.close();
  });

  it("resumes from an initial bookmark via lastEventId", () => {
    const handle = openFeedStream({
      workspaceId: "ws-1",
      onEvent: () => {},
      initialLastEventId: "ev-40",
    });
    const url = new URL(FakeEventSource.instances[0].url);
    expect(url.searchParams.get("lastEventId")).toBe("ev-40");
    handle.close();
  });

  it("delivers parsed feed-event rows and skips malformed payloads", () => {
    const seen: string[] = [];
    const handle = openFeedStream({
      workspaceId: "ws-1",
      onEvent: (ev) => seen.push(ev.id),
    });
    const source = FakeEventSource.instances[0];
    source.emit("feed-event", row("ev-1"));
    source.emit("feed-event", "not-json{");
    source.emit("feed-event", row("ev-2"));
    expect(seen).toEqual(["ev-1", "ev-2"]);
    handle.close();
  });

  it("omits the token param when no access token is available", () => {
    getAccessToken.mockReturnValue(null);
    const handle = openFeedStream({ workspaceId: "ws-1", onEvent: () => {} });
    const url = new URL(FakeEventSource.instances[0].url);
    expect(url.searchParams.has("access_token")).toBe(false);
    handle.close();
  });

  it("close() closes the underlying source", () => {
    const handle = openFeedStream({ workspaceId: "ws-1", onEvent: () => {} });
    const source = FakeEventSource.instances[0];
    handle.close();
    expect(source.closed).toBe(true);
  });
});
