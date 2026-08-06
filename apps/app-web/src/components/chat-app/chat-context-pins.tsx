"use client";

/**
 * Work Bench — the shared room's resizable right-hand context drawer
 * (multiplayer chat P1b, T16/D10).
 *
 * The transcript no longer spends two full-width rows on room metadata and
 * pinned-context chips. `ChatContextPins` is a persistent flat right section:
 * expanded it shows an icon-led live assistant roster and pin surface;
 * collapsed it becomes one icon-only column. It reuses the shared operator
 * resize behavior and remembers its expanded width. There is deliberately no
 * shadow/elevation, no prose-heavy metadata card, and no duplicate trigger in
 * the Chat top bar.
 *
 * Data flows through `lib/api/session-pins.ts`; the parent bumps
 * `refreshKey` off the room stream's `pins_changed` signal so every viewer's
 * row updates live (signals, never data). Labels resolve server-side under
 * the SESSION's clearance; a `null` label renders the unavailable state
 * rather than hiding the pin. Files dropped on Pins (or chosen from Add) go
 * through the durable storage-only route before their returned file ids are
 * pinned; transient chat-upload ids are never used, and pinning never implies
 * consent to distill or extract.
 *
 * Spec: docs/architecture/features/chat-app.md → "Pinned room context".
 * [COMP:app-web/chat-context-pins]
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertCircle,
  BadgeDollarSign,
  BrainCircuit,
  Building2,
  ChevronDown,
  FileUp,
  FileText,
  Link as LinkIcon,
  LoaderCircle,
  PanelRightClose,
  PanelRightOpen,
  Paperclip,
  Pin,
  Plus,
  SquareCheck,
  StickyNote,
  User,
  Users,
  X,
} from "lucide-react";
import { AssistantAvatar } from "@/components/assistant-avatar";
import { cn } from "@/lib/utils";
import { useT, format } from "@/lib/i18n/client";
import {
  PeekResizeHandle,
  usePeekResize,
} from "@/components/operator/resizable-peek";
import {
  addSessionPin,
  listSessionPins,
  removeSessionPin,
  type SessionPinKind,
  type SessionPinRow,
} from "@/lib/api/session-pins";
import { listViews } from "@/lib/api/views";
import { fetchWorkspaceTasks } from "@/lib/api/tasks";
import { fetchWorkspaceCrm } from "@/lib/api/crm";
import {
  LARGE_FILE_CONFIRM_BYTES,
  MAX_STORED_FILE_BYTES,
  storeFiles,
} from "@/lib/api/ingest";
import { useFileDrop } from "@/lib/use-file-drop";
import { partitionUpload } from "@/lib/use-file-attachments";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import {
  EMPTY_WORKER_RUN_SUMMARY,
  fetchWorkerRunSummary,
  type WorkerRunSummary,
} from "@/lib/api/pending-questions";

const KIND_ICON: Record<SessionPinKind, typeof Pin> = {
  page: FileText,
  task: SquareCheck,
  contact: User,
  company: Building2,
  deal: BadgeDollarSign,
  file: Paperclip,
  url: LinkIcon,
  instruction: StickyNote,
};

type PickerKind =
  | "file"
  | "page"
  | "task"
  | "contact"
  | "company"
  | "deal"
  | "url"
  | "instruction";
const PICKER_KINDS: PickerKind[] = [
  "file",
  "page",
  "task",
  "contact",
  "company",
  "deal",
  "url",
  "instruction",
];

type Candidate = { id: string; label: string };

type FileUpload = {
  id: string;
  fileName: string;
  status: "uploading" | "error";
  error?: string;
  progress?: number;
};

const WORK_BENCH_ID = "chat-work-bench";
const WORK_BENCH_CONTENT_ID = "chat-work-bench-content";
const WORKER_POLL_MS = 2_000;

type WorkBenchAssistant = {
  id: string;
  name: string;
  iconSeed?: number | null;
};

type WorkBenchTool = {
  id: string;
  status: string;
  description?: string;
  workerId?: string;
};

export function ChatContextPins({
  sessionId,
  workspaceId,
  refreshKey,
  startedByName,
  assistant = null,
  turnActive = false,
  waitingForInput = false,
  currentStep = null,
  tools = [],
  expanded,
  onExpandedChange,
}: {
  sessionId: string;
  workspaceId: string;
  refreshKey: number;
  startedByName: string | null;
  assistant?: WorkBenchAssistant | null;
  turnActive?: boolean;
  waitingForInput?: boolean;
  currentStep?: string | null;
  tools?: WorkBenchTool[];
  expanded: boolean;
  onExpandedChange: (expanded: boolean) => void;
}) {
  const dictionary = useT();
  const chatT = dictionary.chatApp;
  const t = chatT.pins;
  const [pins, setPins] = useState<SessionPinRow[]>([]);
  const [addOpen, setAddOpen] = useState(false);
  const [pickKind, setPickKind] = useState<PickerKind>("file");
  const [search, setSearch] = useState("");
  const [urlValue, setUrlValue] = useState("");
  const [instructionValue, setInstructionValue] = useState("");
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [fileBusy, setFileBusy] = useState(false);
  const [fileUploads, setFileUploads] = useState<FileUpload[]>([]);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [workerSummary, setWorkerSummary] = useState<WorkerRunSummary>(
    EMPTY_WORKER_RUN_SUMMARY,
  );
  const { width, resizing, handleProps } = usePeekResize(
    "chat:work-bench-width",
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && expanded) onExpandedChange(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [expanded, onExpandedChange]);

  const refresh = useCallback(async () => {
    try {
      setPins(await listSessionPins(sessionId));
    } catch {
      // Keep the last known row — a transient failure must not empty it.
    }
  }, [sessionId]);

  useEffect(() => {
    void refresh();
  }, [refresh, refreshKey]);

  // The worker store is the durable truth for delegated assistants (including
  // when a teammate owns the POST stream). Poll only while a lead turn or a
  // persisted worker is active; an idle room performs one read on open and
  // then stays quiet.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      try {
        const summary = await fetchWorkerRunSummary(sessionId);
        if (cancelled) return;
        setWorkerSummary(summary);
        if (turnActive || summary.running > 0) {
          timer = setTimeout(() => void poll(), WORKER_POLL_MS);
        }
      } catch {
        // Preserve the last good roster. If the lead turn is still live, retry
        // because a worker may be spawned after this transient failure.
        if (!cancelled && turnActive) {
          timer = setTimeout(() => void poll(), WORKER_POLL_MS);
        }
      }
    };

    setWorkerSummary(EMPTY_WORKER_RUN_SUMMARY);
    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [sessionId, turnActive]);

  // Candidate lists load lazily per picked kind (client-side filter — the
  // flat-read SDKs the operator surfaces already use).
  useEffect(() => {
    if (
      !addOpen ||
      pickKind === "file" ||
      pickKind === "url" ||
      pickKind === "instruction"
    ) {
      return;
    }
    let cancelled = false;
    setCandidates(null);
    void (async () => {
      try {
        let rows: Candidate[] = [];
        if (pickKind === "page") {
          const views = await listViews({ workspaceId });
          rows = views.map((v) => ({ id: v.id, label: v.name }));
        } else if (pickKind === "task") {
          const tasks = await fetchWorkspaceTasks(workspaceId);
          rows = tasks.map((task) => ({ id: task.id, label: task.title }));
        } else {
          const crm = await fetchWorkspaceCrm(workspaceId);
          const source =
            pickKind === "contact"
              ? crm.contacts
              : pickKind === "company"
                ? crm.companies
                : crm.deals;
          rows = source.map((r) => ({ id: r.id, label: r.name }));
        }
        if (!cancelled) setCandidates(rows);
      } catch {
        if (!cancelled) setCandidates([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [addOpen, pickKind, workspaceId]);

  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    const list = candidates ?? [];
    return (
      needle
        ? list.filter((c) => c.label.toLowerCase().includes(needle))
        : list
    ).slice(0, 8);
  }, [candidates, search]);

  const addPin = useCallback(
    async (
      pin:
        | { kind: Exclude<SessionPinKind, "url" | "instruction">; refId: string }
        | { kind: "url"; url: string }
        | { kind: "instruction"; text: string },
    ) => {
      if (busy) return;
      setBusy(true);
      setError(null);
      try {
        await addSessionPin(sessionId, pin);
        setAddOpen(false);
        setSearch("");
        setUrlValue("");
        setInstructionValue("");
        await refresh();
      } catch {
        setError(t.addFailed);
      } finally {
        setBusy(false);
      }
    },
    [busy, refresh, sessionId, t],
  );

  const pinFiles = useCallback(
    async (fileList: FileList | File[]) => {
      if (fileBusy) return;
      const files = Array.from(fileList);
      if (files.length === 0) return;
      if (files.length > 5) {
        setError(t.fileLimit);
        return;
      }

      let uploads: FileUpload[] = [];
      const updateUpload = (
        id: string,
        update:
          | { status: "error"; error: string }
          | { progress: number }
          | null,
      ) => {
        setFileUploads((current) =>
          current.flatMap((item) => {
            if (item.id !== id) return [item];
            return update ? [{ ...item, ...update }] : [];
          }),
        );
      };

      setFileBusy(true);
      setError(null);

      try {
        const { attach, rejected } = await partitionUpload(files, {
          maxBytes: MAX_STORED_FILE_BYTES,
          canRouteMedia: false,
        });
        const confirmed: File[] = [];
        for (const file of attach) {
          if (file.size > LARGE_FILE_CONFIRM_BYTES) {
            const size = `${(file.size / (1024 * 1024)).toFixed(1)} MB`;
            const ok = await confirmDialog({
              title: t.largeFileTitle,
              description: format(t.largeFileDescription, {
                fileName: file.name,
                size,
              }),
              confirmLabel: t.largeFileConfirm,
              cancelLabel: t.largeFileCancel,
            });
            if (!ok) continue;
          }
          confirmed.push(file);
        }
        const uploadStartedAt = Date.now();
        uploads = confirmed.map((file, index) => ({
          id: `${file.name}-${file.lastModified}-${index}-${uploadStartedAt}`,
          fileName: file.name,
          status: "uploading" as const,
          progress: 0,
        }));
        const rejectedUploads: FileUpload[] = rejected.map(
          ({ file, reason }, index) => ({
            id: `${file.name}-${file.lastModified}-rejected-${index}-${uploadStartedAt}`,
            fileName: file.name,
            status: "error",
            error:
              reason === "too_large"
                ? t.fileTooLarge
                : dictionary.attachments.videoUnsupported,
          }),
        );
        setFileUploads((current) => [
          ...current.filter((item) => item.status === "error"),
          ...rejectedUploads,
          ...uploads,
        ]);
        if (confirmed.length === 0) return;

        let anyPinned = false;
        let anyFailed = rejected.length > 0;
        const uploadIdByFile = new Map(
          confirmed.map((file, index) => [file, uploads[index].id]),
        );
        const results = await storeFiles(workspaceId, confirmed, {
          onProgress: (file, uploadedBytes, totalBytes) => {
            const uploadId = uploadIdByFile.get(file);
            if (!uploadId) return;
            updateUpload(uploadId, {
              progress: Math.min(100, Math.round((uploadedBytes / totalBytes) * 100)),
            });
          },
        });
        for (let index = 0; index < uploads.length; index += 1) {
          const upload = uploads[index];
          const result = results[index];
          if (!result?.ok || !result.fileId) {
            anyFailed = true;
            updateUpload(upload.id, {
              status: "error",
              error: result?.error ?? t.filePinFailed,
            });
            continue;
          }
          try {
            await addSessionPin(sessionId, {
              kind: "file",
              refId: result.fileId,
            });
            anyPinned = true;
            updateUpload(upload.id, null);
          } catch {
            anyFailed = true;
            updateUpload(upload.id, {
              status: "error",
              error: t.filePinFailed,
            });
          }
        }
        if (anyPinned) await refresh();
        if (!anyFailed) setAddOpen(false);
      } catch {
        for (const upload of uploads) {
          updateUpload(upload.id, {
            status: "error",
            error: t.filePinFailed,
          });
        }
      } finally {
        setFileBusy(false);
      }
    },
    [dictionary.attachments, fileBusy, refresh, sessionId, t, workspaceId],
  );

  const { isDragging, dropProps } = useFileDrop(
    (files) => void pinFiles(files),
    { disabled: fileBusy },
  );

  const unpin = useCallback(
    async (pinId: string) => {
      try {
        await removeSessionPin(sessionId, pinId);
        await refresh();
      } catch {
        setError(t.removeFailed);
      }
    },
    [refresh, sessionId, t],
  );

  const kindLabel = (kind: SessionPinKind): string =>
    kind === "file"
      ? t.kindFile
      : kind === "page"
      ? t.kindPage
      : kind === "task"
        ? t.kindTask
        : kind === "contact"
          ? t.kindContact
          : kind === "company"
            ? t.kindCompany
            : kind === "deal"
              ? t.kindDeal
              : kind === "url"
                ? t.kindUrl
                : kind === "instruction"
                  ? t.kindInstruction
                  : kind;

  const chipLabel = (pin: SessionPinRow): string =>
    pin.label ?? (pin.kind === "url" ? (pin.url ?? "") : t.unavailable);

  const leadTools = tools.filter((tool) => !tool.workerId);
  const leadDone = leadTools.filter((tool) => tool.status === "done").length;
  const leadRunning = leadTools.filter((tool) => tool.status === "running").length;
  const activeLead = turnActive && assistant ? assistant : null;
  const activeCount = (activeLead ? 1 : 0) + workerSummary.running;

  if (!expanded) {
    const expandLabel = `${chatT.workBenchExpand}. ${chatT.captureIndicator}`;
    return (
      <aside
        id={WORK_BENCH_ID}
        aria-label={chatT.workBench}
        className="relative flex h-full w-11 shrink-0 flex-col items-center overflow-hidden border-l border-border bg-background transition-[width] duration-200 ease-out"
      >
        <button
          type="button"
          onClick={() => onExpandedChange(true)}
          aria-expanded={false}
          aria-controls={WORK_BENCH_CONTENT_ID}
          aria-label={expandLabel}
          title={expandLabel}
          className="relative mt-2 grid size-9 place-items-center rounded-lg text-primary transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          <PanelRightOpen className="size-4" aria-hidden />
          {activeCount > 0 && (
            <span
              className="absolute right-1.5 top-1.5 size-1.5 rounded-full bg-emerald-500 ring-2 ring-background"
              aria-hidden
            />
          )}
        </button>
      </aside>
    );
  }

  return (
    <aside
      id={WORK_BENCH_ID}
      aria-label={chatT.workBench}
      style={width !== null ? { width } : undefined}
      className={cn(
        "relative flex h-full max-w-full shrink-0 flex-col overflow-hidden border-l border-border bg-background",
        width === null && "w-full sm:w-[360px] lg:w-[400px]",
        !resizing && "transition-[width] duration-200 ease-out",
        resizing && "select-none",
      )}
    >
      <PeekResizeHandle resizing={resizing} {...handleProps} />

      <header className="flex shrink-0 items-center gap-3 border-b border-border/70 px-4 py-3">
        <h2 className="min-w-0 flex-1 text-sm font-semibold text-foreground">
          {chatT.workBench}
        </h2>
        <div className="flex items-center gap-1" aria-label={chatT.roomStatus}>
          <span
            role="img"
            aria-label={chatT.sharedBadge}
            title={chatT.sharedBadge}
            className="grid size-7 place-items-center rounded-md bg-muted/70 text-muted-foreground"
          >
            <Users className="size-3.5" aria-hidden />
          </span>
          {startedByName && (
            <span
              title={format(chatT.startedBy, { name: startedByName })}
              className="inline-flex h-7 max-w-28 items-center gap-1.5 rounded-md bg-muted/70 px-2 text-[11px] text-muted-foreground"
            >
              <User className="size-3 shrink-0" aria-hidden />
              <span className="truncate">{startedByName}</span>
            </span>
          )}
          <span
            role="img"
            aria-label={chatT.captureIndicator}
            title={chatT.captureIndicator}
            className="grid size-7 place-items-center rounded-md bg-primary/10 text-primary"
          >
            <BrainCircuit className="size-3.5" aria-hidden />
          </span>
        </div>
        <button
          type="button"
          onClick={() => onExpandedChange(false)}
          aria-expanded="true"
          aria-controls={WORK_BENCH_CONTENT_ID}
          aria-label={chatT.workBenchCollapse}
          title={chatT.workBenchCollapse}
          className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          <PanelRightClose className="size-4" aria-hidden />
        </button>
      </header>

      <div
        id={WORK_BENCH_CONTENT_ID}
        className="min-h-0 flex-1 overflow-y-auto px-4 py-4"
      >
        <section aria-labelledby="chat-work-bench-live-work" aria-live="polite">
          <div className="flex items-center gap-2">
            <span
              className={cn(
                "grid size-7 place-items-center rounded-lg",
                activeCount > 0
                  ? "bg-emerald-500/10 text-emerald-600 dark:text-emerald-300"
                  : "bg-muted text-muted-foreground",
              )}
            >
              <Activity className="size-3.5" aria-hidden />
            </span>
            <h3
              id="chat-work-bench-live-work"
              className="min-w-0 flex-1 text-xs font-semibold text-foreground"
            >
              {chatT.liveWork}
            </h3>
            {activeCount > 0 && (
              <span className="rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-300">
                {format(chatT.liveWorkActive, { count: activeCount })}
              </span>
            )}
          </div>

          {activeCount === 0 ? (
            <div className="mt-3 flex flex-col items-center justify-center rounded-xl border border-dashed border-border/80 py-5 text-center">
              <div className="relative grid size-11 place-items-center rounded-full bg-muted/70 text-muted-foreground">
                <Activity className="size-5" aria-hidden />
                <span
                  className="absolute bottom-1.5 right-1.5 size-2 rounded-full border-2 border-background bg-muted-foreground/40"
                  aria-hidden
                />
              </div>
              <p className="mt-2 text-xs font-medium text-muted-foreground">
                {chatT.liveWorkIdleTitle}
              </p>
            </div>
          ) : (
            <div className="mt-3 space-y-2" role="list">
              {activeLead && (
                <article
                  role="listitem"
                  className="rounded-xl border border-primary/20 bg-primary/[0.035] p-3"
                >
                  <div className="flex items-start gap-2.5">
                    <AssistantAvatar
                      id={activeLead.id}
                      name={activeLead.name}
                      iconSeed={activeLead.iconSeed ?? undefined}
                      size="sm"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <div className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
                          {activeLead.name}
                        </div>
                        <span className="inline-flex shrink-0 items-center gap-1 text-[10px] font-medium text-primary">
                          <LoaderCircle
                            className={cn(
                              "size-3",
                              !waitingForInput && "animate-spin",
                            )}
                            aria-hidden
                          />
                          {waitingForInput
                            ? chatT.liveWorkWaiting
                            : chatT.liveWorkWorking}
                        </span>
                      </div>
                      {currentStep && (
                        <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-muted-foreground">
                          {currentStep}
                        </p>
                      )}
                      {leadTools.length > 0 && (
                        <p className="mt-1.5 text-[10px] text-muted-foreground/80">
                          {format(chatT.liveWorkSteps, {
                            done: leadDone,
                            running: leadRunning,
                          })}
                        </p>
                      )}
                      <div
                        className="mt-2 h-1 overflow-hidden rounded-full bg-primary/10"
                        aria-hidden
                      >
                        <div
                          className={cn(
                            "h-full w-full rounded-full bg-gradient-to-r from-transparent via-primary/60 to-transparent",
                            !waitingForInput && "animate-pulse",
                          )}
                        />
                      </div>
                    </div>
                  </div>
                </article>
              )}

              {workerSummary.active.map((worker, index) => {
                const workerTools = tools.filter(
                  (tool) => tool.workerId === worker.workerId,
                );
                const runningTool = workerTools.find(
                  (tool) => tool.status === "running",
                );
                const done = workerTools.filter(
                  (tool) => tool.status === "done",
                ).length;
                const running = workerTools.filter(
                  (tool) => tool.status === "running",
                ).length;
                const ordinal = worker.workerId.match(/^worker_(\d+)$/)?.[1];
                const name = format(chatT.liveWorkAssistant, {
                  number: ordinal ?? index + 1,
                });
                return (
                  <article
                    key={worker.workerId}
                    role="listitem"
                    className="rounded-xl border border-border/70 bg-muted/20 p-3"
                  >
                    <div className="flex items-start gap-2.5">
                      <AssistantAvatar
                        id={worker.workerId}
                        name={name}
                        size="sm"
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <div className="min-w-0 flex-1 truncate text-xs font-medium text-foreground">
                            {name}
                          </div>
                          <span className="inline-flex shrink-0 items-center gap-1 text-[10px] font-medium text-emerald-700 dark:text-emerald-300">
                            <span className="size-1.5 animate-pulse rounded-full bg-emerald-500" aria-hidden />
                            {chatT.liveWorkWorking}
                          </span>
                        </div>
                        <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-muted-foreground">
                          {runningTool?.description ?? worker.description}
                        </p>
                        {workerTools.length > 0 && (
                          <p className="mt-1.5 text-[10px] text-muted-foreground/80">
                            {format(chatT.liveWorkSteps, { done, running })}
                          </p>
                        )}
                        <div
                          className="mt-2 h-1 overflow-hidden rounded-full bg-emerald-500/10"
                          aria-hidden
                        >
                          <div className="h-full w-full animate-pulse rounded-full bg-gradient-to-r from-transparent via-emerald-500/60 to-transparent" />
                        </div>
                      </div>
                    </div>
                  </article>
                );
              })}
            </div>
          )}
        </section>

        <section
          aria-label={t.rowAria}
          className="relative mt-5"
          {...dropProps}
        >
          <input
            ref={fileInputRef}
            type="file"
            multiple
            tabIndex={-1}
            aria-hidden="true"
            className="sr-only"
            onChange={(event) => {
              const selected = event.currentTarget.files;
              if (selected) void pinFiles(selected);
              event.currentTarget.value = "";
            }}
          />
          {isDragging && (
            <div className="absolute inset-0 z-20 grid min-h-40 place-items-center rounded-xl border-2 border-dashed border-primary bg-background/95 text-primary">
              <div className="text-center">
                <FileUp className="mx-auto size-7" aria-hidden />
                <div className="mt-2 text-xs font-semibold">{t.dropToPin}</div>
              </div>
            </div>
          )}
          <div className="flex items-center gap-2">
            <span className="grid size-7 place-items-center rounded-lg bg-primary/10 text-primary">
              <Pin className="size-3.5" aria-hidden />
            </span>
            <h3 className="min-w-0 flex-1 text-xs font-semibold text-foreground">
              {chatT.pinnedContext}
            </h3>
            <button
              type="button"
              onClick={() => {
                setAddOpen((open) => !open);
                setError(null);
              }}
              aria-expanded={addOpen}
              aria-controls="chat-work-bench-add-menu"
              className={cn(
                "inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition-colors",
                addOpen
                  ? "bg-accent text-foreground"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              <Plus className="size-3.5" aria-hidden />
              {t.add}
              <ChevronDown
                className={cn(
                  "size-3 transition-transform",
                  addOpen && "rotate-180",
                )}
                aria-hidden
              />
            </button>
          </div>

          {addOpen && (
            <div
              id="chat-work-bench-add-menu"
              className="mt-3 space-y-3 rounded-xl border border-border/70 bg-muted/15 p-3"
            >
              <div
                className="grid grid-cols-4 gap-1"
                aria-label={t.pickerTitle}
              >
                {PICKER_KINDS.map((kind) => {
                  const Icon = KIND_ICON[kind];
                  const label = kindLabel(kind);
                  return (
                    <button
                      key={kind}
                      type="button"
                      onClick={() => setPickKind(kind)}
                      aria-label={label}
                      aria-pressed={pickKind === kind}
                      title={label}
                      className={cn(
                        "grid h-9 place-items-center rounded-lg border transition-colors",
                        pickKind === kind
                          ? "border-primary/30 bg-primary/10 text-primary"
                          : "border-transparent bg-background/70 text-muted-foreground hover:border-border hover:text-foreground",
                      )}
                    >
                      <Icon className="size-4" aria-hidden />
                    </button>
                  );
                })}
              </div>
              {pickKind === "file" ? (
                <button
                  type="button"
                  disabled={fileBusy}
                  onClick={() => fileInputRef.current?.click()}
                  className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-border bg-background px-3 py-4 text-xs font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:text-primary disabled:opacity-50"
                >
                  {fileBusy ? (
                    <LoaderCircle className="size-4 animate-spin" aria-hidden />
                  ) : (
                    <FileUp className="size-4" aria-hidden />
                  )}
                  <span>{t.dropFiles}</span>
                  <span className="text-primary">{t.browseFiles}</span>
                </button>
              ) : pickKind === "url" ? (
                <div className="space-y-1.5">
                  <input
                    type="url"
                    value={urlValue}
                    onChange={(e) => setUrlValue(e.target.value)}
                    placeholder={t.urlPlaceholder}
                    className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs outline-none focus:ring-2 focus:ring-ring/40"
                  />
                  <button
                    type="button"
                    disabled={busy || !urlValue.trim()}
                    onClick={() => void addPin({ kind: "url", url: urlValue.trim() })}
                    className="rounded-md bg-action px-2.5 py-1 text-[11px] font-medium text-action-foreground disabled:opacity-50"
                  >
                    {t.pinAction}
                  </button>
                </div>
              ) : pickKind === "instruction" ? (
                <div className="space-y-1.5">
                  <textarea
                    value={instructionValue}
                    onChange={(e) => setInstructionValue(e.target.value)}
                    placeholder={t.instructionPlaceholder}
                    rows={3}
                    maxLength={2000}
                    className="w-full resize-none rounded-md border border-border bg-background px-2 py-1.5 text-xs outline-none focus:ring-2 focus:ring-ring/40"
                  />
                  <button
                    type="button"
                    disabled={busy || !instructionValue.trim()}
                    onClick={() =>
                      void addPin({ kind: "instruction", text: instructionValue.trim() })
                    }
                    className="rounded-md bg-action px-2.5 py-1 text-[11px] font-medium text-action-foreground disabled:opacity-50"
                  >
                    {t.pinAction}
                  </button>
                </div>
              ) : (
                <div className="space-y-1">
                  <input
                    type="search"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder={t.searchPlaceholder}
                    className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-xs outline-none focus:ring-2 focus:ring-ring/40"
                  />
                  <div className="max-h-44 overflow-y-auto">
                    {filtered.length === 0 && candidates !== null && (
                      <p className="px-1 py-1.5 text-[11px] text-muted-foreground">
                        {t.noResults}
                      </p>
                    )}
                    {filtered.map((candidate) => (
                      <button
                        key={candidate.id}
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          void addPin({ kind: pickKind, refId: candidate.id })
                        }
                        className="block w-full truncate rounded-md px-2 py-1.5 text-left text-xs text-foreground transition-colors hover:bg-accent disabled:opacity-50"
                      >
                        {candidate.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {error && <p className="text-[11px] text-destructive">{error}</p>}
            </div>
          )}

          <div className="mt-3 space-y-2">
            {fileUploads.map((upload) => (
              <div
                key={upload.id}
                className={cn(
                  "flex items-center gap-2 rounded-lg border px-3 py-2",
                  upload.status === "error"
                    ? "border-destructive/25 bg-destructive/5"
                    : "border-border/70 bg-muted/20",
                )}
              >
                {upload.status === "uploading" ? (
                  <LoaderCircle
                    className="size-4 shrink-0 animate-spin text-primary"
                    aria-hidden
                  />
                ) : (
                  <AlertCircle
                    className="size-4 shrink-0 text-destructive"
                    aria-hidden
                  />
                )}
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs text-foreground">
                    {upload.fileName}
                  </div>
                  {upload.error && (
                    <div className="truncate text-[10px] text-destructive">
                      {upload.error}
                    </div>
                  )}
                  {upload.status === "uploading" && upload.progress !== undefined && (
                    <div className="mt-1.5 flex items-center gap-2">
                      <div
                        role="progressbar"
                        aria-label={upload.fileName}
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={upload.progress}
                        aria-valuetext={format(t.uploadingProgress, {
                          percent: upload.progress,
                        })}
                        className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-primary/10"
                      >
                        <div
                          className="h-full rounded-full bg-primary transition-[width] duration-200 ease-out motion-reduce:transition-none"
                          style={{ width: `${upload.progress}%` }}
                        />
                      </div>
                      <span className="w-8 shrink-0 text-right text-[10px] tabular-nums text-muted-foreground">
                        {upload.progress}%
                      </span>
                    </div>
                  )}
                </div>
                {upload.status === "error" && (
                  <button
                    type="button"
                    onClick={() =>
                      setFileUploads((current) =>
                        current.filter((item) => item.id !== upload.id),
                      )
                    }
                    aria-label={t.dismissFileError}
                    title={t.dismissFileError}
                    className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    <X className="size-3.5" aria-hidden />
                  </button>
                )}
              </div>
            ))}
            {pins.length === 0 && (
              <button
                type="button"
                disabled={fileBusy}
                onClick={() => fileInputRef.current?.click()}
                className="flex w-full flex-col items-center justify-center rounded-xl border border-dashed border-border px-3 py-6 text-center text-muted-foreground transition-colors hover:border-primary/40 hover:text-primary disabled:opacity-50"
              >
                <span className="grid size-11 place-items-center rounded-full bg-muted/70">
                  {fileBusy ? (
                    <LoaderCircle className="size-5 animate-spin" aria-hidden />
                  ) : (
                    <FileUp className="size-5" aria-hidden />
                  )}
                </span>
                <span className="mt-2 text-xs font-medium">{t.dropFiles}</span>
                <span className="mt-0.5 text-[10px] text-primary">
                  {t.browseFiles}
                </span>
              </button>
            )}
            {pins.map((pin) => {
              const Icon = KIND_ICON[pin.kind] ?? Pin;
              return (
                <article
                  key={pin.id}
                  className={cn(
                    "group rounded-lg border border-border/70 bg-background p-3",
                    pin.label === null && pin.kind !== "url" && "opacity-65",
                  )}
                >
                  <div className="flex items-start gap-2.5">
                    <div className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
                      <Icon className="size-3.5" aria-hidden />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                        {kindLabel(pin.kind)}
                      </div>
                      <div
                        className={cn(
                          "mt-0.5 break-words text-xs leading-relaxed text-foreground",
                          pin.label === null && pin.kind !== "url" && "italic",
                        )}
                      >
                        {pin.kind === "instruction" ? pin.text : chipLabel(pin)}
                      </div>
                      {pin.kind === "url" && pin.url && (
                        <a
                          href={pin.url}
                          target="_blank"
                          rel="noreferrer"
                          className="mt-1 block truncate text-[11px] text-primary underline-offset-2 hover:underline"
                        >
                          {pin.url}
                        </a>
                      )}
                      {pin.addedByName && (
                        <div className="mt-1 text-[10px] text-muted-foreground">
                          {format(t.addedBy, { name: pin.addedByName })}
                        </div>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => void unpin(pin.id)}
                      aria-label={`${t.remove}: ${chipLabel(pin)}`}
                      title={t.remove}
                      className="rounded-md p-1 text-muted-foreground opacity-0 transition-all hover:bg-destructive/10 hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100"
                    >
                      <X className="size-3.5" aria-hidden />
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
          {!addOpen && error && (
            <p className="mt-3 text-[11px] text-destructive">{error}</p>
          )}
        </section>
      </div>
    </aside>
  );
}
