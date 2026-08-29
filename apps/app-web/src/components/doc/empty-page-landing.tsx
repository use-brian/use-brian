"use client";

/**
 * Default-viewer landing — what the doc centre pane shows when no page
 * is open (the `/p` index, a blank tab). Two affordances:
 *
 *   ┌─ chatter ──────────────────────────────────────────────┐
 *   │  badge + gradient title + "what do you want to see?"    │
 *   │  composer (+ attach files, research toggle, model       │
 *   │  picker) + one-tap starter prompts. On send / tap,      │
 *   │  builds a page. A quiet "Start with a blank page"       │
 *   │  button below skips the AI prompt (`onStartBlank`).     │
 *   ├─ recents ──────────────────────────────────────────────┤
 *   │  Up to 5 recently-opened pages as quick-link cards.     │
 *   └─────────────────────────────────────────────────────────┘
 *
 * The chatter is presentational: submitting (composer send or a starter-
 * prompt tap) calls `onSubmitPrompt` with the chosen model tier, research
 * flag, and any staged file ids. The shell implements that as "pre-create a
 * draft, navigate to it, then build it on the page" (the construction streams
 * onto the page body), threading the model/research/files through the
 * chat-seed so the build turn uses them. See `doc-shell.tsx` →
 * `handleBuildPage`. Attachments are uploaded here (before any draft/session
 * exists) and ride the build turn as `fileIds` — `fileId`s are
 * session-agnostic on the read path (`useFileAttachments`).
 *
 * Tone: a document surface — tonally neutral; the palette brand (`--primary` /
 * `--ring`) appears only as the primary CTA, the focus ring, and small hover
 * accents. The hero sparkle badge stays neutral (`text-muted-foreground`) — a
 * persistent saturated-brand icon reads off-brand on the Notion surface. The
 * attach + send buttons match the page-comment composers' style (a muted
 * paperclip and a circular `--primary` send with an up-arrow, no
 * neutral action tokens) so every doc composer reads the same. Motion via
 * `.animate-*`.
 *
 * Spec: docs/architecture/features/doc.md → "Default-viewer landing".
 *
 * [COMP:app-web/empty-page-landing]
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  ArrowUpRight,
  Check,
  ChevronDown,
  Clock3,
  LayoutTemplate,
  Paperclip,
  PencilLine,
  Sparkles,
  X,
} from "lucide-react";
import { ChatComposer } from "@use-brian/chat-ui";
import {
  derivePageIcon,
  listWorkspaceAssistants,
  type ViewListRow,
  type WorkspaceAssistantSummary,
} from "@/lib/api/views";
import {
  ASSISTANT_REFRESH_EVENT,
  type AssistantRefreshDetail,
} from "@/lib/assistant-events";
import {
  readActiveAssistantId,
  resolveDraftAssistantId,
} from "@/lib/active-assistant";
import { AssistantAvatar } from "@/components/assistant-avatar";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { PageIcon } from "./page-icon";
import { useChatModelTier, type ModelTier } from "@/lib/chat-model";
import { ComposerControls } from "@/components/doc/composer-controls";
import {
  AttachmentChips,
  FileDropOverlay,
} from "@/components/doc/attachment-chips";
import { useFileAttachments } from "@/lib/use-file-attachments";
import { useFileDrop } from "@/lib/use-file-drop";
import {
  useRecordingUpload,
  type StagedRecording,
} from "@/lib/recordings/use-recording-upload";
import { useT } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";
import { SetupChecklist } from "./setup-checklist";

type BuildOptions = {
  model: ModelTier;
  researchMode: boolean;
  /** Ready (`done`) attachment ids to feed the build turn, in chip order. */
  fileIds: string[];
  /** Uploaded recordings staged without processing, in chip order. */
  attachedRecordingIds: string[];
  /** Which workspace assistant drafts the page (the footer picker). Rides
   *  the chat-seed so the dock switches its interlocutor for the build turn.
   *  Absent while the primary hasn't resolved → the dock's own default. */
  assistantId?: string;
};

type Props = {
  /** Workspace id — backs model-tier plan gating. */
  workspaceId: string;
  /**
   * Workspace primary assistant — lets an attached `video/*` route to the
   * recordings pipeline (direct-to-GCS + transcribe-to-brain) instead of being
   * rejected by the upload guard. Absent → video falls to the guard chip.
   */
  assistantId?: string;
  /** Recently-opened pages (saved rows), most-recent first, pre-capped. */
  cards: ViewListRow[];
  /** Open a card's page in the active tab. */
  onOpenCard: (id: string) => void;
  /**
   * Build a page from a prompt — the shell pre-creates a draft, navigates
   * to it, and streams the construction onto the page body, using the
   * chosen model tier + research flag. Fired by the composer's send and by
   * a starter-prompt tap.
   */
  onSubmitPrompt: (text: string, opts: BuildOptions) => void;
  /**
   * Skip the AI prompt entirely and open an empty editor to write the page
   * by hand. On a blank tab the shell mints a draft first; on an empty draft
   * (the draft already has an id) it just drops the landing for that page.
   * Fired by the "Start with a blank page" button below the composer.
   */
  onStartBlank: () => void;
  /** Open the template gallery to seed a new page from a template. */
  onStartFromTemplate?: () => void;
  /**
   * Cold-start signal: zero connected connectors (≈ setup incomplete), or
   * `null`/`false` once set up. When `true`, the home landing renders the
   * dismissable setup checklist above the chatter. Lifted from the shared
   * `studioSetupIncomplete` signal in `DocSidebarDataProvider` (the same
   * one the sidebar Studio nudge reads) — no second connectors fetch. Defaults
   * undefined (no checklist) so a non-cold-start caller never shows it.
   */
  studioSetupIncomplete?: boolean | null;
};

export function EmptyPageLanding({
  workspaceId,
  assistantId,
  cards,
  onOpenCard,
  onSubmitPrompt,
  onStartBlank,
  onStartFromTemplate,
  studioSetupIncomplete,
}: Props) {
  const t = useT().docPage;
  const tAttach = useT().attachments;
  const tRec = useT().recordings;
  const [prompt, setPrompt] = useState("");
  // Landing defaults to Pro (respecting any cached choice), shared with the
  // floating dock via the `doc-chat-model` key + plan-gated.
  const { model, setModel, plan } = useChatModelTier(workspaceId, "pro");
  // Deep-research mode for the build turn. Doc research now ships — a
  // `mode:'research'` doc turn keeps its page-authoring tools and authors
  // findings onto the page (the 2026-06-01 fix split "forbids research" from
  // "forbids coordinator"), so the landing arms it like every other doc
  // composer. Quota / exhaustion surface on the build turn's own SSE (in the
  // chat dock), so the landing only holds the armed flag.
  const [researchMode, setResearchMode] = useState(false);
  // Attached video routes to durable recording staging (direct-to-GCS upload +
  // duration estimate only) exactly like the chat dock. It does not open the
  // blueprint dialog or start processing merely because bytes were selected.
  // A later build prompt carries the staged recording id into the chat turn so
  // Brian can use the user's stated purpose and confirm any processing there.
  // See
  // docs/architecture/media/transcription.md → "Chat-attached video".
  const rec = useRecordingUpload(workspaceId, assistantId ?? "");
  const [pendingRecordings, setPendingRecordings] = useState<StagedRecording[]>([]);
  // File attachments staged on the landing. `fileId`s are session-agnostic on
  // the read path (see `useFileAttachments`), so we upload here — before any
  // draft / session exists — and hand the ready ids to the build turn via the
  // chat-seed (`onSubmitPrompt` → `handleBuildPage` → seed → `/api/chat`).
  const att = useFileAttachments(undefined, {
    onRouteMedia:
      workspaceId && assistantId
        ? async (videos) => {
            for (const file of videos) {
              const staged = await rec.stage(file);
              if (staged) setPendingRecordings((current) => [...current, staged]);
            }
          }
        : undefined,
  });
  const fileInputRef = useRef<HTMLInputElement>(null);
  const drop = useFileDrop((files) => void att.upload(files));

  // ── Draft-assistant picker ─────────────────────────────────────────────
  // Which workspace assistant drafts the page. Defaults to the dock's
  // persisted per-workspace selection (the same `active-assistant` key the
  // floating chat's switcher writes), repaired to the primary when that id
  // has left the roster. A pick here only rides the build seed — the dock
  // persists it when the build actually fires, so browsing the picker never
  // yanks the dock's live conversation. Roster kept fresh via the workspace
  // event spine, same rule as the dock's switcher.
  const [assistants, setAssistants] = useState<WorkspaceAssistantSummary[]>([]);
  const [pickedAssistantId, setPickedAssistantId] = useState<string | null>(
    () => readActiveAssistantId(workspaceId),
  );
  const [assistantPickerOpen, setAssistantPickerOpen] = useState(false);
  const reloadAssistants = useCallback(() => {
    if (!workspaceId) return;
    listWorkspaceAssistants(workspaceId)
      .then((list) => setAssistants(list))
      .catch(() => {
        /* picker just stays hidden; the dock's default still drafts */
      });
  }, [workspaceId]);
  useEffect(() => {
    reloadAssistants();
  }, [reloadAssistants]);
  useEffect(() => {
    const onRefresh = (event: Event) => {
      const detail = (event as CustomEvent<AssistantRefreshDetail>).detail;
      if (detail?.workspaceId && detail.workspaceId !== workspaceId) return;
      reloadAssistants();
    };
    window.addEventListener(ASSISTANT_REFRESH_EVENT, onRefresh);
    return () => window.removeEventListener(ASSISTANT_REFRESH_EVENT, onRefresh);
  }, [workspaceId, reloadAssistants]);
  const draftAssistantId = resolveDraftAssistantId({
    persisted: pickedAssistantId,
    primary: assistantId ?? null,
    roster: assistants,
  });
  const draftAssistant =
    assistants.find((a) => a.id === draftAssistantId) ?? null;

  function submit(text: string) {
    const trimmed = text.trim();
    // An attachment-only turn is valid once its upload is ready. The chat
    // route asks the user what outcome they want before semantic processing.
    if (!trimmed && !att.hasReady && pendingRecordings.length === 0) return;
    if (att.uploading || rec.status === "uploading") return;
    onSubmitPrompt(trimmed, {
      model,
      researchMode,
      fileIds: att.fileIds(),
      attachedRecordingIds: pendingRecordings.map((recording) => recording.recordingId),
      ...(draftAssistantId ? { assistantId: draftAssistantId } : {}),
    });
    att.clear();
    setPendingRecordings([]);
  }

  function submitComposer() {
    if (att.uploading || rec.status === "uploading") return;
    submit(prompt);
    setPrompt("");
  }

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-12 px-6 py-16">
      {/* ── Cold-start setup checklist ───────────────────────── */}
      {/* Home half of the §4 lifecycle-aware Studio prominence: shown only at
          cold start (zero connected connectors). Calm + non-blocking + opt-out;
          auto-hides the instant a connector connects (same signal as the
          sidebar nudge). [COMP:app-web/setup-checklist] */}
      {studioSetupIncomplete === true ? (
        <SetupChecklist workspaceId={workspaceId} />
      ) : null}

      {/* ── Chatter ──────────────────────────────────────────── */}
      <section className="flex flex-col items-center text-center">
        <span className="animate-pop-in mb-5 inline-flex size-12 items-center justify-center rounded-2xl border border-border bg-muted/50 text-muted-foreground shadow-sm">
          <Sparkles className="size-6" aria-hidden />
        </span>

        <h1 className="bg-gradient-to-b from-foreground to-foreground/65 bg-clip-text text-2xl font-semibold tracking-tight text-transparent">
          {t.landing.title}
        </h1>
        <p className="mt-2 max-w-md text-sm leading-relaxed text-muted-foreground">
          {t.landing.subtitle}
        </p>

        {/* Composer — one unified "prompt window": the border + focus ring live
            on the whole card (`focus-within`), wrapping the input row AND the
            footer controls so the research toggle + model picker read as part of
            the composer rather than a detached strip below it (mirrors the
            page-comments band). The ring never sits on the inner textarea (the
            global `:focus-visible` ring is suppressed there). Create stays
            vertically centered (`items-center`). The whole card is a file drop
            target (paperclip + drag-and-drop); staged chips render above the
            input row. `allowEmptySend` lets a files-only build through once the
            uploads are ready. */}
        <div
          className={cn(
            "relative mt-6 w-full rounded-[1.05rem] border border-border bg-card p-2 shadow-sm",
            "transition-[border-color,box-shadow] focus-within:border-ring [&_:focus-visible]:shadow-none",
          )}
          {...drop.dropProps}
        >
          <FileDropOverlay active={drop.isDragging} />
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files) void att.upload(e.target.files);
              e.target.value = "";
            }}
          />
          <ChatComposer
            value={prompt}
            onChange={setPrompt}
            onSend={submitComposer}
            placeholder={t.landing.placeholder}
            allowEmptySend={att.hasReady || pendingRecordings.length > 0}
            disabled={att.uploading || rec.status === "uploading"}
            slotAttachments={
              att.attachments.length > 0 || pendingRecordings.length > 0 || rec.status !== "idle" ? (
                <div className="px-1 pb-2">
                  {att.attachments.length > 0 ? (
                    <AttachmentChips
                      attachments={att.attachments}
                      onRemove={att.remove}
                    />
                  ) : null}
                  {pendingRecordings.length > 0 ? (
                    <div className="flex flex-wrap gap-1.5 py-0.5">
                      {pendingRecordings.map((recording) => (
                        <span
                          key={recording.recordingId}
                          className="inline-flex items-center gap-1 rounded border border-border bg-muted/40 px-2 py-0.5 text-xs text-muted-foreground"
                        >
                          <span aria-hidden>◉</span>
                          {tRec.chatStagedChip.replace("{name}", recording.title)}
                          <button
                            type="button"
                            onClick={() => setPendingRecordings((current) =>
                              current.filter((item) => item.recordingId !== recording.recordingId)
                            )}
                            aria-label={`${tAttach.remove} ${recording.title}`}
                            className="rounded p-0.5 hover:bg-muted"
                          >
                            <X className="size-3" aria-hidden />
                          </button>
                        </span>
                      ))}
                    </div>
                  ) : null}
                  {rec.status !== "idle" ? (
                    <p
                      className={cn(
                        "py-0.5 text-left text-xs",
                        rec.status === "error"
                          ? "text-destructive"
                          : "text-muted-foreground",
                      )}
                      role="status"
                    >
                      {rec.status === "uploading"
                        ? tRec.uploading
                        : rec.status === "processing"
                          ? tRec.processing
                          : rec.message}
                    </p>
                  ) : null}
                </div>
              ) : null
            }
            className="w-full"
            // The input row is the textarea alone — the attach button and the
            // Create CTA live in the footer below (attach next to Research, the
            // send button next to the model picker), so a grown multi-line
            // prompt isn't flanked by controls drifting in its vertical centre.
            rowClassName="flex"
            // ChatComposer auto-grows this textarea to fit content (see
            // @use-brian/chat-ui) — the host only sets the cap, never its own
            // resize logic. `max-h-[240px]` (~10 lines) keeps a longer "what do
            // you want to see?" prompt fully visible before the box starts
            // scrolling (`overflow-y-auto`); the old 160px clipped multi-line
            // asks too early. Matches the floating dock's composer.
            textareaClassName={cn(
              "flex-1 min-w-0 resize-none overflow-y-auto bg-transparent px-2.5 py-2 text-sm leading-relaxed",
              "min-h-[44px] max-h-[240px] outline-none focus-visible:shadow-none placeholder:text-muted-foreground",
            )}
            // The Create CTA is rendered in the footer instead (next to the
            // model picker), so the composer's own send button is hidden. Enter
            // still sends through the composer's key handler (`onSend`).
            sendButtonClassName="hidden"
          />

          {/* Footer — a single control strip in parity with the page-comment
              composers (`page-comments.tsx` et al.): attach (paperclip) +
              deep-research toggle on the LEFT, model-tier picker + the send
              button on the RIGHT, all in one row. `ComposerControls` fills the
              middle with its own spacer so the picker pins to the right, and the
              send button sits next to it (not below). Attach + send reuse the
              comment composers' exact button style - a muted paperclip and a
              circular `--primary` send with an up-arrow (lucide `ArrowUp`) - so
              every doc composer reads the same; the send button keeps an
              aria-label so it stays "Create" for assistive tech. Enter still
              sends via the composer's own key handler. The picker opens downward
              (`selectSide="bottom"`) since the landing sits near the top of the
              pane; research quota / exhaustion surface on the build turn itself,
              so the landing passes a null quota. */}
          <div className="flex items-center gap-1.5 px-1 pt-1">
            <button
              type="button"
              aria-label={tAttach.attach}
              onClick={() => fileInputRef.current?.click()}
              className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground"
            >
              <Paperclip className="size-[18px]" aria-hidden />
            </button>
            {/* Draft-assistant picker — dock-switcher-style chip + popover.
                Renders only at roster length > 1 (a single option degrades to
                no control, same rule as the dock's switcher); the pick rides
                the build seed as `assistantId`. */}
            {assistants.length > 1 && draftAssistant ? (
              <Popover
                open={assistantPickerOpen}
                onOpenChange={setAssistantPickerOpen}
              >
                <PopoverTrigger
                  className="flex min-w-0 max-w-40 shrink-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  aria-label={t.landing.assistantLabel}
                  title={t.landing.assistantLabel}
                >
                  <AssistantAvatar
                    id={draftAssistant.id}
                    name={draftAssistant.name}
                    iconSeed={draftAssistant.iconSeed ?? undefined}
                    size="sm"
                  />
                  <span className="truncate">{draftAssistant.name}</span>
                  <ChevronDown
                    className="size-3.5 shrink-0 text-muted-foreground"
                    aria-hidden
                  />
                </PopoverTrigger>
                <PopoverContent
                  align="start"
                  className="w-60 max-w-[calc(100vw-2rem)] gap-0.5 p-1"
                >
                  <p className="px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                    {t.landing.assistantTitle}
                  </p>
                  {assistants.map((a) => (
                    <button
                      key={a.id}
                      type="button"
                      onClick={() => {
                        setAssistantPickerOpen(false);
                        setPickedAssistantId(a.id);
                      }}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                        a.id === draftAssistantId
                          ? "bg-muted text-foreground"
                          : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                      )}
                    >
                      <AssistantAvatar
                        id={a.id}
                        name={a.name}
                        iconSeed={a.iconSeed ?? undefined}
                        size="sm"
                      />
                      <span className="min-w-0 flex-1 truncate">{a.name}</span>
                      {a.id === draftAssistantId ? (
                        <Check
                          className="size-4 shrink-0 text-primary"
                          aria-hidden
                        />
                      ) : null}
                    </button>
                  ))}
                </PopoverContent>
              </Popover>
            ) : null}
            <ComposerControls
              model={model}
              onModelChange={setModel}
              plan={plan}
              researchMode={researchMode}
              onResearchModeChange={setResearchMode}
              researchQuota={null}
              researchExhausted={false}
              showResearch
              selectSide="bottom"
              className="flex-1"
            />
            <button
              type="button"
              onClick={submitComposer}
              disabled={
                att.uploading ||
                rec.status === "uploading" ||
                (!prompt.trim() && !att.hasReady && pendingRecordings.length === 0)
              }
              aria-label={t.landing.send}
              title={t.landing.send}
              className="inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-action text-action-foreground transition-colors hover:bg-action/90 disabled:bg-foreground/10 disabled:text-muted-foreground"
            >
              <ArrowUp className="size-4" aria-hidden />
            </button>
          </div>
        </div>

        {/* Starter prompts — one tap builds a page for that prompt. */}
        <div className="animate-stagger mt-4 flex flex-wrap items-center justify-center gap-2">
          {t.landing.suggestions.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => submit(s)}
              className={cn(
                "press group/chip inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-3 py-1.5",
                "text-xs font-medium text-muted-foreground",
                "transition-colors hover:border-muted-foreground/30 hover:bg-muted/60 hover:text-foreground",
              )}
            >
              <Sparkles
                className="size-3 text-muted-foreground/70 transition-colors group-hover/chip:text-primary"
                aria-hidden
              />
              {s}
            </button>
          ))}
        </div>

        {/* Escape hatch — skip the AI prompt and just start writing. A quiet
            text button (not a CTA, not a sparkle chip) so it reads as the
            opposite of the build-it-for-me chatter above: open an empty editor
            and author the page by hand. The shell mints/opens the draft. */}
        <button
          type="button"
          onClick={onStartBlank}
          className={cn(
            "press mt-5 inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium",
            "text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground",
          )}
        >
          <PencilLine className="size-3.5" aria-hidden />
          {t.landing.startBlank}
        </button>
        <button
          type="button"
          onClick={onStartFromTemplate}
          className={cn(
            "press mt-2 inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium",
            "text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground",
          )}
        >
          <LayoutTemplate className="size-3.5" aria-hidden />
          {t.landing.startFromTemplate}
        </button>
      </section>

      {/* ── Recents ──────────────────────────────────────────── */}
      {cards.length > 0 ? (
        <section>
          <div className="mb-3 flex items-center gap-2 px-0.5">
            <Clock3 className="size-3.5 text-muted-foreground" aria-hidden />
            <h2 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {t.landing.recentsTitle}
            </h2>
            <span className="hairline ml-1 h-px flex-1" aria-hidden />
          </div>
          <div className="animate-stagger grid grid-cols-1 gap-2.5 sm:grid-cols-2">
            {cards.map((row) => (
              <RecentCard
                key={row.id}
                row={row}
                untitled={t.breadcrumbUntitled}
                onOpen={onOpenCard}
              />
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function RecentCard({
  row,
  untitled,
  onOpen,
}: {
  row: ViewListRow;
  untitled: string;
  onOpen: (id: string) => void;
}) {
  const Glyph = derivePageIcon({
    entity: row.entity,
    viewType: row.viewType,
    nameOrigin: row.nameOrigin,
  });
  const name = row.name.trim() || untitled;
  return (
    <button
      type="button"
      onClick={() => onOpen(row.id)}
      title={name}
      className={cn(
        "hover-lift press group flex items-center gap-3 rounded-xl border border-border bg-card px-3.5 py-3 text-left",
        "hover:border-muted-foreground/25",
      )}
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted/60 text-base ring-1 ring-border/60">
        <PageIcon
          icon={row.icon}
          fallback={Glyph}
          emojiClassName="leading-none"
          glyphClassName="size-4 text-muted-foreground"
          imgClassName="size-5 rounded-[4px] object-cover"
        />
      </span>
      <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
        {name}
      </span>
      <ArrowUpRight
        className="size-4 shrink-0 text-transparent transition-colors group-hover:text-muted-foreground"
        aria-hidden
      />
    </button>
  );
}
