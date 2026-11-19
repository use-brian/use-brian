"use client";

/**
 * The Office file's Brian rail: one shared conversation per file.
 *
 * While the file is being generated, the rail shows the generation job as
 * Brian's message (persisted status plus its latest event, the input question
 * or template picker) and a send is steering. Once generation is done, a send
 * is a chat turn in the file's shared `office_thread` conversation: nothing
 * needs to be selected (the selection is a dismissible focus hint), every
 * reader follows the thread live, and an edit Brian starts shows as an Office
 * edit card that tracks its revision job. View-only readers read the thread
 * but cannot send.
 *
 * Spec: docs/architecture/features/office.md -> "Brian conversation in the file".
 * [COMP:app-web/office-iteration-panel]
 */

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowUp, CheckCircle2, ChevronRight, CircleAlert, CircleDashed, Crosshair, Sparkles, X } from "lucide-react";
import { ChatComposer, type PendingConfirmation, type ToolUsed } from "@use-brian/chat-ui";
import type { OfficeArtifactSnapshot } from "@use-brian/office-model";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { MessageBubble, mapSessionRows, type MessageWithViews } from "@/components/chrome/chat-message-bubble";
import { ChatConfirmationCard } from "@/components/chrome/chat-confirmation-card";
import { ComposerControls, useComposerControls } from "@/components/doc/composer-controls";
import type { ConversationState } from "@/lib/chat/conversation-controller";
import { provisionalConversationKey } from "@/lib/chat/conversation-registry";
import { useConversation } from "@/lib/chat/use-conversation";
import { describeToolFromInput } from "@/lib/tool-narration";
import { docPagePath } from "@/lib/doc-page-url";
import { useT } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";
import { getUserInfo } from "@/lib/user";
import {
  getOfficeConversation,
  officeJobFailureKind,
  resumeOfficeGeneration,
  startOfficeConversation,
  steerOfficeJob,
  type OfficeConversation,
  type OfficeJob,
  type OfficeJobEvent,
} from "@/lib/office/api";
import { readOfficeJobStream, useOfficeJobStream, type OfficeJobConnection } from "@/lib/office/job-stream";
import { officeEventLabel, officeJobStateLabel } from "@/lib/office/job-labels";
import { useOfficePanelIdentity } from "@/lib/office/surface-cache";
import { OfficeEditCard, officeEditResult } from "./office-edit-card";

const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const GENERATION_KINDS = new Set(["create", "import", "template_compile"]);

export type OfficeBrianScope =
  | { kind: "none" }
  | { kind: "slide"; slide: number }
  | { kind: "slides"; count: number }
  | { kind: "object"; slide: number }
  | { kind: "objects"; slide: number; count: number }
  | { kind: "objects_across_slides"; count: number; slides: number }
  | { kind: "targets"; count: number };

export function officeBrianScope(snapshot: OfficeArtifactSnapshot | undefined, targetIds: string[]): OfficeBrianScope {
  if (!snapshot || targetIds.length === 0) return { kind: "none" };
  if (snapshot.family !== "presentation") return { kind: "targets", count: targetIds.length };
  const targetSet = new Set(targetIds);
  const selectedSlides = snapshot.slides.flatMap((slide, index) => targetSet.has(slide.id) ? [{ slide: index + 1, id: slide.id }] : []);
  if (selectedSlides.length === targetSet.size) {
    return selectedSlides.length === 1 ? { kind: "slide", slide: selectedSlides[0]!.slide } : { kind: "slides", count: selectedSlides.length };
  }
  const selectedObjects = snapshot.slides.flatMap((slide, index) => slide.objects.flatMap((object) => targetSet.has(object.id) ? [{ slide: index + 1, id: object.id }] : []));
  if (selectedObjects.length !== targetSet.size) return { kind: "targets", count: targetIds.length };
  const slides = new Set(selectedObjects.map((object) => object.slide));
  if (slides.size !== 1) return { kind: "objects_across_slides", count: selectedObjects.length, slides: slides.size };
  const slide = selectedObjects[0]!.slide;
  return selectedObjects.length === 1 ? { kind: "object", slide } : { kind: "objects", slide, count: selectedObjects.length };
}

/** A generation-kind job that has not settled: sends steer it instead of starting a turn. */
function officeGenerationOpen(job: OfficeJob | null): boolean {
  return Boolean(job && (!job.jobKind || GENERATION_KINDS.has(job.jobKind)) && !TERMINAL.has(job.status));
}

type OfficeJobActivityProps = {
  workspaceId: string;
  artifactId: string;
  /** The artifact's latest job (generation, or a revision Brian started). */
  jobId?: string;
  snapshot?: OfficeArtifactSnapshot;
  targetIds: string[];
  /** An owned reason the file cannot take a message right now (offline, inactive). Never "nothing selected". */
  sendDisabledReason?: string;
  onRevisionCompleted(): void | Promise<void>;
  onOpenHistory?(): void;
};

export function OfficeJobActivity(props: OfficeJobActivityProps) {
  const identity = useOfficePanelIdentity();
  return <OfficeJobActivityContent key={`${identity.prefix}:${props.artifactId}`} {...props} prefix={identity.prefix} />;
}

type LiveTurn = { text: string; tools: ToolUsed[]; own: boolean };
type SteeringNote = { id: string; text: string };

/** The rail's slice of the conversation snapshot. */
type RailView = {
  messages: MessageWithViews[];
  ownStreaming: boolean;
  ownText: string;
  ownTools: ToolUsed[];
  teammateRunning: boolean;
  teammateText: string;
  confirmations: PendingConfirmation[];
  errorCode: string | null;
};
const ACTIVE_PHASES = new Set(["running", "suspended"]);
const selectRail = (state: ConversationState): RailView => {
  const ownStreaming = state.transcript.isStreaming;
  const error = state.notices.find((notice) => notice.code === "error");
  return {
    messages: state.transcript.messages as MessageWithViews[],
    ownStreaming,
    ownText: state.transcript.streamingText,
    ownTools: state.activity.tools,
    // A followed turn this renderer did not start (a teammate's, or another tab's).
    teammateRunning: !ownStreaming && (state.mirror.active || ACTIVE_PHASES.has(state.run.phase)),
    teammateText: state.mirror.active ? state.mirror.text : "",
    confirmations: state.transcript.pendingConfirmations.filter((row) => row.status === "pending" || row.status === "approving"),
    errorCode: error?.code === "error" ? error.errorCode : null,
  };
};

function OfficeJobActivityContent({ workspaceId, artifactId, jobId, snapshot, targetIds, sendDisabledReason, onRevisionCompleted, onOpenHistory, prefix }: OfficeJobActivityProps & { prefix: string | null }) {
  const tChat = useT().chat;
  const tChatApp = useT().chatApp;
  const t = useT().office;
  const router = useRouter();
  const controls = useComposerControls(workspaceId);
  const currentUserId = getUserInfo()?.id ?? null;
  const presentationId = `office-rail:${useId()}`;

  // The file's own job, by push (generation progress, input questions).
  const jobStream = useOfficeJobStream(jobId);
  const job = jobStream.job;

  const [conversation, setConversation] = useState<OfficeConversation | null>(null);
  const [steering, setSteering] = useState<SteeringNote[]>([]);
  const [instruction, setInstruction] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [focusDismissed, setFocusDismissed] = useState(false);
  const [templateVersionId, setTemplateVersionId] = useState("");
  const owner = useRef<object | null>(null);
  useLayoutEffect(() => { owner.current = {}; return () => { owner.current = null; }; }, [artifactId]);
  const onRevisionCompletedRef = useRef(onRevisionCompleted);
  onRevisionCompletedRef.current = onRevisionCompleted;

  // Refused activity clears everything derived from it, including a pending
  // draft written while reading it (office.md "Live job progress").
  useLayoutEffect(() => {
    if (jobStream.ended !== "revoked") return;
    setInstruction("");
    setSteering([]);
    setError(null);
    setTemplateVersionId("");
  }, [jobStream.ended]);

  // A new selection is a new focus hint.
  const targetKey = targetIds.join(",");
  useEffect(() => { setFocusDismissed(false); }, [targetKey]);

  useEffect(() => {
    let cancelled = false;
    void getOfficeConversation(artifactId).then((value) => { if (!cancelled) setConversation(value); })
      .catch(() => { if (!cancelled) setConversation(null); });
    return () => { cancelled = true; };
  }, [artifactId]);

  // The file's shared thread as a dock-profile room presentation of the
  // conversation controller: follow, history, send, mid-turn and approvals.
  const sessionId = conversation?.sessionId ?? null;
  const narration = tChat.toolNarration;
  const { controller, value: view } = useConversation({
    workspaceId,
    sessionId,
    // Never sent on: the first send creates the thread first.
    provisionalKey: provisionalConversationKey("office", artifactId),
    presentationId,
    room: true,
    capabilities: {
      profile: "dock",
      mapHistoryRows: (rows) => mapSessionRows(rows, narration),
      describeTool: (name, input) => describeToolFromInput(name, input, narration),
    },
  }, selectRail);

  // Visibility release (office.md): the controller lets go of the follow
  // transport after 60 s hidden and reopens it when the rail is visible.
  useEffect(() => {
    if (!controller || typeof document === "undefined") return;
    const update = () => controller.setVisible(presentationId, document.visibilityState !== "hidden");
    update();
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, [controller, presentationId]);

  // After its own turn the rail reads the canonical rows, so edit cards and
  // sender labels come from history rather than the streamed copy.
  const ownStreaming = view?.ownStreaming ?? false;
  const wasStreaming = useRef(false);
  useEffect(() => {
    if (wasStreaming.current && !ownStreaming) void controller?.reloadHistory();
    wasStreaming.current = ownStreaming;
  }, [controller, ownStreaming]);

  const generationOpen = officeGenerationOpen(job);
  const templateNeeded = job?.status === "needs_input" && job.errorCode === "template_ambiguous";
  const answerNeeded = job?.status === "needs_input" && job.errorCode === "material_fact_missing";
  const canSend = Boolean(prefix) && (generationOpen ? job?.status !== "needs_input" || answerNeeded : Boolean(conversation?.canSend)) && !sendDisabledReason;
  const focusIds = focusDismissed ? [] : targetIds;

  type PendingSend = { sessionId: string; text: string; focusIds: string[]; model: string | undefined; assistantId: string | null };
  const pendingSend = useRef<PendingSend | null>(null);
  const post = useCallback((target: NonNullable<typeof controller>, request: Omit<PendingSend, "sessionId">) => {
    const state = target.getSnapshot();
    // Another sender's turn is running: hand this message to it (the room
    // mid-turn post) instead of racing it for the session's turn lease.
    const teammate = !state.transcript.isStreaming && ACTIVE_PHASES.has(state.run.phase);
    return target.send({
      presentationId,
      text: request.text,
      assistantId: request.assistantId,
      bodyExtras: {
        ...(request.focusIds.length ? { officeSelection: { targetIds: request.focusIds } } : {}),
        ...(request.model ? { model: request.model } : {}),
        ...(teammate ? { midTurn: true } : {}),
      },
      userMessage: { senderUserId: currentUserId },
      onRejected: () => setInstruction((current) => current || request.text),
    });
  }, [currentUserId, presentationId]);

  // A send that created the thread is posted once this rail is attached to
  // that session's controller (the hook attaches in a layout effect first).
  useEffect(() => {
    const request = pendingSend.current;
    if (!request || !controller || controller.getSessionId() !== request.sessionId) return;
    pendingSend.current = null;
    void post(controller, request);
  }, [controller, post]);

  const runTurn = useCallback(async (text: string) => {
    const started = owner.current;
    let thread = conversation;
    const request = { text, focusIds, model: controls.model || undefined, assistantId: thread?.assistant?.id ?? null };
    if (!thread?.sessionId) {
      const created = await startOfficeConversation(artifactId);
      if (!started || started !== owner.current) return;
      thread = { sessionId: created.sessionId, canSend: true, role: thread?.role ?? "comment", assistant: created.assistant };
      pendingSend.current = { ...request, sessionId: created.sessionId, assistantId: created.assistant?.id ?? request.assistantId };
      setConversation(thread);
      return;
    }
    if (!controller || controller.getSessionId() !== thread.sessionId) throw new Error("office_thread_unavailable");
    await post(controller, request);
  }, [artifactId, controller, controls.model, conversation, focusIds, post]);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const text = instruction.trim();
    const started = owner.current;
    const current = () => Boolean(started && started === owner.current && readOfficeJobStream(jobId).ended !== "revoked");
    if (!current() || !text || submitting || !canSend || templateNeeded) return;
    setSubmitting(true);
    setError(null);
    controller?.dismissNotice("error");
    try {
      if (generationOpen && jobId) {
        // During generation a send steers the job: no model turn, no charge.
        await steerOfficeJob(jobId, text);
        if (!current()) return;
        setSteering((rows) => [...rows, { id: `steer-${Date.now()}`, text }]);
        setInstruction("");
        return;
      }
      setInstruction("");
      await runTurn(text);
    } catch {
      if (current()) { setError(t.chatTurnFailed); setInstruction(text); }
    } finally {
      if (current()) setSubmitting(false);
    }
  }

  async function resumeTemplate() {
    const started = owner.current;
    const current = () => Boolean(started && started === owner.current && readOfficeJobStream(jobId).ended !== "revoked");
    if (!current() || submitting || !job?.canResumeTemplate || !job.templateChoices?.some((choice) => choice.templateVersionId === templateVersionId)) return;
    setSubmitting(true);
    try {
      await resumeOfficeGeneration({ artifactId: job.artifactId, jobId: job.id, templateVersionId });
      if (!current()) return;
      // The stream delivers the resumed status and its event; no refetch.
      setTemplateVersionId("");
      if (current()) await onRevisionCompletedRef.current();
    } catch {
      if (current()) setError(t.chatTurnFailed);
    } finally { if (current()) setSubmitting(false); }
  }

  async function decide(toolCallId: string, decision: "allow" | "deny", comment?: string) {
    if (!controller) return;
    const result = await controller.respondConfirmation(toolCallId, decision === "allow" ? "approve" : "deny", comment);
    if (result === "forbidden") setError(tChatApp.confirmNotAllowed);
    else if (result === "failed") setError(t.chatTurnFailed);
  }

  const messages = view?.messages ?? [];
  const restoreDraft = (messageId: string) => {
    // Non-destructive retry in a shared thread: the text returns to the
    // composer; nobody's messages are truncated.
    const index = messages.findIndex((row) => row.id === messageId);
    const source = messages[index]?.role === "user" ? messages[index] : [...messages.slice(0, Math.max(0, index))].reverse().find((row) => row.role === "user");
    if (source?.text) setInstruction(source.text);
  };

  const live: LiveTurn | null = view?.ownStreaming
    ? { text: view.ownText, tools: view.ownTools, own: true }
    : view?.teammateText ? { text: view.teammateText, tools: [], own: false } : null;
  const remoteRunning = Boolean(view?.teammateRunning);
  const noticeError = view?.errorCode
    ? view.errorCode === "office_chat_read_only" ? t.chatReadOnly
      : view.errorCode === "office_generation_active" ? t.iterationActiveHint : t.chatTurnFailed
    : null;

  return <OfficeJobActivityView
    job={generationOpen || (job && (!job.jobKind || GENERATION_KINDS.has(job.jobKind))) ? job : null}
    events={jobStream.events}
    connection={jobStream.connection}
    loading={Boolean(jobId && !job && jobStream.ended !== "revoked")}
    conversation={conversation}
    messages={messages}
    live={live}
    remoteRunning={remoteRunning}
    steering={steering}
    confirmations={view?.confirmations ?? []}
    currentUserId={currentUserId}
    workspaceId={workspaceId}
    instruction={instruction}
    scope={officeBrianScope(snapshot, focusIds)}
    onDismissFocus={() => setFocusDismissed(true)}
    canSend={canSend}
    sendDisabledReason={sendDisabledReason}
    submitting={submitting}
    error={error ?? noticeError}
    controls={<ComposerControls model={controls.model} onModelChange={controls.setModel} plan={controls.plan} researchMode={controls.researchMode} onResearchModeChange={controls.setResearchMode} researchQuota={controls.researchQuota} researchExhausted={controls.researchExhausted} />}
    onInstructionChange={setInstruction}
    onSubmit={submit}
    onRevisionCompleted={() => onRevisionCompletedRef.current()}
    onOpenHistory={onOpenHistory}
    onOpenPage={(pageId) => router.push(docPagePath(workspaceId, pageId))}
    onRetry={restoreDraft}
    onApprove={(id) => void decide(id, "allow")}
    onDeny={(id, comment) => void decide(id, "deny", comment)}
    templatesHref={`/w/${workspaceId}/office/templates`}
    templateVersionId={templateVersionId}
    onTemplateChange={setTemplateVersionId}
    onResumeTemplate={() => void resumeTemplate()}
  />;
}

export function OfficeJobActivityView({
  job,
  events,
  connection = "live",
  loading = false,
  conversation = null,
  messages = [],
  live = null,
  remoteRunning = false,
  steering = [],
  confirmations = [],
  currentUserId = null,
  workspaceId = "",
  instruction,
  scope,
  onDismissFocus,
  canSend,
  sendDisabledReason,
  submitting = false,
  error = null,
  controls,
  onInstructionChange,
  onSubmit,
  onRevisionCompleted,
  onOpenHistory,
  onOpenPage,
  onRetry,
  onApprove,
  onDeny,
  templatesHref,
  templateVersionId = "",
  onTemplateChange,
  onResumeTemplate,
}: {
  job: OfficeJob | null;
  events: OfficeJobEvent[];
  connection?: OfficeJobConnection;
  loading?: boolean;
  conversation?: OfficeConversation | null;
  messages?: MessageWithViews[];
  live?: LiveTurn | null;
  remoteRunning?: boolean;
  steering?: SteeringNote[];
  confirmations?: PendingConfirmation[];
  currentUserId?: string | null;
  workspaceId?: string;
  instruction: string;
  scope: OfficeBrianScope;
  onDismissFocus?(): void;
  canSend: boolean;
  sendDisabledReason?: string;
  submitting?: boolean;
  error?: string | null;
  controls?: React.ReactNode;
  onInstructionChange(value: string): void;
  onSubmit(event: React.FormEvent): void;
  onRevisionCompleted?(): void | Promise<void>;
  onOpenHistory?(): void;
  onOpenPage?(pageId: string): void;
  onRetry?(messageId: string): void;
  onApprove?(toolCallId: string): void;
  onDeny?(toolCallId: string, comment?: string): void;
  templatesHref?: string;
  templateVersionId?: string;
  onTemplateChange?(value: string): void;
  onResumeTemplate?(): void;
}) {
  const dict = useT();
  const t = dict.office;
  const tChat = dict.chat;
  const formRef = useRef<HTMLFormElement>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const generationOpen = officeGenerationOpen(job);
  const templateNeeded = job?.status === "needs_input" && job.errorCode === "template_ambiguous";
  const inputNeeded = job?.status === "needs_input";
  const failed = job?.status === "failed";
  const failureKind = officeJobFailureKind(job?.errorCode);
  const failureTitle = failureKind === "presentation_fit" ? t.presentationFitFailed : failureKind === "presentation_plan" ? t.presentationPlanFailed : failureKind === "fit" ? t.fitFailed : t.failed;
  const failureBody = failureKind === "presentation_fit" ? t.presentationFitFailedBody : failureKind === "presentation_plan" ? t.presentationPlanFailedBody : failureKind === "fit" ? t.fitFailedBody : t.generationFailedBody;
  const scopeLabel = scope.kind === "slide" ? t.brianScopeSlide.replace("{slide}", String(scope.slide))
    : scope.kind === "slides" ? t.brianScopeSlides.replace("{count}", String(scope.count))
    : scope.kind === "object" ? t.brianScopeObject.replace("{slide}", String(scope.slide))
    : scope.kind === "objects" ? t.brianScopeObjects.replace("{slide}", String(scope.slide)).replace("{count}", String(scope.count))
    : scope.kind === "objects_across_slides" ? t.brianScopeObjectsAcrossSlides.replace("{count}", String(scope.count)).replace("{slides}", String(scope.slides))
    : scope.kind === "targets" ? t.brianScopeTargets.replace("{count}", String(scope.count))
    : null;
  const busy = submitting || Boolean(live?.own);
  const disabled = !instruction.trim() || busy || !canSend;

  const latestEvent = events.at(-1) ?? null;
  // Persisted status plus latest persisted event; nothing inferred (office.md "No generic Working").
  const statusLabel = failed ? failureTitle : officeJobStateLabel(t, job?.status, latestEvent);
  const isLive = connection === "live";
  const inFlight = job?.status === "queued" || job?.status === "running";
  const question = templateNeeded ? t.templateSelectionQuestion : job?.inputQuestion ?? String([...events].reverse().find(event => event.code === "office.job.needs_input" && typeof event.params.question === "string")?.params.question ?? t.eventNeedsInput);
  const connectionNote = job && !isLive ? connection === "offline" ? t.jobOffline : t.jobReconnecting : null;
  const jobText = failed ? failureBody : inputNeeded ? templateNeeded ? t.templateSelectionHint : t.generationAnswerHint
    : connectionNote ?? (inFlight ? t.iterationActiveHint : null);
  const runIcon = job?.status === "completed" ? <CheckCircle2 className="size-3 shrink-0 text-emerald-600" aria-hidden />
    : failed ? <CircleAlert className="size-3 shrink-0 text-destructive" aria-hidden />
    : <CircleDashed className={cn("size-3 shrink-0", inFlight && isLive && "animate-spin [animation-duration:3s]")} aria-hidden />;
  const readOnly = conversation !== null && !conversation.canSend && !generationOpen;
  const assistant = conversation?.assistant ? { id: conversation.assistant.id, name: conversation.assistant.name, iconSeed: null } : null;

  const editCards = (tools: ToolUsed[] | undefined) => {
    const cards = (tools ?? []).flatMap((tool) => {
      const result = officeEditResult(tool);
      return result ? [<OfficeEditCard key={result.jobId} {...result} onSettled={onRevisionCompleted} onOpenHistory={onOpenHistory} />] : [];
    });
    return cards.length ? <div className="space-y-2">{cards}</div> : null;
  };
  const bubble = (message: MessageWithViews) => <MessageBubble
    key={message.id}
    message={message}
    assistant={assistant}
    workspaceId={workspaceId}
    openInDocLabel={tChat.openInDoc}
    appendedLabel={tChat.viewAppended}
    createdLabel={tChat.viewCreated}
    onOpenInDoc={(pageId) => onOpenPage?.(pageId)}
    onRetry={(id) => onRetry?.(id)}
    onRetryUser={(id) => onRetry?.(id)}
    onCopy={(id, text) => { void navigator.clipboard?.writeText(text); setCopied(id); }}
    copied={copied === message.id}
    retryLabel={tChat.retry}
    copyLabel={tChat.copy}
    copiedLabel={tChat.copied}
    citationLabel={tChat.citationLabel}
    senderLabel={message.role === "user" && message.senderUserId && message.senderUserId !== currentUserId ? message.senderName ?? t.teammate : null}
    extras={message.role === "assistant" ? editCards(message.toolsUsed) : null}
  />;
  const empty = !job && !loading && messages.length === 0 && !live && steering.length === 0;

  // Same chrome as the rest of the app's chat: assistant message rows
  // (avatar + prose, activity receipt above the text) over the Chat app's
  // bordered composer box.
  return <section className="flex min-h-0 flex-1 flex-col" aria-label={t.editWithBrian}>
    <header className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-2.5">
      <Sparkles className="size-3.5 text-primary" aria-hidden />
      <h2 className="text-sm font-medium">{t.editWithBrian}</h2>
    </header>
    <div className="min-h-0 flex-1 space-y-5 overflow-y-auto px-4 py-4" data-office-thread="true">
      {job || loading || empty ? <div className="flex gap-2.5">
        <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary ring-1 ring-primary/15"><Sparkles className="size-3.5" aria-hidden /></div>
        <div className="min-w-0 flex-1 space-y-2.5 pt-0.5">
          {job ? <details className="group/run min-w-0 text-xs">
            <summary className="flex w-fit max-w-full cursor-pointer list-none items-center gap-1.5 py-0.5 text-[11px] text-muted-foreground/70 transition-colors hover:text-muted-foreground max-sm:min-h-11 [&::-webkit-details-marker]:hidden">
              <ChevronRight className="size-3 shrink-0 transition-transform group-open/run:rotate-90" aria-hidden />
              {runIcon}
              <span className="truncate">{t.runActivity}</span>
              {statusLabel ? <>
                <span aria-hidden>·</span>
                <span className={cn("truncate", failed && "text-destructive")}>{statusLabel}</span>
              </> : null}
            </summary>
            {events.length ? <ol className="mt-1.5 flex flex-col gap-1.5 border-l border-border/60 pl-3">
              {events.flatMap((event) => {
                const label = officeEventLabel(t, event);
                return label ? [<li key={event.id} className="flex min-w-0 items-baseline justify-between gap-2 leading-snug text-muted-foreground">
                  <span className="min-w-0 break-words">{label}</span>
                  <time className="shrink-0 text-[10px] tabular-nums text-muted-foreground/60">{new Date(event.createdAt).toLocaleTimeString()}</time>
                </li>] : [];
              })}
            </ol> : null}
          </details> : null}
          {job || empty
            ? (jobText ?? (empty ? t.brianEditHint : null))
              ? <p role={failed ? "alert" : connectionNote ? "status" : undefined} className={cn("break-words text-[14px] leading-[1.6]", failed ? "text-destructive" : connectionNote ? "text-muted-foreground" : "text-foreground")}>{jobText ?? t.brianEditHint}</p>
              : null
            : <div data-office-job-skeleton="true" aria-hidden className="h-4 w-40 animate-pulse rounded bg-muted" />}
          {inputNeeded ? <div className="space-y-3 rounded-xl border border-border bg-muted/30 p-3 text-sm">
            <p role="status" className="leading-relaxed">{question}</p>
            {templateNeeded ? job?.canResumeTemplate ? <>
              {job.templateChoices?.length ? <>
                <SearchableSelect value={templateVersionId} onValueChange={onTemplateChange ?? (()=>undefined)} items={job.templateChoices.map(choice=>({value:choice.templateVersionId,label:choice.name}))} placeholder={t.chooseTemplateTitle} searchPlaceholder={t.searchTemplates} emptyMessage={t.noMatchingTemplates} aria-label={t.chooseTemplateTitle} className="max-sm:min-h-11 w-full" disabled={submitting}/>
                <Button type="button" disabled={submitting || !job.templateChoices.some(choice=>choice.templateVersionId===templateVersionId)} onClick={onResumeTemplate} className="max-sm:min-h-11 w-full">{submitting ? t.queued : t.resumeGeneration}</Button>
              </> : <p className="text-muted-foreground">{t.noPublishedTemplateForDraft}</p>}
              {templatesHref ? <Link href={templatesHref} className="inline-flex min-h-8 max-sm:min-h-11 items-center underline">{t.openTemplates}</Link> : null}
            </> : <p className="text-muted-foreground">{t.templateRecoveryUnavailable}</p> : null}
          </div> : null}
        </div>
      </div> : null}
      {messages.map(bubble)}
      {steering.map((note) => <div key={note.id} className="flex flex-col items-end" data-office-steering="true">
        <span className="mb-0.5 px-1 text-[11px] text-muted-foreground">{t.steeringSent}</span>
        <div className="max-w-[85%] rounded-2xl rounded-br-md bg-secondary px-3.5 py-2 text-[14px] leading-[1.5] text-secondary-foreground shadow-sm break-words whitespace-pre-wrap">{note.text}</div>
      </div>)}
      {live ? live.text || live.tools.length
        ? bubble({ id: "live-turn", role: "assistant", text: live.text, timestamp: new Date(), ...(live.tools.length ? { toolsUsed: live.tools } : {}) })
        : <div className="flex gap-2.5" data-office-thinking="true">
          <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary ring-1 ring-primary/15"><Sparkles className="size-3.5" aria-hidden /></div>
          <div aria-hidden className="mt-2 h-4 w-24 animate-pulse rounded bg-muted" />
        </div>
        : remoteRunning ? <div aria-hidden className="ml-9 h-4 w-24 animate-pulse rounded bg-muted" data-office-thinking="true" /> : null}
      {confirmations.map((confirmation) => <ChatConfirmationCard key={confirmation.toolCallId} confirmation={confirmation} approveLabel={tChat.confirmationApprove} denyLabel={tChat.confirmationDeny} approvingLabel={tChat.confirmationApproving} onApprove={(id) => onApprove?.(id)} onDeny={(id, comment) => onDeny?.(id, comment)} />)}
      {error ? <p role="alert" className="break-words text-[14px] leading-[1.6] text-destructive">{error}</p> : null}
    </div>
    {templateNeeded ? null : readOnly ? <p className="shrink-0 border-t border-border px-4 py-3 text-xs leading-relaxed text-muted-foreground" data-office-read-only="true">{t.chatReadOnly}</p>
      : <form ref={formRef} onSubmit={onSubmit} className="shrink-0 px-3 pb-3 pt-1">
      <div className="rounded-xl border border-border bg-background shadow-sm focus-within:border-ring [&_:focus-visible]:shadow-none">
        <label className="sr-only" htmlFor="office-brian-instruction">{t.editWithBrian}</label>
        <ChatComposer
          textareaId="office-brian-instruction"
          value={instruction}
          onChange={onInstructionChange}
          onSend={() => formRef.current?.requestSubmit()}
          disabled={busy && !generationOpen}
          sendDisabled={disabled}
          placeholder={t.iterationPlaceholder}
          sendLabel={<><ArrowUp className="size-4" aria-hidden /><span className="sr-only">{submitting ? t.queued : t.askBrian}</span></>}
          rowClassName="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-y-1 px-2 pb-2"
          textareaClassName="order-1 col-span-2 w-full min-h-[44px] max-h-48 min-w-0 resize-none overflow-y-auto bg-transparent px-1.5 pt-2.5 pb-1 text-[16px] leading-relaxed outline-none placeholder:text-muted-foreground focus-visible:shadow-none disabled:cursor-not-allowed disabled:opacity-60 md:text-sm"
          sendButtonClassName="order-3 ml-1 inline-flex size-11 shrink-0 items-center justify-center rounded-lg bg-action text-action-foreground transition-colors hover:bg-action/90 focus-visible:shadow-none disabled:pointer-events-none disabled:opacity-40 sm:size-8"
          slotPreInput={<div className="order-2 flex min-w-0 flex-wrap items-center gap-1.5 px-1.5">
            {scopeLabel ? <span className="flex min-w-0 items-center gap-1.5 rounded-md bg-muted/60 py-0.5 pl-1.5 pr-0.5 text-[11px] text-muted-foreground" data-office-brian-scope={scope.kind}>
              <Crosshair className="size-3 shrink-0 text-primary/70" aria-hidden />
              <span className="shrink-0">{t.brianScope}:</span>
              <span className="truncate font-medium text-foreground">{scopeLabel}</span>
              {onDismissFocus ? <button type="button" onClick={onDismissFocus} aria-label={t.clearFocus} title={t.clearFocus} className="inline-flex size-6 shrink-0 items-center justify-center rounded hover:bg-muted max-sm:size-11"><X className="size-3" aria-hidden /></button> : null}
            </span> : null}
            {!generationOpen ? controls : null}
          </div>}
        />
      </div>
      {sendDisabledReason ? <p className="mt-2 px-1 text-xs leading-relaxed text-muted-foreground">{sendDisabledReason}</p> : null}
    </form>}
  </section>;
}
