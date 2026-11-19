// @vitest-environment jsdom
/** [COMP:app-web/conversation-visibility] Settings actions obey current server capabilities. */
import React, { act, createContext, useContext } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getDictionary } from "@/lib/i18n/dictionaries";
const fixture = vi.hoisted(() => ({ offline: false, save: vi.fn(), cap: vi.fn(), project: vi.fn(), refresh: vi.fn() }));
vi.mock("@/lib/i18n/client", () => ({ useT: () => getDictionary("en") }));
vi.mock("@/lib/offline/use-offline-sync", () => ({ useIsOffline: () => fixture.offline }));
vi.mock("@/lib/api/sessions", () => ({ getChatSessionSummary: async () => null, updateConversationVisibility: (...a: unknown[]) => fixture.save(...a), raiseConversationCap: (...a: unknown[]) => fixture.cap(...a), moveConversationProject: (...a: unknown[]) => fixture.project(...a) }));
vi.mock("@/lib/api/context-scopes", () => ({ listContextProjects: async () => [] }));
vi.mock("@/lib/chat-session-events", () => ({ dispatchChatSessionsRefresh: (...a: unknown[]) => fixture.refresh(...a) }));
vi.mock("@/lib/api/mentions", () => ({ getDirectoryViewerId: () => "viewer", readWorkspaceMemberDirectory: async () => ({ members: [{ userId: "mate", name: "Fixture teammate" }] }) }));
vi.mock("@/lib/offline/application-write-authority", () => ({ currentOfflineWriteAuthority: () => ({ viewerId: "viewer", workspaceId: "workspace", apiOrigin: "fixture", applicationId: "native" }), sameOfflineWriteAuthority: (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b) }));
vi.mock("@/components/ui/popover", () => {
  const Context = createContext({ open: false, onOpenChange: (_: boolean) => {} });
  return {
    Popover: ({ open, onOpenChange, children }: { open: boolean; onOpenChange: (open: boolean) => void; children: React.ReactNode }) => <Context.Provider value={{ open, onOpenChange }}>{children}</Context.Provider>,
    PopoverTrigger: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => { const c = useContext(Context); return <button {...props} onClick={() => c.onOpenChange(!c.open)}>{children}</button>; },
    PopoverContent: ({ children }: { children: React.ReactNode }) => useContext(Context).open ? <div>{children}</div> : null,
  };
});
import { ConversationVisibilityControl } from "../conversation-visibility-control";
import type { DocSession } from "@/lib/api/sessions";
const session: DocSession = { id: "session", title: "Fixture", channelId: "channel", lastActive: "2026-11-18T00:00:00Z", appOrigin: "chat", conversationVisibility: "workspace", conversationVisibilityVersion: 4, conversationCap: "internal", conversationCompartments: [], conversationProjectIds: [], participantUserIds: ["mate"], capabilities: { canNarrow: true, canWiden: false, canManageParticipants: true, canRaiseCap: false, canMoveProject: false } };
let root: Root, container: HTMLDivElement;
const button = (name: string) => [...container.querySelectorAll("button")].find(b => b.textContent === name || b.getAttribute("aria-label") === name)!;
const click = async (name: string) => { await act(async () => { button(name).click(); }); };
async function mount(row: DocSession) { await act(async () => { root.render(<ConversationVisibilityControl session={row} workspaceId="workspace" />); }); }
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  fixture.offline = false; vi.clearAllMocks(); fixture.save.mockResolvedValue({ ...session, conversationVisibilityVersion: 5 });
  fixture.cap.mockResolvedValue({ ...session, conversationVisibilityVersion: 5, conversationCap: "confidential" });
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
});
afterEach(() => { act(() => root.unmount()); container.remove(); });
describe("conversation visibility controls", () => {
  it("omits controls until the server supplies activated metadata", async () => {
    await mount({ ...session, conversationVisibility: undefined, capabilities: undefined }); expect(container.textContent).toBe("");
  });
  it("cannot widen a private-by-kind chat even if unrelated management flags exist", async () => {
    await mount({ ...session, conversationVisibility: "private_by_kind", capabilities: { ...session.capabilities!, canWiden: true } });
    await click("Conversation visibility");
    expect(container.textContent).toContain("This one-to-one chat stays private");
    expect(button("Workspace")).toBeUndefined(); expect(button("Save visibility")).toBeUndefined();
  });
  it("lets a starter narrow with the server version and prevents widening", async () => {
    await mount(session); await click("Conversation visibility"); await click("Private"); await click("Save visibility");
    expect(fixture.save).toHaveBeenCalledWith("session", { expectedVersion: 4, visibility: "configured_private", participantUserIds: ["mate"] });
    expect(fixture.refresh).toHaveBeenCalledWith("workspace");
  });
  it("offers widening only with canWiden and submits the configured participants", async () => {
    await mount({ ...session, conversationVisibility: "configured_private", capabilities: { ...session.capabilities!, canWiden: true } });
    await click("Conversation visibility"); await click("Workspace"); await click("Save visibility");
    expect(fixture.save.mock.calls[0][1]).toMatchObject({ visibility: "workspace", expectedVersion: 4 });
  });
  it("offers only cap raises and sends the canonical expected version", async () => {
    await mount({ ...session, capabilities: { ...session.capabilities!, canRaiseCap: true } }); await click("Conversation visibility");
    expect(button("Public")).toBeUndefined(); expect(button("Internal")).toBeUndefined(); await click("Confidential");
    expect(fixture.cap).toHaveBeenCalledWith("session", { expectedVersion: 4, cap: "confidential" });
  });
  it("revalidates a conflict and keeps the operation-local error visible", async () => {
    fixture.save.mockRejectedValue({ status: 409 }); await mount(session); await click("Conversation visibility"); await click("Save visibility");
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Visibility changed elsewhere");
    expect(fixture.refresh).toHaveBeenCalledWith("workspace");
  });
  it("retained offline metadata cannot authorize any settings write", async () => {
    fixture.offline = true; await mount(session); await click("Conversation visibility");
    expect(button("Save visibility").disabled).toBe(true); expect(button("Private").disabled).toBe(true);
    await click("Save visibility"); expect(fixture.save).not.toHaveBeenCalled();
  });
});
