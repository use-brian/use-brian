// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { en } from "@/lib/i18n/dictionaries/en";
import { NativeComputerPage } from "../native-computer-page";
import { nativeComputer, type ComputerControl } from "@/lib/native-computer";
import { createNativeContextTask, fetchNativeContextTasks, type NativeContextTask } from "@/lib/api/native-computer";
import { promptDialog } from "@/components/ui/prompt-dialog";
import { resetSurfaceCache } from "@/lib/surface-cache";
const viewer = vi.hoisted(() => ({ id: "owner" }));
vi.mock("@/lib/user", () => ({ getUserInfo: () => viewer }));
vi.mock("@/lib/i18n/client", () => ({ useT: () => en }));
vi.mock("next/link", () => ({ default: ({ children }: { children: React.ReactNode }) => <span>{children}</span> }));
vi.mock("@/lib/api/native-computer", () => ({ fetchNativeContextTasks: vi.fn(), createNativeContextTask: vi.fn() }));
vi.mock("@/components/ui/prompt-dialog", () => ({ promptDialog: vi.fn() }));
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

it("[COMP:app-web/native-computer] explicitly creates a task without a desktop or device and selects only a readable refreshed task", async () => {
  resetSurfaceCache(); delete window.usebrianDesktop;
  vi.mocked(fetchNativeContextTasks).mockReset().mockResolvedValue([]);
  vi.mocked(createNativeContextTask).mockReset().mockImplementation(async () => {
    vi.mocked(fetchNativeContextTasks).mockResolvedValue([{ id: "created", title: "My task" }]);
    return { id: "created", title: "My task" };
  });
  vi.mocked(promptDialog).mockReset().mockResolvedValue("  My task  ");
  const el = document.createElement("div"); document.body.append(el); const root = createRoot(el);
  const choose = async (label: string, name: string) => {
    await act(async () => (el.querySelector(`[aria-label="${label}"]`) as HTMLElement).click());
    await act(async () => Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(o => o.textContent === name)!.click());
  };
  const button = () => Array.from(el.querySelectorAll("button")).find(b => b.textContent === en.nativeComputer.createTask)!;
  try {
    await act(async () => root.render(<NativeComputerPage workspaceId="w" />));
    expect(button().disabled).toBe(true);
    await choose(en.nativeComputer.assistant, "Assistant");
    await choose(en.nativeComputer.conversation, "Conversation");
    expect(createNativeContextTask).not.toHaveBeenCalled();
    await act(async () => button().click());
    expect(createNativeContextTask).toHaveBeenCalledExactlyOnceWith("w", "a", "c", "My task");
    expect(el.querySelector(`[aria-label="${en.nativeComputer.task}"]`)?.textContent).toContain("My task");
    vi.mocked(createNativeContextTask).mockRejectedValueOnce(new Error("private denial"));
    await act(async () => button().click());
    expect(el.textContent).toContain(en.nativeComputer.createTaskFailed);
    expect(el.textContent).not.toContain("private denial");
    // A successful insert whose refreshed row is no longer readable is not selected.
    vi.mocked(createNativeContextTask).mockResolvedValueOnce({ id: "hidden", title: "Hidden task" });
    await act(async () => button().click());
    expect(el.textContent).not.toContain("Hidden task");
    expect(el.textContent).toContain(en.nativeComputer.createTaskFailed);
  } finally { await act(async () => root.unmount()); el.remove(); resetSurfaceCache(); viewer.id = "owner"; }
});

it.each(["prompt", "success", "failure"].flatMap(mode => ["conversation", "assistant", "workspace", "viewer"].map(change => ({ mode, change }))))("[COMP:app-web/native-computer] fences stale $mode creation after $change changes", async ({ mode, change }) => {
  resetSurfaceCache(); delete window.usebrianDesktop;
  vi.mocked(fetchNativeContextTasks).mockReset().mockResolvedValue([]);
  let resolvePrompt!: (s: string) => void;
  let resolveCreate!: (t: NativeContextTask) => void;
  let rejectCreate!: (e: Error) => void;
  vi.mocked(promptDialog).mockReset().mockImplementation(() => mode === "prompt" ? new Promise(resolve => { resolvePrompt = resolve; }) : Promise.resolve("Task"));
  vi.mocked(createNativeContextTask).mockReset().mockImplementation(() => new Promise((resolve, reject) => { resolveCreate = resolve; rejectCreate = reject; }));
  const el = document.createElement("div"); document.body.append(el); const root = createRoot(el);
  const choose = async (label: string, name: string) => {
    await act(async () => (el.querySelector(`[aria-label="${label}"]`) as HTMLElement).click());
    await act(async () => Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(o => o.textContent === name)!.click());
  };
  try {
    await act(async () => root.render(<NativeComputerPage workspaceId="w" />));
    await choose(en.nativeComputer.assistant, "Assistant");
    await choose(en.nativeComputer.conversation, "Conversation");
    await act(async () => Array.from(el.querySelectorAll("button")).find(b => b.textContent === en.nativeComputer.createTask)!.click());
    if (change === "conversation") {
      await choose(en.nativeComputer.conversation, "Second conversation");
      await choose(en.nativeComputer.conversation, "Conversation"); // A -> B -> A remains stale.
    } else if (change === "assistant") await choose(en.nativeComputer.assistant, "Other assistant");
    else if (change === "workspace") await act(async () => root.render(<NativeComputerPage workspaceId="other" />));
    else viewer.id = "other-owner"; // Even before the next account-change render.
    const calls = vi.mocked(fetchNativeContextTasks).mock.calls.length;
    await act(async () => {
      if (mode === "prompt") resolvePrompt("Stale title");
      else if (mode === "success") resolveCreate({ id: "late", title: "Late task" });
      else rejectCreate(new Error("private failure"));
    });
    if (mode === "prompt") expect(createNativeContextTask).not.toHaveBeenCalled();
    expect(fetchNativeContextTasks).toHaveBeenCalledTimes(calls);
    expect(el.textContent).not.toContain("Late task");
    expect(el.textContent).not.toContain(en.nativeComputer.createTaskFailed);
  } finally { await act(async () => root.unmount()); el.remove(); resetSurfaceCache(); viewer.id = "owner"; }
});

it.each(["before", "after"])("[COMP:app-web/native-computer] post-create refresh detaches the pending initial read resolving %s the fresh read", async order => {
  resetSurfaceCache(); delete window.usebrianDesktop;
  let oldRead!: (rows: NativeContextTask[]) => void;
  let freshRead!: (rows: NativeContextTask[]) => void;
  vi.mocked(fetchNativeContextTasks).mockReset()
    .mockImplementationOnce(() => new Promise(resolve => { oldRead = resolve; }))
    .mockImplementationOnce(() => new Promise(resolve => { freshRead = resolve; }));
  vi.mocked(promptDialog).mockReset().mockResolvedValue("Created task");
  vi.mocked(createNativeContextTask).mockReset().mockResolvedValue({ id: "created", title: "Created task" });
  const el = document.createElement("div"); document.body.append(el); const root = createRoot(el);
  const choose = async (label: string, name: string) => {
    await act(async () => (el.querySelector(`[aria-label="${label}"]`) as HTMLElement).click());
    await act(async () => Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(o => o.textContent === name)!.click());
  };
  try {
    await act(async () => root.render(<NativeComputerPage workspaceId="w" />));
    await choose(en.nativeComputer.assistant, "Assistant");
    await choose(en.nativeComputer.conversation, "Conversation");
    expect(fetchNativeContextTasks).toHaveBeenCalledTimes(1);
    await act(async () => Array.from(el.querySelectorAll("button")).find(b => b.textContent === en.nativeComputer.createTask)!.click());
    expect(createNativeContextTask).toHaveBeenCalledExactlyOnceWith("w", "a", "c", "Created task");
    expect(fetchNativeContextTasks).toHaveBeenCalledTimes(2);
    if (order === "before") await act(async () => oldRead([]));
    await act(async () => freshRead([{ id: "created", title: "Created task" }]));
    if (order === "after") await act(async () => oldRead([]));
    expect(el.querySelector(`[aria-label="${en.nativeComputer.task}"]`)?.textContent).toContain("Created task");
    expect(el.textContent).not.toContain(en.nativeComputer.createTaskFailed);
    expect(fetchNativeContextTasks).toHaveBeenCalledTimes(2);
  } finally { await act(async () => root.unmount()); el.remove(); resetSurfaceCache(); }
});
