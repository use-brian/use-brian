// @vitest-environment jsdom
/** [COMP:app-web/comment-assistant-picker] Page comment selection and upload reach real sends. */
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import { PageComments } from "../page-comments";
import type { CommentThread } from "@/lib/api/comments";
import type { DocSessionMessage } from "@/lib/api/sessions";

const mocks = vi.hoisted(() => ({
  create: vi.fn(), auth: vi.fn(), roster: vi.fn(), rows: [] as DocSessionMessage[],
}));
const voices = [
  { id: "a1", name: "Alpha", iconSeed: 1, kind: "primary", appType: null },
  { id: "a2", name: "Beta", iconSeed: 2, kind: "standard", appType: null },
];
vi.mock("@/lib/api/views", async original => ({ ...await original<typeof import("@/lib/api/views")>(), listWorkspaceAssistants: mocks.roster }));
vi.mock("@/lib/api/comments", async original => ({ ...await original<typeof import("@/lib/api/comments")>(), createCommentThread: mocks.create }));
vi.mock("@/lib/auth-fetch", () => ({ authFetch: mocks.auth }));
vi.mock("@/lib/api/sessions", async original => ({ ...await original<typeof import("@/lib/api/sessions")>(), fetchSessionMessages: async () => [...mocks.rows] }));
vi.mock("@/lib/offline/application-write-authority", () => ({ currentOfflineWriteAuthority: () => ({ apiOrigin: "https://api.example", viewerId: "u1", workspaceId: "ws1" }) }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let host: HTMLDivElement;
let calls: Array<Record<string, unknown>>;
const thread: CommentThread = { id: "thread-unified", pageId: "p1", workspaceId: "ws1", sessionId: "session-unified", anchorKind: "human_range", anchorBlockId: null, quote: null, resolvedAt: null, resolvedBy: null, createdBy: "u1", createdAt: "2026-01-01T00:00:00Z" };
beforeEach(() => {
  localStorage.clear();
  mocks.rows = [];
  calls = [];
  mocks.create.mockReset().mockResolvedValue(thread);
  mocks.roster.mockReset().mockResolvedValue(voices);
  mocks.auth.mockReset().mockImplementation(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/files/upload")) return { ok: true, json: async () => ({ files: [{ id: "file-one" }] }) };
    if (url.endsWith("/api/chat")) {
      const body = JSON.parse(init!.body as string);
      calls.push(body);
      mocks.rows.push({ id: `human-${calls.length}`, role: "user", content: body.message, timestamp: "2026-01-01T00:00:00Z", senderUserId: "u1", senderName: "Writer" },
        { id: `reply-${calls.length}`, role: "assistant", content: "Answer", timestamp: "2026-01-01T00:00:00Z", senderUserId: null, senderName: null, senderAssistantId: body.assistantId });
      return { ok: true, body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('event: text_delta\ndata: {"text":"Answer"}\n\n')); controller.close(); } }) };
    }
    return { ok: false, json: async () => ({}) };
  });
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  Element.prototype.scrollIntoView = vi.fn();
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); });
function Harness() {
  const [threads, setThreads] = useState<CommentThread[]>([]);
  return <PageComments pageId="p1" workspaceId="ws1" assistantId="a1" currentUser={{ id: "u1", name: "Writer" }} threads={threads} onPick={() => {}} onSubmitted={row => setThreads([row])} />;
}
async function mount(node = <Harness />) { await act(async () => root.render(<I18nProvider locale="en" dict={en}>{node}</I18nProvider>)); }
async function choose(name: string) {
  await act(async () => host.querySelector<HTMLButtonElement>(`[aria-label="${en.docPage.landing.assistantLabel}"]`)!.click());
  const option = [...document.querySelectorAll<HTMLElement>("[role=option]")].find(option => option.textContent === name)!;
  await act(async () => option.dispatchEvent(new MouseEvent("mousemove", { bubbles: true })));
  await act(async () => option.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true })));
  await act(async () => option.click());
  expect(host.querySelector(`[aria-label="${en.docPage.landing.assistantLabel}"]`)!.textContent).toContain(name);
}
async function type(text: string) {
  await act(async () => { const input = host.querySelector("textarea")!; Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, text); input.dispatchEvent(new Event("input", { bubbles: true })); });
}

describe("[COMP:app-web/comment-assistant-picker] Unified Page composer", () => {
  it("addresses the selected voice on the first comment and a later reply without changing session", async () => {
    await mount();
    expect(host.querySelector(`[aria-label="${en.attachments.attach}"]`)).not.toBeNull();
    await choose("Beta");
    await type("Please draft this page");
    await act(async () => host.querySelector<HTMLButtonElement>(`[aria-label="${en.comments.send}"]`)!.click());
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ assistantId: "a2" }));
    expect(calls[0]).toMatchObject({ assistantId: "a2", sessionId: thread.sessionId, docViewId: "p1" });
    await choose("Alpha");
    expect([...host.querySelectorAll("span.font-semibold")].map(node => node.textContent)).toContain("Beta");
    await type("Continue with the same page");
    await act(async () => host.querySelector<HTMLButtonElement>(`[aria-label="${en.comments.send}"]`)!.click());
    expect(calls[1]).toMatchObject({ assistantId: "a1", sessionId: thread.sessionId, docViewId: "p1" });
    expect(mocks.create).toHaveBeenCalledOnce();
  });
  it("enables AI for picked files and prevents a plain post from discarding staged uploads", async () => {
    const onSubmitted = vi.fn();
    await mount(<PageComments pageId="p2" workspaceId="ws1" assistantId="a1" threads={[]} onPick={() => {}} onSubmitted={onSubmitted} />);
    await act(async () => { const input = host.querySelector<HTMLInputElement>('input[type="file"]')!; Object.defineProperty(input, "files", { value: [new File(["notes"], "notes.txt", { type: "text/plain" })] }); input.dispatchEvent(new Event("change", { bubbles: true })); });
    expect(host.textContent).toContain("notes.txt");
    const toggle = host.querySelector<HTMLButtonElement>(`[aria-label="${en.comments.aiReply}"]`)!;
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    await type("Use my notes");
    await act(async () => toggle.click());
    expect(host.textContent).toContain("notes.txt");
    expect(host.textContent).toContain(en.comments.attachmentsNeedAi);
    expect(host.querySelector<HTMLButtonElement>(`[aria-label="${en.comments.send}"]`)!.disabled).toBe(true);
    await act(async () => toggle.click());
    await act(async () => host.querySelector<HTMLButtonElement>(`[aria-label="${en.comments.send}"]`)!.click());
    expect(onSubmitted).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ aiReply: true, fileIds: ["file-one"] }));
  });
  it("does not add selection or upload capabilities to read-only comments", async () => {
    await mount(<PageComments pageId="readonly" workspaceId="ws1" threads={[]} onPick={() => {}} onSubmitted={() => {}} />);
    expect(host.querySelector("textarea")).toBeNull();
    expect(host.querySelector(`[aria-label="${en.attachments.attach}"]`)).toBeNull();
    expect(mocks.roster).not.toHaveBeenCalled();
  });
});
