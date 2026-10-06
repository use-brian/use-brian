import { desktopBridge } from "./desktop-auth-source";

/** Structural copy of computer-control/protocol. No grants or credentials cross this seam. */
export type NativeTarget = { appId: string; processId: number; processInstanceId: string; windowId: string; windowInstanceId: string };
export type DiscoveredTarget = NativeTarget & { displayName?: string };
/** Canonical field order, independent of helper JSON key order or mutable labels. */
export function nativeTargetIdentity({ appId, processId, processInstanceId, windowId, windowInstanceId }: NativeTarget): NativeTarget {
  return { appId, processId, processInstanceId, windowId, windowInstanceId };
}
export const nativeTargetKey = (target: NativeTarget) => JSON.stringify(nativeTargetIdentity(target));
/** Reject malformed discovery data; main still revalidates target membership at consent. */
export function isNativeTarget(value: unknown): value is DiscoveredTarget {
  if (!value || typeof value !== "object") return false;
  const target = value as Record<string, unknown>;
  const keys = ["appId", "processInstanceId", "windowId", "windowInstanceId"];
  return Object.keys(target).every(key => [...keys, "processId", "displayName"].includes(key)) && (target.displayName === undefined || typeof target.displayName === "string" && target.displayName.length <= 256) && keys.every(key => typeof target[key] === "string" && target[key].length > 0 && target[key].length <= 256)
    && typeof target.processId === "number" && Number.isSafeInteger(target.processId) && target.processId > 0;
}
export type NativeState = "unavailable" | "permission_required" | "ready" | "awaiting_local_consent" | "active" | "awaiting_action_approval" | "paused_for_user" | "stopped" | "ended";
export type NativeStatus = {
  protocol: "native-computer-v1"; state: NativeState; epoch: number;
  capabilities: { protocol: "native-computer-v1"; platform: "darwin" | "win32" | "linux" | "unsupported"; axRead: boolean; semanticActions: boolean; windowCapture: boolean; input: boolean; visualInvokeVersion?: 1; accessibilityPermission: "granted" | "denied" | "unknown"; capturePermission: "granted" | "denied" | "unknown"; limitations: string[] };
  identity?: { deploymentId: string; userId: string; workspaceId: string; deviceId: string; sessionId: string; conversationId: string } & ({ taskId: string; profileId?: never } | { profileId: string; taskId?: never }); expiresAt?: number;
};
export function supportsNativeVisual(caps?: NativeStatus["capabilities"]) {
  return caps?.semanticActions === true && caps.windowCapture === true && caps.visualInvokeVersion === 1
    && caps.accessibilityPermission === "granted" && caps.capturePermission === "granted";
}
/** allowControl=false runs a one-shot local inspector; capture must also be false. */
export type NativeProfileConnection = { workspaceId: string; profileId: string; target: DiscoveredTarget; allowControl: boolean; allowCapture: boolean };
/** Legacy: allowControl=false selects the one-shot local inspector. */
export type NativeStart = { workspaceId: string; assistantId: string; conversationId: string; taskId: string; goal: string; target: DiscoveredTarget; allowControl: boolean; allowCapture: boolean };
export type DesktopComputerControlMessage =
  | ({ type: "connect-profile" } & NativeProfileConnection)
  | { type: "disconnect-profile" }
  | { type: "status" | "targets" | "check-readiness" | "acknowledge-verification" | "stop" | "disconnect" }
  | { type: "permissions"; permission?: "accessibility" | "screen-recording" }
  | { type: "workspace-changed"; workspaceId: string }
  | ({ type: "start" | "resume" } & NativeStart);
export type NativeInspection = { id: string; capturedAt: number; completeness: "complete" | "partial" | "unavailable";
  nodes: { ref: string; parentRef?: string; role: string; name: string; value?: string; enabled: boolean; sensitive: boolean }[] };
const profileErrorCodes = ["native_execution_unavailable", "computer_profiles_schema_unavailable", "sign_in_required", "computer_profiles_forbidden", "api_not_supported", "network_unreachable", "computer_profiles_unavailable"] as const;
export type NativeProfileErrorCode = typeof profileErrorCodes[number];
export type DesktopComputerControlResult = { ok: boolean; profileId?: string; profileConnected?: boolean; profileErrorCode?: NativeProfileErrorCode; verificationAvailable?: boolean; verificationConsented?: boolean; cleanupPending?: boolean; error?: string; status?: NativeStatus; targets?: DiscoveredTarget[]; deviceId?: string; inspection?: NativeInspection; readiness?: { helperAdmitted: true; capabilities: NativeStatus["capabilities"] } };
export type ComputerControl = (message: DesktopComputerControlMessage) => Promise<DesktopComputerControlResult>;

/** A single persistent renderer owner. No automatic start, resume, pairing or API exchange. */
export class NativeComputer {
  private value: DesktopComputerControlResult & { readinessPending?: boolean; readinessFailed?: boolean } = { ok: false };
  private listeners = new Set<() => void>();
  private generation = 0;
  private cleanupRevision = 0;
  private consentRevision = 0;
  /** Revocation also clears form opt-ins when main returns the same status phase. */
  get setupRevision() { return this.consentRevision; }
  private workspaceId = "";
  private starting?: number;
  constructor(private bridge: () => ComputerControl | undefined = () => desktopBridge()?.computerControl) {}
  snapshot = () => this.value;
  serverSnapshot = (): typeof this.value => EMPTY;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(value: typeof this.value) { this.value = value; this.listeners.forEach(fn => fn()); }
  async send(message: DesktopComputerControlMessage) {
    if (message.type === "acknowledge-verification" && (!this.value.verificationAvailable || this.starting !== undefined)) return EMPTY;
    if (this.value.cleanupPending && ["connect-profile", "start", "resume", "targets", "permissions", "check-readiness", "acknowledge-verification"].includes(message.type)) return { ok: false, cleanupPending: true };
    if (["stop", "disconnect-profile", "disconnect", "workspace-changed"].includes(message.type)) ++this.consentRevision;
    const cleanupRevision = this.cleanupRevision;
    const readiness = message.type === "check-readiness";
    const polling = message.type === "status";
    const auxiliary = readiness || polling || message.type === "permissions" || message.type === "targets";
    const acknowledgment = message.type === "acknowledge-verification";
    const beginsStart = message.type === "connect-profile" || message.type === "start" || message.type === "resume" || acknowledgment;
    const generation = auxiliary ? this.generation : ++this.generation;
    const duringStart = auxiliary && this.starting === generation;
    if (beginsStart) this.starting = generation;
    if (acknowledgment || message.type === "stop") this.publish({ ...this.value, verificationConsented: undefined, ...(message.type === "stop" ? { profileId: undefined, profileConnected: false } : {}) });
    if (readiness && !duringStart) this.publish({ ...this.value, readiness: undefined, readinessFailed: false, readinessPending: true });
    if (["disconnect-profile", "disconnect", "workspace-changed"].includes(message.type)) this.publish({ ok: false, ...(this.value.cleanupPending ? { cleanupPending: true } : {}) });
    if (["connect-profile", "start", "resume", "disconnect", "workspace-changed", "stop"].includes(message.type)) this.publish({ ...this.value, inspection: undefined, readiness: undefined, readinessFailed: undefined, readinessPending: undefined });
    try {
      const { profileErrorCode, ...response } = await this.bridge()?.(message) ?? EMPTY;
      // IPC is a runtime boundary: unknown codes must not enter state or return values.
      const result: DesktopComputerControlResult = { ...response,
        ...(message.type === "connect-profile" && !response.ok && profileErrorCodes.includes(profileErrorCode as NativeProfileErrorCode)
          ? { profileErrorCode } : {}) };
      if (generation !== this.generation) return EMPTY;
      // A reply begun before observed cleanup cannot restore old status/targets,
      // even if a newer poll has already confirmed that cleanup finished.
      if ((auxiliary || acknowledgment) && cleanupRevision !== this.cleanupRevision) {
        // Permission setup intentionally stops discovery. A poll may observe that
        // teardown before main confirms the request was delivered. Acknowledge
        // only delivery; never restore any pre-cleanup status or authority.
        if (message.type === "permissions" && result.ok && result.cleanupPending === false) return { ok: true };
        return EMPTY;
      }
      if (result.cleanupPending) {
        ++this.cleanupRevision;
        this.publish({ ok: result.ok, cleanupPending: true });
        return result;
      }
      if (!this.value.cleanupPending && (duringStart || auxiliary && this.starting === generation)) return result;
      if (readiness) {
        this.publish({ ...this.value, readiness: result.ok ? result.readiness : undefined, readinessFailed: !result.ok || !result.readiness?.helperAdmitted, readinessPending: false });
        return result;
      }
      const previous = this.value;
      if (previous.cleanupPending && result.cleanupPending !== false) {
        this.publish({ ok: false, cleanupPending: true });
        return result;
      }
      const sameSession = result.ok && result.status?.identity && previous.status?.identity &&
        JSON.stringify(result.status.identity) === JSON.stringify(previous.status.identity) &&
        result.status.epoch === previous.status.epoch && ["active", "stopped"].includes(result.status.state);
      const verification = !polling && !["stop", "disconnect-profile", "disconnect", "workspace-changed", "connect-profile", "start", "resume"].includes(message.type)
        ? { verificationAvailable: previous.verificationAvailable, verificationConsented: acknowledgment ? result.ok && result.verificationConsented === true : previous.verificationConsented } : {};
      this.publish({ ...verification, ...result, readiness: previous.readiness, readinessFailed: previous.readinessFailed, readinessPending: previous.readinessPending, ...(polling && sameSession && previous.inspection ? { inspection: previous.inspection } : {}) });
      return result;
    } catch {
      if (generation === this.generation && !((auxiliary || acknowledgment) && cleanupRevision !== this.cleanupRevision) && !duringStart && !(auxiliary && this.starting === generation)) this.publish(readiness ? { ...this.value, readiness: undefined, readinessFailed: true, readinessPending: false } : this.value.cleanupPending ? { ok: false, cleanupPending: true } : EMPTY);
      return EMPTY;
    } finally { if (beginsStart && this.starting === generation) this.starting = undefined; }
  }
  enter(workspaceId: string) {
    this.workspaceId = workspaceId;
    this.publish(this.value.cleanupPending ? { ok: false, cleanupPending: true } : EMPTY);
    return this.send({ type: "workspace-changed", workspaceId });
  }
  clearInspection = () => { ++this.generation; this.publish({ ...this.value, inspection: undefined, readiness: undefined, readinessFailed: undefined, readinessPending: undefined }); };
  check = () => this.send({ type: "status" });
  stop = () => this.send({ type: "stop" });
  leave() { this.workspaceId = ""; return this.send({ type: "disconnect" }); }
  connectProfile(input: NativeProfileConnection) {
    if (input.workspaceId !== this.workspaceId || !input.profileId || !isNativeTarget(input.target) || typeof input.allowControl !== "boolean" || typeof input.allowCapture !== "boolean") return Promise.resolve(EMPTY);
    const { workspaceId, profileId, target, allowControl, allowCapture } = input;
    return this.send({ type: "connect-profile", workspaceId, profileId, target: nativeTargetIdentity(target), allowControl, allowCapture });
  }
  disconnectProfile = () => this.send({ type: "disconnect-profile" });
  start(type: "start" | "resume", input: NativeStart) {
    if (input.workspaceId !== this.workspaceId || !input.assistantId || !input.conversationId || !input.taskId || !input.goal.trim() || input.goal.length > 2000 || !isNativeTarget(input.target)) return Promise.resolve(EMPTY);
    // Explicit projection keeps accidental UI metadata (or tokens) off IPC.
    const { workspaceId, assistantId, conversationId, taskId, goal, target, allowControl, allowCapture } = input;
    return this.send({ type, workspaceId, assistantId, conversationId, taskId, goal, target: nativeTargetIdentity(target), allowControl, allowCapture });
  }
}
const EMPTY: DesktopComputerControlResult = { ok: false };
export const nativeComputer = new NativeComputer();
