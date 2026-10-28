// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import { resetSurfaceCache, loadSurfaceCache, readSurfaceCache, isSurfaceCacheStale } from "@/lib/surface-cache";
import { chatSessionsCacheKey } from "@/lib/surface-prefetch";
import { ArchivedChatsSettings } from "../archived-chats-settings";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const workspace = vi.hoisted(() => ({ workspaceId: "workspace-1" }));
vi.mock("@/lib/workspace-context", () => ({ useWorkspaceContext: () => workspace }));
vi.mock("@/lib/user", () => ({ getUserInfo: () => ({ id: "viewer" }) }));
vi.mock("next/link", () => ({ default: (props: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props} /> }));
const api = vi.hoisted(() => ({ listPersonalSessions: vi.fn(), listWorkspaceSessions: vi.fn(), setSessionArchived: vi.fn() }));
vi.mock("@/lib/api/sessions", () => api);

const row = { id: "archived-1", title: "Earlier planning", appOrigin: "chat", channelId: "earlier", lastActive: "2026-10-01T01:00:00.000Z" };
let root: Root;
let host: HTMLDivElement;
const onOpenChat = vi.fn();
beforeEach(() => {
  vi.resetAllMocks();
  resetSurfaceCache();
  workspace.workspaceId = "workspace-1";
  api.listPersonalSessions.mockResolvedValue([row]);
  api.listWorkspaceSessions.mockResolvedValue([]);
  api.setSessionArchived.mockImplementation(async () => { api.listPersonalSessions.mockResolvedValue([]); api.listWorkspaceSessions.mockResolvedValue([]); });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
const settle = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); };
const button = (name: string) => {
  const result = Array.from(document.querySelectorAll<HTMLButtonElement>("button")).find(b => b.textContent?.trim() === name || b.getAttribute("aria-label") === name);
  if (!result) throw new Error(`Missing button: ${name}`);
  return result;
};
async function render() { await act(async () => root.render(<I18nProvider locale="en" dict={en}><ArchivedChatsSettings onOpenChat={onOpenChat} /></I18nProvider>)); }
async function manage() { await act(async () => button(en.chatApp.archiveManage).click()); await settle(); }

describe("[COMP:app-web/settings-chat-archive] archive manager", () => {
  it("opens from Manage and only loads history when requested", async () => {
    await render(); expect(api.listPersonalSessions).not.toHaveBeenCalled();
    await manage();
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(row.title);
    expect(api.listPersonalSessions).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "workspace-1", archived: true, strict: true }));
    expect(document.querySelector("time")?.dateTime).toBe(row.lastActive);
  });
  it("opens a saved chat and closes the manager without unarchiving", async () => {
    await render(); await manage();
    const link = document.querySelector<HTMLAnchorElement>('a[href*="s=archived-1"]')!;
    expect(link.getAttribute("href")).toBe("/w/workspace-1/chat?s=archived-1");
    link.addEventListener("click", event => event.preventDefault());
    await act(async () => link.click());
    expect(onOpenChat).toHaveBeenCalledOnce();
    expect(api.setSessionArchived).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
  it("unarchives and invalidates the active list even outside Chat", async () => {
    const key = chatSessionsCacheKey("workspace-1");
    await loadSurfaceCache(key, async () => []);
    await render(); await manage();
    await act(async () => button(en.chatApp.unarchiveChat).click()); await settle();
    expect(api.setSessionArchived).toHaveBeenCalledWith(row.id, false);
    expect(document.querySelector('a[href*="s=archived-1"]')).toBeNull();
    expect(document.body.textContent).toContain(en.chatApp.archiveEmpty);
    expect(readSurfaceCache(key).data).toEqual([]);
    expect(isSurfaceCacheStale(key)).toBe(true);
  });
  it("keeps failed unarchives visible with an error", async () => {
    api.setSessionArchived.mockRejectedValueOnce(new Error("offline"));
    await render(); await manage();
    await act(async () => button(en.chatApp.unarchiveChat).click());
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(en.chatApp.restoreFailed);
    expect(document.querySelector('a[href*="s=archived-1"]')).not.toBeNull();
  });
  it("shows list failures and retries instead of pretending history is empty", async () => {
    api.listPersonalSessions.mockRejectedValueOnce(new Error("offline"));
    await render(); await manage();
    expect(document.body.textContent).toContain(en.chatApp.archiveLoadFailed);
    expect(document.body.textContent).not.toContain(en.chatApp.archiveEmpty);
    await act(async () => button(en.chatApp.archiveRetry).click()); await settle();
    expect(document.querySelector('a[href*="s=archived-1"]')).not.toBeNull();
  });
  it("separates Workspace archives and preserves their deep link", async () => {
    api.listWorkspaceSessions.mockResolvedValue([row]);
    await render(); await manage();
    await act(async () => button(en.chatApp.viewWorkspace).click()); await settle();
    expect(api.listWorkspaceSessions).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "workspace-1", archived: true, strict: true }));
    expect(document.querySelector('a[href*="s=archived-1"]')?.getAttribute("href")).toBe("/w/workspace-1/chat?v=workspace&s=archived-1");
  });
  it("paginates older history without dropping the first page", async () => {
    api.listPersonalSessions.mockResolvedValueOnce(Array.from({ length: 50 }, (_, i) => ({ ...row, id: `archive-${i}`, title: `Planning ${i}` }))).mockResolvedValueOnce([row]);
    await render(); await manage();
    await act(async () => button(en.chatApp.moreChats).click()); await settle();
    expect(api.listPersonalSessions).toHaveBeenLastCalledWith(expect.objectContaining({ before: { id: "archive-49", lastActive: row.lastActive } }));
    expect(document.querySelectorAll("li")).toHaveLength(51);
  });
  it("Escape closes only the manager, and workspace switches cannot retain its contents", async () => {
    await render(); await manage();
    const outerEscape = vi.fn(); window.addEventListener("keydown", outerEscape);
    await act(async () => document.querySelector('[role="dialog"]')!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
    window.removeEventListener("keydown", outerEscape);
    expect(outerEscape).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await manage(); workspace.workspaceId = "workspace-2"; await render();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });
});
