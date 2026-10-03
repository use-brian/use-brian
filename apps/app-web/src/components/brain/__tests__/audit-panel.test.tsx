// @vitest-environment jsdom
import { act, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { DocSessionMessage } from "@/lib/api/sessions";
import type { AuditTurn, TurnTrace } from "@/lib/turn-audit";
import { AUDIT_ACCESS_STEP_MS } from "@/lib/turn-audit";

const mocks = vi.hoisted(() => ({ messages: vi.fn(), trace: vi.fn(), graph: vi.fn(), pager: vi.fn() }));
vi.mock("@/lib/api/sessions", async (original) => ({ ...await original<typeof import("@/lib/api/sessions")>(), fetchSessionMessages: mocks.messages }));
vi.mock("@/lib/api/turn-trace", () => ({ fetchTurnTrace: mocks.trace, fetchTurnPayload: vi.fn(async () => null) }));
vi.mock("@/lib/api/brain-inbox", () => ({ fetchBrainRow: vi.fn(async () => null) }));
vi.mock("@/components/brain/graph-view", () => ({ BrainGraphView: (props: { onAccessReady: (ready: boolean) => void }) => {
  mocks.graph(props);
  useEffect(() => props.onAccessReady(true), [props.onAccessReady]);
  return <div data-testid="graph" />;
} }));
import { AuditPanel } from "../audit-panel";

const rowId = "11111111-1111-4111-8111-111111111111";
const transcript = [
  { id: "u1", role: "user", content: "Old budget", timestamp: "2026-09-01T00:00:00Z" },
  { id: "a1", role: "assistant", content: "Budget approved", timestamp: "2026-09-01T00:01:00Z" },
  { id: "u2", role: "user", content: "Launch status", timestamp: "2026-09-02T00:00:00Z" },
  { id: "a2", role: "assistant", content: "The launch is Friday", timestamp: "2026-09-02T00:01:00Z" },
] as DocSessionMessage[];
const trace: TurnTrace = { fidelity: "full", preEpoch: false, sessionId: "session", steps: [
  { ordinal: 1, kind: "retrieval", at: null, payloadRefs: [], metadata: { returnedRows: [{ rowId, primitive: "memory" }] } },
  { ordinal: 2, kind: "tool_call", at: null, payloadRefs: [], metadata: { name: "getEntity", input: { name: "Launch" } } },
] };
let root: Root;
let container: HTMLDivElement;
let reducedMotion = false;

function Harness({ session = "session", initialTurn = null }: { session?: string; initialTurn?: string | null }) {
  const [turn, setTurn] = useState(initialTurn);
  return <I18nProvider locale="en" dict={en}><AuditPanel key={session} workspaceId="workspace" sessionId={session} turnId={turn} onSelectTurn={setTurn} onTurnsLoaded={(turns: AuditTurn[]) => mocks.pager(turns)} graph={{ nodes: [], edges: [], truncated: false }} viewpointAssistantId={null} cacheScope={null} onOpenRow={() => {}} /></I18nProvider>;
}
async function mount(props = {}) { await act(async () => root.render(<Harness {...props} />)); }
async function search(value: string) {
  const input = container.querySelector("input")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function button(label: string) { return container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!; }
function latestGraph() { return mocks.graph.mock.calls.at(-1)![0]; }

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  reducedMotion = false;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  window.matchMedia = vi.fn().mockImplementation(() => ({ matches: reducedMotion, addEventListener: vi.fn(), removeEventListener: vi.fn() }));
  Element.prototype.scrollIntoView = vi.fn();
  mocks.messages.mockResolvedValue(transcript);
  mocks.trace.mockResolvedValue(trace);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); vi.useRealTimers(); });

describe("[COMP:app-web/brain-audit] transcript browsing and replay", () => {
  it("selects newest first and keeps pager, search and selected trace in sync", async () => {
    await mount();
    expect([...container.querySelectorAll("button[aria-pressed]")].map((row) => row.textContent)).toEqual([
      expect.stringContaining("Turn 2"), expect.stringContaining("Turn 1"),
    ]);
    expect(container.querySelector('button[aria-pressed="true"]')!.textContent).toContain("Turn 2");
    await search("BUDGET");
    expect(mocks.pager.mock.calls.at(-1)![0].map((turn: AuditTurn) => turn.id)).toEqual(["a1"]);
    expect(container.querySelector('button[aria-pressed="true"]')!.textContent).toContain("Turn 1");
    await search("no match");
    expect(container.textContent).toContain(en.brainPage.audit.noMatchingTurns);
    expect(mocks.pager.mock.calls.at(-1)![0]).toEqual([]);
    expect(latestGraph().highlightIds).toBeNull();
    await act(async () => button(en.brainPage.audit.clearSearch).click());
    expect(container.querySelectorAll("button[aria-pressed]")).toHaveLength(2);
  });
  it("honors an explicit older turn and resets search on a conversation switch", async () => {
    await mount({ initialTurn: "a1" });
    expect(container.querySelector('button[aria-pressed="true"]')!.textContent).toContain("Turn 1");
    await search("budget");
    await mount({ session: "second" });
    expect(container.querySelector("input")!.value).toBe("");
    expect(container.querySelectorAll("button[aria-pressed]")).toHaveLength(2);
  });
  it("loops the replay in retrieval order, pauses, and restarts without changing the full highlight set", async () => {
    await mount();
    expect(latestGraph().accessIds).toEqual([rowId]);
    const highlight = latestGraph().highlightIds;
    await act(async () => button(en.brainPage.audit.pauseReplay).click());
    await act(async () => { vi.advanceTimersByTime(AUDIT_ACCESS_STEP_MS * 3); });
    expect(latestGraph().accessIds).toEqual([rowId]);
    expect(latestGraph().accessPulseKey).toBeNull();
    await act(async () => button(en.brainPage.audit.replay).click());
    await act(async () => { vi.advanceTimersByTime(AUDIT_ACCESS_STEP_MS); });
    expect(latestGraph().accessNames).toEqual(["launch"]);
    expect(latestGraph().highlightIds).toBe(highlight);
    // The last access holds one extra beat, then the loop starts over with a
    // fresh pulse key so the first entry pulses again.
    const lastKey = latestGraph().accessPulseKey;
    await act(async () => { vi.advanceTimersByTime(AUDIT_ACCESS_STEP_MS * 2); });
    expect(latestGraph().accessIds).toEqual([rowId]);
    expect(latestGraph().accessPulseKey).not.toBeNull();
    expect(latestGraph().accessPulseKey).not.toBe(lastKey);
    expect(container.querySelector('li[aria-current="step"]')).not.toBeNull();
  });
  it("uses static highlights and manual access steps with reduced motion", async () => {
    reducedMotion = true;
    await mount();
    expect(latestGraph().accessPulseKey).toBeNull();
    await act(async () => button(en.brainPage.audit.nextAccess).click());
    expect(latestGraph().accessNames).toEqual(["launch"]);
    expect(button(en.brainPage.audit.pauseReplay)).toBeNull();
  });
  it("never animates a turn with no recorded brain access", async () => {
    mocks.trace.mockResolvedValue({ ...trace, steps: [] });
    await mount();
    expect(container.textContent).toContain(en.brainPage.audit.noRecordedAccess);
    expect(latestGraph().accessPulseKey).toBeNull();
    expect(latestGraph().highlightIds).toBeNull();
    expect(button(en.brainPage.audit.replay)).toBeNull();
  });
  it("pauses the access sequence while the document is hidden", async () => {
    await mount();
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    await act(async () => { vi.advanceTimersByTime(AUDIT_ACCESS_STEP_MS * 3); });
    expect(latestGraph().accessIds).toEqual([rowId]);
    visibility.mockReturnValue("visible");
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    await act(async () => { vi.advanceTimersByTime(AUDIT_ACCESS_STEP_MS); });
    expect(latestGraph().accessNames).toEqual(["launch"]);
    visibility.mockRestore();
  });
});
