import type { WorkspacePickerItem } from "./workspace-picker";
import type { WorkspaceContextValue } from "./workspace-context";
import { parseDesktopWorkspaceRows, parseDesktopWorkspaceContext } from "../../desktop/offline-bootstrap";

export type WorkspaceAdmission =
  | { kind: "allowed"; value: WorkspaceContextValue }
  | { kind: "checking" | "forbidden" | "missing" | "unavailable" };
export interface SessionSnapshot {
  session: "checking" | "signed-out" | "reauthenticate" | "authenticated";
  connection: "online" | "offline" | "unavailable";
  identity: string | null;
  workspaces: WorkspacePickerItem[];
  admissions: Record<string, WorkspaceAdmission>;
}
export interface SessionCache {
  identity: string;
  workspaces: WorkspacePickerItem[];
  contexts: Record<string, WorkspaceContextValue>;
}
export interface SessionAdapter {
  /** Scope only; decoding a subject is never evidence of authentication. */
  identity(): string | null;
  subject?(): string | null;
  hasCredential(): boolean;
  session(): Promise<{ status: number; data?: unknown }>;
  workspace(id: string): Promise<{ status: number; data?: unknown }>;
  read(identity: string): Promise<unknown>;
  write(identity: string, value: SessionCache | null): Promise<void>;
}
const empty = (): SessionSnapshot => ({ session: "checking", connection: "online", identity: null, workspaces: [], admissions: {} });

/** One single-flight authority for app entry. Spec: features/account-entry.md. [COMP:app-web/app-session] */
export class AppSessionController {
  private value = empty();
  private epoch = 0;
  private listeners = new Set<() => void>();
  private sessionFlight: Promise<void> | null = null;
  private workspaceFlights = new Map<string, Promise<void>>();
  private writes: Promise<void> = Promise.resolve();
  private cache: SessionCache | null = null;
  private rejected = new Set<string>();
  constructor(private adapter: SessionAdapter) {}
  snapshot = (): SessionSnapshot => this.value;
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };
  private publish(value: SessionSnapshot): void {
    this.value = value;
    for (const listener of this.listeners) listener();
  }
  private persist(value: SessionCache | null, identity: string): void {
    const epoch = this.epoch;
    this.writes = this.writes.catch(() => {}).then(async () => {
      if (value && epoch !== this.epoch) return;
      await this.adapter.write(identity, value);
    }).catch(() => {});
  }
  invalidate(logout = false, identity?: string | null): void {
    if (identity && ((this.value.identity && identity !== this.value.identity) || (this.adapter.identity() && identity !== this.adapter.identity()))) return;
    const old = identity ?? this.value.identity ?? this.adapter.identity();
    if (old) this.rejected.add(old);
    ++this.epoch;
    this.sessionFlight = null;
    this.workspaceFlights.clear();
    this.cache = null;
    this.publish({ ...empty(), session: logout ? "signed-out" : "reauthenticate", identity: old });
    if (old) this.persist(null, old);
  }
  private current(epoch: number, identity: string | null): boolean {
    return epoch === this.epoch && (!identity || this.adapter.identity() === identity);
  }
  check = (): Promise<void> => {
    const before = this.adapter.identity();
    if (before && this.value.identity && before !== this.value.identity) {
      ++this.epoch; this.sessionFlight = null; this.workspaceFlights.clear(); this.cache = null;
      this.publish({ ...empty(), identity: before });
    }
    if (this.sessionFlight) return this.sessionFlight;
    const epoch = this.epoch;
    const flight = this.resolveSession(epoch, before);
    this.sessionFlight = flight;
    void flight.finally(() => { if (this.sessionFlight === flight) this.sessionFlight = null; });
    return flight;
  };
  private async resolveSession(epoch: number, before: string | null): Promise<void> {
    try {
      const response = await this.adapter.session();
      if (epoch !== this.epoch || (before && this.adapter.identity() && before !== this.adapter.identity())) return;
      const identity = this.adapter.identity();
      if (response.status === 401) { this.invalidate(!before, before); return; }
      if (response.status < 200 || response.status >= 300 || !identity) {
        this.publish({ ...empty(), identity, connection: "unavailable" });
        return;
      }
      const list = response.data as { workspaces?: unknown; teams?: unknown } | null;
      if (!Array.isArray(list?.workspaces) && !Array.isArray(list?.teams)) { this.publish({ ...empty(), identity, connection: "unavailable" }); return; }
      const workspaces = parseDesktopWorkspaceRows(list.workspaces ?? list.teams);
      const same = identity === this.value.identity;
      this.rejected.delete(identity);
      this.cache = { identity, workspaces, contexts: this.cache?.identity === identity ? this.cache.contexts : {} };
      this.publish({ session: "authenticated", connection: "online", identity, workspaces,
        admissions: same ? this.value.admissions : {} });
      this.persist(this.cache, identity);
    } catch {
      if (!this.current(epoch, before)) return;
      const identity = this.adapter.identity();
      const raw = identity && !this.rejected.has(identity) && this.adapter.hasCredential() ? this.cache?.identity === identity ? this.cache : await this.adapter.read(identity).catch(() => null) : null;
      if (!this.current(epoch, before)) return;
      const cached = raw as Partial<SessionCache> | null;
      if (identity && cached?.identity === identity && Array.isArray(cached.workspaces) && cached.contexts && typeof cached.contexts === "object") {
        const subject = this.adapter.subject?.();
        const contexts = Object.fromEntries(Object.entries(cached.contexts).filter(([id, value]) =>
          value && value.workspaceId === id && (!subject || value.me?.id === subject)));
        const workspaces = parseDesktopWorkspaceRows(cached.workspaces).filter(row => contexts[row.id]);
        if (workspaces.length === 0) { this.publish({ ...empty(), identity, connection: "offline" }); return; }
        this.cache = { identity, workspaces, contexts };
        this.publish({ session: "authenticated", connection: "offline", identity,
          workspaces, admissions: {} });
      } else this.publish({ ...empty(), identity, connection: "offline" });
    }
  }
  admit = (id: string, force = false): Promise<void> => {
    if (this.value.session !== "authenticated") return Promise.resolve();
    if (this.workspaceFlights.has(id)) return this.workspaceFlights.get(id)!;
    if (!force && this.value.admissions[id]) return Promise.resolve();
    const epoch = this.epoch;
    const identity = this.value.identity;
    const flight = this.resolveWorkspace(id, epoch, identity);
    this.workspaceFlights.set(id, flight);
    void flight.finally(() => { if (this.workspaceFlights.get(id) === flight) this.workspaceFlights.delete(id); });
    return flight;
  };
  private admission(id: string, result: WorkspaceAdmission): void {
    this.publish({ ...this.value, admissions: { ...this.value.admissions, [id]: result } });
  }
  private async resolveWorkspace(id: string, epoch: number, identity: string | null): Promise<void> {
    if (this.value.admissions[id]?.kind !== "allowed") this.admission(id, { kind: "checking" });
    try {
      const response = await this.adapter.workspace(id);
      if (!this.current(epoch, identity)) return;
      if (response.status === 401) { this.invalidate(); return; }
      if (response.status === 403 || response.status === 404) {
        this.admission(id, { kind: response.status === 403 ? "forbidden" : "missing" });
        this.publish({ ...this.value, workspaces: this.value.workspaces.filter(row => row.id !== id) });
        if (this.cache) { const contexts = { ...this.cache.contexts }; delete contexts[id]; this.cache = { ...this.cache, contexts }; this.persist(this.cache, identity!); }
        return;
      }
      const data = response.data as { id?: string; name?: string; role?: string; me?: { id?: string } } | null;
      if (response.status !== 200 || data?.id !== id || typeof data.name !== "string" || (this.adapter.subject?.() && data.me?.id !== this.adapter.subject()) || !["owner", "admin", "member"].includes(data.role ?? "")) {
        this.admission(id, { kind: "unavailable" }); return;
      }
      const value = parseDesktopWorkspaceContext(id, data)!;
      this.admission(id, { kind: "allowed", value });
      if (this.cache) { this.cache = { ...this.cache, contexts: { ...this.cache.contexts, [id]: value } }; this.persist(this.cache, identity!); }
    } catch {
      if (!this.current(epoch, identity)) return;
      const cached = this.cache?.contexts[id];
      const value = cached && cached.workspaceId === id && this.adapter.hasCredential()
        ? parseDesktopWorkspaceContext(id, cached) : null;
      this.publish({ ...this.value, connection: "offline" });
      this.admission(id, value ? { kind: "allowed", value } : { kind: "unavailable" });
    }
  }
}

/** Normalize before trusting an origin; rejects slash/backslash authority escapes. */
export function safeAccountReturn(raw: string | null | undefined, origin: string): string {
  if (!raw || raw.length > 4096 || /[\\\u0000-\u0020]/.test(raw) || !raw.startsWith("/") || raw.startsWith("//")) return "/";
  try {
    const url = new URL(raw, origin);
    if (url.origin !== origin || url.pathname === "/accounts" || url.pathname.startsWith("/login")) return "/";
    return url.pathname + url.search + url.hash;
  } catch { return "/"; }
}
