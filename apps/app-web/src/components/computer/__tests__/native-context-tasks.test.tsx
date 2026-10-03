// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { en } from "@/lib/i18n/dictionaries/en";
import { NativeComputerPage } from "../native-computer-page";
import { nativeComputer, type ComputerControl } from "@/lib/native-computer";
import { fetchNativeContextTasks, type NativeContextTask } from "@/lib/api/native-computer";
import { resetSurfaceCache } from "@/lib/surface-cache";
vi.mock("@/lib/i18n/client", () => ({ useT: () => en }));
vi.mock("next/link", () => ({ default: ({ children }: { children: React.ReactNode }) => <span>{children}</span> }));
vi.mock("@/lib/api/native-computer", () => ({ fetchNativeContextTasks: vi.fn() }));
vi.mock("@/lib/chat-surface-data", () => ({ useChatSessionsData: () => ({ assistantsLoaded: true, assistants: [{ id: "a", name: "Assistant" }, { id: "b", name: "Other assistant" }], personal: [{ id: "c", assistantId: "a", title: "Conversation" }, { id: "d", assistantId: "a", title: "Second conversation" }, { id: "e", assistantId: "b", title: "Other conversation" }] }) }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

it("[COMP:app-web/native-computer] fences late task reads and resets selection across conversation, assistant and workspace changes", async () => {
  resetSurfaceCache();
  const pending = new Map<string, (rows: NativeContextTask[]) => void>();
  vi.mocked(fetchNativeContextTasks).mockImplementation((w, a, c) => new Promise(resolve => pending.set(`${w}/${a}/${c}`, resolve)));
  const control = vi.fn<ComputerControl>().mockResolvedValue({ ok: true, targets: [] });
  window.usebrianDesktop = { signIn: vi.fn(), computerControl: control };
  await nativeComputer.enter("w");
  const el = document.createElement("div"); document.body.append(el); const root = createRoot(el);
  const choose = async (label: string, name: string) => {
    await act(async () => (el.querySelector(`[aria-label="${label}"]`) as HTMLElement).click());
    await act(async () => Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(o => o.textContent === name)!.click());
  };
  const taskText = () => el.querySelector(`[aria-label="${en.nativeComputer.task}"]`)!.textContent;
  try {
    await act(async () => root.render(<NativeComputerPage workspaceId="w" />));
    expect(fetchNativeContextTasks).not.toHaveBeenCalled();
    await choose(en.nativeComputer.assistant, "Assistant");
    expect(fetchNativeContextTasks).not.toHaveBeenCalled();
    await choose(en.nativeComputer.conversation, "Conversation");
    expect(fetchNativeContextTasks).toHaveBeenLastCalledWith("w", "a", "c");
    await choose(en.nativeComputer.conversation, "Second conversation");
    await act(async () => pending.get("w/a/d")!([{ id: "new", title: "New task" }]));
    await choose(en.nativeComputer.task, "New task");
    await act(async () => pending.get("w/a/c")!([{ id: "old", title: "Old task" }]));
    expect(taskText()).toContain("New task");
    await choose(en.nativeComputer.conversation, "Conversation");
    expect(taskText()).not.toContain("New task");
    await choose(en.nativeComputer.task, "Old task");
    await choose(en.nativeComputer.assistant, "Other assistant");
    expect(taskText()).not.toContain("Old task");
    await choose(en.nativeComputer.conversation, "Other conversation");
    await act(async () => root.render(<NativeComputerPage workspaceId="other" />));
    await act(async () => pending.get("w/b/e")!([{ id: "late", title: "Late task" }]));
    expect(taskText()).not.toMatch(/Old task|New task|Late task/);
    expect(control.mock.calls.some(([m]) => m.type === "start" || m.type === "resume")).toBe(false);
  } finally {
    await act(async () => { root.unmount(); await nativeComputer.leave(); });
    el.remove(); delete window.usebrianDesktop; resetSurfaceCache();
  }
});

it("[COMP:app-web/native-computer] exposes retry for a cached cold task-load failure and recovers on success", async () => {
  resetSurfaceCache();
  vi.mocked(fetchNativeContextTasks).mockReset()
    .mockRejectedValueOnce(new Error("private backend details"))
    .mockResolvedValue([{ id: "t", title: "Recovered task" }]);
  const control = vi.fn<ComputerControl>().mockResolvedValue({ ok: true, targets: [] });
  window.usebrianDesktop = { signIn: vi.fn(), computerControl: control };
  await nativeComputer.enter("w");
  const el = document.createElement("div"); document.body.append(el); const root = createRoot(el);
  const choose = async (label: string, name: string) => {
    await act(async () => (el.querySelector(`[aria-label="${label}"]`) as HTMLElement).click());
    await act(async () => Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(o => o.textContent === name)!.click());
  };
  try {
    await act(async () => root.render(<NativeComputerPage workspaceId="w" />));
    await choose(en.nativeComputer.assistant, "Assistant");
    await choose(en.nativeComputer.conversation, "Conversation");
    expect(el.querySelector('[role="alert"]')?.textContent).toContain(en.tasksPage.loadFailed);
    expect(el.textContent).not.toContain("private backend details");
    expect(fetchNativeContextTasks).toHaveBeenCalledTimes(1);
    // Remounting must not hide the cached failure or require navigation/cache clearing.
    await act(async () => root.render(null));
    await act(async () => root.render(<NativeComputerPage workspaceId="w" />));
    await choose(en.nativeComputer.assistant, "Assistant");
    await choose(en.nativeComputer.conversation, "Conversation");
    expect(fetchNativeContextTasks).toHaveBeenCalledTimes(1);
    const retry = Array.from(el.querySelectorAll("button")).find(b => b.textContent === en.tasksPage.retry)!;
    expect(retry).toBeDefined();
    await act(async () => retry.click());
    expect(fetchNativeContextTasks).toHaveBeenCalledTimes(2);
    expect(fetchNativeContextTasks).toHaveBeenLastCalledWith("w", "a", "c");
    expect(el.querySelector('[role="alert"]')).toBeNull();
    await choose(en.nativeComputer.task, "Recovered task");
    expect(el.querySelector(`[aria-label="${en.nativeComputer.task}"]`)?.textContent).toContain("Recovered task");
    expect(control.mock.calls.some(([m]) => m.type === "start" || m.type === "resume")).toBe(false);
  } finally {
    await act(async () => { root.unmount(); await nativeComputer.leave(); });
    el.remove(); delete window.usebrianDesktop; resetSurfaceCache();
  }
});
