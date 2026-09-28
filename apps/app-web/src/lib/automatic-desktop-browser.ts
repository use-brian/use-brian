import { desktopBridge, type DesktopBridge } from "./desktop-auth-source";
import { pairBrowserExtension } from "./api/computer";

type Status = Awaited<ReturnType<NonNullable<DesktopBridge["browserControl"]>>>;
export type LocalProfile = { id: string; defaultBackend: string; canManage?: boolean };
export type BrowserState = {
  workspaceId: string; profileId?: string;
  phase: "idle" | "connecting" | "connected" | "paused" | "failed";
};
const empty: BrowserState = { workspaceId: "", phase: "idle" };

export function chooseLocalProfile(profiles: LocalProfile[], activeId?: string) {
  const local = profiles.filter(p => p.defaultBackend === "local" && p.canManage === true);
  return local.find(p => p.id === activeId) ?? local.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)[0];
}

/** One renderer-wide owner. Polling observes state, never retries a failed attempt.
 * Native cancel must invalidate pending consent/pair without pausing a live host.
 * [COMP:app-web/automatic-desktop-browser]
 */
export class AutomaticDesktopBrowser {
  private state = empty;
  private listeners = new Set<() => void>();
  private workspace = "";
  private profiles: LocalProfile[] = [];
  private generation = 0;
  private abort?: AbortController;
  private running = false;
  private pairing = false;
  private attempted = new Set<string>();
  constructor(
    private control = () => desktopBridge()?.browserControl,
    private mint = pairBrowserExtension,
  ) {}
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = () => this.state;
  serverSnapshot = () => empty;
  private publish(state: BrowserState) {
    if (JSON.stringify(state) === JSON.stringify(this.state)) return;
    this.state = state;
    this.listeners.forEach(fn => fn());
  }
  configure(workspace: string, profiles: LocalProfile[]) {
    this.cancel();
    this.workspace = workspace;
    this.profiles = profiles;
    void this.check();
  }
  cancel() {
    this.generation++;
    this.abort?.abort();
    if (this.pairing) void this.control()?.({ type: "cancel" }).catch(() => {});
  }
  leave() { this.cancel(); this.workspace = ""; }
  show = async () => { await this.control()?.({ type: "show" }); };
  retry = async () => { await this.check(true); };
  check = async (explicit = false) => {
    const control = this.control();
    if (this.running || !this.workspace || !control) return;
    this.running = true;
    const generation = this.generation;
    const workspace = this.workspace;
    const valid = () => generation === this.generation && workspace === this.workspace;
    let target: LocalProfile | undefined;
    let key: string | undefined;
    try {
      let status: Status = await control({ type: "status" });
      if (!valid()) return;
      if (!status.ok) throw new Error("status unavailable");
      // Native pairing may finish before its IPC reply. Reconcile the native
      // identity even when cancellation prevented this renderer from adopting it.
      if (status.workspaceId === workspace && status.browserProfileId &&
          !this.profiles.some(p => p.id === status.browserProfileId && p.defaultBackend === "local" && p.canManage === true)) {
        await control({ type: "disconnect" });
        if (!valid()) return;
        status = await control({ type: "status" });
        if (!valid()) return;
      }
      target = chooseLocalProfile(this.profiles, status.workspaceId === workspace ? status.browserProfileId : undefined);
      if (!target) { this.publish({ workspaceId: workspace, phase: "idle" }); return; }
      const base = { workspaceId: workspace, profileId: target.id };
      if (status.connected) {
        this.publish({ ...base, phase: status.workspaceId === workspace && status.browserProfileId === target.id ? "connected" : "idle" });
        return; // Never replace an active host, including one belonging to another workspace.
      }
      if (status.automaticBlocked && !explicit) { this.publish({ ...base, phase: "paused" }); return; }
      key = `${workspace}/${target.id}`;
      if (this.attempted.has(key) && !explicit) {
        this.publish({ ...base, phase: "failed" }); return;
      }
      this.attempted.add(key);
      this.publish({ ...base, phase: "connecting" });
      const expectedControlEpoch = explicit ? status.controlEpoch : undefined;
      if (explicit && !Number.isSafeInteger(expectedControlEpoch)) throw new Error("resume fencing unavailable");
      this.abort = new AbortController();
      const token = await this.mint(workspace, target.id, this.abort.signal);
      if (!valid()) { this.attempted.delete(key); return; }
      if (!token) throw new Error("pair token unavailable");
      // Recheck after HTTP: Stop or another owner may have appeared meanwhile.
      status = await control({ type: "status" });
      if (!valid()) { this.attempted.delete(key); return; }
      if (!status.ok) throw new Error("status unavailable");
      if (explicit && status.controlEpoch !== expectedControlEpoch) {
        this.publish({ ...base, phase: "paused" }); return;
      }
      if (status.connected || (status.automaticBlocked && !explicit)) {
        this.publish({ ...base, phase: status.automaticBlocked ? "paused" : "idle" }); return;
      }
      this.pairing = true;
      const result = await control({ type: "pair", relayUrl: token.relayUrl, pairingToken: token.pairingToken, automatic: !explicit, ...(explicit ? { expectedControlEpoch } : {}) });
      if (!valid()) { this.attempted.delete(key); return; }
      const after = await control({ type: "status" });
      if (!valid()) return;
      this.publish({ ...base, phase: after.automaticBlocked ? "paused" : result.ok && after.connected && after.workspaceId === workspace && after.browserProfileId === target.id ? "connected" : "failed" });
    } catch {
      if (valid()) this.publish({ workspaceId: workspace, profileId: target?.id, phase: "failed" });
      else if (key) this.attempted.delete(key);
    } finally {
      this.running = false;
      this.pairing = false;
      if (!valid() && this.workspace) void this.check();
    }
  };
}
export const automaticDesktopBrowser = new AutomaticDesktopBrowser();
