// @vitest-environment jsdom
import React, { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { en } from "@/lib/i18n/dictionaries/en";
import { TuningChatPanel } from "../tuning-chat-panel";
import type { DocSessionMessage } from "@/lib/api/sessions";
import { conversationRegistry } from "@/lib/chat/conversation-registry";
const mocks = vi.hoisted(() => ({ fetch: vi.fn(), messages: vi.fn(), pending: vi.fn(), status: vi.fn(), stop: vi.fn(), approval: vi.fn() }));
vi.mock("@/lib/i18n/client", () => ({ useT: () => en, format: (text: string) => text }));
vi.mock("@/lib/auth-fetch", () => ({ authFetch: (...args: unknown[]) => mocks.fetch(...args), getAccessToken: () => null }));
vi.mock("@/lib/api/sessions", async importOriginal => ({ ...await importOriginal<typeof import("@/lib/api/sessions")>(), fetchSessionMessages: (...args: unknown[]) => mocks.messages(...args), readChatTurnStatus: (...args: unknown[]) => mocks.status(...args), stopTurn: (...args: unknown[]) => mocks.stop(...args) }));
vi.mock("@/lib/api/pending-questions", async importOriginal => ({ ...await importOriginal<typeof import("@/lib/api/pending-questions")>(), fetchPendingSessionInput: (...args: unknown[]) => mocks.pending(...args) }));
vi.mock("@/lib/api/approvals", () => ({ respondByKind: (...args: unknown[]) => mocks.approval(...args) }));
vi.mock("@/lib/api/usage", () => ({ getUsage: async () => ({ plan: "free" }) }));
vi.mock("@/components/chrome/chat-activity", () => ({
  ChatActivityFeed: ({ events, tools }: { events: { text: string }[]; tools: { status: string }[] }) => <div data-activity>{events.map(e => e.text).join(" ")}{tools.map(t => t.status).join(" ")}</div>,
  ChatActivitySummary: ({ tools }: { tools: { name: string }[] }) => <div data-receipt>{tools.map(t => t.name).join(" ")}</div>,
  ChatCitationList: ({ citations }: { citations: { title: string }[] }) => <div data-sources>{citations.map(c => c.title).join(" ")}</div>,
}));
vi.mock("@/components/chrome/chat-file-attachment", () => ({ ChatFileAttachments: ({ attachments }: { attachments: { name: string }[] }) => <div data-files>{attachments.map(f => f.name).join(" ")}</div> }));
vi.mock("@/components/chrome/chat-confirmation-card", () => ({ ChatConfirmationCard: ({ confirmation, onApprove, onDeny, onAlwaysAllow }: { confirmation: { toolCallId: string; allowPersistentApproval?: boolean }; onApprove: (id: string) => void; onDeny: (id: string, comment: string) => void; onAlwaysAllow?: (id: string) => void }) => <div data-confirmation><button onClick={() => onApprove(confirmation.toolCallId)}>approve</button><button onClick={() => onDeny(confirmation.toolCallId, "Keep the draft")}>deny</button>{confirmation.allowPersistentApproval && <button onClick={() => onAlwaysAllow?.(confirmation.toolCallId)}>always</button>}</div> }));
vi.mock("@/components/chrome/pending-question-panel", () => ({ PendingQuestionPanel: ({ approvalId }: { approvalId: string }) => <div data-question>{approvalId}</div> }));
vi.mock("@/lib/recorder/dock-recorder-bridge", () => ({ registerDockRecorderChatTarget: () => () => {} }));
// The rail is a presentation of the shared conversation controller, which is
// scoped by the signed-in viewer (write authority).
vi.mock("@/lib/user", async importOriginal => ({ ...await importOriginal<typeof import("@/lib/user")>(), getUserInfo: () => ({ id: "viewer-1", name: "Viewer", email: "viewer@example.com" }), subscribeUserInfo: () => () => {} }));
let root: Root, host: HTMLDivElement;
const frame = (event: string, data = {}) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
function source() {
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const body = new ReadableStream<Uint8Array>({ start(c) { controller = c; } });
  return { response: new Response(body), send: (event: string, data = {}) => controller.enqueue(new TextEncoder().encode(frame(event, data))), close: () => controller.close() };
}
function row(id: string, text: string, role: "assistant" | "user" = "assistant"): DocSessionMessage { return { id, role, content: text, timestamp: "2026-01-01T00:00:00Z", senderName: null, senderUserId: null }; }
async function mount(sid = "draft") { await act(async () => { root.render(<TuningChatPanel sessionId={sid} assistantId="writer" assistantName="Writer" workspaceId="workspace" ready />); }); }
async function send(text: string) {
  const field = host.querySelector("textarea")!;
  act(() => { Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(field, text); field.dispatchEvent(new Event("input", { bubbles: true })); });
  await act(async () => { field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
}
beforeEach(async () => {
  vi.clearAllMocks(); localStorage.clear();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mocks.status.mockReset().mockResolvedValue({ status: "idle", turnId: null });
  mocks.messages.mockResolvedValue([]); mocks.pending.mockResolvedValue({ pending: null, toolConfirmation: null }); mocks.stop.mockResolvedValue({}); mocks.approval.mockResolvedValue({ ok: true });
  mocks.fetch.mockImplementation(async () => new Response(frame("status", { status: "idle" }) + frame("done")));
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await mount();
});
// The registry is a renderer singleton: each case starts with no conversations.
afterEach(() => { act(() => root.unmount()); host.remove(); conversationRegistry().disposeAll(); });
describe("[COMP:app-web/feed-chat-stream] Feed panel", () => {
  it("quotes selected text from a persisted message, sends its reference and restores saved quotes", async () => {
    const id = crypto.randomUUID();
    mocks.messages.mockResolvedValue([row(id, "Keep the orchard diagram, simplify its labels.")]);
    await mount("reply-session");
    const content = host.querySelector('[data-feed-message] .chat-markdown p')!;
    const range = document.createRange(); range.setStart(content.firstChild!, 9); range.setEnd(content.firstChild!, 24);
    window.getSelection()!.removeAllRanges(); window.getSelection()!.addRange(range);
    await act(async () => host.querySelector<HTMLButtonElement>(`button[aria-label="${en.chatApp.reply}"]`)!.click());
    expect(host.querySelector('[data-feed-reply-context]')?.textContent).toContain('orchard diagram');
    expect(document.activeElement).toBe(host.querySelector('textarea'));
    const direct = source(); mocks.fetch.mockResolvedValueOnce(direct.response);
    await send('Use this direction');
    expect(JSON.parse(mocks.fetch.mock.calls.at(-1)![1].body)).toMatchObject({ sessionId: 'reply-session', replyTo: { id, text: 'orchard diagram' } });
    expect(host.querySelector('[data-feed-reply-context]')).toBeNull();
    expect(host.querySelector('[data-feed-reply-quote]')?.textContent).toBe('orchard diagram');
    await act(async () => { direct.send('done'); direct.close(); });
    mocks.messages.mockResolvedValue([{ ...row('saved', 'Use this direction', 'user'), replyToText: 'orchard diagram' }]);
    await mount('reloaded-reply');
    expect(host.querySelector('[data-feed-reply-quote]')?.textContent).toBe('orchard diagram');
  });
  it("attaches explicit passage context beside the composer for one turn and can remove it", async () => {
    const anchor = { target: { kind: 'block' as const, segmentId: crypto.randomUUID(), blockId: crypto.randomUUID() }, quote: 'Selected opening', sourceRevision: 4, state: 'attached' as const };
    // Feed targets name real (UUID) draft sessions; the controller validates them.
    const passage = crypto.randomUUID();
    function Attached() {
      const [selected, setSelected] = useState<typeof anchor | undefined>(anchor);
      return <TuningChatPanel sessionId={passage} assistantId="writer" assistantName="Writer" workspaceId="workspace" ready feedTarget={{ sessionId: passage, revision: 5 }} feedSelection={selected} onClearFeedSelection={() => setSelected(undefined)} />;
    }
    await act(async () => root.render(<Attached />));
    const chip = host.querySelector('[data-feed-selection-attachment]')!;
    expect(chip.parentElement?.querySelector('textarea')).toBeTruthy();
    expect(chip.textContent).toContain(anchor.quote);
    mocks.fetch.mockImplementation(async () => new Response(frame('done')));
    await send('Tighten this');
    expect(JSON.parse(mocks.fetch.mock.calls.at(-1)![1].body).feedTarget).toEqual({ sessionId: passage, revision: 4, target: anchor.target });
    expect(host.querySelector('[data-feed-selection-attachment]')).toBeNull();
    await send('Back to the image');
    expect(JSON.parse(mocks.fetch.mock.calls.at(-1)![1].body).feedTarget).toEqual({ sessionId: passage, revision: 5 });
    await act(async () => root.render(<Attached key="remove" />));
    await act(async () => host.querySelector<HTMLButtonElement>('[data-feed-selection-attachment] button')!.click());
    await send('Whole post instead');
    expect(JSON.parse(mocks.fetch.mock.calls.at(-1)![1].body).feedTarget.target).toBeUndefined();
  });
  it("retries with the original attached scope and quote, never a later composer selection", async () => {
    const quotedId = crypto.randomUUID(); const userId = crypto.randomUUID();
    mocks.messages.mockResolvedValue([row(quotedId, 'Earlier image direction')]);
    const anchor = { target: { kind: 'block' as const, segmentId: crypto.randomUUID(), blockId: crypto.randomUUID() }, quote: 'First passage', sourceRevision: 4, state: 'attached' as const };
    const retryScope = crypto.randomUUID();
    const render = async (selection: typeof anchor | undefined) => act(async () => root.render(<TuningChatPanel sessionId={retryScope} assistantId="writer" assistantName="Writer" workspaceId="workspace" ready feedTarget={{ sessionId: retryScope, revision: 4 }} feedSelection={selection} />));
    await render(anchor);
    await act(async () => host.querySelector<HTMLButtonElement>(`button[aria-label="${en.chatApp.reply}"]`)!.click());
    const direct = source(); mocks.fetch.mockResolvedValueOnce(direct.response);
    await send('Refine this');
    await act(async () => { direct.send('user_message_saved', { id: userId }); direct.send('text_delta', { text: 'Refined' }); direct.send('done'); direct.close(); });
    await render({ ...anchor, target: { ...anchor.target, blockId: crypto.randomUUID() }, quote: 'Different passage' });
    const retry = source(); mocks.fetch.mockResolvedValueOnce(retry.response);
    const buttons = host.querySelectorAll<HTMLButtonElement>(`button[aria-label="${en.feedPage.tuningChat.retry}"]`);
    await act(async () => buttons[buttons.length - 1]!.click());
    expect(JSON.parse(mocks.fetch.mock.calls.at(-1)![1].body)).toMatchObject({ truncateFromMessageId: userId, feedTarget: { sessionId: retryScope, revision: 4, target: anchor.target }, replyTo: { id: quotedId, text: 'Earlier image direction' } });
    expect(host.querySelector('[data-feed-selection-attachment]')?.textContent).toContain('Different passage');
    await act(async () => { retry.send('done'); retry.close(); });
  });
  it("keeps quoted replies staged while a turn runs instead of silently queuing plain text", async () => {
    mocks.messages.mockResolvedValue([row(crypto.randomUUID(), 'Earlier image direction')]);
    await mount('busy-reply');
    const direct = source(); mocks.fetch.mockResolvedValueOnce(direct.response);
    await send('First question');
    await act(async () => host.querySelector<HTMLButtonElement>(`button[aria-label="${en.chatApp.reply}"]`)!.click());
    const before = mocks.fetch.mock.calls.length;
    await send('About that image');
    expect(mocks.fetch.mock.calls).toHaveLength(before);
    expect(host.querySelector('textarea')?.value).toBe('About that image');
    expect(host.querySelector('[data-feed-reply-context]')).toBeTruthy();
    await act(async () => { direct.send('done'); direct.close(); });
    await act(async () => host.querySelector<HTMLButtonElement>(`button[aria-label="${en.chatApp.replyCancel}"]`)!.click());
    expect(host.querySelector('textarea')?.value).toBe('About that image');
  });
  it("stages a pasted clipboard image and sends an image-only turn with its real metadata", async () => {
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: vi.fn(() => "blob:clipboard-image") });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: vi.fn() });
    const fileId = crypto.randomUUID();
    mocks.fetch.mockImplementation(async (url, init) => {
      if (String(url).endsWith("/api/files/upload")) return new Response(JSON.stringify({ files: [{ id: fileId }] }), { status: 200 });
      // The server accepts the turn (`session`) before it ends; chips detach on acceptance.
      if (String(url).endsWith("/api/chat") && init?.method === "POST") return new Response(frame("session", { sessionId: "draft" }) + frame("done"));
      return new Response(frame("status", { status: "idle" }) + frame("done"));
    });
    const field = host.querySelector("textarea")!;
    const image = new File(["pixels"], "clipboard.png", { type: "image/png" });
    const paste = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", { value: { files: [image], getData: () => "" } });
    await act(async () => field.dispatchEvent(paste));
    expect(paste.defaultPrevented).toBe(true);
    await vi.waitFor(() => expect(host.textContent).toContain("clipboard.png"));
    expect(host.querySelector<HTMLImageElement>('img[src="blob:clipboard-image"]')).not.toBeNull();
    const sendButton = host.querySelector<HTMLButtonElement>(`button[title="${en.feedPage.tuningChat.send}"]`)!;
    await vi.waitFor(() => expect(sendButton.disabled).toBe(false));
    await act(async () => sendButton.click());
    const chatCall = mocks.fetch.mock.calls.find(([url, init]) => String(url).endsWith("/api/chat") && init?.method === "POST")!;
    expect(JSON.parse(chatCall[1].body)).toMatchObject({ message: "", fileIds: [fileId], sessionId: "draft", assistantId: "writer" });
    expect(host.querySelector<HTMLImageElement>('img[alt="clipboard.png"]')?.src).toBe("blob:clipboard-image");
    expect(host.textContent?.match(/clipboard\.png/g)).toHaveLength(1);
  });
  it("paints deltas before done, keeps receipts/files/documents after done, and rekeys the user row for retry", async () => {
    const direct = source(); mocks.fetch.mockResolvedValue(direct.response);
    await send("Improve the draft");
    const request = JSON.parse(mocks.fetch.mock.calls.at(-1)![1].body);
    expect(request).toMatchObject({ message: "Improve the draft", sessionId: "draft", assistantId: "writer" });
    await act(async () => { direct.send("user_message_saved", { id: "user-row" }); direct.send("reasoning", { text: "Reviewing the opening" }); direct.send("tool_start", { id: "tool", name: "searchKnowledge" }); direct.send("tool_result", { id: "tool" }); direct.send("assistant_message_saved", { id: "internal" }); direct.send("text_delta", { text: "A clearer opening" }); });
    expect(host.textContent).toContain("A clearer opening");
    expect(host.querySelector('[data-activity]')?.textContent).toContain("Reviewing the opening");
    expect(host.querySelector('[data-receipt]')).toBeNull();
    await act(async () => { direct.send("citation", { sources: [{ url: "https://example.com", title: "Reference" }] }); direct.send("attachments", { attachments: [{ fileId: "file", workspaceId: "workspace", path: "draft.txt", name: "draft.txt", mime: "text/plain", sizeBytes: 10 }] }); direct.send("document_payload", { toolUseId: "doc", title: "Source document", content: "Exact source" }); direct.send("assistant_message_saved", { id: "final" }); direct.send("done"); direct.close(); });
    expect(host.querySelector('[data-receipt]')?.textContent).toContain("searchKnowledge");
    expect(host.querySelector('[data-sources]')?.textContent).toBe("Reference");
    expect(host.querySelector('[data-files]')?.textContent).toBe("draft.txt");
    expect(host.textContent).toContain("Source document");
    expect(host.textContent?.match(/A clearer opening/g)).toHaveLength(1);
    const retry = source(); mocks.fetch.mockResolvedValue(retry.response);
    await act(async () => { host.querySelector<HTMLButtonElement>(`button[aria-label="${en.feedPage.tuningChat.retry}"]`)!.click(); });
    expect(JSON.parse(mocks.fetch.mock.calls.at(-1)![1].body).truncateFromMessageId).toBe("user-row");
  });
  it("reattaches a dropped POST and reconciles complete history without replaying the request", async () => {
    const direct = source(), follow = source();
    mocks.fetch.mockResolvedValueOnce(direct.response).mockResolvedValueOnce(follow.response);
    await send("Refine this");
    await act(async () => { direct.send("text_delta", { text: "Partial" }); direct.close(); });
    expect(mocks.fetch.mock.calls.at(-1)![0]).toMatch(/sessions\/draft\/stream$/);
    mocks.status.mockResolvedValue({ status: "running", turnId: null });
    await act(async () => { follow.send("status", { status: "running" }); follow.send("snapshot", { text: "Complete preview", reasoning: "Checking the source" }); follow.send("snapshot", { text: "Complete preview", reasoning: "Checking the source" }); });
    expect(host.textContent?.match(/Complete preview/g)).toHaveLength(1);
    mocks.messages.mockResolvedValue([row("u", "Refine this", "user"), row("a", "Full persisted answer")]);
    mocks.status.mockResolvedValue({ status: "idle", turnId: null });
    await act(async () => { follow.send("turn_completed"); follow.send("done"); follow.close(); });
    expect(host.textContent).toContain("Full persisted answer");
    expect(host.textContent).not.toContain("Complete preview");
    expect(mocks.fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });
  it("persists a live Always allow decision through the canonical resolver", async () => {
    const direct = source(); mocks.fetch.mockResolvedValueOnce(direct.response).mockResolvedValue(new Response("{}"));
    await send("Run the action");
    await act(async () => direct.send("tool_confirmation_required", { toolCallId: "tool", toolName: "writeExample", allowPersistentApproval: true }));
    await act(async () => host.querySelector<HTMLButtonElement>("[data-confirmation] button:nth-child(3)")!.click());
    expect(JSON.parse(mocks.fetch.mock.calls.at(-1)![1].body)).toEqual({ sessionId: "draft", toolCallId: "tool", decision: "always_allow" });
  });
  it("retains a failed Always allow card for retry", async () => {
    const direct = source(); mocks.fetch.mockResolvedValueOnce(direct.response).mockResolvedValue(new Response("{}", { status: 403 }));
    await send("Run the action");
    await act(async () => direct.send("tool_confirmation_required", { toolCallId: "tool", toolName: "writeExample", allowPersistentApproval: true }));
    await act(async () => host.querySelector<HTMLButtonElement>("[data-confirmation] button:nth-child(3)")!.click());
    expect(host.querySelector("[data-confirmation]")).not.toBeNull();
    expect(host.textContent).toContain(en.chatApp.confirmNotAllowed);
  });
  it("persists Always allow for a restored approval", async () => {
    mocks.pending.mockResolvedValue({ pending: null, toolConfirmation: { approvalId: "approval", toolName: "writeExample", input: {}, displayLines: [], allowPersistentApproval: true } });
    await mount("restored-draft");
    await act(async () => host.querySelector<HTMLButtonElement>("[data-confirmation] button:nth-child(3)")!.click());
    expect(mocks.approval).toHaveBeenCalledWith({ id: "approval", kind: "tool_invocation" }, "approved", undefined, { grantAlways: true });
  });
  it.each(["approve", "deny"])("submits %s for the exact live resolver and session", async decision => {
    const direct = source(); mocks.fetch.mockResolvedValueOnce(direct.response).mockResolvedValue(new Response("{}"));
    await send("Prepare the file");
    await act(async () => { direct.send("tool_confirmation_required", { toolCallId: "tool", approvalId: "approval", toolName: "sendFile", input: { fileId: "file" } }); });
    await act(async () => { host.querySelector<HTMLButtonElement>(`[data-confirmation] button:nth-child(${decision === "approve" ? 1 : 2})`)!.click(); });
    expect(mocks.fetch.mock.calls.at(-1)![0]).toMatch(/chat\/confirm$/);
    expect(JSON.parse(mocks.fetch.mock.calls.at(-1)![1].body)).toEqual({ sessionId: "draft", toolCallId: "tool", decision: decision === "approve" ? "allow" : "deny", ...(decision === "deny" ? { comment: "Keep the draft" } : {}) });
  });
  it("does not flush queued input on disconnect, or resend an input applied in the same terminal batch", async () => {
    const direct = source(), follow = source();
    mocks.fetch.mockImplementation(async (_url, init) => {
      if (init?.method === "POST") {
        const body = JSON.parse(init.body);
        return body.inputId ? new Response(frame("queued") + frame("done")) : direct.response;
      }
      return follow.response;
    });
    await send("Refine this");
    await send("Keep the example");
    const queuedBody = JSON.parse(mocks.fetch.mock.calls.at(-1)![1].body);
    expect(queuedBody.inputId).toBeTruthy();
    await act(async () => direct.close());
    expect(mocks.fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(2);
    mocks.messages.mockResolvedValue([row("u", "Refine this", "user"), row("q", "Keep the example", "user"), row("a", "Updated")]);
    // The authoritative fresh reads agree with the running legacy activity;
    // only the fourth (done) read observes idle.
    mocks.status.mockResolvedValueOnce({ status: "running", turnId: null })
      .mockResolvedValueOnce({ status: "running", turnId: null })
      .mockResolvedValueOnce({ status: "running", turnId: null });
    await act(async () => {
      follow.send("status", { status: "running" });
      follow.send("activity", { event: "input_applied", inputId: queuedBody.inputId, messageId: "q" });
      follow.send("activity", { event: "input_applied", inputId: queuedBody.inputId, messageId: "q" });
      follow.send("done"); follow.close();
      await new Promise(resolve => setTimeout(resolve, 10));
    });
    expect(mocks.fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(2);
    expect(host.textContent?.match(/Keep the example/g)).toHaveLength(1);
  });
  it("stops the server turn after reconnect before clearing the working state", async () => {
    const direct = source(), follow = source();
    mocks.fetch.mockResolvedValueOnce(direct.response).mockResolvedValueOnce(follow.response);
    await send("Refine this");
    await act(async () => direct.close());
    let resolve!: () => void;
    mocks.stop.mockImplementation(() => new Promise<{ stopped: boolean }>(done => { resolve = () => done({ stopped: true }); }));
    await act(async () => host.querySelector<HTMLButtonElement>(`button[title="${en.feedPage.tuningChat.stop}"]`)!.click());
    expect(mocks.stop).toHaveBeenCalledWith("draft", null);
    expect(host.querySelector(`button[title="${en.feedPage.tuningChat.stop}"]`)).not.toBeNull();
    mocks.fetch.mockImplementation(async () => new Response(frame("done")));
    await act(async () => resolve());
    // A followed turn settles on the relay's own completion, not locally.
    await act(async () => { follow.send("turn_completed", { reason: "stopped_by_user" }); follow.send("done"); follow.close(); });
    expect(host.querySelector(`button[title="${en.feedPage.tuningChat.stop}"]`)).toBeNull();
  });
  it("shows a recovery refusal without resending and permits an explicit GET retry", async () => {
    const direct = source();
    mocks.fetch.mockResolvedValueOnce(direct.response).mockResolvedValueOnce(new Response(null, { status: 403 }));
    await send("Refine this"); await act(async () => direct.close());
    expect(host.textContent).toContain(en.chat.turnReconnectFailed);
    mocks.fetch.mockImplementation(async () => new Response(frame("done")));
    await act(async () => [...host.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === en.feedPage.tuningChat.retry)!.click());
    expect(mocks.fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
  });
  it("restores suspended questions and generic approvals on re-entry", async () => {
    mocks.pending.mockResolvedValue({ pending: { approvalId: "question" }, toolConfirmation: { approvalId: "approval", toolName: "sendFile", input: {}, description: "Review the file", displayLines: [] } });
    await mount("other-draft");
    expect(host.querySelector('[data-question]')?.textContent).toBe("question");
    expect(host.querySelectorAll('[data-confirmation]')).toHaveLength(1);
    await act(async () => host.querySelector<HTMLButtonElement>('[data-confirmation] button')!.click());
    expect(mocks.approval).toHaveBeenCalledWith({ id: "approval", kind: "tool_invocation" }, "approved", undefined, undefined);
  });
  it("retains typed input while the initial status probe is unresolved", async () => {
    const probe = source(); mocks.fetch.mockResolvedValueOnce(probe.response);
    await mount("probing-draft");
    await send("Keep this typed request");
    expect(mocks.fetch.mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
    expect(host.querySelector("textarea")!.value).toBe("Keep this typed request");
    await act(async () => { probe.send("status", { status: "idle" }); probe.send("done"); probe.close(); });
    expect(host.querySelector<HTMLButtonElement>(`button[title="${en.feedPage.tuningChat.send}"]`)!.disabled).toBe(false);
  });
  it("does not let a late old transcript overwrite a new draft", async () => {
    let resolve!: (rows: DocSessionMessage[]) => void;
    mocks.messages.mockImplementationOnce(() => new Promise(done => { resolve = done; })).mockResolvedValue([row("new", "New draft reply")]);
    await mount("slow-draft");
    await mount("new-draft");
    await act(async () => resolve([row("old", "Old draft reply")]));
    expect(host.textContent).toContain("New draft reply"); expect(host.textContent).not.toContain("Old draft reply");
  });
});
