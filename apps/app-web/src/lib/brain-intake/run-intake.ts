/**
 * The intake pipeline the queue runs a batch through. Pure orchestration over
 * an injected SDK (`IntakeDeps`) and an injected row store, so it is
 * unit-tested with no network and no React: the store in production is
 * `intake-queue.ts`, and the SDK is the same `lib/api/ingest.ts` /
 * `lib/api/recordings.ts` / `confirm-and-process.ts` the modal used to call
 * inline.
 *
 * - Ordinary files at or under the 30 MiB multipart ceiling go out through
 *   `ingestFiles` in one pass; larger ones (to 1 GiB) take the durable
 *   chunked storage lane one at a time and then the stored-file ingest route.
 *   Each `queued` reply is watched to a terminal state (an unreadable poll is
 *   NOT a failure - the job row is durable - so it keeps the row analyzing).
 * - A lone `.zip` goes to the LinkedIn importer.
 * - Media uploads run ONE AT A TIME with byte progress, run the cheap
 *   estimate, and stop at `awaiting_review`. The cost + blueprint confirm
 *   opens only from `reviewRecording` (the tray's Review button): the upload
 *   may finish long after the user moved to another surface, and a modal
 *   popping into their keystrokes is exactly what this queue exists to avoid.
 *   Nothing is spent before that click, and a cancelled confirm keeps the
 *   staged `recordingId` so Review never re-uploads.
 *
 * Spec: docs/architecture/features/files.md -> "The intake queue and the
 * bottom-bar tray". [COMP:app-web/brain-intake-queue]
 */

import {
  MAX_INGEST_FILE_BYTES,
  getIngestJobStatus,
  ingestFiles,
  ingestLinkedInArchive,
  reingestStoredFile,
  storeFiles,
  type IngestFileResult,
  type IngestJobStatus,
  type ReingestOutcome,
  type StoreFilesOptions,
} from "@/lib/api/ingest";
import {
  estimateRecording,
  recordingMimeForFile,
  startRecordingUpload,
  type RecordingEstimate,
} from "@/lib/api/recordings";
import {
  confirmAndProcessRecording,
  type ConfirmProcessInput,
  type ConfirmProcessResult,
} from "@/lib/recordings/confirm-and-process";
import { recordingFailureMessage } from "@/lib/recordings/failure-copy";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import type { IntakeItem, IntakeStatus } from "./intake-queue";

export type IntakeDeps = {
  ingestFiles: (workspaceId: string, files: File[]) => Promise<IngestFileResult[]>;
  /** The durable chunked lane (8 MiB parts, to 1 GiB) for files past the multipart ceiling. */
  storeFiles: (
    workspaceId: string,
    files: File[],
    options?: StoreFilesOptions,
  ) => Promise<IngestFileResult[]>;
  reingestStoredFile: (workspaceId: string, fileId: string) => Promise<ReingestOutcome>;
  ingestLinkedInArchive: (workspaceId: string, file: File) => Promise<IngestFileResult>;
  getIngestJobStatus: (
    jobId: string,
  ) => Promise<{ status: IngestJobStatus; error?: string } | null>;
  startRecordingUpload: (params: {
    workspaceId: string;
    assistantId: string;
    file: File;
    onProgress?: (progress: number) => void;
  }) => Promise<{ recordingId: string }>;
  estimateRecording: (recordingId: string) => Promise<RecordingEstimate>;
  confirmAndProcessRecording: (input: ConfirmProcessInput) => Promise<ConfirmProcessResult>;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
};

export const defaultIntakeDeps: IntakeDeps = {
  ingestFiles,
  storeFiles,
  reingestStoredFile,
  ingestLinkedInArchive,
  getIngestJobStatus,
  startRecordingUpload,
  estimateRecording,
  confirmAndProcessRecording,
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

/** The two store operations the runner needs; injected to avoid a module cycle. */
export type IntakeStore = {
  update: (id: string, patch: Partial<IntakeItem>) => void;
  get: (id: string) => IntakeItem | undefined;
};

export type RunContext = { deps: IntakeDeps; t: Dictionary; store: IntakeStore };

const POLL_INTERVAL_MS = 3_000;
/** Give up watching (not the job - the job is durable) after this long. */
const POLL_TIMEOUT_MS = 15 * 60_000;

/**
 * What one upload reply means for the row. Only the server saying so makes a
 * row red: a `queued` reply with a job id is analyzing, not done and not failed.
 */
export function statusForIngestResult(result: IngestFileResult | undefined): IntakeStatus {
  if (!result || !result.ok) return "error";
  if (result.status === "queued" && result.jobId) return "analyzing";
  return "done";
}

/**
 * `fetch` rejects with a bare `TypeError` for anything that never reached a
 * handler: offline, DNS, CORS, or a body the edge refused. Its message is not
 * something to show a user, so name the class of failure instead.
 */
function transportMessage(err: unknown, t: Dictionary): string {
  return err instanceof TypeError
    ? t.docPage.suggested.ingestUnreachable
    : (err as Error).message || t.docPage.suggested.ingestFailed;
}

async function watchJob(id: string, jobId: string, ctx: RunContext): Promise<void> {
  const deadline = ctx.deps.now() + POLL_TIMEOUT_MS;
  while (ctx.deps.now() < deadline) {
    await ctx.deps.sleep(POLL_INTERVAL_MS);
    // Dismissed rows stop polling; the job finishes on the worker either way.
    if (!ctx.store.get(id)) return;
    const state = await ctx.deps.getIngestJobStatus(jobId);
    if (!state) continue;
    if (state.status === "done") {
      ctx.store.update(id, { status: "done" });
      return;
    }
    if (state.status === "failed") {
      ctx.store.update(id, {
        status: "error",
        error: state.error ?? ctx.t.docPage.suggested.ingestFailed,
      });
      return;
    }
  }
}

/**
 * An ordinary file past the multipart ceiling: the durable chunked storage
 * lane (the one Work Bench pins use, with byte progress), then the stored-file
 * ingest route, which answers with the same job lane the multipart route
 * does. `requires_confirmation` (the same bytes are already in the brain) and
 * `in_flight` (already running) are the end state the user asked for.
 */
async function runLarge(item: IntakeItem, ctx: RunContext): Promise<void> {
  ctx.store.update(item.id, { status: "uploading", progress: 0 });
  let stored: IngestFileResult | undefined;
  try {
    [stored] = await ctx.deps.storeFiles(item.workspaceId, [item.file], {
      onProgress: (_file, uploadedBytes, totalBytes) => {
        const current = ctx.store.get(item.id);
        if (!current || current.status !== "uploading" || totalBytes <= 0) return;
        ctx.store.update(item.id, {
          progress: Math.max(current.progress ?? 0, Math.min(1, uploadedBytes / totalBytes)),
        });
      },
    });
  } catch (err) {
    ctx.store.update(item.id, { status: "error", error: transportMessage(err, ctx.t) });
    return;
  }
  if (!stored?.ok || !stored.fileId) {
    ctx.store.update(item.id, {
      status: "error",
      error: stored?.error ?? ctx.t.docPage.suggested.ingestFailed,
    });
    return;
  }
  ctx.store.update(item.id, { status: "analyzing", progress: 1, result: stored });
  let outcome: ReingestOutcome;
  try {
    outcome = await ctx.deps.reingestStoredFile(item.workspaceId, stored.fileId);
  } catch (err) {
    ctx.store.update(item.id, { status: "error", error: transportMessage(err, ctx.t) });
    return;
  }
  if (outcome.status === "queued" && outcome.jobId) {
    ctx.store.update(item.id, { result: { ...stored, status: "queued", jobId: outcome.jobId } });
    void watchJob(item.id, outcome.jobId, ctx);
    return;
  }
  if (outcome.status === "stored_only") {
    // Past the parse ceiling: in workspace files, not in the brain. Say so.
    ctx.store.update(item.id, { status: "done", result: { ...stored, status: "stored" }, storedOnly: true });
    return;
  }
  ctx.store.update(item.id, { status: "done", result: { ...stored, status: "queued" } });
}

async function runOrdinary(all: IntakeItem[], ctx: RunContext): Promise<void> {
  const large = all.filter((item) => item.file.size > MAX_INGEST_FILE_BYTES);
  const items = all.filter((item) => item.file.size <= MAX_INGEST_FILE_BYTES);
  // Large files go one at a time so their byte progress means something.
  const largeRun = (async () => {
    for (const item of large) {
      if (!ctx.store.get(item.id)) continue;
      await runLarge(item, ctx);
    }
  })();
  await Promise.all([largeRun, runSmall(items, ctx)]);
}

async function runSmall(items: IntakeItem[], ctx: RunContext): Promise<void> {
  if (items.length === 0) return;
  const { workspaceId } = items[0];
  for (const item of items) ctx.store.update(item.id, { status: "uploading", progress: null });
  let results: IngestFileResult[];
  try {
    results = await ctx.deps.ingestFiles(
      workspaceId,
      items.map((item) => item.file),
    );
  } catch (err) {
    const error = transportMessage(err, ctx.t);
    for (const item of items) ctx.store.update(item.id, { status: "error", error });
    return;
  }
  // `results` is positional over `items`.
  items.forEach((item, idx) => {
    const result = results[idx];
    const status = statusForIngestResult(result);
    if (status === "error") {
      ctx.store.update(item.id, {
        status,
        error: result?.error ?? ctx.t.docPage.suggested.ingestFailed,
      });
      return;
    }
    ctx.store.update(item.id, { status, result });
    if (status === "analyzing" && result?.jobId) void watchJob(item.id, result.jobId, ctx);
  });
}

async function runLinkedIn(item: IntakeItem, ctx: RunContext): Promise<void> {
  ctx.store.update(item.id, { status: "uploading", progress: null });
  try {
    const result = await ctx.deps.ingestLinkedInArchive(item.workspaceId, item.file);
    const status = statusForIngestResult(result);
    if (status === "error") {
      ctx.store.update(item.id, {
        status,
        error: result.error ?? ctx.t.docPage.suggested.ingestFailed,
      });
      return;
    }
    ctx.store.update(item.id, { status: "done", result });
  } catch (err) {
    ctx.store.update(item.id, { status: "error", error: transportMessage(err, ctx.t) });
  }
}

async function stageMedia(item: IntakeItem, ctx: RunContext): Promise<void> {
  if (!item.assistantId) {
    ctx.store.update(item.id, {
      status: "error",
      error: ctx.t.docPage.suggested.ingestMediaNeedsAssistant,
    });
    return;
  }
  ctx.store.update(item.id, { status: "uploading", progress: 0 });
  let recordingId: string;
  try {
    ({ recordingId } = await ctx.deps.startRecordingUpload({
      workspaceId: item.workspaceId,
      assistantId: item.assistantId,
      file: item.file,
      onProgress: (progress) => {
        const current = ctx.store.get(item.id);
        if (!current || current.status !== "uploading") return;
        ctx.store.update(item.id, { progress: Math.max(current.progress ?? 0, progress) });
      },
    }));
  } catch (err) {
    ctx.store.update(item.id, {
      status: "error",
      error: recordingFailureMessage(err, "upload", ctx.t),
    });
    return;
  }
  ctx.store.update(item.id, { status: "checking", progress: 1, recordingId });
  try {
    const estimate = await ctx.deps.estimateRecording(recordingId);
    ctx.store.update(item.id, {
      status: "awaiting_review",
      durationSeconds: estimate.durationSeconds,
    });
  } catch (err) {
    ctx.store.update(item.id, {
      status: "error",
      error: recordingFailureMessage(err, "estimate", ctx.t),
    });
  }
}

/**
 * Run one batch. Ordinary files and the LinkedIn archive go first (one request
 * each, no byte progress to serialise on); media then uploads one at a time.
 */
export async function runIntakeBatch(items: IntakeItem[], ctx: RunContext): Promise<void> {
  const ordinary = items.filter((item) => item.kind === "file");
  const linkedin = items.filter((item) => item.kind === "linkedin");
  const media = items.filter((item) => item.kind === "media");
  await Promise.all([
    runOrdinary(ordinary, ctx),
    ...linkedin.map((item) => runLinkedIn(item, ctx)),
  ]);
  for (const item of media) {
    // A row dismissed while queued is skipped; one in flight cannot be.
    if (!ctx.store.get(item.id)) continue;
    await stageMedia(item, ctx);
  }
}

/**
 * The tray's Review button: estimate again (cheap; the duration is already
 * persisted server-side), open the cost + blueprint + destination confirm,
 * and enqueue on consent. A cancel returns the row to Ready to review with
 * the same staged recording, so the next Review never re-uploads.
 */
export async function reviewRecording(item: IntakeItem, ctx: RunContext): Promise<void> {
  if (!item.recordingId) return;
  ctx.store.update(item.id, { status: "reviewing" });
  let stage: "estimate" | "process" = "estimate";
  try {
    const outcome = await ctx.deps.confirmAndProcessRecording({
      workspaceId: item.workspaceId,
      recordingId: item.recordingId,
      t: ctx.t,
      isVideo: recordingMimeForFile(item.file)?.startsWith("video/") ?? false,
      onStage: (s) => {
        stage = s;
      },
    });
    if (outcome.outcome === "cancelled") {
      ctx.store.update(item.id, { status: "awaiting_review" });
      return;
    }
    ctx.store.update(item.id, { status: "done" });
  } catch (err) {
    ctx.store.update(item.id, {
      status: "error",
      error: recordingFailureMessage(err, stage, ctx.t),
    });
  }
}
