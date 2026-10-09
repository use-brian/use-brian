"use client";

/**
 * Live Office job progress over the per-job stream
 * (`GET /api/office/jobs/:jobId/stream`).
 *
 * One connection per job per tab, shared through a module-level registry keyed
 * by `jobId`: the rail, the canvas, edit cards and comments all subscribe to
 * the same stream. Reconnects resume from the last seen seq (`Last-Event-ID`)
 * on jittered backoff, and each connect refreshes the token through
 * `authFetch`. A hidden tab releases its stream after 60s. There is no timer
 * poll beside the stream: the reconnect with catch-up IS the degraded path,
 * and while it runs the connection state says so.
 *
 * Spec: docs/architecture/features/office.md -> "Live job progress".
 * [COMP:app-web/office-job-stream]
 */
import { useCallback, useSyncExternalStore } from "react";
import { createSSEBuffer, parseSSEStream } from "@use-brian/chat-ui";
import { authFetch } from "@/lib/auth-fetch";
import { publicRuntimeConfig } from "@/lib/runtime-public-config";
import { createVisibilityGate, reconnectDelayMs } from "@/lib/workspace-events";
import type { OfficeJob, OfficeJobEvent } from "./api";

const API_URL = publicRuntimeConfig().apiUrl ?? "http://localhost:4000";

export type OfficeJobConnection = "live" | "reconnecting" | "offline";
export type OfficeJobStreamState = {
  job: OfficeJob | null;
  events: OfficeJobEvent[];
  connection: OfficeJobConnection;
  /** `done` after a terminal frame; `revoked` when access ended (job and events cleared). */
  ended: null | "done" | "revoked";
};

/** Statuses after which a waiter can act: terminal, or paused for input. */
const SETTLED = new Set(["completed", "failed", "cancelled", "needs_input"]);

type Entry = {
  state: OfficeJobStreamState;
  listeners: Set<() => void>;
  lastSeq: number;
  inner: AbortController | null;
  dispose: () => void;
};

const registry = new Map<string, Entry>();
const INITIAL: OfficeJobStreamState = { job: null, events: [], connection: "reconnecting", ended: null };

function offline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

function wait(signal: AbortSignal, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

function update(entry: Entry, patch: Partial<OfficeJobStreamState>): void {
  entry.state = { ...entry.state, ...patch };
  for (const listener of entry.listeners) listener();
}

/** Apply one stream frame. Exported for the unit test. */
export function applyOfficeJobFrame(state: OfficeJobStreamState, lastSeq: number, event: string, data: unknown): { state: OfficeJobStreamState; lastSeq: number } {
  if (event === "job") return { state: { ...state, job: data as OfficeJob, connection: "live" }, lastSeq };
  if (event === "event") {
    const row = data as OfficeJobEvent;
    if (typeof row?.seq !== "number" || row.seq <= lastSeq) return { state, lastSeq };
    return { state: { ...state, events: [...state.events, row], connection: "live" }, lastSeq: row.seq };
  }
  if (event === "done") return { state: { ...state, ended: "done", connection: "live" }, lastSeq };
  if (event === "revoked") return { state: { job: null, events: [], ended: "revoked", connection: "live" }, lastSeq };
  return { state, lastSeq };
}

async function run(jobId: string, entry: Entry, signal: AbortSignal): Promise<void> {
  let attempt = 0;
  while (!signal.aborted && !entry.state.ended) {
    let opened = false;
    try {
      const response = await authFetch(`${API_URL}/api/office/jobs/${encodeURIComponent(jobId)}/stream`, {
        signal,
        cache: "no-store",
        headers: entry.lastSeq > 0 ? { "Last-Event-ID": String(entry.lastSeq) } : {},
      });
      if (response.status === 404) {
        update(entry, { job: null, events: [], ended: "revoked", connection: "live" });
        return;
      }
      if (!response.ok || !response.body) throw new Error("office_job_stream_unavailable");
      opened = true;
      attempt = 0;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      const buffer = createSSEBuffer();
      while (!signal.aborted) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const frame of parseSSEStream(decoder.decode(value, { stream: true }), buffer)) {
          const next = applyOfficeJobFrame(entry.state, entry.lastSeq, frame.event, frame.data);
          entry.lastSeq = next.lastSeq;
          if (next.state !== entry.state) update(entry, next.state);
        }
        if (entry.state.ended) return;
      }
    } catch {
      if (signal.aborted) return;
    }
    if (signal.aborted || entry.state.ended) return;
    // A clean server cycle reconnects at once; a failure backs off.
    update(entry, { connection: offline() ? "offline" : "reconnecting" });
    await wait(signal, opened ? 0 : reconnectDelayMs(attempt++));
  }
}

function open(jobId: string): Entry {
  const existing = registry.get(jobId);
  if (existing) return existing;
  const entry: Entry = { state: INITIAL, listeners: new Set(), lastSeq: 0, inner: null, dispose: () => undefined };
  registry.set(jobId, entry);
  if (typeof document === "undefined") return entry;
  const connect = () => {
    if (entry.inner || entry.state.ended) return;
    const controller = new AbortController();
    entry.inner = controller;
    void run(jobId, entry, controller.signal).finally(() => {
      if (entry.inner === controller) entry.inner = null;
    });
  };
  const disconnect = () => {
    entry.inner?.abort();
    entry.inner = null;
    if (!entry.state.ended) update(entry, { connection: "reconnecting" });
  };
  const gate = createVisibilityGate({ connect, disconnect });
  const onVisibility = () => gate.onVisibility(document.visibilityState === "hidden" ? "hidden" : "visible");
  const onOnline = () => { if (!entry.state.ended && entry.state.connection === "offline") { disconnect(); connect(); } };
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("online", onOnline);
  entry.dispose = () => {
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("online", onOnline);
    gate.dispose();
    entry.inner?.abort();
    entry.inner = null;
  };
  // A tab that starts hidden connects on first focus (workspace-events rule).
  if (document.visibilityState !== "hidden") connect();
  return entry;
}

/** Subscribe to a job's live state; the last unsubscribe closes the shared stream. */
export function subscribeOfficeJobStream(jobId: string, listener: () => void): () => void {
  const entry = open(jobId);
  entry.listeners.add(listener);
  return () => {
    entry.listeners.delete(listener);
    if (entry.listeners.size) return;
    entry.dispose();
    if (registry.get(jobId) === entry) registry.delete(jobId);
  };
}

export function readOfficeJobStream(jobId: string | null | undefined): OfficeJobStreamState {
  return (jobId && registry.get(jobId)?.state) || INITIAL;
}

/** Live `{ job, events, connection }` for one job; `undefined` stays idle. */
export function useOfficeJobStream(jobId: string | null | undefined): OfficeJobStreamState {
  const subscribe = useCallback((listener: () => void) => jobId ? subscribeOfficeJobStream(jobId, listener) : () => undefined, [jobId]);
  const snapshot = useCallback(() => readOfficeJobStream(jobId), [jobId]);
  return useSyncExternalStore(subscribe, snapshot, () => INITIAL);
}

/**
 * Resolve once the job settles (terminal or paused for input), over the same
 * registry. No wall-clock cap: liveness, not wall-clock. Rejects when access
 * is revoked or when `isCurrent` reports that the caller no longer owns the wait.
 */
export function awaitOfficeJob(jobId: string, isCurrent: () => boolean = () => true): Promise<OfficeJob> {
  return new Promise((resolve, reject) => {
    let unsubscribe: (() => void) | null = null;
    let settled = false;
    const finish = (outcome: () => void) => {
      if (settled) return;
      settled = true;
      queueMicrotask(() => unsubscribe?.());
      outcome();
    };
    const check = () => {
      if (!isCurrent()) return finish(() => reject(new Error("office_job_owner_expired")));
      const state = readOfficeJobStream(jobId);
      if (state.ended === "revoked") return finish(() => reject(new Error("office_job_revoked")));
      if (state.job && SETTLED.has(state.job.status)) {
        const job = state.job;
        return finish(() => resolve(job));
      }
    };
    unsubscribe = subscribeOfficeJobStream(jobId, check);
    if (settled) unsubscribe();
    else check();
  });
}

/** Test-only teardown. */
export function _resetOfficeJobStreams(): void {
  for (const entry of registry.values()) entry.dispose();
  registry.clear();
}
