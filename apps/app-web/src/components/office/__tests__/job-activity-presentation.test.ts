// @vitest-environment jsdom
/**
 * [COMP:app-web/office-iteration-panel] The Office file rail as a dock-profile
 * room presentation of the shared conversation controller (M5 WP-E), driven
 * on fake transports and a manual scheduler: the focus hint rides the POST as
 * the typed `officeSelection` field, a send during a teammate's followed turn
 * is the room mid-turn post (never a second turn), the hidden rail releases
 * only the follow transport after 60 s and reopens it when visible, approvals
 * go through `respondConfirmation`, and the rail reloads canonical history
 * after its own turn so edit cards come from saved rows. Replaces the rail's
 * own follow SSE loop, visibility gate, side stream, turn refs and confirm
 * POST. Spec: docs/architecture/features/office.md -> "Controller presentation
 * (M5 WP-E, 2026-11-17)".
 */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import { createConversationController } from "@/lib/chat/conversation-controller";
import { createConversationRegistry, type ConversationRegistry } from "@/lib/chat/conversation-registry";
import { SCOPE, TURN_A, fakeScheduler, fakeTransport, settle } from "@/lib/chat/__tests__/conversation-fakes";
import type { DocSessionMessage } from "@/lib/api/sessions";
import { getOfficeConversation, startOfficeConversation } from "@/lib/office/api";

const ARTIFACT = "10000000-0000-4000-8000-000000000003";
const TARGET = "10000000-0000-4000-8000-000000000070";
const harness = vi.hoisted(() => ({ registry: null as unknown as ConversationRegistry }));

vi.mock("@/lib/chat/conversation-registry", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/chat/conversation-registry")>(),
  conversationRegistry: () => harness.registry,
}));
vi.mock("@/lib/user", () => ({ getUserInfo: () => ({ id: "viewer-1" }) }));
vi.mock("@/lib/workspace-context", () => ({ useOptionalWorkspaceContext: () => ({ workspaceId: "workspace-1", me: { id: "viewer-1" } }) }));
vi.mock("@/lib/runtime-public-config", () => ({ publicRuntimeConfig: () => ({ apiUrl: "https://api.example" }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("@/components/doc/composer-controls", () => ({
  useComposerControls: () => ({ model: "standard", setModel: vi.fn(), plan: "pro", researchMode: false, setResearchMode: vi.fn(), researchQuota: null, researchExhausted: false }),
  ComposerControls: () => null,
}));
vi.mock("@/lib/office/api", async (importOriginal) => ({
  ...await importOriginal<typeof import("@/lib/office/api")>(),
  getOfficeConversation: vi.fn(async () => ({ sessionId: "session-1", canSend: true, role: "edit", assistant: { id: "assistant-1", name: "Brian" } })),
  startOfficeConversation: vi.fn(async () => ({ sessionId: "session-1", assistant: { id: "assistant-1", name: "Brian" } })),
  steerOfficeJob: vi.fn(async () => undefined),
}));
vi.mock("@/lib/office/job-stream", () => {
  const idle = { job: null, events: [], connection: "live", ended: null };
  return { readOfficeJobStream: () => idle, useOfficeJobStream: () => idle };
});

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let net: ReturnType<typeof fakeTransport>;
let clock: ReturnType<typeof fakeScheduler>;
let history: DocSessionMessage[];
let fetchHistoryRows: ReturnType<typeof vi.fn>;
let host: HTMLDivElement;
let root: Root;
let visibility: DocumentVisibilityState = "visible";

beforeEach(() => {
  net = fakeTransport();
  clock = fakeScheduler();
  history = [];
  fetchHistoryRows = vi.fn(async () => history);
  // Raw rows mapped by the rail's own `mapHistoryRows`, as in production.
  const transport = { ...net.transport, loadHistory: undefined, fetchHistoryRows };
  harness.registry = createConversationRegistry({
    createController: (init) => createConversationController({ ...init, transport, scheduler: clock.scheduler }),
    setTimeout: (callback, ms) => clock.scheduler.setTimeout(callback, ms),
    currentIdentity: () => ({ viewerId: SCOPE.viewerId, apiOrigin: SCOPE.apiOrigin }),
  });
  visibility = "visible";
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  net.status.current = { status: "idle", turnId: null };
  vi.mocked(startOfficeConversation).mockClear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); harness.registry.disposeAll(); });

async function mount(targetIds: string[] = []) {
  const { OfficeJobActivity } = await import("../job-activity");
  const rail = createElement(OfficeJobActivity, { workspaceId: SCOPE.workspaceId, artifactId: ARTIFACT, snapshot: undefined, targetIds, onRevisionCompleted: vi.fn() });
  await act(async () => root.render(createElement(I18nProvider, { locale: "en", dict: en as unknown as Dictionary, children: rail })));
  await act(async () => { await settle(); });
}
async function submit(text: string) {
  const input = host.querySelector<HTMLTextAreaElement>("#office-brian-instruction")!;
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  await act(async () => { setter.call(input, text); input.dispatchEvent(new Event("input", { bubbles: true })); });
  await act(async () => { host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
  await act(async () => { await settle(); });
}
const paint = async () => act(async () => { clock.runFrames(); await settle(); });
const roomFollow = () => net.follows.filter((row) => row.sessionId === "session-1").at(-1)!.sse!;

describe("[COMP:app-web/office-iteration-panel] the rail as a controller presentation", () => {
  it("sends the focus hint as the typed officeSelection field on the file's thread", async () => {
    await mount([TARGET]);
    await submit("Make this bolder");
    expect(net.chats).toHaveLength(1);
    expect(net.chats[0]!.body).toMatchObject({
      message: "Make this bolder", sessionId: "session-1", assistantId: "assistant-1", workspaceId: SCOPE.workspaceId,
      model: "standard", officeSelection: { targetIds: [TARGET] },
    });
    expect(net.chats[0]!.body).not.toHaveProperty("midTurn");
  });

  it("creates the thread before the first send and never posts without its session", async () => {
    vi.mocked(getOfficeConversation).mockResolvedValueOnce({ sessionId: null, canSend: true, role: "edit", assistant: { id: "assistant-1", name: "Brian" } });
    await mount();
    expect(net.chats).toHaveLength(0);
    await submit("Start the summary slide");
    expect(startOfficeConversation).toHaveBeenCalledWith(ARTIFACT);
    expect(net.chats).toHaveLength(1);
    expect(net.chats[0]!.body).toMatchObject({ sessionId: "session-1", message: "Start the summary slide" });
  });

  it("hands a send to a teammate's running turn as the room mid-turn post", async () => {
    await mount();
    net.status.current = { status: "running", turnId: TURN_A };
    await act(async () => { roomFollow().send("status", { status: "running", turnId: TURN_A }); await settle(); });
    await act(async () => { roomFollow().send("snapshot", { turnId: TURN_A, text: "Teammate draft" }); await settle(); });
    await paint();
    expect(host.textContent).toContain("Teammate draft");
    await submit("Also add a chart");
    expect(net.chats).toHaveLength(0);
    expect(net.sides).toEqual([expect.objectContaining({ message: "Also add a chart", midTurn: true, sessionId: "session-1", assistantId: "assistant-1" })]);
  });

  it("releases only the follow transport after 60 s hidden and reopens it when visible", async () => {
    await mount();
    const first = roomFollow();
    visibility = "hidden";
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); await settle(); });
    await act(async () => { await clock.advance(59_000); });
    expect(first.aborted()).toBe(false);
    await act(async () => { await clock.advance(2_000); });
    expect(first.aborted()).toBe(true);
    const opened = net.follows.length;
    visibility = "visible";
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); await settle(); });
    expect(net.follows.length).toBe(opened + 1);
    expect(net.transport.stopTurn).not.toHaveBeenCalled();
  });

  it("answers a mirrored approval through the controller and shows a refusal", async () => {
    await mount();
    net.status.current = { status: "running", turnId: TURN_A };
    await act(async () => { roomFollow().send("status", { status: "running", turnId: TURN_A }); await settle(); });
    await act(async () => {
      roomFollow().send("activity", { event: "tool_confirmation_required", turnId: TURN_A, toolCallId: "tool-1", toolName: "reviseOfficeArtifact", input: {} });
      await settle();
    });
    net.transport.confirmLive.mockResolvedValueOnce({ ok: false, status: 403 });
    const approve = () => Array.from(host.querySelectorAll("button")).find((node) => node.textContent === en.chat.confirmationApprove)!;
    await act(async () => { approve().click(); await settle(); });
    expect(net.transport.confirmLive).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "session-1", toolCallId: "tool-1", decision: "allow" }));
    expect(host.textContent).toContain(en.chatApp.confirmNotAllowed);
    await act(async () => { approve().click(); await settle(); });
    expect(net.transport.confirmLive).toHaveBeenCalledTimes(2);
  });

  it("reloads canonical rows after its own turn so the edit card comes from history", async () => {
    await mount();
    await submit("Shorten slide two");
    const chat = net.lastChat();
    fetchHistoryRows.mockClear();
    history = [
      { id: "u1", role: "user", content: "Shorten slide two", timestamp: "2026-11-17T00:00:00Z", senderUserId: SCOPE.viewerId, senderName: null },
      { id: "a1", role: "assistant", content: [{ type: "tool_use", id: "call-1", name: "reviseOfficeArtifact", input: {} }, { type: "text", text: "Saved reply" }], timestamp: "2026-11-17T00:00:01Z", senderName: null, senderUserId: null },
      { id: "r1", role: "user", content: [{ type: "tool_result", toolUseId: "call-1", content: JSON.stringify({ jobId: "revision-job", mode: "direct" }) }], timestamp: "2026-11-17T00:00:02Z", senderName: null, senderUserId: null },
    ] as DocSessionMessage[];
    await act(async () => {
      chat.sse.send("session", { sessionId: "session-1", turnId: TURN_A });
      chat.sse.send("text_delta", { text: "Working on it" });
      chat.sse.send("done", { turnId: TURN_A });
      chat.sse.close();
      await settle();
    });
    await paint();
    expect(fetchHistoryRows).toHaveBeenCalledWith("session-1", expect.anything());
    expect(host.textContent).toContain("Saved reply");
    expect(host.querySelector('[data-office-edit-card]')).not.toBeNull();
  });
});
