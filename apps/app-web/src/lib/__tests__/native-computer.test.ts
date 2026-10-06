import { describe, expect, it, vi } from "vitest";
import { NativeComputer, isNativeTarget, type ComputerControl, type NativeStart, type DesktopComputerControlResult } from "../native-computer";
const input: NativeStart = { workspaceId: "w", assistantId: "a", conversationId: "c", taskId: "t", goal: "Read the document", target: { appId: "app", processId: 1, processInstanceId: "p1", windowId: "win", windowInstanceId: "w1" }, allowControl: false, allowCapture: false };
describe("[COMP:app-web/native-computer] narrow bridge lifecycle", () => {
  it("never starts on enter, polling, Stop, workspace change or disconnect", async () => {
    const control = vi.fn<ComputerControl>().mockResolvedValue({ ok: true });
    const owner = new NativeComputer(() => control);
    await owner.enter("w"); await owner.check(); await owner.stop(); await owner.enter("other"); await owner.leave();
    expect(control.mock.calls.map(([m]) => m.type)).toEqual(["workspace-changed", "status", "stop", "workspace-changed", "disconnect"]);
  });
  it("requires context and projects only consent fields for explicit start/resume", async () => {
    const control = vi.fn<ComputerControl>().mockResolvedValue({ ok: true });
    const owner = new NativeComputer(() => control);
    await owner.start("start", input);
    expect(control).not.toHaveBeenCalled();
    await owner.enter("w");
    await owner.start("start", { ...input, conversationId: "" });
    expect(control).toHaveBeenCalledTimes(1);
    await owner.start("start", { ...input, token: "must-not-cross" } as NativeStart);
    expect(control).toHaveBeenLastCalledWith({ type: "start", ...input });
    await owner.start("resume", input);
    expect(control).toHaveBeenLastCalledWith({ type: "resume", ...input });
  });
  it("sends Stop immediately while start is pending and ignores its stale result", async () => {
    let finish!: (value: { ok: boolean }) => void;
    const control = vi.fn<ComputerControl>().mockImplementation(m => m.type === "start" ? new Promise(resolve => { finish = resolve; }) : Promise.resolve({ ok: false }));
    const owner = new NativeComputer(() => control);
    await owner.enter("w"); const starting = owner.start("start", input);
    const stopping = owner.stop();
    expect(control).toHaveBeenLastCalledWith({ type: "stop" });
    await stopping; finish({ ok: true }); await starting;
    expect(owner.snapshot()).toEqual({ ok: false });
  });
  it("fails closed for a missing or rejected bridge", async () => {
    expect(await new NativeComputer(() => undefined).check()).toEqual({ ok: false });
    expect(await new NativeComputer(() => async () => { throw new Error("private details"); }).check()).toEqual({ ok: false });
  });
});

it("[COMP:app-web/native-computer] discovery schema rejects extra authority, stale partial identity and invalid process IDs", () => {
  expect(isNativeTarget(input.target)).toBe(true);
  expect(isNativeTarget({ ...input.target, token: "secret" })).toBe(false);
  expect(isNativeTarget({ appId: "app", windowId: "window" })).toBe(false);
  expect(isNativeTarget({ ...input.target, processId: 0 })).toBe(false);
  expect(isNativeTarget({ ...input.target, processId: NaN })).toBe(false);
});

it("[COMP:app-web/native-computer] keeps local inspection across polls but clears it on lifecycle boundaries", async () => {
  const inspection = { id: "snapshot", capturedAt: 1, completeness: "complete" as const, nodes: [] };
  const status = { state: "active", epoch: 1, identity: { workspaceId: "w", userId: "u" } } as DesktopComputerControlResult["status"];
  const control = vi.fn<ComputerControl>().mockImplementation(async m => ({ ok: true, status, ...(m.type === "start" ? { inspection } : {}) }));
  const owner = new NativeComputer(() => control);
  await owner.enter("w"); await owner.start("start", input); await owner.check();
  expect(owner.snapshot().inspection).toEqual(inspection);
  await owner.stop(); expect(owner.snapshot().inspection).toBeUndefined();
  await owner.start("start", input); const leaving = owner.leave();
  expect(owner.snapshot().inspection).toBeUndefined(); await leaving;
  await owner.enter("w"); await owner.start("start", input);
  control.mockResolvedValueOnce({ ok: true, status: { ...status!, identity: { ...status!.identity!, userId: "other" } } });
  await owner.check(); expect(owner.snapshot().inspection).toBeUndefined();
  await owner.start("start", input); const entering = owner.enter("other");
  expect(owner.snapshot().inspection).toBeUndefined(); await entering;
});
it("[COMP:app-web/native-computer] status polling cannot swallow a pending inspection and late reads never return after Stop", async () => {
  let finish!: (value: DesktopComputerControlResult) => void;
  const control = vi.fn<ComputerControl>().mockImplementation(m => m.type === "start" ? new Promise(resolve => { finish = resolve; }) : Promise.resolve({ ok: true }));
  const owner = new NativeComputer(() => control); await owner.enter("w");
  const inspection = { id: "local", capturedAt: 1, completeness: "complete" as const, nodes: [] };
  const first = owner.start("start", input); await owner.check(); finish({ ok: true, inspection }); await first;
  expect(owner.snapshot().inspection).toEqual(inspection);
  const second = owner.start("start", input); expect(owner.snapshot().inspection).toBeUndefined();
  await owner.stop(); finish({ ok: true, inspection });
  expect(await second).toEqual({ ok: false }); expect(owner.snapshot().inspection).toBeUndefined();
});

it("[COMP:app-web/native-computer] retains the ended local snapshot across status polls, clears for next setup or sign-out", async () => {
  const inspection = { id: "one-shot", capturedAt: 1, completeness: "complete" as const, nodes: [] };
  const status = { state: "stopped", epoch: 2, identity: { workspaceId: "w", userId: "u" } } as DesktopComputerControlResult["status"];
  const control = vi.fn<ComputerControl>().mockImplementation(async m => ({ ok: true, status, ...(m.type === "start" ? { inspection } : {}) }));
  const owner = new NativeComputer(() => control);
  await owner.enter("w"); await owner.start("start", input); await owner.check(); await owner.check();
  expect(owner.snapshot().inspection).toEqual(inspection);
  owner.clearInspection(); expect(owner.snapshot().inspection).toBeUndefined();
  await owner.start("start", input);
  control.mockResolvedValueOnce({ ok: false }); await owner.check();
  expect(owner.snapshot().inspection).toBeUndefined();
});

it("[COMP:app-web/native-computer] a poll begun during inspection cannot erase the stopped snapshot after completion", async () => {
  let finish!: (value: DesktopComputerControlResult) => void;
  const control = vi.fn<ComputerControl>().mockResolvedValue({ ok: true });
  const owner = new NativeComputer(() => control); await owner.enter("w");
  let finishStart!: (value: DesktopComputerControlResult) => void;
  control.mockImplementation(m => new Promise(resolve => { if (m.type === "status") finish = resolve; else finishStart = resolve; }));
  const start = owner.start("start", input); const poll = owner.check();
  const inspection = { id: "ended", capturedAt: 1, completeness: "complete" as const, nodes: [] };
  finishStart({ ok: true, inspection }); await start;
  finish({ ok: true }); await poll;
  expect(owner.snapshot().inspection).toEqual(inspection);
});

it('[COMP:app-web/native-computer] local labels have UTF-16 bounds and never cross start IPC; keys ignore ordering and labels', async () => {
  const { nativeTargetKey } = await import('../native-computer');
  const control = vi.fn<ComputerControl>().mockResolvedValue({ ok: true });
  const owner = new NativeComputer(() => control);
  await owner.enter('w');
  const target = { ...input.target, displayName: '😀'.repeat(128) };
  expect(isNativeTarget(target)).toBe(true);
  expect(isNativeTarget({ ...target, displayName: '😀'.repeat(129) })).toBe(false);
  expect(isNativeTarget({ ...target, displayName: null })).toBe(false);
  await owner.start('start', { ...input, target });
  expect(control).toHaveBeenLastCalledWith({ type: 'start', ...input });
  expect(nativeTargetKey(Object.fromEntries(Object.entries(target).reverse()) as typeof target)).toBe(nativeTargetKey(input.target));
  expect(nativeTargetKey({ ...target, windowInstanceId: 'reused' })).not.toBe(nativeTargetKey(target));
});

it.each(["permissions", "targets", "check-readiness"] as const)("[COMP:app-web/native-computer] rejected %s cannot supersede pending Start, even arriving after completion", async type => {
  for (const late of [false, true]) {
    let finishStart!: (value: DesktopComputerControlResult) => void;
    let finishAux!: (value: DesktopComputerControlResult) => void;
    const control = vi.fn<ComputerControl>().mockResolvedValue({ ok: true });
    const owner = new NativeComputer(() => control); await owner.enter("w");
    control.mockImplementation(m => new Promise(resolve => { if (m.type === "start") finishStart = resolve; else finishAux = resolve; }));
    const start = owner.start("start", input); const auxiliary = owner.send({ type });
    const rejected = { ok: false, error: "Native setup busy" };
    if (!late) { finishAux(rejected); expect(await auxiliary).toEqual(rejected); }
    const inspection = { id: "only-snapshot", capturedAt: 1, completeness: "complete" as const, nodes: [] };
    finishStart({ ok: true, inspection }); await start;
    if (late) { finishAux(rejected); expect(await auxiliary).toEqual(rejected); }
    expect(owner.snapshot().inspection).toEqual(inspection);
    const stop = owner.stop(); expect(owner.snapshot().inspection).toBeUndefined();
    finishAux({ ok: true }); await stop;
  }
});

it.each(['startup_timeout', 'startup_refused', 'spawn_failed', 'unavailable', 'PRIVATE_REASON'])("[COMP:app-web/native-computer] allowlists readiness failure %s and clears it on success", async code => {
  const control = vi.fn<ComputerControl>().mockResolvedValue({ ok: true });
  const owner = new NativeComputer(() => control); await owner.enter("w");
  control.mockResolvedValueOnce({ ok: false, readinessErrorCode: code as any });
  await owner.send({ type: "check-readiness" });
  expect(owner.snapshot().readinessErrorCode).toBe(code === 'PRIVATE_REASON' ? undefined : code);
  expect(owner.snapshot().readinessFailed).toBe(true);
  await owner.stop(); expect(owner.snapshot().readinessErrorCode).toBeUndefined();
  control.mockResolvedValueOnce({ ok: true, readiness });
  await owner.send({ type: "check-readiness" });
  expect(owner.snapshot().readinessErrorCode).toBeUndefined();
  expect(owner.snapshot().readinessFailed).toBe(false);
});
const readiness = { helperAdmitted: true as const, capabilities: { platform: "darwin" } as NonNullable<DesktopComputerControlResult["status"]>["capabilities"] };
it("[COMP:app-web/native-computer] readiness metadata and failures preserve the inspector and status", async () => {
  const inspection = { id: "local", capturedAt: 1, completeness: "complete" as const, nodes: [] };
  const status = { state: "stopped", epoch: 2 } as DesktopComputerControlResult["status"];
  const control = vi.fn<ComputerControl>().mockResolvedValue({ ok: true, status, inspection });
  const owner = new NativeComputer(() => control); await owner.enter("w");
  control.mockResolvedValueOnce({ ok: true, readiness });
  await owner.send({ type: "check-readiness" });
  expect(owner.snapshot()).toMatchObject({ status, inspection, readiness, readinessPending: false });
  control.mockRejectedValueOnce(new Error("private"));
  await owner.send({ type: "check-readiness" });
  expect(owner.snapshot()).toMatchObject({ status, inspection, readinessFailed: true });
  expect(owner.snapshot().readiness).toBeUndefined();
});
it.each(["stop", "workspace-changed", "disconnect"] as const)("[COMP:app-web/native-computer] %s discards late readiness and clears admission", async type => {
  let finish!: (value: DesktopComputerControlResult) => void;
  const control = vi.fn<ComputerControl>().mockResolvedValue({ ok: true, readiness });
  const owner = new NativeComputer(() => control); await owner.enter("w");
  await owner.send({ type: "check-readiness" });
  expect(owner.snapshot().readiness).toEqual(readiness);
  control.mockImplementation(m => m.type === "check-readiness" ? new Promise(resolve => { finish = resolve; }) : Promise.resolve({ ok: true }));
  const pending = owner.send({ type: "check-readiness" });
  await owner.send(type === "workspace-changed" ? { type, workspaceId: "other" } : { type });
  expect(owner.snapshot().readiness).toBeUndefined();
  expect(owner.snapshot().readinessPending).toBeFalsy();
  finish({ ok: true, readiness }); expect(await pending).toEqual({ ok: false });
  expect(owner.snapshot().readiness).toBeUndefined();
});


it("publishes cleanup polls during a hung start, keeps Stop available, and fences commands until confirmed cleanup", async () => {
  let finish!: (result: DesktopComputerControlResult) => void;
  const control = vi.fn<ComputerControl>().mockImplementation(async m => m.type === "start" ? new Promise(resolve => { finish = resolve; }) : { ok: true });
  const owner = new NativeComputer(() => control);
  await owner.enter("w");
  const starting = owner.start("start", input);
  control.mockResolvedValue({ ok: true, cleanupPending: true });
  await owner.check();
  expect(owner.snapshot()).toEqual({ ok: true, cleanupPending: true });
  const calls = control.mock.calls.length;
  for (const type of ["targets", "permissions", "check-readiness"] as const) await owner.send({ type });
  await owner.start("resume", input);
  expect(control).toHaveBeenCalledTimes(calls);
  await owner.stop(); await owner.stop();
  await owner.enter("other");
  finish({ ok: true, inspection: { id: "private", capturedAt: 1, completeness: "complete", nodes: [] } });
  await starting;
  expect(owner.snapshot()).toEqual({ ok: true, cleanupPending: true });
  control.mockRejectedValueOnce(new Error("private"));
  await owner.check();
  expect(owner.snapshot()).toEqual({ ok: false, cleanupPending: true });
  control.mockResolvedValueOnce({ ok: true });
  await owner.check();
  expect(owner.snapshot().cleanupPending).toBe(true);
  control.mockResolvedValue({ ok: true, cleanupPending: false });
  await owner.check();
  expect(owner.snapshot().cleanupPending).toBe(false);
  await owner.send({ type: "targets" });
  expect(control).toHaveBeenLastCalledWith({ type: "targets" });
});


it("an older status response cannot clear newly observed cleanup", async () => {
  let finish!: (result: DesktopComputerControlResult) => void;
  const control = vi.fn<ComputerControl>().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
    .mockResolvedValue({ ok: true, cleanupPending: true });
  const owner = new NativeComputer(() => control);
  const old = owner.check();
  await owner.check();
  finish({ ok: true, cleanupPending: false }); await old;
  expect(owner.snapshot().cleanupPending).toBe(true);
  control.mockResolvedValue({ ok: true, cleanupPending: false });
  await owner.check();
  expect(owner.snapshot().cleanupPending).toBe(false);
});

it.each(["status", "targets"] as const)("[COMP:app-web/native-computer] stale %s cannot return prior scope after cleanup has finished", async type => {
  for (const reject of [false, true]) {
    let finish!: (result: DesktopComputerControlResult) => void;
    let fail!: (error: Error) => void;
    const control = vi.fn<ComputerControl>().mockImplementationOnce(() => new Promise((resolve, reject) => { finish = resolve; fail = reject; }));
    const owner = new NativeComputer(() => control);
    const stale = owner.send({ type });
    control.mockResolvedValueOnce({ ok: true, cleanupPending: true });
    await owner.check();
    control.mockResolvedValueOnce({ ok: true, cleanupPending: false });
    await owner.check();
    const clean = owner.snapshot();
    if (reject) fail(new Error("old request failed"));
    else finish({ ok: true, cleanupPending: false, targets: [input.target] });
    expect(await stale).toEqual({ ok: false });
    expect(owner.snapshot()).toBe(clean);
  }
});

it.each([false, true])("[COMP:app-web/native-computer] confirms permission delivery across cleanup without restoring scope (poll finished=%s)", async cleared => {
  let finish!: (result: DesktopComputerControlResult) => void;
  const control = vi.fn<ComputerControl>().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const owner = new NativeComputer(() => control);
  const request = owner.send({ type: "permissions", permission: "accessibility" });
  control.mockResolvedValueOnce({ ok: true, cleanupPending: true }); await owner.check();
  if (cleared) { control.mockResolvedValueOnce({ ok: true, cleanupPending: false }); await owner.check(); }
  const clean = owner.snapshot();
  finish({ ok: true, cleanupPending: false, targets: [input.target], profileConnected: true,
    inspection: { id: 'old', capturedAt: 1, completeness: 'complete', nodes: [] } });
  expect(await request).toEqual({ ok: true });
  expect(owner.snapshot()).toBe(clean);
});
it.each([
  { ok: false, cleanupPending: false }, { ok: true }, { ok: true, cleanupPending: true },
])("[COMP:app-web/native-computer] refuses unconfirmed permission delivery across cleanup: %j", async result => {
  let finish!: (result: DesktopComputerControlResult) => void;
  const control = vi.fn<ComputerControl>().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const owner = new NativeComputer(() => control);
  const request = owner.send({ type: "permissions" });
  control.mockResolvedValueOnce({ ok: true, cleanupPending: true }); await owner.check();
  const clean = owner.snapshot(); finish(result);
  expect(await request).toEqual({ ok: false }); expect(owner.snapshot()).toBe(clean);
});
it.each(["stop", "workspace"])("[COMP:app-web/native-computer] permission delivery cannot bypass %s invalidation", async boundary => {
  let finish!: (result: DesktopComputerControlResult) => void;
  const control = vi.fn<ComputerControl>().mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const owner = new NativeComputer(() => control);
  const request = owner.send({ type: "permissions" });
  control.mockResolvedValue({ ok: true, cleanupPending: true }); await owner.check();
  if (boundary === "stop") await owner.stop(); else await owner.enter("other");
  const clean = owner.snapshot(); finish({ ok: true, cleanupPending: false });
  expect(await request).toEqual({ ok: false }); expect(owner.snapshot()).toBe(clean);
});

it("[COMP:app-web/native-computer] acknowledgment is explicit, unsupported fails closed, and native decline never confirms", async () => {
  const control = vi.fn<ComputerControl>().mockResolvedValue({ ok: true });
  const owner = new NativeComputer(() => control);
  await owner.enter("w"); await owner.check();
  await owner.send({ type: "acknowledge-verification" });
  expect(control).not.toHaveBeenCalledWith({ type: "acknowledge-verification" });
  control.mockResolvedValueOnce({ ok: true, verificationAvailable: true, verificationConsented: false });
  await owner.check();
  expect(control).not.toHaveBeenCalledWith({ type: "acknowledge-verification" });
  control.mockResolvedValueOnce({ ok: false });
  await owner.send({ type: "acknowledge-verification" });
  expect(owner.snapshot().verificationConsented).toBe(false);
  control.mockResolvedValueOnce({ ok: true }); // Success alone is not native approval.
  await owner.send({ type: "acknowledge-verification" });
  expect(owner.snapshot().verificationConsented).toBe(false);
  control.mockResolvedValueOnce({ ok: true, verificationConsented: true });
  await owner.send({ type: "acknowledge-verification" });
  expect(owner.snapshot().verificationConsented).toBe(true);
  await owner.send({ type: "targets" });
  expect(owner.snapshot().verificationConsented).toBe(true);
  await owner.check(); // A status without optional support must not retain old approval.
  expect(owner.snapshot().verificationConsented).toBeUndefined();
});

it.each(["stop", "workspace-changed", "disconnect"] as const)("[COMP:app-web/native-computer] %s fences native approval and stale status immediately", async type => {
  let approve!: (result: DesktopComputerControlResult) => void;
  let poll!: (result: DesktopComputerControlResult) => void;
  const control = vi.fn<ComputerControl>().mockResolvedValue({ ok: true, verificationAvailable: true, verificationConsented: true });
  const owner = new NativeComputer(() => control);
  await owner.enter("w"); await owner.check();
  control.mockImplementation(m => m.type === "acknowledge-verification" ? new Promise(resolve => { approve = resolve; }) : m.type === "status" ? new Promise(resolve => { poll = resolve; }) : Promise.resolve({ ok: true }));
  const pending = owner.send({ type: "acknowledge-verification" });
  const stale = owner.check();
  const revision = owner.setupRevision;
  const reset = owner.send(type === "workspace-changed" ? { type, workspaceId: "other" } : { type });
  expect(owner.snapshot().verificationConsented).toBeUndefined();
  expect(owner.setupRevision).toBeGreaterThan(revision);
  await reset;
  approve({ ok: true, verificationConsented: true });
  poll({ ok: true, verificationAvailable: true, verificationConsented: true });
  expect(await pending).toEqual({ ok: false });
  expect(await stale).toEqual({ ok: false });
  expect(owner.snapshot().verificationConsented).toBeUndefined();
});

it("[COMP:app-web/native-computer] cleanup fences a late native approval even after cleanup finishes", async () => {
  let finish!: (result: DesktopComputerControlResult) => void;
  const control = vi.fn<ComputerControl>().mockResolvedValue({ ok: true, verificationAvailable: true });
  const owner = new NativeComputer(() => control);
  await owner.enter("w"); await owner.check();
  control.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const pending = owner.send({ type: "acknowledge-verification" });
  control.mockResolvedValueOnce({ ok: true, cleanupPending: true }); await owner.check();
  control.mockResolvedValueOnce({ ok: true, cleanupPending: false }); await owner.check();
  finish({ ok: true, verificationConsented: true });
  expect(await pending).toEqual({ ok: false });
  expect(owner.snapshot().verificationConsented).toBeUndefined();
});

it("[COMP:app-web/native-computer] visual capability is optional and requires both permissions, not raw input", async () => {
  const { supportsNativeVisual } = await import("../native-computer");
  const caps = { semanticActions: true, windowCapture: true, input: false, visualInvokeVersion: 1, accessibilityPermission: "granted", capturePermission: "granted" } as NonNullable<DesktopComputerControlResult["status"]>["capabilities"];
  expect(supportsNativeVisual(caps)).toBe(true);
  expect(supportsNativeVisual(undefined)).toBe(false);
  for (const unsupported of [{ visualInvokeVersion: undefined }, { accessibilityPermission: "denied" as const }, { capturePermission: "unknown" as const }, { semanticActions: false }, { windowCapture: false }]) {
    expect(supportsNativeVisual({ ...caps, ...unsupported })).toBe(false);
  }
});

it('[COMP:app-web/native-computer] profile connect projects only selected permissions and ignores late replies after disconnect', async () => {
  let finish!: (value: DesktopComputerControlResult) => void;
  const control = vi.fn<ComputerControl>().mockImplementation(m => m.type === 'connect-profile' ? new Promise(resolve => { finish = resolve; }) : Promise.resolve({ ok: true, profileConnected: false }));
  const owner = new NativeComputer(() => control);
  await owner.enter('w');
  const pending = owner.connectProfile({ ...input, profileId: 'profile' });
  expect(control).toHaveBeenLastCalledWith({ type: 'connect-profile', workspaceId: 'w', profileId: 'profile', target: input.target, allowControl: false, allowCapture: false });
  await owner.disconnectProfile();
  finish({ ok: true, profileId: 'profile', profileConnected: true }); await pending;
  expect(owner.snapshot().profileConnected).toBe(false);
});

const profileCodes = ["native_execution_unavailable", "computer_profiles_schema_unavailable", "sign_in_required", "computer_profiles_forbidden", "api_not_supported", "network_unreachable", "computer_profiles_unavailable"] as const;
it.each(profileCodes)("[COMP:app-web/native-computer] propagates safe profile code %s", async profileErrorCode => {
  const control = vi.fn<ComputerControl>().mockResolvedValue({ ok: false, profileErrorCode });
  const owner = new NativeComputer(() => control);
  await owner.enter("w");
  expect(owner.snapshot()).not.toHaveProperty("profileErrorCode");
  expect(await owner.connectProfile({ ...input, profileId: "p" })).toMatchObject({ profileErrorCode });
  expect(owner.snapshot()).toMatchObject({ profileErrorCode });
  await owner.check();
  expect(owner.snapshot()).not.toHaveProperty("profileErrorCode");
});
it.each(["PRIVATE_BODY", "computer_profiles_duplicate", { code: "native_execution_unavailable" }, null])("[COMP:app-web/native-computer] drops unknown profile code %j", async code => {
  const control = vi.fn<ComputerControl>().mockResolvedValue({ ok: false, profileErrorCode: code } as DesktopComputerControlResult);
  const owner = new NativeComputer(() => control);
  await owner.enter("w");
  const result = await owner.connectProfile({ ...input, profileId: "p" });
  expect(result).not.toHaveProperty("profileErrorCode");
  expect(owner.snapshot()).not.toHaveProperty("profileErrorCode");
});
