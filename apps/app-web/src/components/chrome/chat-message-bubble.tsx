"use client";

/**
 * One chat message row, shared by every Brian conversation surface: the
 * floating dock and the Office file rail. An assistant reply is avatar plus
 * prose with its collapsed activity receipt above the text; a user message is
 * the neutral right-aligned bubble. `mapSessionRows` restores persisted
 * session rows into the same shape the live stream builds.
 *
 * Extracted from `floating-chat.tsx` so the rail reuses it rather than copying
 * it (docs/architecture/features/office.md -> "Brian conversation in the file").
 * [COMP:app-web/floating-chat]
 */
import { useMemo, type ReactNode } from "react";
import remarkGfm from "remark-gfm";
import { ArrowRight, Check, Copy, RotateCw, Sparkles } from "lucide-react";
import { ChatMarkdown, type Message } from "@use-brian/chat-ui";
import { cn } from "@/lib/utils";
import { docPagePath, pageIdFromInAppHref } from "@/lib/doc-page-url";
import { AssistantAvatar } from "@/components/assistant-avatar";
import { ChatFileAttachments } from "@/components/chrome/chat-file-attachment";
import { ChatCodeBlock } from "@/components/chrome/chat-code-block";
import { ChatActivitySummary, ChatCitationList } from "@/components/chrome/chat-activity";
import { MessageAttachments } from "@/components/doc/message-attachment-card";
import type { WorkspaceAssistantSummary } from "@/lib/api/views";
import type { NarrationDict } from "@/lib/tool-narration";
import { extractMessageText, fetchSessionMessages, parseMessageAttachments, type MessageAttachmentRef } from "@/lib/api/sessions";
import { collectToolResults, restoreAssistantActivity } from "@/lib/activity-receipt";
import { coalesceAssistantRunMessages } from "@/components/chat-app/chat-transcript";

export type ViewAttachment = {
  toolUseId: string;
  payload: unknown;
  entity?: string;
  viewType?: string;
  viewId?: string;
  /** Whether the call appended to an existing draft or created a new one. */
  action?: "appended" | "created";
};

/** Extends chat-ui's Message with the per-message view list. */
export type MessageWithViews = Message & {
  views?: ViewAttachment[];
  /**
   * The ANSWERING assistant for this reply (multi-voice doc thread /
   * migration 390's `sender_assistant_id`). Restored rows carry the
   * persisted stamp; live turns stamp the addressed assistant at send time.
   * Null/absent on human rows and pre-390 history — those render as the
   * active assistant.
   */
  senderAssistantId?: string | null;
  /**
   * The user's OWN uploaded attachments (pasted screenshots, picked/dropped
   * files), shown as thumbnail/file cards on their message bubble. On the live
   * send path these carry object-URL previews handed off from the composer
   * tray; on session restore they carry base64 thumbnails parsed from the
   * persisted `<attached_file>` blocks. Distinct from `fileAttachments`, which
   * are the assistant's outbound `sendFile` download cards.
   */
  userAttachments?: MessageAttachmentRef[];
  /** Who sent a user row, for shared threads where several people write. */
  senderUserId?: string | null;
  senderName?: string;
};

export function mapSessionRows(
  rows: Awaited<ReturnType<typeof fetchSessionMessages>>,
  narration: NarrationDict,
  coalesce = true,
): MessageWithViews[] {
  // Each call's outcome lives on the tool_result carrier row the transcript
  // never renders — index them once so a failed call restores as `retried`.
  const outcomes = collectToolResults(rows);
  const mapped = rows
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m): MessageWithViews => {
      const { toolsUsed, activityNotes } =
        m.role === "assistant"
          ? restoreAssistantActivity(m.content, outcomes, narration, m.id)
          : { toolsUsed: [], activityNotes: [] };
      // User rows: split the persisted body into clean text + structured
      // attachment refs (base64 image thumbnails), so a restored message shows
      // the same thumbnail cards as the live send — not the "📎 filename"
      // placeholder `extractMessageText` leaves behind.
      const parsedUser =
        m.role === "user" ? parseMessageAttachments(m.content) : null;
      return {
        id: m.id,
        role: m.role as "user" | "assistant",
        // Strip `<followup>` from restored assistant rows — pre-fix history may
        // carry the volunteered tag (the server now strips before persist).
        text:
          m.role === "assistant"
            ? stripFollowUps(extractMessageText(m.content))
            : (parsedUser?.text ?? extractMessageText(m.content)),
        timestamp: new Date(m.timestamp),
        ...(m.role === "user" ? { senderUserId: m.senderUserId, ...(m.senderName ? { senderName: m.senderName } : {}) } : {}),
        ...(m.role === "assistant" && m.senderAssistantId
          ? { senderAssistantId: m.senderAssistantId }
          : {}),
        ...(toolsUsed.length > 0 ? { toolsUsed } : {}),
        ...(activityNotes.length > 0 ? { activityNotes } : {}),
        ...(m.attachments && m.attachments.length > 0
          ? { fileAttachments: m.attachments }
          : {}),
        ...(parsedUser && parsedUser.attachments.length > 0
          ? { userAttachments: parsedUser.attachments }
          : {}),
      };
    })
    .filter(
      (m) =>
        m.text.trim().length > 0 ||
        m.toolsUsed?.length ||
        m.fileAttachments?.length ||
        m.userAttachments?.length,
    );
  // One assistant row per query-loop round in storage; one reply per run on
  // screen (the Chat app's fold, so a multi-step run keeps one receipt).
  return coalesce ? coalesceAssistantRunMessages(mapped) : mapped;
}

/**
 * Remove any `<followup>[...]</followup>` chip tag from assistant text.
 * Doc is an `app` surface with no chip affordance, so the tag must never
 * render. Mirrors `stripFollowUps` in `@use-brian/shared` (kept inline to
 * avoid pulling the shared barrel into the browser bundle — the same reason
 * `apps/web` inlines its own copy). Also drops a trailing malformed opener so
 * a half-streamed tag can't survive.
 */
export function stripFollowUps(text: string): string {
  return text
    .replace(/<followup>\s*\[[\s\S]*?\]\s*<\/followup>/g, "")
    .replace(/<followup[\s\S]*$/, "")
    .trimEnd();
}

function ChatPageLink({
  href,
  children,
  workspaceId,
  onOpenPage,
}: React.AnchorHTMLAttributes<HTMLAnchorElement> & {
  workspaceId: string;
  onOpenPage: (pageId: string) => void;
}) {
  const pageId = pageIdFromInAppHref(href);
  if (pageId) {
    return (
      <a
        href={docPagePath(workspaceId, pageId)}
        onClick={(e) => {
          e.preventDefault();
          onOpenPage(pageId);
        }}
      >
        {children}
      </a>
    );
  }
  if (href && /^https?:\/\//i.test(href)) {
    return (
      <a href={href} target="_blank" rel="noreferrer">
        {children}
      </a>
    );
  }
  if (href) return <a href={href}>{children}</a>;
  return <>{children}</>;
}

const CHAT_REMARK_PLUGINS = [remarkGfm];

/**
 * `ChatMarkdown` with in-app page links wired up (see {@link ChatPageLink}).
 * Used for both finalised assistant messages and the live streaming buffer so
 * a page reference is clickable the moment it renders.
 */
export function ChatMarkdownWithLinks({
  text,
  workspaceId,
  onOpenPage,
}: {
  text: string;
  workspaceId: string;
  onOpenPage: (pageId: string) => void;
}) {
  const components = useMemo(
    () => ({
      a: (props: React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
        <ChatPageLink {...props} workspaceId={workspaceId} onOpenPage={onOpenPage} />
      ),
      // Fenced code blocks carry a one-click copy affordance.
      pre: ChatCodeBlock,
    }),
    [workspaceId, onOpenPage],
  );
  return <ChatMarkdown text={text} components={components} remarkPlugins={CHAT_REMARK_PLUGINS} />;
}

export function MessageBubble({
  message,
  assistant,
  workspaceId,
  openInDocLabel,
  appendedLabel,
  createdLabel,
  onOpenInDoc,
  onRetry,
  onRetryUser,
  onCopy,
  copied,
  retryLabel,
  copyLabel,
  copiedLabel,
  citationLabel,
  senderLabel,
  extras,
}: {
  message: MessageWithViews;
  // The voice whose avatar fronts THIS assistant reply — resolved per
  // message from `senderAssistantId` (the doc thread is per-turn
  // addressable, so one loaded conversation can carry several assistants'
  // replies), falling back to the active assistant for unstamped rows.
  // `null` before any identity resolves — the avatar degrades to the
  // generic glyph.
  assistant: Pick<WorkspaceAssistantSummary, "id" | "name" | "iconSeed"> | null;
  workspaceId: string;
  openInDocLabel: string;
  appendedLabel: string;
  createdLabel: string;
  onOpenInDoc: (viewId: string) => void;
  onRetry: (assistantMessageId: string) => void;
  onRetryUser: (userMessageId: string) => void;
  onCopy: (messageId: string, text: string) => void;
  copied: boolean;
  retryLabel: string;
  copyLabel: string;
  copiedLabel: string;
  citationLabel: string;
  /** Shared threads: the name shown above a teammate's message. */
  senderLabel?: string | null;
  /** Rendered after an assistant reply's text (e.g. the Office edit card). */
  extras?: ReactNode;
}) {
  if (message.role === "user") {
    return (
      <div className="group flex flex-col items-end">
        {senderLabel ? <span className="mb-0.5 px-1 text-[11px] text-muted-foreground">{senderLabel}</span> : null}
        {/* Neutral Notion-style bubble — a calm elevated `--secondary` surface,
            NOT a saturated `--primary` fill. The brand blue is reserved for the
            small accents (sparkle/spinner); a full-blue bubble was the loudest,
            least-cohesive element on the dark theme and white-on-blue missed
            WCAG AA (≈3.9:1). `--secondary` reads ~9:1 in both modes. */}
        {message.text ? (
          <div className="max-w-[85%] rounded-2xl rounded-br-md bg-secondary px-3.5 py-2 text-[14px] leading-[1.5] text-secondary-foreground shadow-sm break-words whitespace-pre-wrap">
            {message.text}
          </div>
        ) : null}
        {/* The user's own uploaded attachments (pasted images / picked files) —
            image thumbnails or file cards, right-aligned under the bubble. */}
        {message.userAttachments?.length ? (
          <div className="w-full max-w-[280px]">
            <MessageAttachments attachments={message.userAttachments} workspaceId={workspaceId} />
          </div>
        ) : null}
        {message.text ? (
          <div className="flex items-center gap-1 -mr-1 pt-0.5 opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity">
            <IconActionButton
              tooltip={copied ? copiedLabel : copyLabel}
              onClick={() => onCopy(message.id, message.text)}
            >
              {copied ? (
                <Check className="size-3.5" aria-hidden />
              ) : (
                <Copy className="size-3.5" aria-hidden />
              )}
            </IconActionButton>
            <IconActionButton
              tooltip={retryLabel}
              onClick={() => onRetryUser(message.id)}
            >
              <RotateCw className="size-3.5" aria-hidden />
            </IconActionButton>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="group flex gap-2.5">
      {assistant ? (
        <div className="mt-0.5 shrink-0">
          <AssistantAvatar
            id={assistant.id}
            name={assistant.name}
            iconSeed={assistant.iconSeed ?? undefined}
            size="sm"
          />
        </div>
      ) : (
        <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary ring-1 ring-primary/15">
          <Sparkles className="size-3.5" aria-hidden />
        </div>
      )}
      <div className="flex-1 min-w-0 pt-0.5 space-y-2.5">
        {message.toolsUsed?.length ? (
          <ChatActivitySummary
            tools={message.toolsUsed}
            notes={message.activityNotes}
            reasoning={message.activityReasoning}
            durationMs={message.activityDurationMs}
          />
        ) : null}
        {message.text ? (
          <div className="chat-markdown prose prose-sm dark:prose-invert max-w-none text-[14px] leading-[1.6] text-foreground break-words">
            <ChatMarkdownWithLinks
              text={message.text}
              workspaceId={workspaceId}
              onOpenPage={onOpenInDoc}
            />
          </div>
        ) : null}
        {message.views?.length ? (
          <div className="space-y-2">
            {message.views.map((view) => (
              <ViewBlock
                key={view.toolUseId}
                view={view}
                openInDocLabel={openInDocLabel}
                appendedLabel={appendedLabel}
                createdLabel={createdLabel}
                onOpenInDoc={onOpenInDoc}
              />
            ))}
          </div>
        ) : null}
        {extras}
        {message.fileAttachments?.length ? (
          <ChatFileAttachments attachments={message.fileAttachments} />
        ) : null}
        {message.citations && message.citations.length > 0 ? (
          <ChatCitationList citations={message.citations} label={citationLabel} />
        ) : null}
        {message.text ? (
          <div className="flex items-center gap-1 -ml-1 pt-0.5 opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity">
            <IconActionButton
              tooltip={copied ? copiedLabel : copyLabel}
              onClick={() => onCopy(message.id, message.text)}
            >
              {copied ? (
                <Check className="size-3.5" aria-hidden />
              ) : (
                <Copy className="size-3.5" aria-hidden />
              )}
            </IconActionButton>
            <IconActionButton
              tooltip={retryLabel}
              onClick={() => onRetry(message.id)}
            >
              <RotateCw className="size-3.5" aria-hidden />
            </IconActionButton>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** Small icon button with hover tooltip. */
function IconActionButton({
  tooltip,
  onClick,
  children,
}: {
  tooltip: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <div className="relative group/btn">
      <button
        type="button"
        onClick={onClick}
        // The tooltip is hover-only, so the accessible name and the native
        // title carry the label on touch (responsive contract M2); 36px
        // targets below `md` (M3).
        aria-label={tooltip}
        title={tooltip}
        className="inline-flex size-9 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground transition-colors md:size-7"
      >
        {children}
      </button>
      <div
        role="tooltip"
        className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 px-2 py-0.5 text-[10px] font-medium rounded bg-foreground text-background whitespace-nowrap max-md:hidden md:opacity-0 md:group-hover/btn:opacity-100 pointer-events-none transition-opacity shadow-md"
      >
        {tooltip}
      </div>
    </div>
  );
}

/**
 * Confirmation pill for a `renderView` action. The widget itself never
 * inline-renders in chat — doc is a draft-first surface, so the
 * model speaks and the page renders. The pill states the entity that
 * was rendered + whether the call appended to the current draft or
 * created a new one. Click navigates to the draft.
 */
function ViewBlock({
  view,
  openInDocLabel,
  appendedLabel,
  createdLabel,
  onOpenInDoc,
}: {
  view: ViewAttachment;
  openInDocLabel: string;
  appendedLabel: string;
  createdLabel: string;
  onOpenInDoc: (viewId: string) => void;
}): ReactNode {
  if (!view.viewId) return null;
  const entityLabel =
    view.entity && view.viewType
      ? `${view.entity}/${view.viewType}`
      : view.entity ?? "view";
  const actionLabel =
    view.action === "appended" ? appendedLabel : createdLabel;
  return (
    <button
      type="button"
      onClick={() => onOpenInDoc(view.viewId!)}
      className={cn(
        "inline-flex items-center gap-2 rounded-md border border-border bg-background",
        "px-2.5 py-1.5 text-xs transition-colors",
        "hover:bg-muted",
      )}
      title={openInDocLabel}
    >
      <Sparkles className="size-3.5 text-primary shrink-0" aria-hidden />
      <span className="font-medium text-foreground">{entityLabel}</span>
      <span className="text-muted-foreground">·</span>
      <span className="text-muted-foreground">{actionLabel}</span>
      <ArrowRight className="size-3 text-muted-foreground" aria-hidden />
    </button>
  );
}

