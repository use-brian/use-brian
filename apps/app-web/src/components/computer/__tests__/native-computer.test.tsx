// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { en } from "@/lib/i18n/dictionaries/en";
import { NativeComputerCoordinator } from "../native-computer-coordinator";
import { NativeComputerPage } from "../native-computer-page";
import { nativeComputer, type ComputerControl, type DesktopComputerControlResult, type NativeStatus } from "@/lib/native-computer";
import { authFetch } from "@/lib/auth-fetch";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { promptDialog } from "@/components/ui/prompt-dialog";
vi.mock("@/lib/i18n/client", () => ({ useT: () => en }));
vi.mock("@/lib/auth-fetch", () => ({ authFetch: vi.fn() }));
vi.mock("@/lib/runtime-public-config", () => ({ publicRuntimeConfig: () => ({ apiUrl: "https://api.test" }) }));
vi.mock("@/components/ui/prompt-dialog", () => ({ promptDialog: vi.fn() }));
vi.mock("@/components/ui/confirm-dialog", () => ({ confirmDialog: vi.fn().mockResolvedValue(true) }));
vi.mock("next/link", () => ({ default: ({ children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props}>{children}</a> }));
// Keep interactions deterministic while testing the page's scope and consent logic.
vi.mock("@/components/ui/select", () => ({
  Select: ({ children, value, onValueChange, disabled }: any) => <select disabled={disabled} value={value ?? ""} onChange={e => onValueChange(e.target.value)}><option value="" />{children}</select>,
  SelectTrigger: () => null, SelectValue: () => null,
  SelectContent: ({ children }: any) => <>{children}</>,
  SelectItem: ({ children, value }: any) => <option value={value}>{children}</option>,
}));
vi.mock("@/components/ui/checkbox", () => ({ Checkbox: ({ checked, onCheckedChange, ...props }: any) => <input type="checkbox" checked={checked} onChange={e => onCheckedChange(e.target.checked)} {...props} /> }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const profile = { id: "p", workspaceId: "w", name: "My Mac", enabledAssistantIds: [], assistantRoutingNotes: {}, deviceId: null, connected: false, canManage: true };
const target = { appId: "app", processId: 1, processInstanceId: "pi", windowId: "win", windowInstanceId: "wi", displayName: "<script>window</script>" };
const status = { state: "ready", capabilities: { semanticActions: true, windowCapture: true, visualInvokeVersion: 1, accessibilityPermission: "granted", capturePermission: "granted" } } as NativeStatus;
let el: HTMLDivElement; let root: Root;
const button = (text: string) => Array.from(el.querySelectorAll("button")).find(b => b.textContent === text)!;
const primary = () => button(en.computerProfiles.connect) ?? button(en.computerProfiles.inspect);
async function render(workspaceId = "w") { await act(async () => root.render(<NativeComputerPage workspaceId={workspaceId} />)); }
async function choose(index: number, value: string) { await act(async () => { const select = el.querySelectorAll("select")[index]; select.value = value; select.dispatchEvent(new Event("change", { bubbles: true })); }); }
async function selectConnection() { await choose(0, "p"); await choose(1, el.querySelectorAll("select")[1].options[1].value); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
beforeEach(() => {
  el = document.createElement("div"); root = createRoot(el);
  vi.mocked(authFetch).mockResolvedValue(new Response(JSON.stringify({ profiles: [profile] })));
  // Each request receives a fresh response body.
  vi.mocked(authFetch).mockImplementation(async () => new Response(JSON.stringify({ profiles: [profile], profile })));
  vi.spyOn(nativeComputer, "snapshot").mockReturnValue({ ok: true, status });
  vi.spyOn(nativeComputer, "send").mockResolvedValue({ ok: true, status, targets: [target] });
  vi.mocked(promptDialog).mockResolvedValue("My Mac");
  vi.mocked(confirmDialog).mockResolvedValue(true);
});
afterEach(async () => { await act(async () => root.unmount()); delete window.usebrianDesktop; vi.restoreAllMocks(); vi.clearAllMocks(); vi.useRealTimers(); });
function desktop() { window.usebrianDesktop = { signIn: vi.fn(), computerControl: vi.fn() }; }
it("[COMP:app-web/native-computer] creates a private profile without assistant, conversation, task, or goal", async () => {
  await render();
  expect(el.textContent).toContain(en.computerProfiles.browserHelp);
  expect(el.textContent).not.toContain(en.nativeComputer.createTask);
  expect(el.querySelector("textarea")).toBeNull();
  expect(primary()).toBeUndefined();
  await act(async () => button(en.computerProfiles.create).click());
  const [, init] = vi.mocked(authFetch).mock.calls.find(([, init]) => init?.method === "POST")!;
  expect(JSON.parse(init!.body as string)).toEqual({ workspaceId: "w", name: "My Mac" });
  expect(nativeComputer.send).not.toHaveBeenCalled();
});
it("[COMP:app-web/native-computer] connects with a fresh canonical target and explicit opt-ins, reports failure, disconnects", async () => {
  desktop(); await render(); await selectConnection();
  expect(el.querySelector("script")).toBeNull();
  await act(async () => (el.querySelectorAll('input')[0] as HTMLInputElement).click());
  await act(async () => (el.querySelectorAll('input')[1] as HTMLInputElement).click());
  vi.mocked(nativeComputer.send).mockImplementation(async message => message.type === "connect-profile" ? { ok: false } : { ok: true, status, targets: [target] });
  await act(async () => primary().click());
  const { displayName: _label, ...canonical } = target;
  expect(nativeComputer.send).toHaveBeenCalledWith({ type: "connect-profile", workspaceId: "w", profileId: "p", target: canonical, allowControl: true, allowCapture: true });
  expect(el.textContent).toContain(en.computerProfiles.connectionError);
  await act(async () => button(en.computerProfiles.disconnect).click());
  expect(nativeComputer.send).toHaveBeenCalledWith({ type: "disconnect-profile" });
  expect([...el.querySelectorAll("input")].every(input => !input.checked)).toBe(true);
});
it("[COMP:app-web/native-computer] identifies a disabled backend instead of blaming Mac permissions", async () => {
  desktop(); await render(); await selectConnection();
  await act(async () => (el.querySelectorAll('input')[0] as HTMLInputElement).click());
  vi.mocked(nativeComputer.send).mockImplementation(async message => message.type === "connect-profile"
    ? { ok: false, profileErrorCode: "native_execution_unavailable" }
    : { ok: true, status, targets: [target] });
  await act(async () => primary().click());
  expect(el.textContent).toContain(en.computerProfiles.errors.native_execution_unavailable);
  expect(el.textContent).not.toContain(en.computerProfiles.connectionError);
});
it("[COMP:app-web/native-computer] rejects vanished or replaced targets at connect", async () => {
  desktop(); await render(); await selectConnection();
  vi.mocked(nativeComputer.send).mockResolvedValue({ ok: true, status, targets: [{ ...target, windowInstanceId: "replacement" }] });
  await act(async () => primary().click());
  expect(vi.mocked(nativeComputer.send).mock.calls.some(([m]) => m.type === "connect-profile")).toBe(false);
  expect(el.textContent).toContain(en.computerProfiles.connectionError);
});
it.each(["stop", "workspace"])("[COMP:app-web/native-computer] fences pending connection discovery after %s", async change => {
  desktop(); await render(); await selectConnection();
  const pending = deferred<any>();
  vi.mocked(nativeComputer.send).mockImplementation(message => message.type === "targets" ? pending.promise : Promise.resolve({ ok: true }));
  await act(async () => primary().click());
  if (change === "stop") await act(async () => button(en.computerProfiles.disconnect).click());
  else await render("other");
  await act(async () => pending.resolve({ ok: true, status, targets: [target] }));
  expect(vi.mocked(nativeComputer.send).mock.calls.some(([m]) => m.type === "connect-profile")).toBe(false);
});
it("[COMP:app-web/native-computer] stale profile list cannot restore another workspace", async () => {
  const pending = deferred<Response>();
  vi.mocked(authFetch).mockReturnValueOnce(pending.promise);
  await render(); await render("other");
  await act(async () => pending.resolve(new Response(JSON.stringify({ profiles: [profile] }))));
  expect(el.textContent).not.toContain("My Mac");
});
it("[COMP:app-web/native-computer] cancels creation dialog on workspace change", async () => {
  const pending = deferred<string | null>(); vi.mocked(promptDialog).mockReturnValue(pending.promise);
  await render(); await act(async () => button(en.computerProfiles.create).click()); await render("other");
  await act(async () => pending.resolve("Old name"));
  expect(vi.mocked(authFetch).mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
});
it("[COMP:app-web/native-computer] blocked readiness is visible and permissions remain available", async () => {
  desktop(); vi.mocked(nativeComputer.snapshot).mockReturnValue({ ok: true, status: { ...status, state: "permission_required" } });
  await render(); expect(el.textContent).toContain(en.computerProfiles.blocked);
  expect(primary().disabled).toBe(true);
  expect(button(en.nativeComputer.permissions).disabled).toBe(false);
  expect(button(en.nativeComputer.verificationAcknowledge)).toBeUndefined();
});
it("[COMP:app-web/native-computer] renames and deletes a profile independently of chat", async () => {
  await render(); await choose(0, "p");
  vi.mocked(promptDialog).mockResolvedValueOnce("Office Mac");
  await act(async () => button(en.computerProfiles.rename).click());
  expect(authFetch).toHaveBeenCalledWith("https://api.test/api/native-computer/profiles/p", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ name: "Office Mac" }) }));
  await act(async () => button(en.computerProfiles.delete).click());
  expect(authFetch).toHaveBeenCalledWith("https://api.test/api/native-computer/profiles/p", expect.objectContaining({ method: "DELETE" }));
  expect(nativeComputer.send).not.toHaveBeenCalled();
});
it("[COMP:app-web/native-computer] create failure is visible and does not select a fabricated profile", async () => {
  await render(); vi.mocked(authFetch).mockResolvedValueOnce(new Response("{}", { status: 403 }));
  await act(async () => button(en.computerProfiles.create).click());
  expect(el.querySelector('[role="alert"]')?.textContent).toContain(en.computerProfiles.errors.computer_profiles_forbidden);
  expect(el.querySelector("select")!.value).toBe("");
});
it("[COMP:app-web/native-computer] global Stop generation fences fresh discovery even before a rerender", async () => {
  desktop(); await render(); await selectConnection();
  let resolve!: (value: any) => void;
  vi.mocked(nativeComputer.send).mockReturnValueOnce(new Promise(r => { resolve = r; }));
  await act(async () => primary().click());
  const next = nativeComputer.setupRevision + 1;
  vi.spyOn(nativeComputer, "setupRevision", "get").mockReturnValue(next);
  await act(async () => resolve({ ok: true, status, targets: [target] }));
  expect(vi.mocked(nativeComputer.send).mock.calls.some(([m]) => m.type === "connect-profile")).toBe(false);
  expect([...el.querySelectorAll("input")].every(input => !input.checked)).toBe(true);
});
it("[COMP:app-web/native-computer] capability loss between render and click never downgrades control silently", async () => {
  desktop(); await render(); await selectConnection();
  await act(async () => el.querySelector("input")!.click());
  vi.mocked(nativeComputer.snapshot).mockReturnValue({ ok: true, status: { ...status, capabilities: { ...status.capabilities, semanticActions: false } } });
  await act(async () => primary().click());
  expect(vi.mocked(nativeComputer.send).mock.calls.some(([m]) => m.type === "connect-profile")).toBe(false);
  expect(el.textContent).toContain(en.computerProfiles.connectionError);
});
it.each(["active", "awaiting_local_consent", "awaiting_action_approval"] as const)("[COMP:app-web/native-computer] %s disables permissions and discovery but leaves Stop available", async phase => {
  desktop(); vi.mocked(nativeComputer.snapshot).mockReturnValue({ ok: true, status: { ...status, state: phase } });
  await render();
  expect(button(en.nativeComputer.permissions).disabled).toBe(true);
  expect(button(en.nativeComputer.screenRecordingSettings).disabled).toBe(true);
  expect(button(en.nativeComputer.checkReadiness).disabled).toBe(true);
  expect(button(en.computerProfiles.disconnect).disabled).toBe(false);
  expect(nativeComputer.send).not.toHaveBeenCalledWith({ type: "targets" });
});
it.each(["visualInvokeVersion", "windowCapture"] as const)("[COMP:app-web/native-computer] missing %s never enables screenshot fallback", async missing => {
  desktop();
  const capabilities = { ...status.capabilities }; delete capabilities[missing];
  vi.mocked(nativeComputer.snapshot).mockReturnValue({ ok: true, status: { ...status, capabilities } });
  await render(); await selectConnection(); await act(async () => el.querySelector("input")!.click());
  expect((el.querySelectorAll("input")[1] as HTMLInputElement).disabled).toBe(true);
  await act(async () => primary().click());
  expect(nativeComputer.send).toHaveBeenCalledWith(expect.objectContaining({ type: "connect-profile", allowControl: true, allowCapture: false }));
});
it.each(["stopped", "paused_for_user", "ended", "unavailable", "permission_required"] as const)("[COMP:app-web/native-computer] entering %s revokes both opt-ins with unchanged capabilities", async phase => {
  desktop(); await render(); await selectConnection();
  await act(async () => el.querySelectorAll("input")[0].click());
  await act(async () => el.querySelectorAll("input")[1].click());
  vi.mocked(nativeComputer.snapshot).mockReturnValue({ ok: true, status: { ...status, state: phase } });
  await render();
  expect([...el.querySelectorAll("input")].every(input => !input.checked)).toBe(true);
});
it("[COMP:app-web/native-computer] cleanup blocks connection and discovery while repeated Stop remains available", async () => {
  desktop(); vi.mocked(nativeComputer.snapshot).mockReturnValue({ ok: false, cleanupPending: true, status });
  await render();
  expect(el.textContent).toContain(en.nativeComputer.cleanupPending);
  expect(primary().disabled).toBe(true);
  expect(button(en.computerProfiles.disconnect).disabled).toBe(false);
  expect(nativeComputer.send).not.toHaveBeenCalledWith({ type: "targets" });
});
it("[COMP:app-web/native-computer] persistent coordinator keeps polling and revokes on workspace change", async () => {
  desktop(); vi.useFakeTimers();
  const enter = vi.spyOn(nativeComputer, "enter").mockResolvedValue({ ok: true });
  const leave = vi.spyOn(nativeComputer, "leave").mockResolvedValue({ ok: true });
  const check = vi.spyOn(nativeComputer, "check").mockResolvedValue({ ok: true });
  await act(async () => root.render(<NativeComputerCoordinator workspaceId="w" />));
  expect(enter).toHaveBeenCalledWith("w");
  const calls = check.mock.calls.length;
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  expect(check.mock.calls.length).toBeGreaterThan(calls);
  await act(async () => root.render(<NativeComputerCoordinator workspaceId="other" />));
  expect(leave).toHaveBeenCalled(); expect(enter).toHaveBeenCalledWith("other");
});
it.each([false, true])("[COMP:app-web/native-computer] packaged preverification can request control with capture=%s only through Connect", async capture => {
  desktop();
  vi.mocked(nativeComputer.snapshot).mockReturnValue({ ok: true, verificationAvailable: true, verificationConsented: false, status: { ...status, state: "unavailable", capabilities: { ...status.capabilities, semanticActions: false, windowCapture: false, visualInvokeVersion: undefined } } });
  await render(); await selectConnection();
  expect(el.textContent).toContain(en.computerProfiles.pendingVerification);
  expect(el.querySelector("textarea")).toBeNull();
  expect(el.textContent).not.toContain(en.nativeComputer.createTask);
  const [control, screenshot] = el.querySelectorAll("input");
  expect(control.disabled).toBe(false);
  expect(screenshot.disabled).toBe(true);
  await act(async () => control.click());
  expect(screenshot.disabled).toBe(false);
  if (capture) await act(async () => screenshot.click());
  expect(vi.mocked(nativeComputer.send).mock.calls.every(([m]) => m.type === "targets")).toBe(true);
  expect(button(en.nativeComputer.verificationAcknowledge)).toBeUndefined();
  await act(async () => primary().click());
  const { displayName: _label, ...canonical } = target;
  expect(nativeComputer.send).toHaveBeenCalledWith({ type: "connect-profile", workspaceId: "w", profileId: "p", target: canonical, allowControl: true, allowCapture: capture });
  expect(vi.mocked(nativeComputer.send).mock.calls.some(([m]) => m.type === "acknowledge-verification")).toBe(false);
});
it("[COMP:app-web/native-computer] completed verification does not override unsupported native capabilities", async () => {
  desktop();
  vi.mocked(nativeComputer.snapshot).mockReturnValue({ ok: true, verificationAvailable: true, verificationConsented: true, status: { ...status, capabilities: { ...status.capabilities, semanticActions: false, windowCapture: false } } });
  await render(); await selectConnection();
  expect([...el.querySelectorAll("input")].every(input => input.disabled && !input.checked)).toBe(true);
});
it("[COMP:app-web/native-computer] losing preverification availability during discovery never sends requested authority", async () => {
  desktop();
  const unverified = { ok: true, verificationAvailable: true, verificationConsented: false, status: { ...status, capabilities: { ...status.capabilities, semanticActions: false, windowCapture: false } } };
  vi.mocked(nativeComputer.snapshot).mockReturnValue(unverified);
  await render(); await selectConnection(); await act(async () => el.querySelector("input")!.click());
  const pending = deferred<any>(); vi.mocked(nativeComputer.send).mockReturnValueOnce(pending.promise);
  await act(async () => primary().click());
  vi.mocked(nativeComputer.snapshot).mockReturnValue({ ...unverified, verificationAvailable: false });
  await act(async () => pending.resolve({ ok: true, status: unverified.status, targets: [target] }));
  expect(vi.mocked(nativeComputer.send).mock.calls.some(([m]) => m.type === "connect-profile")).toBe(false);
  expect(el.textContent).toContain(en.computerProfiles.connectionError);
});
it.each(["permission_required", "ready"] as const)("[COMP:app-web/native-computer] known Accessibility denial stays blocked in %s even with verification available", async phase => {
  desktop();
  vi.mocked(nativeComputer.snapshot).mockReturnValue({ ok: true, verificationAvailable: true, status: { ...status, state: phase, capabilities: { ...status.capabilities, accessibilityPermission: "denied" } } });
  await render(); await selectConnection();
  expect(primary().disabled).toBe(true);
  expect(el.textContent).toContain(en.nativeComputer.permissionHelp);
  expect(el.textContent).toContain(en.computerProfiles.blocked);
  expect(button(en.nativeComputer.permissions).disabled).toBe(false);
  expect(button(en.nativeComputer.screenRecordingSettings).disabled).toBe(false);
  expect([...el.querySelectorAll("input")].every(input => input.disabled && !input.checked)).toBe(true);
  await act(async () => primary().click());
  expect(vi.mocked(nativeComputer.send).mock.calls.some(([m]) => m.type === "connect-profile")).toBe(false);
  await act(async () => button(en.nativeComputer.permissions).click());
  expect(nativeComputer.send).toHaveBeenCalledWith({ type: "permissions", permission: "accessibility" });
});
it("[COMP:app-web/native-computer] permission_required itself blocks verification even with unknown TCC", async () => {
  desktop();
  vi.mocked(nativeComputer.snapshot).mockReturnValue({ ok: true, verificationAvailable: true, status: { ...status, state: "permission_required", capabilities: { ...status.capabilities, accessibilityPermission: "unknown" } } });
  await render(); await selectConnection();
  expect(primary().disabled).toBe(true);
  expect(el.textContent).toContain(en.nativeComputer.permissionHelp);
  expect(button(en.nativeComputer.permissions).disabled).toBe(false);
});
it("[COMP:app-web/native-computer] known Screen Recording denial cannot advertise capture during verification", async () => {
  desktop();
  vi.mocked(nativeComputer.snapshot).mockReturnValue({ ok: true, verificationAvailable: true, status: { ...status, capabilities: { ...status.capabilities, semanticActions: false, capturePermission: "denied" } } });
  await render(); await selectConnection();
  await act(async () => el.querySelectorAll("input")[0].click());
  expect(el.querySelectorAll("input")[1].disabled).toBe(true);
  expect(el.textContent).toContain(en.computerProfiles.captureDenied);
  expect(button(en.nativeComputer.screenRecordingSettings).disabled).toBe(false);
  await act(async () => primary().click());
  expect(nativeComputer.send).toHaveBeenCalledWith(expect.objectContaining({ type: "connect-profile", allowControl: true, allowCapture: false }));
});
it("[COMP:app-web/native-computer] unknown bootstrap permissions still allow explicit preverification preferences", async () => {
  desktop();
  vi.mocked(nativeComputer.snapshot).mockReturnValue({ ok: true, verificationAvailable: true, status: { ...status, state: "unavailable", capabilities: { ...status.capabilities, semanticActions: false, windowCapture: false, accessibilityPermission: "unknown", capturePermission: "unknown" } } });
  await render(); await selectConnection();
  await act(async () => el.querySelectorAll("input")[0].click());
  await act(async () => el.querySelectorAll("input")[1].click());
  expect(primary().disabled).toBe(false);
  await act(async () => primary().click());
  expect(nativeComputer.send).toHaveBeenCalledWith(expect.objectContaining({ type: "connect-profile", allowControl: true, allowCapture: true }));
});
it("[COMP:app-web/native-computer] preverification never bypasses a capture denial arriving during fresh discovery", async () => {
  desktop();
  const unverified = { ok: true, verificationAvailable: true, status };
  vi.mocked(nativeComputer.snapshot).mockReturnValue(unverified);
  await render(); await selectConnection();
  await act(async () => el.querySelectorAll("input")[0].click());
  await act(async () => el.querySelectorAll("input")[1].click());
  const pending = deferred<any>(); vi.mocked(nativeComputer.send).mockReturnValueOnce(pending.promise);
  await act(async () => primary().click());
  vi.mocked(nativeComputer.snapshot).mockReturnValue({ ...unverified, status: { ...status, capabilities: { ...status.capabilities, capturePermission: "denied" } } });
  await act(async () => pending.resolve({ ok: true, status, targets: [target] }));
  expect(vi.mocked(nativeComputer.send).mock.calls.some(([m]) => m.type === "connect-profile")).toBe(false);
  expect(el.textContent).toContain(en.computerProfiles.captureDenied);
});
/** Exercise the production renderer store, including its polling and teardown fences. */
async function realInspector() {
  vi.mocked(nativeComputer.snapshot).mockRestore();
  vi.mocked(nativeComputer.send).mockRestore();
  const malicious = '<img src=x onerror="attack()"><script>attack()</script>';
  const identity = { deploymentId: "deployment", userId: "owner", workspaceId: "w", deviceId: "device", sessionId: "local-inspector", conversationId: "local", profileId: "p" };
  const completed: DesktopComputerControlResult = {
    ok: true, profileId: "p", profileConnected: false,
    status: { ...status, state: "stopped", epoch: 1, identity },
    inspection: { id: "snapshot-id", capturedAt: 1, completeness: "partial", nodes: Array.from({ length: 501 }, (_, i) => ({ ref: String(i), role: "textbox", name: i === 0 ? malicious : "secure-name", value: i === 0 ? "public-value" : "secure-value", enabled: true, sensitive: i !== 0 })) },
  };
  let latest: DesktopComputerControlResult = { ok: true, status };
  const bridge = vi.fn<ComputerControl>().mockImplementation(async message => {
    if (message.type === "connect-profile") { latest = completed; return completed; }
    if (message.type === "targets") return { ok: true, status, targets: [target] };
    if (message.type === "status") { const { inspection: _snapshot, ...metadata } = latest; return metadata; }
    latest = { ok: true, profileConnected: false, status }; return latest;
  });
  window.usebrianDesktop = { signIn: vi.fn(), computerControl: bridge };
  await nativeComputer.enter("w");
  await render(); await selectConnection();
  expect(button(en.computerProfiles.connect)).toBeUndefined();
  expect(primary().textContent).toBe(en.computerProfiles.inspect);
  await act(async () => primary().click());
  expect(bridge).toHaveBeenCalledWith(expect.objectContaining({ type: "connect-profile", allowControl: false, allowCapture: false }));
  return { bridge, completed, malicious };
}
it("[COMP:app-web/native-computer] real store shows a bounded redacted inspector after local helper teardown and preserves it across status polls", async () => {
  try {
    const { bridge, malicious } = await realInspector();
    expect(el.textContent).toContain(en.nativeComputer.inspectorStatic);
    expect(el.textContent).toContain("snapshot-id");
    expect(el.textContent).toContain(malicious);
    expect(el.querySelector("img,script")).toBeNull();
    expect(el.textContent).toContain(en.nativeComputer.inspectorRedacted);
    expect(el.textContent).not.toContain("secure-name");
    expect(el.textContent).not.toContain("secure-value");
    expect(el.querySelectorAll("tbody tr")).toHaveLength(500);
    expect(el.textContent).toContain(en.computerProfiles.offline);
    expect(el.textContent).not.toContain(en.computerProfiles.online);
    const calls = bridge.mock.calls.filter(([m]) => m.type === "targets").length;
    await act(async () => { await nativeComputer.check(); window.dispatchEvent(new Event("focus")); });
    expect(el.querySelectorAll("tbody tr")).toHaveLength(500);
    expect(bridge.mock.calls.filter(([m]) => m.type === "targets")).toHaveLength(calls);
    await act(async () => button(en.nativeComputer.inspectorNew).click());
    expect(el.querySelector("table")).toBeNull();
    expect(bridge.mock.calls.filter(([m]) => m.type === "targets").length).toBeGreaterThan(calls);
  } finally { await act(async () => { await nativeComputer.leave(); }); }
});
it("[COMP:app-web/native-computer] real store inspector is workspace-scoped and clears before account teardown completes", async () => {
  try {
    const { bridge, completed } = await realInspector();
    expect(el.querySelector("table")).not.toBeNull();
    await render("other");
    expect(el.querySelector("table")).toBeNull();
    await render("w");
    expect(el.querySelector("table")).not.toBeNull();
    const pending = deferred<DesktopComputerControlResult>();
    bridge.mockImplementationOnce(() => pending.promise);
    let leaving!: Promise<DesktopComputerControlResult>;
    await act(async () => { leaving = nativeComputer.leave(); });
    expect(el.querySelector("table")).toBeNull();
    // The new account can use the same workspace. A previous teardown reply
    // carrying its old snapshot cannot cross the renderer generation fence.
    await act(async () => { await nativeComputer.enter("w"); });
    await act(async () => { pending.resolve(completed); await leaving; });
    expect(el.querySelector("table")).toBeNull();
    expect(el.textContent).not.toContain("snapshot-id");
    expect(nativeComputer.snapshot().inspection).toBeUndefined();
  } finally { await act(async () => { await nativeComputer.leave(); }); }
});
it("[COMP:app-web/native-computer] an idle connected profile does not trap denied TCC settings behind Connect", async () => {
  desktop();
  vi.mocked(nativeComputer.snapshot).mockReturnValue({ ok: true, profileId: "p", profileConnected: true, verificationAvailable: true, status: { ...status, state: "permission_required", capabilities: { ...status.capabilities, accessibilityPermission: "denied", capturePermission: "denied" } } });
  await render();
  expect(primary().disabled).toBe(true);
  expect(button(en.nativeComputer.permissions).disabled).toBe(false);
  expect(button(en.nativeComputer.screenRecordingSettings).disabled).toBe(false);
  await act(async () => button(en.nativeComputer.screenRecordingSettings).click());
  expect(nativeComputer.send).toHaveBeenCalledWith({ type: "permissions", permission: "screen-recording" });
});

it.each([
  [503, "computer_profiles_schema_unavailable", true],
  [404, "api_not_supported", true],
  [401, "sign_in_required", true],
  [403, "computer_profiles_forbidden", true],
  [503, "computer_profiles_unavailable", false],
] as const)("[COMP:app-web/native-computer] actionable HTTP %s error blocks create appropriately and retries", async (status, code, blocked) => {
  const malicious = "<script>SQL password=secret</script>";
  vi.mocked(authFetch).mockImplementation(async () => new Response(JSON.stringify({ code, error: malicious }), { status }));
  await render();
  expect(el.textContent).toContain(en.computerProfiles.errors[code]);
  expect(el.textContent).not.toContain(malicious);
  expect(button(en.computerProfiles.create).disabled).toBe(blocked);
  vi.mocked(authFetch).mockImplementation(async () => new Response(JSON.stringify({ profiles: [profile] })));
  await act(async () => button(en.computerProfiles.retry).click());
  expect(el.querySelector('[role="alert"]')).toBeNull();
  expect(button(en.computerProfiles.create).disabled).toBe(false);
});
it("[COMP:app-web/native-computer] stopped with failed discovery is not an empty list; explicit refresh recovers", async () => {
  desktop();
  vi.mocked(nativeComputer.snapshot).mockReturnValue({ ok: true, status: { ...status, state: "stopped" } });
  vi.mocked(nativeComputer.send).mockResolvedValue({ ok: false });
  await render();
  expect(el.textContent).toContain(en.nativeComputer.windowsNotChecked);
  expect(el.textContent).not.toContain(en.nativeComputer.noTargets);
  vi.mocked(nativeComputer.send).mockResolvedValue({ ok: true, targets: [] });
  await act(async () => button(en.nativeComputer.refreshWindows).click());
  expect(el.textContent).toContain(en.nativeComputer.noTargets);
  vi.mocked(nativeComputer.send).mockRejectedValue(new Error("private helper error"));
  await act(async () => button(en.nativeComputer.refreshWindows).click());
  expect(el.textContent).not.toContain(en.nativeComputer.noTargets);
  expect(el.textContent).not.toContain("private helper error");
  vi.mocked(nativeComputer.send).mockResolvedValue({ ok: true, targets: [target] });
  await act(async () => button(en.nativeComputer.refreshWindows).click());
  expect(el.querySelectorAll("select")[1].options).toHaveLength(2);
  expect(vi.mocked(nativeComputer.send).mock.calls.every(([message]) => message.type === "targets")).toBe(true);
});
it.each(["workspace", "stop"])("[COMP:app-web/native-computer] explicit refresh fences stale %s replies", async change => {
  desktop(); await render();
  const pending = deferred<DesktopComputerControlResult>();
  vi.mocked(nativeComputer.send).mockReturnValueOnce(pending.promise);
  await act(async () => button(en.nativeComputer.refreshWindows).click());
  if (change === "workspace") { vi.mocked(nativeComputer.send).mockResolvedValue({ ok: false }); await render("other"); }
  else { vi.spyOn(nativeComputer, "setupRevision", "get").mockReturnValue(nativeComputer.setupRevision + 1); }
  await act(async () => pending.resolve({ ok: true, targets: [] }));
  expect(el.textContent).not.toContain(en.nativeComputer.noTargets);
});
it("[COMP:app-web/native-computer] pending initial discovery never claims no windows in stopped phase", async () => {
  desktop();
  vi.mocked(nativeComputer.snapshot).mockReturnValue({ ok: true, status: { ...status, state: "stopped" } });
  const pending = deferred<DesktopComputerControlResult>();
  vi.mocked(nativeComputer.send).mockReturnValue(pending.promise);
  await render();
  expect(el.textContent).toContain(en.nativeComputer.windowsNotChecked);
  expect(el.textContent).not.toContain(en.nativeComputer.noTargets);
  await act(async () => pending.resolve({ ok: true, targets: [] }));
  expect(el.textContent).toContain(en.nativeComputer.noTargets);
});
it("[COMP:app-web/native-computer] HTML success blocks creation without leaking content", async () => {
  vi.mocked(authFetch).mockImplementation(async () => new Response("<html>SQL password=secret</html>"));
  await render();
  expect(el.textContent).toContain(en.computerProfiles.errors.api_not_supported);
  expect(el.textContent).not.toContain("password=secret");
  expect(button(en.computerProfiles.create).disabled).toBe(true);
});
it("[COMP:app-web/native-computer] mutation schema errors keep actionable retry rather than a native connection error", async () => {
  desktop(); await render();
  vi.mocked(authFetch).mockResolvedValueOnce(new Response(JSON.stringify({ code: "computer_profiles_schema_unavailable", error: "SQL password=secret" }), { status: 503 }));
  await act(async () => button(en.computerProfiles.create).click());
  expect(el.textContent).toContain(en.computerProfiles.errors.computer_profiles_schema_unavailable);
  expect(el.textContent).not.toContain(en.computerProfiles.connectionError);
  expect(el.textContent).not.toContain("password=secret");
  expect(button(en.computerProfiles.create).disabled).toBe(true);
  await act(async () => button(en.computerProfiles.retry).click());
  expect(button(en.computerProfiles.create).disabled).toBe(false);
});
