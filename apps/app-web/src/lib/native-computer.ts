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
  capabilities: { protocol: "native-computer-v1"; platform: "darwin" | "win32" | "linux" | "unsupported"; axRead: boolean; semanticActions: boolean; windowCapture: boolean; input: boolean; accessibilityPermission: "granted" | "denied" | "unknown"; capturePermission: "granted" | "denied" | "unknown"; limitations: string[] };
  identity?: { deploymentId: string; userId: string; workspaceId: string; deviceId: string; sessionId: string; conversationId: string; taskId: string }; expiresAt?: number;
};
/** allowControl=false selects the one-shot local inspector, not a remote read-only model task. */
export type NativeStart = { workspaceId: string; assistantId: string; conversationId: string; taskId: string; goal: string; target: DiscoveredTarget; allowControl: boolean; allowCapture: boolean };
export type DesktopComputerControlMessage =
  | { type: "status" | "targets" | "check-readiness" | "stop" | "disconnect" }
  | { type: "permissions"; permission?: "accessibility" | "screen-recording" }
  | { type: "workspace-changed"; workspaceId: string }
  | ({ type: "start" | "resume" } & NativeStart);
export type NativeInspection = { id: string; capturedAt: number; completeness: "complete" | "partial" | "unavailable";
  nodes: { ref: string; parentRef?: string; role: string; name: string; value?: string; enabled: boolean; sensitive: boolean }[] };
export type DesktopComputerControlResult = { ok: boolean; cleanupPending?: boolean; error?: string; status?: NativeStatus; targets?: DiscoveredTarget[]; deviceId?: string; inspection?: NativeInspection; readiness?: { helperAdmitted: true; capabilities: NativeStatus["capabilities"] } };
export type ComputerControl = (message: DesktopComputerControlMessage) => Promise<DesktopComputerControlResult>;

/** A single persistent renderer owner. No automatic start, resume, pairing or API exchange. */
export class NativeComputer {
  private value: DesktopComputerControlResult & { readinessPending?: boolean; readinessFailed?: boolean } = { ok: false };
  private listeners = new Set<() => void>();
  private generation = 0;
  private cleanupRevision = 0;
  private workspaceId = "";
  private starting?: number;
  constructor(private bridge: () => ComputerControl | undefined = () => desktopBridge()?.computerControl) {}
  snapshot = () => this.value;
  serverSnapshot = (): typeof this.value => EMPTY;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(value: typeof this.value) { this.value = value; this.listeners.forEach(fn => fn()); }
  async send(message: DesktopComputerControlMessage) {
    if (this.value.cleanupPending && ["start", "resume", "targets", "permissions", "check-readiness"].includes(message.type)) return { ok: false, cleanupPending: true };
    const cleanupRevision = this.cleanupRevision;
    const readiness = message.type === "check-readiness";
    const polling = message.type === "status";
    const auxiliary = readiness || polling || message.type === "permissions" || message.type === "targets";
    const beginsStart = message.type === "start" || message.type === "resume";
    const generation = auxiliary ? this.generation : ++this.generation;
    const duringStart = auxiliary && this.starting === generation;
    if (beginsStart) this.starting = generation;
    if (readiness && !duringStart) this.publish({ ...this.value, readiness: undefined, readinessFailed: false, readinessPending: true });
    if (["disconnect", "workspace-changed"].includes(message.type)) this.publish({ ok: false, ...(this.value.cleanupPending ? { cleanupPending: true } : {}) });
    if (["start", "resume", "disconnect", "workspace-changed", "stop"].includes(message.type)) this.publish({ ...this.value, inspection: undefined, readiness: undefined, readinessFailed: undefined, readinessPending: undefined });
    try {
      const result = await this.bridge()?.(message) ?? EMPTY;
      if (generation !== this.generation) return EMPTY;
      // A reply begun before observed cleanup cannot restore old status/targets,
      // even if a newer poll has already confirmed that cleanup finished.
      if (auxiliary && cleanupRevision !== this.cleanupRevision) return EMPTY;
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
      this.publish({ ...result, readiness: previous.readiness, readinessFailed: previous.readinessFailed, readinessPending: previous.readinessPending, ...(polling && sameSession && previous.inspection ? { inspection: previous.inspection } : {}) });
      return result;
    } catch {
      if (generation === this.generation && !(auxiliary && cleanupRevision !== this.cleanupRevision) && !duringStart && !(auxiliary && this.starting === generation)) this.publish(readiness ? { ...this.value, readiness: undefined, readinessFailed: true, readinessPending: false } : this.value.cleanupPending ? { ok: false, cleanupPending: true } : EMPTY);
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
  start(type: "start" | "resume", input: NativeStart) {
    if (input.workspaceId !== this.workspaceId || !input.assistantId || !input.conversationId || !input.taskId || !input.goal.trim() || input.goal.length > 2000 || !isNativeTarget(input.target)) return Promise.resolve(EMPTY);
    // Explicit projection keeps accidental UI metadata (or tokens) off IPC.
    const { workspaceId, assistantId, conversationId, taskId, goal, target, allowControl, allowCapture } = input;
    return this.send({ type, workspaceId, assistantId, conversationId, taskId, goal, target: nativeTargetIdentity(target), allowControl, allowCapture });
  }
}
const EMPTY: DesktopComputerControlResult = { ok: false };
export const nativeComputer = new NativeComputer();
