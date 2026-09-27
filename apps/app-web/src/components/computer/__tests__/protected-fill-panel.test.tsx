// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { en } from "@/lib/i18n/dictionaries/en";
import type { ComputerTask } from "@/lib/api/computer";
vi.mock("@/lib/i18n/client", () => ({ useT: () => en }));
vi.mock("@/lib/surface-prefetch", () => ({ crmRegionCacheKey: () => "crm:ws:lookups" }));
vi.mock("@/lib/surface-cache", () => ({ useCachedResource: () => ({ data: { contacts: [{ id: "contact", name: "PRIVATE_RECORD_NAME" }] } }) }));
vi.mock("@/lib/api/crm", () => ({ fetchCrmDirectories: vi.fn() }));
vi.mock("@/components/chrome/surface-skeleton", () => ({ ListSurfaceSkeleton: () => null }));
vi.mock("@/components/ui/searchable-select", () => ({ SearchableSelect: (p: { onValueChange: (s: string) => void; disabled: boolean }) => <button disabled={p.disabled} onClick={() => p.onValueChange("contact")}>record</button> }));
vi.mock("@/components/ui/checkbox", () => ({ Checkbox: (p: { checked: boolean; disabled: boolean; onCheckedChange: (b: boolean) => void }) => <button role="checkbox" aria-checked={p.checked} disabled={p.disabled} onClick={() => p.onCheckedChange(!p.checked)} /> }));
vi.mock("@/lib/runtime-public-config", () => ({ publicRuntimeConfig: () => ({ apiUrl: "https://api.example" }) }));
vi.mock("@/lib/auth-fetch", () => ({ authFetch: vi.fn() }));
vi.mock("@/lib/api/computer", () => ({ getComputerTask: vi.fn() }));
import { authFetch } from "@/lib/auth-fetch";
import { getComputerTask } from "@/lib/api/computer";
import { ProtectedFillPanel } from "../protected-fill-panel";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const task: ComputerTask = { taskId: "task", workspaceId: "ws", profileId: "profile", backend: "local", status: "running", createdAt: 1, connectionState: "connected", injectedSite: "example.com", destinationOrigin: "https://example.com" };

beforeEach(() => vi.clearAllMocks());
afterEach(() => vi.useRealTimers());

async function mountSelection() {
  const el = document.createElement("div"); const root = createRoot(el);
  const render = async (next: ComputerTask) => {
    await act(async () => root.render(<ProtectedFillPanel task={next} workspaceId="ws" sessionId="session" />));
  };
  await render(task);
  const button = (text: string) => [...el.querySelectorAll("button")].find(b => b.textContent === text)!;
  await act(async () => button("record").click());
  await act(async () => (el.querySelectorAll('[role="checkbox"]')[1] as HTMLButtonElement).click());
  await act(async () => (el.querySelectorAll('[role="checkbox"]')[7] as HTMLButtonElement).click());
  return { el, root, button, render };
}

describe("[COMP:app-web/protected-fill] human selection", () => {
  it("fails closed without authoritative origin and explains completion", async () => {
    const el = document.createElement("div"); const root = createRoot(el);
    await act(async () => root.render(<ProtectedFillPanel task={{ ...task, destinationOrigin: undefined }} workspaceId="ws" sessionId="session" />));
    expect(el.textContent).toContain(en.protectedFill.bindingRequired);
    expect(el.querySelectorAll("select")).toHaveLength(0);
    expect([...el.querySelectorAll("button")].find(b => b.textContent === en.protectedFill.issue)?.disabled).toBe(true);
    await act(async () => root.unmount());
  });
  it("requires consent, rechecks task scope, and copies only safe metadata", async () => {
    vi.mocked(getComputerTask).mockResolvedValue(task);
    vi.mocked(authFetch).mockResolvedValue({ status: 201, json: async () => ({ expiresAt: Date.now() + 110_000, references: [{ field: "email", referenceId: "a".repeat(43), value: "RAW_SENTINEL" }] }) } as Response);
    const copy = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText: copy }, configurable: true });
    const el = document.createElement("div"); const root = createRoot(el);
    await act(async () => root.render(<ProtectedFillPanel task={task} workspaceId="ws" sessionId="session" />));
    const button = (text: string) => [...el.querySelectorAll("button")].find(b => b.textContent === text)!;
    await act(async () => button("record").click());
    await act(async () => (el.querySelectorAll('[role="checkbox"]')[1] as HTMLButtonElement).click());
    expect(button(en.protectedFill.issue).disabled).toBe(true);
    await act(async () => (el.querySelectorAll('[role="checkbox"]')[7] as HTMLButtonElement).click());
    await act(async () => button(en.protectedFill.issue).click());
    expect(getComputerTask).toHaveBeenCalledWith("session");
    await act(async () => button(en.protectedFill.copy).click());
    expect(copy).toHaveBeenCalledWith(JSON.stringify({ references: [{ referenceId: "a".repeat(43), field: "email" }] }));
    expect(el.textContent).toContain(en.protectedFill.completion);
    await act(async () => root.unmount());
  });
  it.each([
    { ...task, taskId: "replacement" },
    { ...task, profileId: "another-profile" },
    { ...task, destinationOrigin: "https://other.example" },
    { ...task, destinationOrigin: undefined },
    { ...task, workspaceId: "another-workspace" },
    { ...task, status: "completed" as const },
    null,
  ])("does not issue after task binding changes: %j", async fresh => {
    vi.mocked(getComputerTask).mockResolvedValue(fresh);
    const { root, button, el } = await mountSelection();
    await act(async () => button(en.protectedFill.issue).click());
    expect(authFetch).not.toHaveBeenCalled();
    expect(el.textContent).toContain(en.protectedFill.error);
    await act(async () => root.unmount());
  });

  it("resets human consent when polling reveals a new origin", async () => {
    const { root, button, render, el } = await mountSelection();
    expect(button(en.protectedFill.issue).disabled).toBe(false);
    await render({ ...task, destinationOrigin: "https://new.example" });
    expect(el.textContent).toContain("https://new.example");
    expect(button(en.protectedFill.issue).disabled).toBe(true);
    expect([...el.querySelectorAll('[role="checkbox"]')].every(b => b.getAttribute("aria-checked") === "false")).toBe(true);
    await act(async () => root.unmount());
  });

  it("disables copied references at expiry without offering an unlock", async () => {
    vi.useFakeTimers();
    vi.mocked(getComputerTask).mockResolvedValue(task);
    vi.mocked(authFetch).mockResolvedValue({ status: 201, json: async () => ({ expiresAt: Date.now() + 120_000, references: [{ field: "email", referenceId: "a".repeat(43) }] }) } as Response);
    const { root, button, el } = await mountSelection();
    await act(async () => button(en.protectedFill.issue).click());
    expect(button(en.protectedFill.copy).disabled).toBe(false);
    await act(async () => vi.advanceTimersByTime(120_001));
    expect(button(en.protectedFill.copy).disabled).toBe(true);
    expect(el.textContent).toContain(en.protectedFill.expired);
    expect(authFetch).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());
  });

  it("never posts if the panel unmounts during task revalidation", async () => {
    let resolve!: (value: ComputerTask) => void;
    vi.mocked(getComputerTask).mockReturnValue(new Promise(r => { resolve = r; }));
    const { root, button } = await mountSelection();
    await act(async () => button(en.protectedFill.issue).click());
    await act(async () => root.unmount());
    await act(async () => resolve(task));
    expect(authFetch).not.toHaveBeenCalled();
  });

});
