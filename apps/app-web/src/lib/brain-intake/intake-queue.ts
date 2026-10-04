/**
 * The workspace brain-intake queue: every file handed over by "Add to brain"
 * lives here from enqueue until the user clears its row, so the modal that
 * chose the files can close at once and the user keeps navigating while a
 * large recording uploads.
 *
 * A MODULE-LEVEL store, not React state, on purpose: uploads are promises
 * that outlive any component, and the tray reading this is mounted inside the
 * never-unmounting `/w/[workspaceId]` layout. Session scope - a hard reload
 * drops in-flight transfers with the page (the browser aborts them anyway)
 * and finished rows are not persisted.
 *
 * Spec: docs/architecture/features/files.md -> "The intake queue and the
 * bottom-bar tray". [COMP:app-web/brain-intake-queue]
 */

import { useSyncExternalStore } from "react";
import type { IngestFileResult } from "@/lib/api/ingest";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import {
  defaultIntakeDeps,
  reviewRecording,
  runIntakeBatch,
  type IntakeDeps,
  type IntakeStore,
} from "./run-intake";

export type IntakeKind = "file" | "linkedin" | "media";

/**
 * `queued`          waiting its turn (media uploads run one at a time)
 * `uploading`       bytes in flight; `progress` is the signed PUT fraction for
 *                   media, null for a multipart body (it reports none)
 * `checking`        the recording estimate (cheap server probe, no model call)
 * `awaiting_review` staged with a proven duration; the cost + blueprint
 *                   confirm opens only from the tray's Review button
 * `reviewing`       the confirm is open, or the 202 enqueue is in flight
 * `analyzing`       stored; the brain ingest job is on the worker queue
 * `done`            terminal success (added, stored, queued for transcription)
 * `error`           terminal failure; `error` carries the sentence
 */
export type IntakeStatus =
  | "queued"
  | "uploading"
  | "checking"
  | "awaiting_review"
  | "reviewing"
  | "analyzing"
  | "done"
  | "error";

export type IntakeItem = {
  id: string;
  workspaceId: string;
  assistantId: string | null;
  file: File;
  kind: IntakeKind;
  status: IntakeStatus;
  /** Signed-PUT byte fraction for a media upload; null when unknown. */
  progress: number | null;
  /** Ordinary / LinkedIn upload reply. */
  result?: IngestFileResult;
  /** Staged recording id once the media upload landed. */
  recordingId?: string;
  /** Proven duration from the estimate, shown on the Ready-to-review row. */
  durationSeconds?: number;
  /** Stored in workspace files but past the parse ceiling: not in the brain. */
  storedOnly?: boolean;
  error?: string;
};

const TERMINAL_STATUSES: ReadonlySet<IntakeStatus> = new Set(["done", "error"]);

export function isTerminal(item: Pick<IntakeItem, "status">): boolean {
  return TERMINAL_STATUSES.has(item.status);
}

type IntakeState = {
  items: IntakeItem[];
  /** Tray expanded per workspace; missing = collapsed. */
  expanded: Record<string, boolean>;
};

let state: IntakeState = { items: [], expanded: {} };
const listeners = new Set<() => void>();
let deps: IntakeDeps = defaultIntakeDeps;

function emit() {
  for (const listener of listeners) listener();
}

function setState(next: IntakeState) {
  state = next;
  emit();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): IntakeState {
  return state;
}

const EMPTY: IntakeItem[] = [];
const workspaceSnapshots = new Map<string, { source: IntakeItem[]; items: IntakeItem[] }>();

/** The workspace's rows, referentially stable while the store is unchanged. */
export function getIntakeItems(workspaceId: string): IntakeItem[] {
  const cached = workspaceSnapshots.get(workspaceId);
  if (cached && cached.source === state.items) return cached.items;
  const items = state.items.filter((item) => item.workspaceId === workspaceId);
  const stable = items.length === 0 ? EMPTY : items;
  workspaceSnapshots.set(workspaceId, { source: state.items, items: stable });
  return stable;
}

export function isIntakeTrayExpanded(workspaceId: string): boolean {
  return state.expanded[workspaceId] === true;
}

export function setIntakeTrayExpanded(workspaceId: string, expanded: boolean): void {
  if (isIntakeTrayExpanded(workspaceId) === expanded) return;
  setState({ ...state, expanded: { ...state.expanded, [workspaceId]: expanded } });
}

/** Subscribe a component to one workspace's rows + tray state. */
export function useIntakeQueue(workspaceId: string): {
  items: IntakeItem[];
  expanded: boolean;
} {
  const items = useSyncExternalStore(
    subscribe,
    () => getIntakeItems(workspaceId),
    () => EMPTY,
  );
  const expanded = useSyncExternalStore(
    subscribe,
    () => isIntakeTrayExpanded(workspaceId),
    () => false,
  );
  return { items, expanded };
}

/** Patch one row; a no-op for a row the user has already dismissed. */
export function updateIntakeItem(id: string, patch: Partial<IntakeItem>): void {
  if (!state.items.some((item) => item.id === id)) return;
  setState({
    ...state,
    items: state.items.map((item) => (item.id === id ? { ...item, ...patch } : item)),
  });
}

function getIntakeItem(id: string): IntakeItem | undefined {
  return state.items.find((item) => item.id === id);
}

const store: IntakeStore = { update: updateIntakeItem, get: getIntakeItem };

/**
 * Hand a validated batch to the queue and start it. The caller has already
 * applied the drop-time checks (size cap, batch cap, ZIP alone); the queue
 * takes every file it is given. The tray expands so the rows the user just
 * saw in the modal reappear where the wait now lives.
 */
export function enqueueIntake(input: {
  workspaceId: string;
  assistantId: string | null;
  files: File[];
  kind: (file: File) => IntakeKind;
  t: Dictionary;
}): IntakeItem[] {
  const created: IntakeItem[] = input.files.map((file) => ({
    id: crypto.randomUUID(),
    workspaceId: input.workspaceId,
    assistantId: input.assistantId,
    file,
    kind: input.kind(file),
    status: "queued",
    progress: null,
  }));
  if (created.length === 0) return created;
  setState({
    ...state,
    items: [...state.items, ...created],
    expanded: { ...state.expanded, [input.workspaceId]: true },
  });
  void runIntakeBatch(created, { deps, t: input.t, store });
  return created;
}

/**
 * A row whose recording is staged server-side and not yet queued: Ready to
 * review, or a failed review (a 5xx on the enqueue must not cost the user a
 * gigabyte upload; the bytes and duration are still there).
 */
export function canReviewIntakeItem(item: Pick<IntakeItem, "status" | "recordingId">): boolean {
  return (
    !!item.recordingId && (item.status === "awaiting_review" || item.status === "error")
  );
}

/** Open the cost + blueprint confirm for one staged recording. */
export function reviewIntakeItem(id: string, t: Dictionary): Promise<void> {
  const item = getIntakeItem(id);
  if (!item || !canReviewIntakeItem(item)) return Promise.resolve();
  return reviewRecording(item, { deps, t, store });
}

/** Remove one terminal row (in-flight rows stay: their promise is still running). */
export function dismissIntakeItem(id: string): void {
  const item = getIntakeItem(id);
  if (!item || !isTerminal(item)) return;
  setState({ ...state, items: state.items.filter((entry) => entry.id !== id) });
}

/** Remove every done/failed row of one workspace. */
export function clearFinishedIntake(workspaceId: string): void {
  const next = state.items.filter(
    (item) => item.workspaceId !== workspaceId || !isTerminal(item),
  );
  if (next.length === state.items.length) return;
  setState({ ...state, items: next });
}

/** Test seam: swap the SDK the runner calls, and wipe the store between cases. */
export function __setIntakeDepsForTests(next: IntakeDeps | null): void {
  deps = next ?? defaultIntakeDeps;
}

export function __resetIntakeQueueForTests(): void {
  workspaceSnapshots.clear();
  setState({ items: [], expanded: {} });
}
