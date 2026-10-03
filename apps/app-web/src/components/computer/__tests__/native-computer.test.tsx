// @vitest-environment jsdom
import { act, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { en } from "@/lib/i18n/dictionaries/en";
import { NativeComputerCoordinator } from "../native-computer-coordinator";
import { NativeComputerPage } from "../native-computer-page";
import { nativeComputer, type NativeStatus, type ComputerControl } from "@/lib/native-computer";
vi.mock("@/lib/i18n/client", () => ({ useT: () => en }));
vi.mock("next/link", () => ({ default: ({ children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props}>{children}</a> }));
const setup = vi.hoisted(() => ({ populated: false }));
vi.mock("@/lib/chat-surface-data", () => ({ useChatSessionsData: () => ({ assistantsLoaded: true, assistants: setup.populated ? [{ id: "a", name: "Assistant" }] : [], personal: setup.populated ? [{ id: "c", assistantId: "a", title: "Conversation" }] : [] }) }));
vi.mock("@/lib/surface-cache", () => ({ useCachedResource: () => ({ data: setup.populated ? [{ id: "t", title: "Task" }] : [] }) }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => { setup.populated = false; delete window.usebrianDesktop; });
it("[COMP:app-web/native-computer] persistent owner revokes on workspace change and Stop stays local", async () => {
  const control = vi.fn<ComputerControl>().mockResolvedValue({ ok: true });
  window.usebrianDesktop = { signIn: vi.fn(), computerControl: control };
  const el = document.createElement("div"); const root = createRoot(el);
  try {
    await act(async () => root.render(<StrictMode><NativeComputerCoordinator workspaceId="w" /><NativeComputerPage workspaceId="w" /></StrictMode>));
    expect(control.mock.calls.some(([m]) => m.type === "start" || m.type === "resume")).toBe(false);
    expect(el.textContent).toContain(en.nativeComputer.title);
    const start = Array.from(el.querySelectorAll("button")).find(b => b.textContent === en.nativeComputer.start)!;
    expect(start.disabled).toBe(true);
    const stop = Array.from(el.querySelectorAll("button")).find(b => b.textContent === en.nativeComputer.stop)!;
    await act(async () => stop.click());
    expect(control).toHaveBeenLastCalledWith({ type: "stop" });
    await act(async () => root.render(<NativeComputerCoordinator workspaceId="other" />));
    expect(control).toHaveBeenCalledWith({ type: "disconnect" });
    expect(control).toHaveBeenCalledWith({ type: "workspace-changed", workspaceId: "other" });
    expect(control.mock.calls.some(([m]) => m.type === "start" || m.type === "resume")).toBe(false);
  } finally { await act(async () => root.unmount()); }
});
it("[COMP:app-web/native-computer] browser-only setup never sends native requests", async () => {
  const el = document.createElement("div"); const root = createRoot(el);
  try {
    await act(async () => root.render(<NativeComputerPage workspaceId="w" />));
    expect(el.textContent).toContain(en.nativeComputer.unavailable);
    expect(el.querySelector("textarea")).toBeNull();
  } finally { await act(async () => root.unmount()); }
});

it("[COMP:app-web/native-computer] inspector renders malicious AX as text, redacts secure nodes and bounds rows", async () => {
  const malicious = '<img src=x onerror="alert(1)"><script>attack()</script>';
  const status = { state: "stopped", epoch: 2, identity: { workspaceId: "w" }, capabilities: {} } as NativeStatus;
  const control = vi.fn<ComputerControl>().mockResolvedValue({ ok: true, status });
  window.usebrianDesktop = { signIn: vi.fn(), computerControl: control };
  await nativeComputer.enter("w");
  control.mockResolvedValueOnce({ ok: true, status, inspection: { id: "snapshot-id", capturedAt: 1, completeness: "partial", nodes: Array.from({ length: 501 }, (_, i) => ({ ref: String(i), role: "textbox", name: i === 0 ? malicious : "secure-name", value: i === 0 ? "public-value" : "secure-value", enabled: true, sensitive: i !== 0 })) } });
  await nativeComputer.start("start", { workspaceId: "w", assistantId: "a", conversationId: "c", taskId: "t", goal: "Read", target: { appId: "a", processId: 1, processInstanceId: "p", windowId: "w", windowInstanceId: "wi" }, allowControl: false, allowCapture: false });
  const el = document.createElement("div"); const root = createRoot(el);
  try {
    await act(async () => root.render(<NativeComputerPage workspaceId="w" />));
    expect(el.textContent).toContain(malicious); expect(el.querySelector("img, script")).toBeNull();
    expect(el.textContent).toContain(en.nativeComputer.inspectorRedacted);
    expect(el.textContent).not.toContain("secure-name"); expect(el.textContent).not.toContain("secure-value");
    expect(el.querySelectorAll("tbody tr")).toHaveLength(500);
    expect(control.mock.calls.filter(([m]) => m.type === "targets")).toHaveLength(0);
    expect(el.textContent).toContain(en.nativeComputer.inspectorStatic);
    expect(el.textContent).toContain("snapshot-id"); expect(el.textContent).toContain(en.nativeComputer.inspectorCompleteness.partial);
    await act(async () => root.render(<NativeComputerPage workspaceId="other" />));
    expect(el.querySelector("table")).toBeNull();
  } finally { await act(async () => { root.unmount(); await nativeComputer.leave(); }); }
});

it('[COMP:app-web/native-computer] distinguishes same-app document titles as plain text', async () => {
  const malicious = '<img src=x onerror=alert(1)>';
  const base = { appId: 'com.apple.TextEdit', processId: 1, processInstanceId: 'p' };
  const targets = [{ ...base, windowId: 'w1', windowInstanceId: 'wi1', displayName: malicious }, { ...base, windowId: 'w2', windowInstanceId: 'wi2', displayName: 'Second document' }];
  const control = vi.fn<ComputerControl>().mockResolvedValue({ ok: true, targets });
  window.usebrianDesktop = { signIn: vi.fn(), computerControl: control };
  await nativeComputer.enter('w');
  const el = document.createElement('div'); document.body.append(el); const root = createRoot(el);
  try {
    await act(async () => root.render(<NativeComputerPage workspaceId="w" />));
    const picker = el.querySelector(`[aria-label="${en.nativeComputer.target}"]`) as HTMLElement;
    await act(async () => picker.click());
    expect(document.body.textContent).toContain(malicious);
    expect(document.body.textContent).toContain('Second document');
    expect(document.body.querySelector('img, script')).toBeNull();
  } finally { await act(async () => { root.unmount(); await nativeComputer.leave(); }); el.remove(); }
});

it.each(["active", "awaiting_local_consent", "awaiting_action_approval"] as const)("[COMP:app-web/native-computer] Permissions is disabled during %s while Stop remains available", async phase => {
  const status = { state: phase, capabilities: {} } as NativeStatus;
  const control = vi.fn<ComputerControl>().mockResolvedValue({ ok: true, status });
  window.usebrianDesktop = { signIn: vi.fn(), computerControl: control };
  await nativeComputer.enter("w");
  const el = document.createElement("div"); const root = createRoot(el);
  try {
    await act(async () => root.render(<NativeComputerPage workspaceId="w" />));
    const button = (label: string) => Array.from(el.querySelectorAll("button")).find(b => b.textContent === label)!;
    expect(button(en.nativeComputer.permissions).disabled).toBe(true);
    expect(button(en.nativeComputer.checkReadiness).disabled).toBe(true);
    await act(async () => button(en.nativeComputer.permissions).click());
    expect(control).not.toHaveBeenCalledWith({ type: "permissions" });
    expect(button(en.nativeComputer.stop).disabled).toBe(false);
    await act(async () => button(en.nativeComputer.stop).click());
    expect(control).toHaveBeenLastCalledWith({ type: "stop" });
  } finally { await act(async () => { root.unmount(); await nativeComputer.leave(); }); }
});

it("[COMP:app-web/native-computer] Permissions is disabled while Start waits before an active status", async () => {
  setup.populated = true;
  const target = { appId: "app", processId: 1, processInstanceId: "p", windowId: "win", windowInstanceId: "wi", displayName: "Document" };
  const status = { state: "ready", capabilities: {} } as NativeStatus;
  let finish!: (value: { ok: boolean }) => void;
  const control = vi.fn<ComputerControl>().mockImplementation(m => m.type === "start" ? new Promise(resolve => { finish = resolve; }) : Promise.resolve({ ok: true, status, targets: [target] }));
  window.usebrianDesktop = { signIn: vi.fn(), computerControl: control };
  await nativeComputer.enter("w");
  const el = document.createElement("div"); document.body.append(el); const root = createRoot(el);
  try {
    await act(async () => root.render(<NativeComputerPage workspaceId="w" />));
    for (const [label, name] of [[en.nativeComputer.assistant, "Assistant"], [en.nativeComputer.conversation, "Conversation"], [en.nativeComputer.task, "Task"], [en.nativeComputer.target, "Document"]]) {
      await act(async () => (el.querySelector(`[aria-label="${label}"]`) as HTMLElement).click());
      await act(async () => (Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(option => option.textContent?.includes(name))!).click());
    }
    await act(async () => {
      const textarea = el.querySelector("textarea")!;
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "Read document");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const button = (label: string) => Array.from(el.querySelectorAll("button")).find(b => b.textContent === label)!;
    expect(button(en.nativeComputer.start).disabled).toBe(false);
    await act(async () => button(en.nativeComputer.start).click());
    expect(control).toHaveBeenLastCalledWith(expect.objectContaining({ type: "start" }));
    expect(button(en.nativeComputer.permissions).disabled).toBe(true);
    expect(button(en.nativeComputer.checkReadiness).disabled).toBe(true);
    await act(async () => button(en.nativeComputer.permissions).click());
    expect(control).not.toHaveBeenCalledWith({ type: "permissions" });
    await act(async () => button(en.nativeComputer.stop).click());
    expect(control).toHaveBeenLastCalledWith({ type: "stop" });
    await act(async () => finish({ ok: true }));
  } finally { await act(async () => { root.unmount(); await nativeComputer.leave(); }); el.remove(); }
});

it("[COMP:app-web/native-computer] explicit readiness remains available when control is unavailable and reports only admission", async () => {
  let finish!: (value: Awaited<ReturnType<ComputerControl>>) => void;
  const status = { state: "unavailable", capabilities: {} } as NativeStatus;
  const control = vi.fn<ComputerControl>().mockImplementation(m => m.type === "check-readiness" ? new Promise(resolve => { finish = resolve; }) : Promise.resolve({ ok: true, status }));
  window.usebrianDesktop = { signIn: vi.fn(), computerControl: control };
  await nativeComputer.enter("w");
  const el = document.createElement("div"); const root = createRoot(el);
  try {
    await act(async () => root.render(<NativeComputerPage workspaceId="w" />));
    const button = (label: string) => Array.from(el.querySelectorAll("button")).find(b => b.textContent === label)!;
    expect(control).not.toHaveBeenCalledWith({ type: "check-readiness" });
    expect(button(en.nativeComputer.checkReadiness).disabled).toBe(false);
    await act(async () => button(en.nativeComputer.checkReadiness).click());
    expect(control).toHaveBeenCalledWith({ type: "check-readiness" });
    expect(button(en.nativeComputer.checkReadiness).disabled).toBe(true);
    expect(button(en.nativeComputer.stop).disabled).toBe(false);
    await act(async () => finish({ ok: true, readiness: { helperAdmitted: true, capabilities: status.capabilities } }));
    expect(el.textContent).toContain(en.nativeComputer.readinessPassed);
    expect(el.textContent).toContain(en.nativeComputer.states.unavailable);
    await act(async () => button(en.nativeComputer.checkReadiness).click());
    await act(async () => finish({ ok: false, error: "private raw error" }));
    expect(el.textContent).toContain(en.nativeComputer.readinessFailed);
    expect(el.textContent).not.toContain("private raw error");
    await act(async () => button(en.nativeComputer.stop).click());
    expect(el.textContent).not.toContain(en.nativeComputer.readinessFailed);
    expect(control.mock.calls.some(([m]) => ["start", "resume", "permissions"].includes(m.type))).toBe(false);
  } finally { await act(async () => { root.unmount(); await nativeComputer.leave(); }); }
});

const fullCapabilities: NativeStatus["capabilities"] = {
  protocol: "native-computer-v1", platform: "darwin", axRead: true,
  semanticActions: true, windowCapture: true, input: true,
  accessibilityPermission: "granted", capturePermission: "granted", limitations: [],
};
async function fillInspectorForm(el: HTMLElement) {
  for (const [label, name] of [[en.nativeComputer.assistant, "Assistant"], [en.nativeComputer.conversation, "Conversation"], [en.nativeComputer.task, "Task"], [en.nativeComputer.target, "Document"]]) {
    await act(async () => (el.querySelector(`[aria-label="${label}"]`) as HTMLElement).click());
    await act(async () => Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(option => option.textContent?.includes(name))!.click());
  }
  await act(async () => {
    const textarea = el.querySelector("textarea")!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea, "Read document");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
it.each([true, false])("[COMP:app-web/native-computer] observation-only caps (axRead=%s) never request control or capture and retain errors", async axRead => {
  setup.populated = true;
  const status: NativeStatus = { protocol: "native-computer-v1", state: "ready", epoch: 1, capabilities: { ...fullCapabilities, axRead, semanticActions: false, windowCapture: false, input: false } };
  const target = { appId: "app", processId: 1, processInstanceId: "p", windowId: "win", windowInstanceId: "wi", displayName: "Document" };
  const control = vi.fn<ComputerControl>().mockImplementation(async m => m.type === "start" ? { ok: false, error: "private inspector error", status } : { ok: true, status, targets: [target] });
  window.usebrianDesktop = { signIn: vi.fn(), computerControl: control };
  await nativeComputer.enter("w");
  const el = document.createElement("div"); document.body.append(el); const root = createRoot(el);
  try {
    await act(async () => root.render(<NativeComputerPage workspaceId="w" />));
    const start = () => Array.from(el.querySelectorAll("button")).find(b => b.textContent === en.nativeComputer.start)!;
    expect(start().disabled).toBe(true); // Existing conversation/task workflow is required.
    for (const checkbox of el.querySelectorAll<HTMLElement>('[role="checkbox"]')) {
      expect(checkbox.getAttribute("aria-disabled")).toBe("true");
      await act(async () => checkbox.click());
      expect(checkbox.getAttribute("aria-checked")).toBe("false");
    }
    await fillInspectorForm(el);
    expect(start().disabled).toBe(false);
    await act(async () => start().click());
    expect(control).toHaveBeenCalledWith(expect.objectContaining({ type: "start", assistantId: "a", conversationId: "c", taskId: "t", allowControl: false, allowCapture: false }));
    expect(control.mock.calls.some(([m]) => (m.type === "start" || m.type === "resume") && (m.allowControl || m.allowCapture))).toBe(false);
    expect(el.querySelector('[role="alert"]')?.textContent).toBe(en.nativeComputer.error);
    expect(el.textContent).not.toContain("private inspector error");
  } finally { await act(async () => { root.unmount(); await nativeComputer.leave(); }); el.remove(); }
});

it.each(["control", "capture"] as const)("[COMP:app-web/native-computer] rejects stale %s requests and visibly clears unsupported preferences", async lost => {
  setup.populated = true;
  let status: NativeStatus = { protocol: "native-computer-v1", state: "ready", epoch: 1, capabilities: fullCapabilities };
  const target = { appId: "app", processId: 1, processInstanceId: "p", windowId: "win", windowInstanceId: "wi", displayName: "Document" };
  const control = vi.fn<ComputerControl>().mockImplementation(async () => ({ ok: true, status, targets: [target] }));
  window.usebrianDesktop = { signIn: vi.fn(), computerControl: control };
  await nativeComputer.enter("w");
  const el = document.createElement("div"); document.body.append(el); const root = createRoot(el);
  try {
    await act(async () => root.render(<NativeComputerPage workspaceId="w" />));
    await fillInspectorForm(el);
    const boxes = () => Array.from(el.querySelectorAll<HTMLElement>('[role="checkbox"]'));
    await act(async () => boxes()[0].click());
    await act(async () => boxes()[1].click());
    expect(boxes().map(b => b.getAttribute("aria-checked"))).toEqual(["true", "true"]);
    status = { ...status, epoch: 2, capabilities: { ...fullCapabilities, semanticActions: lost !== "control", windowCapture: false, input: false } };
    // Simulate the live store changing before React has rendered the new caps.
    const snapshot = vi.spyOn(nativeComputer, "snapshot").mockReturnValue({ ok: true, status });
    try {
      await act(async () => Array.from(el.querySelectorAll("button")).find(b => b.textContent === en.nativeComputer.start)!.click());
      expect(control.mock.calls.some(([m]) => m.type === "start" || m.type === "resume")).toBe(false);
      expect(el.querySelector('[role="alert"]')?.textContent).toBe(en.nativeComputer.error);
    } finally { snapshot.mockRestore(); }
    await act(async () => { await nativeComputer.check(); });
    expect(boxes().map(b => b.getAttribute("aria-checked"))).toEqual([lost === "control" ? "false" : "true", "false"]);
    expect(boxes()[1].getAttribute("aria-disabled")).toBe("true");
    expect(boxes()[0].getAttribute("aria-disabled") === "true").toBe(lost === "control");
    expect(el.querySelector('[role="alert"]')?.textContent).toBe(en.nativeComputer.error);
    // Restoring support must not resurrect old consent preferences.
    status = { ...status, capabilities: fullCapabilities };
    await act(async () => { await nativeComputer.check(); });
    expect(boxes().map(b => b.getAttribute("aria-checked"))).toEqual([lost === "control" ? "false" : "true", "false"]);
    expect(control.mock.calls.some(([m]) => m.type === "start" || m.type === "resume")).toBe(false);
  } finally { await act(async () => { root.unmount(); await nativeComputer.leave(); }); el.remove(); }
});
