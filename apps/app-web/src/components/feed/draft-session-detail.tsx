"use client";

/**
 * Draft-session detail — the per-draft refine surface, ported faithfully
 * (whole, one file, no logic refactors) from
 * `apps/feed-web/src/app/w/[workspaceId]/[platform]/draft-sessions/[sessionId]/page.tsx`
 * (docs/plans/feed-web-consolidation.md §7.4 — the plan's highest-risk file).
 *
 * Streaming refine chat over `POST /api/chat` (fetch-stream, INLINE — not in
 * the RPC SDK), the live session SSE (`GET .../:sessionId/stream`, INLINE)
 * with reconnect-with-since + presence + typing, the proposeDrafts cardboard,
 * the inline SavedDraftsPanel (approve / reject / delete-published), the
 * post-intent References stockpile, and the reply-intent parent-post tile.
 *
 * Port deltas (disposition rules §6):
 *   - `useWorkspaceContext()` → `useFeedWorkspace()`; `WorkspaceProfile` →
 *     `FeedProfile`; hrefs via `feedPath()`.
 *   - Simple RPCs → the feed SDK (`fetchFeedDraftSessions`,
 *     `fetchFeedSavedDrafts`, `saveFeedSessionDraft`, `approveFeedDraft`,
 *     `rejectFeedDraft`, `deleteFeedPublishedPost`,
 *     `removeFeedSavedDraftRecord`, `deleteFeedDraftSession`,
 *     `sendFeedDraftTypingPing`). Open-route calls the SDK doesn't cover
 *     (`/api/sessions/:id/messages`, `PATCH /api/sessions/:id`,
 *     `/api/workspaces/:id`) stay inline `authFetch`, as do both streams.
 *   - feed-web's `useConfirm().confirm/confirmAsync` → the app-root
 *     `confirmDialog()`; `chooseAsync` (delete-published three-way) → the
 *     feed-scoped `useChoiceDialog()`.
 *   - `describeFeedTool` now takes the `toolTimeline` dictionary as its
 *     first argument (i18n extraction; see `tool-timeline.tsx`).
 *   - All copy via `useT().feedPage` (`draftSessions` + shared
 *     `platformLabels` / `postEmbed` / `tuningChat` / `sections` keys).
 *
 * [COMP:app-web/feed-draft-sessions]
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { ChatMarkdown } from "@use-brian/chat-ui";
import { Check, Copy, Pencil, RotateCcw, Square, Trash2 } from "lucide-react";
import { useFeedWorkspace } from "@/contexts/feed-profiles-context";
import { authFetch } from "@/lib/auth-fetch";
import { BackButton } from "@/components/ui/back-button";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { useChoiceDialog } from "@/components/feed/feed-choice-dialog";
import { NativeEmbed } from "@/components/feed/native-post-embed";
import { AssistantAvatar } from "@/components/assistant-avatar";
import {
  ToolTimeline,
  type ToolEntry,
  describeFeedTool,
} from "@/components/feed/tool-timeline";
import {
  approveFeedDraft,
  deleteFeedDraftSession,
  deleteFeedPublishedPost,
  fetchFeedDraftSessions,
  fetchFeedSavedDrafts,
  rejectFeedDraft,
  removeFeedSavedDraftRecord,
  saveFeedSessionDraft,
  sendFeedDraftTypingPing,
  type FeedDraftSeedKind,
  type FeedSavedDraft,
  type FeedSavedDraftStatus,
} from "@/lib/api/feed";
import { feedPath, type FeedPlatform } from "@/lib/feed-nav";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n/format";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

type FeedPageDict = ReturnType<typeof useT>["feedPage"];
type DraftSessionsDict = FeedPageDict["draftSessions"];

// ── Types ──────────────────────────────────────────────────────

type Message = {
  id: string;
  role: "user" | "assistant";
  text: string;
  timestamp: Date;
  /** Per-message author for team-shared draft sessions. Null for assistant
   *  rows and pre-migration-101 user rows. */
  senderUserId?: string | null;
  /** sequence_num — used as the reconnect cursor for the live SSE. */
  sequenceNum?: number;
};

type StoredMessage = {
  id: string;
  role: string;
  content: unknown;
  timestamp: string;
  senderUserId?: string | null;
  sequenceNum?: number;
};

type ViewerPresence = {
  userId: string;
  name: string | null;
  isTyping: boolean;
  lastSeen: string;
};

type StartedByApi = { id: string; name: string | null };

type SeedCandidate = {
  authorHandle: string;
  text: string;
  externalId?: string;
  permalink?: string;
  mediaUrl?: string;
  /** Where the candidate came from — drives the small caption above the
   *  "Replying to" tile so the operator knows whether it came from the
   *  Inspiration handoff (seed message) or a URL pasted in chat. */
  source?: "inspiration" | "url";
};

type DraftAlternative = {
  text: string;
  label?: string;
};

/** Operator-friendly explanation of why a Threads URL-paste failed to
 *  decode. Only `invalid_shortcode` reaches the client now; kept as a
 *  function so future failure modes get one canonical place to describe
 *  themselves. */
// exported for tests
export function explainResolveFailure(
  t: DraftSessionsDict,
  reason: string,
): string {
  switch (reason) {
    case "invalid_shortcode":
      return t.resolveInvalidShortcode;
    default:
      return t.resolveDefault;
  }
}

type ProposeDraftsInput = {
  rationale: string;
  drafts: Array<{ index: number; text: string; label?: string }>;
};

type SSEEvent = { event: string; data: string };

const PROPOSE_DRAFTS_TOOL = "proposeDrafts";

/**
 * Apply a proposeDrafts tool input to a draft map. Upsert semantics: each
 * supplied index either inserts or replaces; unmentioned indices stay.
 * Returns a new Map (immutable update — React reference equality).
 */
// exported for tests
export function applyProposeDrafts(
  prev: Map<number, DraftAlternative>,
  input: ProposeDraftsInput,
): Map<number, DraftAlternative> {
  const next = new Map(prev);
  for (const d of input.drafts) {
    next.set(d.index, { text: d.text, label: d.label });
  }
  return next;
}

/**
 * Validate an arbitrary value as a proposeDrafts input. Defends against
 * malformed tool calls (which would crash the cardboard) and partial
 * payloads (drafts mid-stream still being assembled).
 */
// exported for tests
export function parseProposeDraftsInput(raw: unknown): ProposeDraftsInput | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  const rationale = typeof obj.rationale === "string" ? obj.rationale : "";
  const drafts = Array.isArray(obj.drafts) ? obj.drafts : null;
  if (!drafts || drafts.length === 0) return null;
  const out: ProposeDraftsInput["drafts"] = [];
  for (const d of drafts) {
    if (!d || typeof d !== "object") continue;
    const item = d as Record<string, unknown>;
    const index = typeof item.index === "number" && Number.isInteger(item.index) ? item.index : null;
    const text = typeof item.text === "string" ? item.text : null;
    if (index == null || index < 1 || !text) continue;
    out.push({
      index,
      text,
      label: typeof item.label === "string" ? item.label : undefined,
    });
  }
  if (out.length === 0) return null;
  return { rationale, drafts: out };
}

/**
 * Walk the persisted message history looking for `tool_use` content blocks
 * with name=`proposeDrafts`, applying each one's upsert in order. Returns
 * the final draft map and the most recent rationale.
 */
// exported for tests
export function replayDraftHistory(
  rows: StoredMessage[],
): { draftMap: Map<number, DraftAlternative>; rationale: string } {
  let draftMap = new Map<number, DraftAlternative>();
  let rationale = "";
  for (const row of rows) {
    if (row.role !== "assistant" || !Array.isArray(row.content)) continue;
    for (const block of row.content) {
      if (typeof block !== "object" || block === null) continue;
      const b = block as { type?: string; name?: string; input?: unknown };
      if (b.type !== "tool_use" || b.name !== PROPOSE_DRAFTS_TOOL) continue;
      const input = parseProposeDraftsInput(b.input);
      if (!input) continue;
      draftMap = applyProposeDrafts(draftMap, input);
      if (input.rationale) rationale = input.rationale;
    }
  }
  return { draftMap, rationale };
}

// ── SSE parser (apps/web pattern) ──────────────────────────────

// exported for tests
export function* parseSSEStream(
  chunk: string,
  buffer: { text: string },
): Generator<SSEEvent> {
  buffer.text += chunk;
  const parts = buffer.text.split("\n\n");
  buffer.text = parts.pop() ?? "";
  for (const part of parts) {
    let event = "message";
    let data = "";
    for (const line of part.split("\n")) {
      if (line.startsWith("event: ")) event = line.slice(7);
      else if (line.startsWith("data: ")) data = line.slice(6);
    }
    if (data) yield { event, data };
  }
}

// ── Content helpers ────────────────────────────────────────────

// exported for tests
export function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (typeof block !== "object" || block === null) return "";
      const b = block as { type?: string; text?: string };
      if (b.type === "text" && typeof b.text === "string") return b.text;
      if (b.type === "image") return "[image]";
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * Compute the chat-bubble text for an assistant message. Tool-only turns
 * (only a `proposeDrafts` tool_use block, no text) intentionally return ""
 * — the cardboard already renders the tool's rationale as a muted caption
 * above the draft cards, so emitting the same rationale as a chat bubble
 * produced two near-identical bubbles per turn (the rationale plus the
 * model's follow-up text that restates it). The empty return is filtered
 * out by both the history load and the SSE path so no bubble is shown.
 */
function assistantContentToText(content: unknown): string {
  return contentToText(content);
}

/**
 * The seeded first user message has a stable shape (see seedFirstMessage in
 * draft-session-store.ts). Pull the candidate handle and quoted text back
 * out so the cardboard can render the original post without a separate fetch.
 *
 * Patterns:
 *   "I want to draft a reply to this {Threads|X} post by @handle:\n\n> text\n\nPlease draft..."
 *   "Here's a {Threads|X} post that caught my eye, by @handle:\n\n> text\n\nUse it..."
 */
// exported for tests
export function parseSeedFromFirstMessage(text: string): SeedCandidate | null {
  const m = text.match(/by @([\w.\-]+):\n\n>\s*([\s\S]+?)(?:\n\nPlease draft|\n\nUse it|$)/);
  if (!m) return null;
  return { authorHandle: m[1], text: m[2].trim(), source: "inspiration" };
}

// ── Pasted post URLs ───────────────────────────────────────────
//
// When the operator types "Draft on this: https://www.threads.com/…" we
// scan their messages for a Threads/X post URL so the cardboard can show
// the original post on the right. The matching here mirrors `parsePostUrl`
// on the backend; we keep it duplicated rather than building a shared
// client package because the rule is small and changes rarely.

const POST_URL_PATTERN =
  /https?:\/\/(?:www\.|mobile\.)?(?:threads\.(?:com|net)|x\.com|twitter\.com)\/[^\s<>"]+/gi;

type ParsedPostUrl =
  | { platform: "threads"; handle: string; shortcode: string; permalink: string }
  | { platform: "twitter"; handle: string; statusId: string; permalink: string };

/**
 * Parse a single Threads/X post URL into a structured handle. Mirrors the
 * backend `parsePostUrl` from `packages/api/src/feed/post-url-parser.ts` —
 * we duplicate it here rather than building a shared client package because
 * the rule is small and changes rarely.
 */
// exported for tests
export function parsePostUrl(input: string): ParsedPostUrl | null {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return null;
  }
  const host = u.hostname.toLowerCase();
  const parts = u.pathname.split("/").filter(Boolean);
  const isThreads = /(?:^|\.)threads\.(?:com|net)$/i.test(host);
  const isX = /(?:^|\.)(?:x|twitter)\.com$/i.test(host);
  if (isThreads && parts.length >= 3 && parts[0].startsWith("@") && parts[1] === "post") {
    return {
      platform: "threads",
      handle: parts[0].slice(1),
      shortcode: parts[2],
      permalink: `https://www.threads.com/${parts[0]}/post/${parts[2]}`,
    };
  }
  if (isX) {
    const idx = parts.indexOf("status");
    if (idx >= 1 && /^\d+$/.test(parts[idx + 1] ?? "")) {
      return {
        platform: "twitter",
        handle: parts[idx - 1],
        statusId: parts[idx + 1],
        permalink: `https://x.com/${parts[idx - 1]}/status/${parts[idx + 1]}`,
      };
    }
  }
  return null;
}

/**
 * Scan a free-form message body for the first recognisable post URL.
 * Trailing punctuation commonly attached to URLs in chat ("…on this: https://…!")
 * is stripped. Returns the parsed handle (or null).
 */
// exported for tests
export function findParsedPostUrl(text: string): ParsedPostUrl | null {
  const matches = text.match(POST_URL_PATTERN);
  if (!matches) return null;
  for (const raw of matches) {
    const cleaned = raw.replace(/[.,;:!?)\]}>'"]+$/g, "");
    const parsed = parsePostUrl(cleaned);
    if (parsed) return parsed;
  }
  return null;
}

// ── Page ───────────────────────────────────────────────────────

export function DraftSessionDetail() {
  const params = useParams<{ workspaceId: string; platform: string; sessionId: string }>();
  const router = useRouter();
  const searchParams = useSearchParams();
  const team = useFeedWorkspace();
  const t = useT().feedPage;
  const td = t.draftSessions;
  const tt = t.toolTimeline;
  const platform = params.platform as FeedPlatform;
  // A workspace can hold several accounts on one platform (each its own
  // assistant). The create flow threads the owning account through as
  // `?account=<assistantId>` so every assistant-scoped call below (stream,
  // save-draft, approve) targets the session's real account instead of
  // silently re-resolving the first profile of the platform. Falls back to
  // first-of-platform for legacy links that predate the param.
  const accountId = searchParams.get("account");
  const profile =
    (accountId
      ? team.profiles.find((p) => p.assistantId === accountId)
      : undefined) ?? team.profiles.find((p) => p.platform === platform);
  const platformLabel = t.platformLabels[platform];
  const isAdmin = team.role === "admin" || team.role === "owner";
  // Draft-app interaction (save / approve / reject) — admin/owner OR a
  // member with `workspace_members.can_draft=true`. Title rename + discard
  // remain admin-or-creator (see canRenameTitle below).
  const canDraft = team.canDraft;
  const { chooseAsync, dialog: choiceDialog } = useChoiceDialog();

  // Direct useState — no chat-ui hooks. Avoids the session/set reducer
  // that wipes messages on every server `session` event (and avoids the
  // "fresh object on every render → infinite useEffect loop" trap).
  const [messages, setMessages] = useState<Message[]>([]);
  const [streamingText, setStreamingText] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  // Live tool timeline for the producer's current turn. Reset on every send;
  // populated from the chat-route SSE's tool_start / tool_input / tool_result
  // events. Watchers don't get these (the bus only forwards tool_input) so
  // their concurrent-turn indicator stands in for it.
  const [toolTimeline, setToolTimeline] = useState<ToolEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [seed, setSeed] = useState<SeedCandidate | null>(null);
  // Persisted seed.kind from the backend (migration 107). Drives the
  // hero/reply-tile layout switch directly — no first-message text
  // re-derivation. `null` for legacy pre-107 rows; the back-compat path
  // falls through to `seed`-source-driven inference. Filled in by the
  // list-fetch effect that already populates `startedBy`.
  const [seedKind, setSeedKind] = useState<FeedDraftSeedKind | null>(null);
  // Threads-only "topic tag" the operator selected on the post-intent
  // hero composer. Forwarded with each save-draft body so the approve
  // handler can pass it to `threadsApi.createPost({ text, topicTag })`.
  // Empty string == no tag selected. Reply-intent sessions never surface
  // this control, so the field is unused there.
  const [topicTag, setTopicTag] = useState<string>("");
  const [topicTagDraft, setTopicTagDraft] = useState<string>("");
  const [isEditingTopic, setIsEditingTopic] = useState(false);
  // References stockpile — every Threads/X post URL the operator pastes
  // into the chat after creation, deduped by permalink, in order of
  // first appearance. Only surfaced for post-intent sessions (the hero
  // is the original draft, references are creative inspiration). On
  // reply-intent sessions the parent-post tile is already pinned and
  // additional URL pastes are ignored for surfacing here.
  const [references, setReferences] = useState<ParsedPostUrl[]>([]);
  // Active reference index — which one of `references` the operator is
  // viewing. Defaults to the most recently added so a paste lands the
  // user on the new card automatically.
  const [activeReferenceIdx, setActiveReferenceIdx] = useState<number>(0);
  // Cardboard state: indices → draft. Upserts via proposeDrafts tool calls.
  // Replayed from session_messages on load; live-updated from SSE tool_input
  // events during a turn.
  const [draftMap, setDraftMap] = useState<Map<number, DraftAlternative>>(new Map());
  // Latest rationale string from a proposeDrafts call — shown as muted
  // caption above the cards.
  const [rationale, setRationale] = useState("");
  // Index of the alternative currently being saved (for per-card loading
  // state). `null` = no save in flight.
  const [savingIndex, setSavingIndex] = useState<number | null>(null);
  // Indices that have been saved to /drafts review (this session lifetime).
  // Reset only when the underlying draft text at that index changes.
  const [savedIndices, setSavedIndices] = useState<Set<number>>(new Set());
  // Inline notice rendered after a save when the backend's reply-target
  // resolver succeeded (cardboard tile is real reply target) or failed
  // (saved as a fresh thread; explain why). Cleared on the next save
  // attempt so stale notices never linger past their relevant action.
  const [replyNotice, setReplyNotice] = useState<{
    kind: "success" | "warning";
    message: string;
  } | null>(null);
  // Saved drafts the team has promoted from this session, with their
  // resolution status (pending/posted/rejected/expired/superseded).
  // Loaded from /draft-sessions/:id/saved-drafts on mount and refreshed
  // after every save-as-draft / approve / reject action so the inline
  // review panel stays in sync.
  const [savedDrafts, setSavedDrafts] = useState<FeedSavedDraft[]>([]);
  // Per-saved-draft inline action state: which one is being approved/rejected,
  // and which one is in inline-edit mode.
  const [actingOnDraftId, setActingOnDraftId] = useState<string | null>(null);
  const [editingDraftId, setEditingDraftId] = useState<string | null>(null);
  const [editingDraftText, setEditingDraftText] = useState("");
  // Carousel position for the draft alternatives (0-based slide index).
  // Derived from scroll position via the snap-scroll handler.
  const [activeSlide, setActiveSlide] = useState(0);
  // Inline-edit state for user messages — mirrors the apps/web chat UX.
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const [editingMessageText, setEditingMessageText] = useState("");
  // Per-message copy-to-clipboard flash. Reset 1.5s after each copy.
  const [copiedMessageId, setCopiedMessageId] = useState<string | null>(null);

  const sessionIdRef = useRef<string | null>(params.sessionId);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const carouselRef = useRef<HTMLUListElement>(null);
  // Snapshot of message ids present after the initial history load. Any
  // message id NOT in this set is "new since mount" and gets a rise-in
  // animation when it appears in the thread. Null until history settles.
  const initialMessageIdsRef = useRef<Set<string> | null>(null);

  // ── Team-shared collaboration state ────────────────────────────
  // Started by — the original creator of the session, surfaced from the
  // list API on first load. Falls back to "unknown" until the fetch lands.
  const [startedBy, setStartedBy] = useState<StartedByApi | null>(null);
  // Editable session title — admins/owners or the original starter can rename.
  const [title, setTitle] = useState<string | null>(null);
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [titleSaving, setTitleSaving] = useState(false);
  // Current viewers + typing state, driven by the SSE `presence` events.
  const [presence, setPresence] = useState<ViewerPresence[]>([]);
  // userId of a teammate who has a turn in flight in this session, derived
  // from `turn_started`/`turn_completed` events. Null when no foreign turn.
  const [activeOtherTurnUser, setActiveOtherTurnUser] = useState<string | null>(null);
  // Cursor for SSE reconnect. Bumped whenever a higher sequenceNum is seen.
  const lastSequenceRef = useRef<number>(0);
  // Stable bag of team-member display names, fetched once on mount and
  // used to attribute messages without a per-message lookup.
  const [memberNames, setMemberNames] = useState<Map<string, string | null>>(new Map());
  // Set of message ids we've already committed to local state — guards
  // against duplicate apply when the chat-route SSE and the live bus
  // both deliver our own turn's events.
  const seenMessageIdsRef = useRef<Set<string>>(new Set());
  const meId = team.me.id;

  function bumpLastSequence(n: number | undefined): void {
    if (typeof n === "number" && n > lastSequenceRef.current) {
      lastSequenceRef.current = n;
    }
  }

  // Keep sessionIdRef synced when the URL changes (route navigation).
  useEffect(() => {
    sessionIdRef.current = params.sessionId;
  }, [params.sessionId]);

  // Load history exactly once per sessionId.
  const loadConversationFailedCopy = td.loadConversationFailed;
  const loadFailedCopy = td.loadFailed;
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setHistoryLoading(true);
      setError(null);
      try {
        const res = await authFetch(`${API_URL}/api/sessions/${params.sessionId}/messages`);
        if (!res.ok) throw new Error(loadConversationFailedCopy);
        const rows = (await res.json()) as StoredMessage[];
        if (cancelled) return;
        const parsed: Message[] = rows
          .filter((r) => r.role === "user" || r.role === "assistant")
          .map((r) => ({
            id: r.id,
            role: r.role as "user" | "assistant",
            text:
              r.role === "assistant"
                ? assistantContentToText(r.content)
                : contentToText(r.content),
            timestamp: new Date(r.timestamp),
            senderUserId: r.senderUserId ?? null,
            sequenceNum: r.sequenceNum,
          }))
          .filter((m) => m.text.length > 0);
        setMessages(parsed);
        // Seed the seen-id set + reconnect cursor with the loaded history
        // so SSE replays don't double-apply and live messages bump the
        // cursor naturally.
        seenMessageIdsRef.current = new Set(parsed.map((m) => m.id));
        // Snapshot the initial set so the UI can tell "history mount" from
        // "live append" and only animate the latter — without this, every
        // historical message would rise-in on first paint.
        initialMessageIdsRef.current = new Set(parsed.map((m) => m.id));
        const maxSeq = parsed.reduce(
          (acc, m) => (typeof m.sequenceNum === "number" && m.sequenceNum > acc ? m.sequenceNum : acc),
          0,
        );
        lastSequenceRef.current = maxSeq;
        // Derive the inspiration seed from the first user message if present.
        const firstUser = parsed.find((m) => m.role === "user");
        if (firstUser) {
          setSeed(parseSeedFromFirstMessage(firstUser.text));
        }
        // Replay every proposeDrafts tool call in this session to reconstruct
        // the cardboard's final state. Deterministic — no regex over text.
        const { draftMap: replayed, rationale: lastRationale } = replayDraftHistory(rows);
        setDraftMap(replayed);
        setRationale(lastRationale);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : loadFailedCopy);
      } finally {
        if (!cancelled) setHistoryLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [params.sessionId, loadConversationFailedCopy, loadFailedCopy]);

  // One-shot fetch of the team's member directory + this session's "Started
  // by" attribution. Both are slowly-changing — no need to refresh per turn.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const teamRes = await authFetch(`${API_URL}/api/workspaces/${params.workspaceId}`);
        if (teamRes.ok && !cancelled) {
          const body = (await teamRes.json()) as {
            members?: Array<{ userId: string; name: string | null }>;
          };
          const next = new Map<string, string | null>();
          for (const m of body.members ?? []) {
            next.set(m.userId, m.name);
          }
          setMemberNames(next);
        }
      } catch { /* non-fatal */ }
      if (!profile) return;
      try {
        const sessions = await fetchFeedDraftSessions(profile.assistantId, platform);
        if (!cancelled) {
          const found = sessions.find((s) => s.id === params.sessionId);
          if (found) {
            setStartedBy(found.startedBy);
            if (typeof found.title === "string") setTitle(found.title);
            // Persisted intent — drives the layout switch below. `undefined`
            // (older API) and `null` (pre-107 row) both keep `seedKind` at
            // its initial null and the fallback derivation kicks in.
            if (found.seedKind !== undefined) setSeedKind(found.seedKind);
          }
        }
      } catch { /* non-fatal */ }
    })();
    return () => { cancelled = true; };
    // We deliberately re-run only when the ids change; the function
    // captures `profile` lazily through the `if (!profile)` guard.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params.workspaceId, params.sessionId, profile?.assistantId]);

  // Auto-scroll on new content. Depend on primitive lengths, not the array
  // reference — array identity churns even when content doesn't.
  const messageCount = messages.length;
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messageCount, streamingText]);

  // Auto-grow the composer: reset height to `auto`, then set to scrollHeight
  // so the textarea grows with content. The `max-h-[24rem]` Tailwind class on
  // the element clamps the visible height; overflow scrolls past that.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [input]);

  // ── Session intent (reply vs post) ─────────────────────────────
  //
  // Single source of truth: `seedKind` persisted on `sessions.seed_kind`
  // at create time (migration 107). The previous heuristic re-derived
  // intent from "is the first user message a URL?" and misclassified
  // every "+ New post" session whose author pasted a Threads URL as a
  // creative reference — see docs/architecture/feed/draft-sessions.md
  // → "Session intent".
  //
  // Pre-107 rows return `seedKind === null` from the API and fall through
  // to the legacy first-message derivation so they keep their old layout.
  // New sessions always carry an explicit kind and never trigger the
  // fallback branch.
  const sessionIntent: "reply" | "post" = (() => {
    if (seedKind === "inspiration-reply" || seedKind === "freeform-reply") return "reply";
    if (seedKind === "inspiration-original" || seedKind === "freeform") return "post";
    // Legacy fallback: derive from the first user message. Inspiration
    // sessions stay reply; first-message URL paste also stays reply
    // (matches what the user saw before the migration). Brand-new
    // sessions never enter this branch because `seedKind` is set.
    const firstUser = messages.find((m) => m.role === "user");
    if (seed && seed.source === "inspiration") return "reply";
    if (firstUser && findParsedPostUrl(firstUser.text)) return "reply";
    return "post";
  })();

  // The "Replying to" tile is only shown for reply-intent sessions.
  // Built synchronously from either the inspiration seed (`seed`) or
  // the legacy first-message URL paste — the embed is the platform's
  // own renderer, so a backend round-trip would only delay the visual
  // without adding information.
  const pastedPreview: SeedCandidate | null = (() => {
    if (sessionIntent !== "reply") return null;
    // freeform-reply / pre-107 URL paste: recover the candidate from the
    // first user message URL. Inspiration kinds are already covered by
    // `seed` (parsed in the history-load effect via parseSeedFromFirstMessage).
    const firstUser = messages.find((m) => m.role === "user");
    const parsed = firstUser ? findParsedPostUrl(firstUser.text) : null;
    if (!parsed) return null;
    return {
      authorHandle: parsed.handle,
      text: "",
      externalId:
        parsed.platform === "threads" ? parsed.shortcode : parsed.statusId,
      permalink: parsed.permalink,
      source: "url",
    };
  })();

  // ── References stockpile (post-intent only) ─────────────────────
  //
  // Scan every user message in the session for Threads / X post URLs
  // and accumulate them into the `references` list. Dedupe by canonical
  // permalink and preserve first-appearance order. Derived in-memory
  // from the `messages` state (which already replays history + receives
  // live SSE appends) so no extra fetch and no schema change. The
  // newest reference becomes the active one so a freshly pasted URL
  // lands the operator on the new card.
  useEffect(() => {
    if (sessionIntent !== "post") {
      // Reply-intent sessions don't surface references; clear any state
      // that may have accumulated before the seedKind fetch landed.
      if (references.length !== 0) setReferences([]);
      return;
    }
    const seen = new Map<string, ParsedPostUrl>();
    for (const m of messages) {
      if (m.role !== "user") continue;
      const parsed = findParsedPostUrl(m.text);
      if (!parsed) continue;
      if (!seen.has(parsed.permalink)) {
        seen.set(parsed.permalink, parsed);
      }
    }
    const next = Array.from(seen.values());
    // Reference equality: only update when the set actually changed so
    // the active-index reset below doesn't churn on every render.
    const sameLength = next.length === references.length;
    const samePermalinks =
      sameLength &&
      next.every((r, i) => r.permalink === references[i]?.permalink);
    if (!samePermalinks) {
      setReferences(next);
      setActiveReferenceIdx(Math.max(0, next.length - 1));
    }
  }, [messages, sessionIntent, references]);

  // ── Live SSE subscription ──────────────────────────────────────
  //
  // Connects to /draft-sessions/:id/stream and applies every event the
  // chat route emits for this session, including events produced on a
  // different Cloud Run instance. Reconnect-with-since covers Cloud Run's
  // request-cap reconnects + flaky-network drops; visibility-aware so
  // background tabs stop holding a request slot.
  //
  // Dedupe rule: the chat-route SSE (consumed by `sendMessage` below)
  // already commits the producing user's own messages. We track ids in
  // `seenMessageIdsRef` so a duplicate `user_message_saved` /
  // `assistant_message_saved` from the bus is a no-op.
  useEffect(() => {
    if (!profile) return;
    const sessionId = params.sessionId;
    let cancelled = false;
    let abort = new AbortController();

    const applyUserMessage = (payload: {
      id: string;
      sequenceNum: number;
      senderUserId: string | null;
      content: unknown;
    }) => {
      bumpLastSequence(payload.sequenceNum);
      if (seenMessageIdsRef.current.has(payload.id)) return;
      seenMessageIdsRef.current.add(payload.id);
      const text = contentToText(payload.content);
      if (!text) return;
      setMessages((prev) => {
        // Already in the list by id — nothing to do.
        if (prev.some((m) => m.id === payload.id)) return prev;
        // If this is our own message (bus race won over the per-turn SSE),
        // promote the optimistic `local-…` bubble to the server id instead
        // of appending a second row. Match by (senderUserId === meId AND
        // local-prefixed id AND identical text); the optimistic bubble was
        // created by sendMessage just above with exactly these fields.
        if (payload.senderUserId && payload.senderUserId === meId) {
          const optimistic = prev.find(
            (m) =>
              m.role === "user" &&
              m.senderUserId === meId &&
              m.id.startsWith("local-") &&
              m.text === text,
          );
          if (optimistic) {
            return prev.map((m) =>
              m.id === optimistic.id
                ? { ...m, id: payload.id, sequenceNum: payload.sequenceNum }
                : m,
            );
          }
        }
        return [
          ...prev,
          {
            id: payload.id,
            role: "user",
            text,
            timestamp: new Date(),
            senderUserId: payload.senderUserId,
            sequenceNum: payload.sequenceNum,
          },
        ];
      });
    };

    const applyAssistantMessage = (payload: {
      id: string;
      sequenceNum: number;
      content: unknown;
    }) => {
      bumpLastSequence(payload.sequenceNum);
      if (seenMessageIdsRef.current.has(payload.id)) return;
      // Walk the content for proposeDrafts upserts so a watcher's cardboard
      // catches up even though they aren't the sender.
      if (Array.isArray(payload.content)) {
        for (const block of payload.content) {
          if (typeof block !== "object" || block === null) continue;
          const b = block as { type?: string; name?: string; input?: unknown };
          if (b.type === "tool_use" && b.name === PROPOSE_DRAFTS_TOOL) {
            const parsed = parseProposeDraftsInput(b.input);
            if (parsed) {
              setDraftMap((prev) => applyProposeDrafts(prev, parsed));
              if (parsed.rationale) setRationale(parsed.rationale);
            }
          }
        }
      }
      const text = assistantContentToText(payload.content);
      if (!text) return;
      seenMessageIdsRef.current.add(payload.id);
      setMessages((prev) => {
        // Idempotent against the per-turn post-stream commit, which may
        // have landed first with the same server id.
        if (prev.some((m) => m.id === payload.id)) return prev;
        return [
          ...prev,
          {
            id: payload.id,
            role: "assistant",
            text,
            timestamp: new Date(),
            sequenceNum: payload.sequenceNum,
          },
        ];
      });
    };

    const dispatchEvent = (eventName: string, raw: string) => {
      let data: Record<string, unknown> = {};
      try { data = JSON.parse(raw) as Record<string, unknown>; } catch { return; }
      switch (eventName) {
        case "hello": {
          const viewers = (data.presence as ViewerPresence[] | undefined) ?? [];
          setPresence(viewers);
          const last = data.lastSequence;
          if (typeof last === "number") bumpLastSequence(last);
          break;
        }
        case "replay": {
          const rows = (data.messages as Array<{
            id: string;
            role: string;
            content: unknown;
            sequenceNum: number;
            senderUserId: string | null;
            createdAt: string;
          }> | undefined) ?? [];
          for (const row of rows) {
            if (row.role === "user") {
              applyUserMessage({
                id: row.id,
                sequenceNum: row.sequenceNum,
                senderUserId: row.senderUserId,
                content: row.content,
              });
            } else if (row.role === "assistant") {
              applyAssistantMessage({
                id: row.id,
                sequenceNum: row.sequenceNum,
                content: row.content,
              });
            }
          }
          break;
        }
        case "user_message_saved": {
          applyUserMessage({
            id: String(data.id ?? ""),
            sequenceNum: Number(data.sequenceNum ?? 0),
            senderUserId: (data.senderUserId as string | null) ?? null,
            content: data.content,
          });
          break;
        }
        case "assistant_message_saved": {
          applyAssistantMessage({
            id: String(data.id ?? ""),
            sequenceNum: Number(data.sequenceNum ?? 0),
            content: data.content,
          });
          break;
        }
        case "tool_input": {
          if (data.name === PROPOSE_DRAFTS_TOOL) {
            const parsed = parseProposeDraftsInput(data.input);
            if (parsed) {
              setDraftMap((prev) => applyProposeDrafts(prev, parsed));
              if (parsed.rationale) setRationale(parsed.rationale);
              setSavedIndices((prev) => {
                const next = new Set(prev);
                for (const d of parsed.drafts) next.delete(d.index);
                return next;
              });
            }
          }
          break;
        }
        case "turn_started": {
          const senderId = data.senderUserId as string | undefined;
          if (senderId && senderId !== meId) setActiveOtherTurnUser(senderId);
          break;
        }
        case "turn_completed": {
          setActiveOtherTurnUser(null);
          break;
        }
        case "presence": {
          const viewers = (data.viewers as ViewerPresence[] | undefined) ?? [];
          setPresence(viewers);
          break;
        }
      }
    };

    const connect = async () => {
      if (cancelled) return;
      abort = new AbortController();
      const since = lastSequenceRef.current > 0 ? `?since=${lastSequenceRef.current}` : "";
      try {
        const res = await authFetch(
          `${API_URL}/api/distribution/${profile.assistantId}/draft-sessions/${sessionId}/stream${since}`,
          { signal: abort.signal },
        );
        if (!res.ok || !res.body) return;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        const buffer = { text: "" };
        while (!cancelled) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const sse of parseSSEStream(decoder.decode(value, { stream: true }), buffer)) {
            dispatchEvent(sse.event, sse.data);
          }
        }
      } catch { /* abort or network drop — schedule reconnect below */ }
      // Reconnect after a brief backoff when the tab is visible.
      if (!cancelled && document.visibilityState === "visible") {
        setTimeout(() => {
          if (!cancelled) void connect();
        }, 1_500);
      }
    };

    void connect();

    const onVisibility = () => {
      if (document.visibilityState === "visible" && !cancelled) {
        // Force a reconnect with the latest cursor.
        abort.abort();
      }
      if (document.visibilityState === "hidden") {
        abort.abort();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelled = true;
      abort.abort();
      document.removeEventListener("visibilitychange", onVisibility);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profile?.assistantId, params.sessionId, meId]);

  // Cardboard alternatives — sorted by index. Driven by tool calls from the
  // assistant; deterministic, no text parsing.
  const sortedAlternatives = Array.from(draftMap.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([index, draft]) => ({ index, ...draft }));
  const hasAlternatives = sortedAlternatives.length > 1;

  // Paginate drafts into 2x2 pages — 4 per page so the operator sees the
  // whole option set at a glance, swiping between pages only when the
  // assistant produced more than 4 alternatives.
  const DRAFTS_PER_PAGE = 4;
  const draftPages: (typeof sortedAlternatives)[] = [];
  for (let i = 0; i < sortedAlternatives.length; i += DRAFTS_PER_PAGE) {
    draftPages.push(sortedAlternatives.slice(i, i + DRAFTS_PER_PAGE));
  }
  const hasMultiplePages = draftPages.length > 1;

  // Clamp the carousel position when the number of alternatives shrinks (e.g.
  // history reload). Don't auto-jump on growth — operator might be reading an
  // earlier option and we shouldn't yank them away when a new one arrives.
  useEffect(() => {
    if (draftPages.length === 0) return;
    if (activeSlide > draftPages.length - 1) {
      setActiveSlide(draftPages.length - 1);
    }
  }, [draftPages.length, activeSlide]);

  const handleCarouselScroll = useCallback(() => {
    const el = carouselRef.current;
    if (!el || el.clientWidth === 0) return;
    const idx = Math.round(el.scrollLeft / el.clientWidth);
    setActiveSlide((prev) => (prev === idx ? prev : idx));
  }, []);

  const goToSlide = useCallback((index: number) => {
    const el = carouselRef.current;
    if (!el) return;
    el.scrollTo({ left: index * el.clientWidth, behavior: "smooth" });
  }, []);

  const sendMessage = useCallback(
    async (
      text: string,
      opts: { truncateFromMessageId?: string } = {},
    ) => {
      if (!profile) return;
      const trimmed = text.trim();
      if (!trimmed) return;

      const localUserId = `local-${Date.now()}`;
      const userMessage: Message = {
        id: localUserId,
        role: "user",
        text: trimmed,
        timestamp: new Date(),
        senderUserId: meId,
      };
      setMessages((prev) => [...prev, userMessage]);
      setInput("");
      setError(null);
      setStreamingText("");
      setToolTimeline([]);
      setIsStreaming(true);

      const controller = new AbortController();
      abortRef.current = controller;

      let accumulated = "";

      try {
        const res = await authFetch(`${API_URL}/api/chat`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            message: trimmed,
            assistantId: profile.assistantId,
            sessionId: sessionIdRef.current ?? undefined,
            ...(opts.truncateFromMessageId
              ? { truncateFromMessageId: opts.truncateFromMessageId }
              : {}),
          }),
          signal: controller.signal,
        });
        if (!res.ok || !res.body) throw new Error(td.streamConnectFailed);

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        const sseBuffer = { text: "" };

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const sse of parseSSEStream(decoder.decode(value, { stream: true }), sseBuffer)) {
            let payload: Record<string, unknown> = {};
            try { payload = JSON.parse(sse.data) as Record<string, unknown>; } catch { /* skip */ }
            switch (sse.event) {
              case "session": {
                // Update sessionIdRef but DO NOT touch messages — the chat-ui
                // reducer does that and it's the bug we just exited.
                const newId = payload.sessionId as string | undefined;
                if (newId && newId !== sessionIdRef.current) {
                  sessionIdRef.current = newId;
                }
                break;
              }
              case "text_delta": {
                const t = payload.text as string | undefined;
                if (t) {
                  accumulated += t;
                  setStreamingText(accumulated);
                }
                break;
              }
              case "user_message_saved": {
                // Remap our optimistic local id to the server id so retry/edit
                // can reference the real row later. Race-safe: the bus SSE
                // (a separate HTTP response) may have already pushed a row
                // with `serverId`. In that case, drop the optimistic instead
                // of remapping — otherwise we'd end up with two rows that
                // both carry `serverId`.
                const serverId = payload.id as string | undefined;
                if (serverId) {
                  // Mark as seen so the bus SSE's mirror of this same event
                  // doesn't double-insert when it lands later.
                  seenMessageIdsRef.current.add(serverId);
                  setMessages((prev) => {
                    const busAlreadyCommitted = prev.some((m) => m.id === serverId);
                    if (busAlreadyCommitted) {
                      return prev.filter((m) => m.id !== localUserId);
                    }
                    return prev.map((m) =>
                      m.id === localUserId ? { ...m, id: serverId } : m,
                    );
                  });
                }
                break;
              }
              case "assistant_message_saved": {
                // Intentionally a no-op. The bus SSE (`applyAssistantMessage`)
                // is the sole writer of assistant bubbles for draft sessions
                // — pre-marking the id in `seenMessageIdsRef` here would cause
                // the bus event to be dropped (the seen check fires before the
                // bubble is committed), so the user wouldn't see the reply
                // until a refresh re-hydrated from `/api/sessions/:id/messages`.
                // The bus path is idempotent on its own (id match in state).
                break;
              }
              case "tool_start": {
                const id = payload.id as string | undefined;
                const name = payload.name as string | undefined;
                if (id && name) {
                  setToolTimeline((prev) =>
                    prev.some((t) => t.id === id)
                      ? prev
                      : [...prev, { id, name, status: "running" }],
                  );
                }
                break;
              }
              case "tool_input": {
                // The cardboard's load-bearing event. When the assistant
                // calls proposeDrafts, apply the upsert to the draft map
                // immediately — operator sees cards form/update live.
                if (payload.name === PROPOSE_DRAFTS_TOOL) {
                  const parsedInput = parseProposeDraftsInput(payload.input);
                  if (parsedInput) {
                    setDraftMap((prev) => applyProposeDrafts(prev, parsedInput));
                    if (parsedInput.rationale) setRationale(parsedInput.rationale);
                    // Reset save badges for any indices whose text just changed.
                    setSavedIndices((prev) => {
                      const next = new Set(prev);
                      for (const d of parsedInput.drafts) next.delete(d.index);
                      return next;
                    });
                  }
                }
                // Enrich the timeline row with a human-readable description
                // now that we know the tool's arguments.
                const id = payload.id as string | undefined;
                const name = payload.name as string | undefined;
                if (id && name) {
                  const enriched = describeFeedTool(
                    tt,
                    name,
                    (payload.input as Record<string, unknown>) ?? {},
                  );
                  if (enriched) {
                    setToolTimeline((prev) =>
                      prev.map((t) =>
                        t.id === id
                          ? { ...t, description: enriched.description, url: enriched.url }
                          : t,
                      ),
                    );
                  }
                }
                break;
              }
              case "tool_result": {
                const id = payload.id as string | undefined;
                const isError = Boolean(payload.isError);
                if (id) {
                  setToolTimeline((prev) =>
                    prev.map((t) =>
                      t.id === id
                        ? { ...t, status: isError ? "retried" : "done" }
                        : t,
                    ),
                  );
                }
                break;
              }
              case "error": {
                setError(
                  (payload.message as string | undefined)
                    ?? (payload.error as string | undefined)
                    ?? t.tuningChat.streamError,
                );
                if (payload.code === "draft_session_busy") {
                  // Drop the optimistic local user bubble — the turn was
                  // rejected by the concurrent-turn guard.
                  setMessages((prev) => prev.filter((m) => m.id !== localUserId));
                }
                break;
              }
            }
          }
        }

        // The bus is the complete source of truth for assistant bubbles in
        // a draft session: the chat route emits `assistant_message_saved` to
        // the bus once per persisted turn (intermediates included), and the
        // bus dispatcher pushes one bubble per event. We deliberately do NOT
        // push from the post-stream path — `accumulated` here lumps every
        // intermediate turn's text into one string, so committing it would
        // create a "second" assistant bubble whose text is the concatenation
        // of all turns alongside the bus-delivered per-turn bubbles. The
        // streamingText buffer is just for the live in-progress render and
        // is dropped now that the stream is done.
        setStreamingText("");
      } catch (err) {
        if ((err as Error).name !== "AbortError") {
          setError(err instanceof Error ? err.message : t.tuningChat.streamFailed);
          setStreamingText("");
        }
      } finally {
        setIsStreaming(false);
        abortRef.current = null;
      }
    },
    // Dictionary refs are context-stable; meId mirrors feed-web's closure.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [profile],
  );

  const onSend = useCallback(async () => {
    if (isStreaming) return;
    if (!input.trim()) return;
    await sendMessage(input);
  }, [input, isStreaming, sendMessage]);

  // ── Seed dispatcher (auto-send first user message from `?seed=`) ──
  //
  // The list page's "New reply" / "New post" creators redirect with a
  // `?seed=` query carrying the URL (reply) or marker text (post). On
  // first mount with an empty session, fire that text through
  // `sendMessage` exactly once so the user sees their seeded message and
  // the assistant's first response without an extra click. Then strip
  // the query from the URL so a refresh / share doesn't re-fire it.
  //
  // Guard rails:
  //   - Wait for `historyLoading` to settle so we don't race the empty
  //     state. If history loads with messages already present, skip
  //     (stale tab from a session that already started).
  //   - `seedDispatchedRef` is module-local to this mount — handles
  //     React 18 strict-mode double-invoke and any reactive re-runs.
  //   - sessionStorage-keyed by sessionId is a second belt: protects
  //     against navigation back/forward firing the effect again before
  //     we've stripped the query.
  const seedDispatchedRef = useRef(false);
  useEffect(() => {
    if (historyLoading) return;
    if (seedDispatchedRef.current) return;
    if (messages.length > 0) return;
    if (isStreaming) return;
    const seedText = searchParams.get("seed");
    if (!seedText) return;
    const storageKey = `draft-seed-fired:${params.sessionId}`;
    try {
      if (sessionStorage.getItem(storageKey)) {
        seedDispatchedRef.current = true;
        return;
      }
      sessionStorage.setItem(storageKey, "1");
    } catch {
      /* storage unavailable — fall through to the in-memory ref guard */
    }
    seedDispatchedRef.current = true;
    void sendMessage(seedText);
    // Strip `?seed=` from the URL so reload / share is a clean state.
    router.replace(
      `${feedPath(params.workspaceId, { platform, segment: "draft-sessions" })}/${params.sessionId}`,
    );
  }, [
    historyLoading,
    messages.length,
    isStreaming,
    searchParams,
    sendMessage,
    router,
    params.workspaceId,
    params.sessionId,
    platform,
  ]);

  // ── Kickoff dispatcher (auto-run the first turn over a seeded session) ──
  //
  // `createDraftSession` persists the seeded first user message (the reply
  // candidate / inspiration context) but does NOT run the chat loop — the
  // create endpoint stays a cheap insert. Without a trigger the operator lands
  // on a session showing their seeded prompt with no assistant draft, and has
  // to manually resend it. This effect engages the loop exactly once on first
  // mount of a freshly-seeded session.
  //
  // Mechanism: re-send the seed message through `POST /api/chat` with
  // `truncateFromMessageId` = the seed row's id. The server deletes-and-
  // reinserts the identical prompt and generates the first draft — the same
  // destroy-and-regenerate path `handleRetryFromUser` uses (chat.ts excludes
  // this unanswered-prompt regen from retry analytics). See
  // docs/architecture/feed/draft-sessions.md → Invariant 4.
  //
  // Guard rails (mirror the seed dispatcher above):
  //   - Wait for both `historyLoading` (messages) and `seedKind` (loaded by a
  //     separate fetch) to settle. Only the three seed kinds that produce a
  //     seed message are eligible; `freeform` posts start empty (no kickoff).
  //   - Fire only when exactly one server-side `user` message exists and no
  //     assistant turn has happened yet. A `local-` optimistic id means a turn
  //     is already in flight — skip.
  //   - `kickoffFiredRef` + a sessionStorage key keep it to once per session
  //     across strict-mode double-invoke, re-renders, and back/forward nav.
  const kickoffFiredRef = useRef(false);
  useEffect(() => {
    if (historyLoading) return;
    if (isStreaming) return;
    if (kickoffFiredRef.current) return;
    const seeded =
      seedKind === "inspiration-reply" ||
      seedKind === "inspiration-original" ||
      seedKind === "freeform-reply";
    if (!seeded) return;
    if (messages.length !== 1) return;
    const only = messages[0];
    if (only.role !== "user") return;
    if (only.id.startsWith("local-")) return; // a turn is already in flight
    const storageKey = `draft-kickoff-fired:${params.sessionId}`;
    try {
      if (sessionStorage.getItem(storageKey)) {
        kickoffFiredRef.current = true;
        return;
      }
      sessionStorage.setItem(storageKey, "1");
    } catch {
      /* storage unavailable — fall through to the in-memory ref guard */
    }
    kickoffFiredRef.current = true;
    const seedText = only.text;
    const seedId = only.id;
    // Clear the local seed row so `sendMessage`'s optimistic re-add doesn't
    // momentarily show two copies; the server truncates the original anyway.
    setMessages([]);
    setStreamingText("");
    void sendMessage(seedText, { truncateFromMessageId: seedId });
  }, [
    historyLoading,
    isStreaming,
    seedKind,
    messages,
    params.sessionId,
    sendMessage,
  ]);

  // ── Per-message actions: copy / edit / retry ───────────────────
  //
  // Mirrors the apps/web chat page. Retry / edit truncate the local
  // message list at the source row and re-send through the chat route
  // with `truncateFromMessageId` so the server deletes the trailing
  // history before generating a new response.

  const copyFailedCopy = td.copyFailed;
  const handleCopy = useCallback((messageId: string, text: string) => {
    if (typeof navigator === "undefined") return;
    void navigator.clipboard.writeText(text).then(
      () => {
        setCopiedMessageId(messageId);
        setTimeout(() => {
          setCopiedMessageId((cur) => (cur === messageId ? null : cur));
        }, 1_500);
      },
      () => {
        setError(copyFailedCopy);
      },
    );
  }, [copyFailedCopy]);

  const handleRetryFromUser = useCallback(
    (userMessageId: string) => {
      if (isStreaming) return;
      const idx = messages.findIndex((m) => m.id === userMessageId);
      if (idx < 0) return;
      const userMsg = messages[idx];
      if (userMsg.role !== "user") return;
      setMessages((prev) => prev.slice(0, idx));
      setStreamingText("");
      void sendMessage(userMsg.text, { truncateFromMessageId: userMessageId });
    },
    [isStreaming, messages, sendMessage],
  );

  const handleSaveEdit = useCallback(
    (userMessageId: string) => {
      if (isStreaming) return;
      const newText = editingMessageText.trim();
      if (!newText) return;
      const idx = messages.findIndex((m) => m.id === userMessageId);
      if (idx < 0) return;
      setEditingMessageId(null);
      setEditingMessageText("");
      setMessages((prev) => prev.slice(0, idx));
      setStreamingText("");
      void sendMessage(newText, { truncateFromMessageId: userMessageId });
    },
    [editingMessageText, isStreaming, messages, sendMessage],
  );

  const handleRetryAssistant = useCallback(
    (assistantMessageId: string) => {
      if (isStreaming) return;
      const idx = messages.findIndex((m) => m.id === assistantMessageId);
      if (idx <= 0) return;
      const precedingUser = messages[idx - 1];
      if (precedingUser.role !== "user") return;
      setMessages((prev) => prev.slice(0, idx - 1));
      setStreamingText("");
      void sendMessage(precedingUser.text, {
        truncateFromMessageId: precedingUser.id,
      });
    },
    [isStreaming, messages, sendMessage],
  );

  const cancelEdit = useCallback(() => {
    setEditingMessageId(null);
    setEditingMessageText("");
  }, []);

  // Rename the session. Allowed for the original starter and for team
  // admins/owners (the backend enforces this for `mode='draft'` sessions).
  // Non-admins who didn't start the session won't see the affordance.
  const canRenameTitle =
    isAdmin || (startedBy?.id != null && startedBy.id === meId);

  const startTitleEdit = useCallback(() => {
    if (!canRenameTitle) return;
    setTitleDraft(title ?? "");
    setIsEditingTitle(true);
  }, [canRenameTitle, title]);

  const cancelTitleEdit = useCallback(() => {
    setIsEditingTitle(false);
    setTitleDraft("");
  }, []);

  const renameFailedCopy = td.renameFailed;
  const saveTitle = useCallback(async () => {
    const trimmed = titleDraft.trim();
    if (!trimmed) return;
    if (trimmed === title) {
      setIsEditingTitle(false);
      return;
    }
    setTitleSaving(true);
    setError(null);
    try {
      const res = await authFetch(`${API_URL}/api/sessions/${params.sessionId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: trimmed }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? renameFailedCopy);
      }
      setTitle(trimmed);
      setIsEditingTitle(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : renameFailedCopy);
    } finally {
      setTitleSaving(false);
    }
  }, [params.sessionId, title, titleDraft, renameFailedCopy]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void onSend();
      }
    },
    [onSend],
  );

  const stopStream = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  // ── Typing beacon ──────────────────────────────────────────────
  //
  // Emit `isTyping: true` once when the input becomes non-empty, refresh
  // every 3s while the user keeps typing, and emit `isTyping: false` 3s
  // after they stop or on submit. NOTIFY only fires on transitions
  // server-side, so refresh-while-typing pings are cheap.
  useEffect(() => {
    if (!profile) return;
    const isTyping = input.trim().length > 0 && !isStreaming;
    if (!isTyping) {
      // No-op fire-and-forget for the off transition.
      void sendFeedDraftTypingPing(profile.assistantId, params.sessionId, false);
      return;
    }
    let cancelled = false;
    const ping = () => {
      if (cancelled) return;
      void sendFeedDraftTypingPing(profile.assistantId, params.sessionId, true);
    };
    ping();
    const timer = setInterval(ping, 3_000);
    // Auto-clear after 3s of no input change — handled by the next effect run
    // since `input` is in the dep array. Submit clears via setInput("").
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input, isStreaming, profile?.assistantId, params.sessionId]);

  // Reset the per-alternative "saved" badges whenever the underlying draft
  // Note: per-index save badges are reset inside the SSE tool_input handler
  // when an upsert touches that index — no global reset effect needed.

  async function saveAsDraft(index: number, text: string) {
    if (!profile || savingIndex !== null) return;
    if (!text.trim()) {
      setError(td.noDraftTextYet);
      return;
    }
    setSavingIndex(index);
    setError(null);
    setReplyNotice(null);
    // Pasted URL preview beats the Inspiration seed — same precedence as
    // the cardboard's "Replying to" tile, so what the operator sees on the
    // right is the post their saved draft will be linked to.
    const replyTarget = pastedPreview ?? seed;
    try {
      // We always pass the reply field when the operator has a target —
      // including the canonical permalink so the backend's resolver can
      // translate a Threads URL shortcode into the Graph API media ID
      // needed for `reply_to_id`. If resolution fails (scope not yet
      // approved by Meta, target profile <100 followers, post not
      // found in the lookup window) the backend strips the reply and
      // saves the draft as a fresh thread, returning a `reply.reason`
      // we surface to the operator below.
      const result = await saveFeedSessionDraft(
        profile.assistantId,
        params.sessionId,
        {
          text,
          platform,
          // Topic tag is post-intent only and Threads-only — the chip
          // isn't surfaced for reply intent or for X. Send it through
          // unconditionally when set; the backend ignores it on reply
          // approvals (see feed.ts approve handler).
          ...(sessionIntent === "post" && platform === "threads" && topicTag.trim()
            ? { topicTag: topicTag.trim() }
            : {}),
          ...(replyTarget
            ? {
                reply: {
                  externalId:
                    replyTarget.externalId ?? `inspiration-${params.sessionId}`,
                  authorHandle: replyTarget.authorHandle,
                  text: replyTarget.text,
                  ...(replyTarget.permalink
                    ? { permalink: replyTarget.permalink }
                    : {}),
                },
              }
            : {}),
        },
      );
      if (!result.ok) {
        throw new Error(result.error ?? td.saveFailed);
      }
      if (result.reply && result.reply.resolved === false) {
        setReplyNotice({
          kind: "warning",
          message: explainResolveFailure(td, result.reply.reason),
        });
      } else if (result.reply && result.reply.resolved === true) {
        setReplyNotice({
          kind: "success",
          message: td.replyResolvedNotice,
        });
      }
      setSavedIndices((prev) => {
        const next = new Set(prev);
        next.add(index);
        return next;
      });
      // Refresh the inline review panel — the just-saved option now lives in
      // the queue with status='pending' and gets its Approve/Reject controls.
      void loadSavedDrafts();
    } catch (err) {
      setError(err instanceof Error ? err.message : td.saveFailed);
    } finally {
      setSavingIndex(null);
    }
  }

  // Load the saved drafts (with resolution status) for this session.
  // Called on mount and after every save / approve / reject so the inline
  // panel mirrors the audit trail without needing live SSE wiring.
  const loadSavedDrafts = useCallback(async () => {
    if (!profile) return;
    const drafts = await fetchFeedSavedDrafts(profile.assistantId, params.sessionId);
    // Non-fatal on error (null) — the panel just stays stale; the next
    // action will refresh it.
    if (drafts) setSavedDrafts(drafts);
  }, [profile, params.sessionId]);

  useEffect(() => {
    void loadSavedDrafts();
  }, [loadSavedDrafts]);

  // Approve a saved draft inline. Posts to the existing approval endpoint;
  // an optional `text` body lets the operator approve an in-place edit
  // without bouncing to a separate review page.
  async function approveSavedDraft(draftId: string, editedText?: string) {
    if (!profile || actingOnDraftId) return;
    const original = savedDrafts.find((d) => d.id === draftId);
    // Double-confirm the exact account before publishing — a workspace can
    // have several accounts and the reply/post is irreversible once it lands.
    const isReply = original?.platformReplyId != null;
    const confirmed = await confirmDialog({
      title: isReply ? td.approveReplyTitle : td.approvePostTitle,
      description: format(td.approveDescription, {
        handle: profile.platformHandle,
        platform: platformLabel,
      }),
      confirmLabel: isReply ? td.approveReplyLabel : td.approvePostLabel,
    });
    if (!confirmed) return;
    setActingOnDraftId(draftId);
    setError(null);
    try {
      const dirty =
        editedText !== undefined &&
        editedText.trim().length > 0 &&
        editedText !== original?.draftText;
      const result = await approveFeedDraft(
        profile.assistantId,
        draftId,
        dirty ? { text: editedText } : {},
      );
      if (!result.ok) {
        if (result.code === "PUBLISH_AMBIGUOUS") {
          // Meta 5xx + container status unresolved. The reply may
          // already be on Threads — auto-retry here would risk a
          // duplicate. Drop the draft from the editor and reload so the
          // operator can decide on Threads before re-approving.
          throw new Error(td.publishAmbiguous);
        }
        throw new Error(result.error ?? td.approveFailed);
      }
      setEditingDraftId(null);
      void loadSavedDrafts();
    } catch (err) {
      setError(err instanceof Error ? err.message : td.approveFailed);
    } finally {
      setActingOnDraftId(null);
    }
  }

  async function rejectSavedDraft(draftId: string) {
    if (!profile || actingOnDraftId) return;
    const ok = await confirmDialog({
      title: td.rejectTitle,
      description: td.rejectDescription,
      confirmLabel: td.rejectLabel,
      variant: "destructive",
    });
    if (!ok) return;
    setActingOnDraftId(draftId);
    setError(null);
    try {
      const result = await rejectFeedDraft(profile.assistantId, draftId);
      if (!result.ok) {
        throw new Error(result.error ?? td.rejectFailed);
      }
      void loadSavedDrafts();
    } catch (err) {
      setError(err instanceof Error ? err.message : td.rejectFailed);
    } finally {
      setActingOnDraftId(null);
    }
  }

  // Delete-flow for an already-published saved draft. Offers two paths via
  // the three-button choice dialog: take the live post down on the platform
  // (DELETE /:assistantId/posts/:mediaId), or just clear this audit-context
  // row (POST /:assistantId/saved-drafts/:id/remove) and leave the post up.
  // Either way we refresh the panel so the row reflects the new state
  // (status flips to `deleted` after a platform delete; the row disappears
  // after a record-only removal).
  async function deleteOrRemovePostedDraft(d: FeedSavedDraft) {
    if (!profile || actingOnDraftId) return;
    setError(null);
    const isReply = d.platformReplyId != null;
    await chooseAsync(
      {
        title: td.deletePublishedTitle,
        description: isReply
          ? td.deletePublishedDescriptionReply
          : td.deletePublishedDescriptionPost,
        confirmLabel: isReply ? td.deleteLiveReply : td.deleteLivePost,
        variant: "destructive",
        secondaryLabel: td.removeRecordOnly,
      },
      // primary — take the live post down
      async () => {
        if (!d.postedMediaId) {
          const message = td.noMediaId;
          setError(message);
          throw new Error(message);
        }
        setActingOnDraftId(d.id);
        try {
          const result = await deleteFeedPublishedPost(
            profile.assistantId,
            d.postedMediaId,
          );
          if (!result.ok) {
            const message = result.error ?? td.deleteFailed;
            setError(message);
            throw new Error(message);
          }
          await loadSavedDrafts();
        } finally {
          setActingOnDraftId(null);
        }
      },
      // secondary — clear the row only
      async () => {
        setActingOnDraftId(d.id);
        try {
          const result = await removeFeedSavedDraftRecord(
            profile.assistantId,
            d.id,
          );
          if (!result.ok) {
            const message = result.error ?? td.removeFailed;
            setError(message);
            throw new Error(message);
          }
          await loadSavedDrafts();
        } finally {
          setActingOnDraftId(null);
        }
      },
    );
  }

  // Discard the entire draft session. Authorization mirrors the backend:
  // admin/owner can discard any team draft; non-admins may only discard
  // sessions they started themselves. The button is hidden otherwise.
  const canDiscardSession =
    isAdmin || (startedBy?.id != null && startedBy.id === meId);

  // The app-root confirmDialog resolves before the action runs, so surface
  // any failure into local state from inside the action body.
  const discardSession = useCallback(async () => {
    if (!profile || !canDiscardSession) return;
    const ok = await confirmDialog({
      title: td.discardTitle,
      description: td.discardDescription,
      confirmLabel: td.discardConfirmLabel,
      variant: "destructive",
    });
    if (!ok) return;
    setError(null);
    const result = await deleteFeedDraftSession(
      profile.assistantId,
      params.sessionId,
    );
    if (!result.ok) {
      setError(result.error ?? td.discardFailed);
      return;
    }
    router.push(feedPath(params.workspaceId, { platform, segment: "draft-sessions" }));
  }, [
    profile,
    canDiscardSession,
    params.sessionId,
    params.workspaceId,
    platform,
    router,
    td.discardTitle,
    td.discardDescription,
    td.discardConfirmLabel,
    td.discardFailed,
  ]);

  if (!profile) {
    return (
      <div className="px-8 py-10 max-w-2xl space-y-4">
        <h1 className="text-xl font-semibold">
          {format(td.notConnectedTitle, { platform: platformLabel })}
        </h1>
        <Link
          href={feedPath(params.workspaceId)}
          className="inline-flex items-center justify-center rounded-xl bg-primary px-4 h-11 text-sm font-medium text-primary-foreground hover:bg-primary/90"
        >
          {format(td.connectCta, { platform: platformLabel })}
        </Link>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-screen animate-fade-in">
      {choiceDialog}
      {/* Top-level header — spans the full content width across the
          cardboard (middle) and chat (right) columns. Lifting it out of
          the chat column means the session chrome (back link, title,
          started-by, presence, discard) reads as page-level rather than
          looking pinned above only the right pane. */}
      <div className="flex items-center gap-3 px-5 h-14 border-b border-border shrink-0">
        <BackButton
          href={feedPath(params.workspaceId, { platform, segment: "draft-sessions" })}
          label={t.sections.draftSessions}
        />
        {isEditingTitle ? (
          <input
            key="title-input"
            type="text"
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void saveTitle();
              }
              if (e.key === "Escape") cancelTitleEdit();
            }}
            onBlur={() => void saveTitle()}
            disabled={titleSaving}
            autoFocus
            maxLength={200}
            // Underline-only styling — suppress the global focus-visible
            // box-shadow ring (see globals.css) so editing the title
            // doesn't paint a ring over the header.
            className="text-sm font-semibold text-foreground bg-transparent border-b border-primary focus:outline-none focus-visible:shadow-none px-0.5 min-w-0 flex-shrink animate-fade-in transition-colors"
            style={{ fontFamily: "var(--font-rocknroll)" }}
          />
        ) : (
          <button
            key="title-button"
            type="button"
            onClick={startTitleEdit}
            disabled={!canRenameTitle}
            title={canRenameTitle ? td.renameTitle : undefined}
            className={`text-sm font-semibold text-foreground truncate text-left animate-fade-in transition-colors ${
              canRenameTitle ? "hover:text-primary cursor-text" : "cursor-default"
            }`}
            style={{ fontFamily: "var(--font-rocknroll)" }}
          >
            {title ?? format(td.defaultTitle, { platform: platformLabel })}
          </button>
        )}
        {startedBy && !isEditingTitle ? (
          <span className="text-[11px] text-muted-foreground truncate animate-fade-in">
            · {format(td.startedBy, { name: startedBy.name ?? td.unknownUser })}
          </span>
        ) : null}
        <div className="flex-1" />
        <ViewerAvatars viewers={presence} meId={meId} />
        {canDiscardSession ? (
          <button
            type="button"
            onClick={() => void discardSession()}
            title={td.discardAction}
            aria-label={td.discardAction}
            className="h-7 w-7 inline-flex items-center justify-center rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        ) : null}
      </div>
      {/* Two-column work area below the shared header. `min-h-0` lets each
          column's `flex-1 overflow-y-auto` scroller actually shrink + scroll
          inside the parent column flex (without it, flex children default
          to min-height: auto and the scrollers would overflow the viewport). */}
      <div className="flex flex-row-reverse flex-1 min-h-0">
      {/* Right (visual): chat thread — flex-row-reverse on parent flips DOM order */}
      <div className="flex flex-1 flex-col min-w-0 md:flex-none md:w-[360px] xl:w-[460px] 2xl:w-[560px] md:shrink-0 md:border-l md:border-border md:bg-sidebar/40">
        <div ref={containerRef} className="flex-1 overflow-y-auto">
          <div className="max-w-[780px] mx-auto px-3 py-4 md:px-6 md:py-6 space-y-6">
            {historyLoading ? (
              <div className="text-sm text-muted-foreground animate-pulse-soft">{td.loadingConversation}</div>
            ) : messages.length === 0 && !isStreaming ? (
              <div className="text-sm text-muted-foreground pt-4 animate-fade-in">
                {td.chatEmptyPrefix}{" "}
                <em>{format(td.chatEmptyExample, { platform: platformLabel })}</em>
                {td.chatEmptySuffix}
              </div>
            ) : null}

            {messages.map((msg, idx) => {
              const isLastAssistant =
                msg.role === "assistant" &&
                idx === messages.length - 1 &&
                !isStreaming;
              const wasCopied = copiedMessageId === msg.id;
              // Only messages that arrived after the initial history snapshot
              // get the rise-in animation — this keeps the initial paint
              // calm and animates only the live appends.
              const isNewSinceMount =
                initialMessageIdsRef.current !== null &&
                !initialMessageIdsRef.current.has(msg.id);
              const enterClass = isNewSinceMount ? "animate-rise-in" : "";

              if (msg.role === "user") {
                const senderId = msg.senderUserId ?? null;
                const isMine = senderId === meId;
                const senderName = senderId
                  ? (memberNames.get(senderId) ?? null)
                  : null;
                const isEditing = editingMessageId === msg.id;
                // Edits/retries only valid on a server-saved row from this
                // operator. The optimistic `local-…` id is replaced with
                // the server id by the chat-route SSE; until then we hide
                // the actions so a click never references a row the
                // server hasn't seen.
                const canMutate =
                  !msg.id.startsWith("local-") && !isStreaming && isMine;
                return (
                  <div
                    key={msg.id}
                    id={`msg-${msg.id}`}
                    className={`flex flex-col items-end group ${enterClass}`}
                  >
                    {senderId && !isMine ? (
                      <span className="text-[10px] text-muted-foreground mb-1 mr-2">
                        @{senderName ?? td.teammate}
                      </span>
                    ) : null}
                    <div className={`${isEditing ? "w-full max-w-2xl" : "max-w-[80%]"} space-y-2 transition-all duration-200`}>
                      {isEditing ? (
                        <div key="edit" className="w-full space-y-2 animate-fade-in">
                          <div className="bg-muted border border-border rounded-2xl p-3 transition-colors">
                            <textarea
                              value={editingMessageText}
                              onChange={(e) => setEditingMessageText(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter" && !e.shiftKey) {
                                  e.preventDefault();
                                  handleSaveEdit(msg.id);
                                }
                                if (e.key === "Escape") cancelEdit();
                              }}
                              autoFocus
                              rows={Math.max(3, editingMessageText.split("\n").length)}
                              // Parent .bg-muted card already conveys focus
                              // via its border; suppress the global
                              // :focus-visible inner ring so it doesn't paint
                              // a second outline inside the parent.
                              className="w-full bg-transparent text-[15px] leading-[1.55] text-foreground resize-none focus:outline-none focus-visible:shadow-none"
                            />
                          </div>
                          <div className="flex items-center justify-end gap-2">
                            <button
                              type="button"
                              onClick={cancelEdit}
                              className="text-sm font-medium px-4 py-1.5 rounded-lg border border-border hover:bg-muted transition-colors"
                            >
                              {td.cancel}
                            </button>
                            <button
                              type="button"
                              onClick={() => handleSaveEdit(msg.id)}
                              disabled={!editingMessageText.trim()}
                              className="text-sm font-medium px-4 py-1.5 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                            >
                              {td.save}
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div key="view" className="space-y-2 animate-fade-in">
                          <div className="inline-block max-w-full bg-primary text-primary-foreground rounded-2xl rounded-br-md px-4 py-2.5 text-[15px] leading-[1.55] shadow-sm">
                            <p className="whitespace-pre-wrap break-words overflow-hidden">
                              {msg.text}
                            </p>
                          </div>
                          <div className="flex items-center gap-1 justify-end opacity-0 group-hover:opacity-100 transition-opacity duration-200 -mr-2">
                            <ActionButton
                              tooltip={wasCopied ? t.tuningChat.copied : t.tuningChat.copy}
                              onClick={() => handleCopy(msg.id, msg.text)}
                            >
                              {wasCopied ? <Check size={14} /> : <Copy size={14} />}
                            </ActionButton>
                            {canMutate ? (
                              <>
                                <ActionButton
                                  tooltip={td.edit}
                                  onClick={() => {
                                    setEditingMessageId(msg.id);
                                    setEditingMessageText(msg.text);
                                  }}
                                >
                                  <Pencil size={14} />
                                </ActionButton>
                                <ActionButton
                                  tooltip={t.tuningChat.retry}
                                  onClick={() => handleRetryFromUser(msg.id)}
                                >
                                  <RotateCcw size={14} />
                                </ActionButton>
                              </>
                            ) : null}
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                );
              }

              const assistantText = stripDraftMarkers(msg.text);
              const canRetryAssistant =
                isLastAssistant && !msg.id.startsWith("assistant-");
              return (
                <div
                  key={msg.id}
                  id={`msg-${msg.id}`}
                  className={`flex flex-col items-start group ${enterClass}`}
                >
                  {/* Assistant attribution — the assistant's own pixel-
                      creature icon + display name (e.g. "Use Brian -
                      Threads"), matching how the main web app identifies
                      the assistant in chat. Not the connected Threads/X
                      account avatar: the assistant is the AI voice, the
                      platform handle is just its outbound identity. */}
                  <div className="flex items-center gap-1.5 mb-1 ml-1">
                    <AssistantAvatar
                      id={profile.assistant.id}
                      name={profile.assistant.name}
                      iconSeed={profile.assistant.iconSeed}
                      size="sm"
                    />
                    <span className="text-[11px] text-muted-foreground font-medium">
                      {profile.assistant.name}
                    </span>
                  </div>
                  <div className="max-w-[85%] text-[15px] leading-[1.6] space-y-2">
                    <ChatMarkdown text={assistantText} />
                    {assistantText ? (
                      <div className="flex items-center gap-1 -ml-2 pt-1 opacity-0 group-hover:opacity-100 transition-opacity duration-200">
                        <ActionButton
                          tooltip={wasCopied ? t.tuningChat.copied : t.tuningChat.copy}
                          onClick={() => handleCopy(msg.id, assistantText)}
                        >
                          {wasCopied ? <Check size={14} /> : <Copy size={14} />}
                        </ActionButton>
                        {canRetryAssistant ? (
                          <ActionButton
                            tooltip={t.tuningChat.retry}
                            onClick={() => handleRetryAssistant(msg.id)}
                          >
                            <RotateCcw size={14} />
                          </ActionButton>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                </div>
              );
            })}

            {isStreaming ? (
              <div className="flex flex-col items-start animate-fade-in">
                {/* Same attribution row as a committed assistant message —
                    keeps the avatar visible during the thinking / streaming
                    phase so the bubble doesn't pop in mid-stream. */}
                <div className="flex items-center gap-1.5 mb-1 ml-1">
                  <AssistantAvatar
                    id={profile.assistant.id}
                    name={profile.assistant.name}
                    iconSeed={profile.assistant.iconSeed}
                    size="sm"
                  />
                  <span className="text-[11px] text-muted-foreground font-medium">
                    {profile.assistant.name}
                  </span>
                </div>
                <div className="max-w-[85%] min-w-0 space-y-2">
                  {toolTimeline.length > 0 ? (
                    <ToolTimeline tools={toolTimeline} />
                  ) : null}
                  {streamingText ? (
                    <div className="text-[15px] leading-[1.6] break-words">
                      <ChatMarkdown text={stripDraftMarkers(streamingText)} />
                      <span
                        className="inline-block w-[3px] h-[16px] bg-primary rounded-full animate-pulse ml-0.5 align-text-bottom"
                        aria-hidden
                      />
                    </div>
                  ) : toolTimeline.length === 0 ? (
                    <div className="flex items-center gap-2 text-sm text-muted-foreground py-1">
                      <span className="flex gap-1" aria-hidden>
                        <span
                          className="w-1.5 h-1.5 rounded-full bg-primary/60 animate-bounce"
                          style={{ animationDelay: "0ms" }}
                        />
                        <span
                          className="w-1.5 h-1.5 rounded-full bg-primary/60 animate-bounce"
                          style={{ animationDelay: "140ms" }}
                        />
                        <span
                          className="w-1.5 h-1.5 rounded-full bg-primary/60 animate-bounce"
                          style={{ animationDelay: "280ms" }}
                        />
                      </span>
                      <span className="italic">{t.tuningChat.thinking}</span>
                    </div>
                  ) : null}
                </div>
              </div>
            ) : null}
          </div>
        </div>

        {error ? (
          <div className="px-5 py-2 text-sm text-destructive bg-destructive/10 border-t border-destructive/20 animate-rise-in">
            {error}
          </div>
        ) : null}

        {replyNotice ? (
          <div
            className={
              "animate-rise-in " + (replyNotice.kind === "warning"
                ? "px-5 py-2 text-sm text-amber-700 dark:text-amber-300 bg-amber-50 dark:bg-amber-900/20 border-t border-amber-200 dark:border-amber-800/40 flex items-start justify-between gap-3"
                : "px-5 py-2 text-sm text-emerald-700 dark:text-emerald-300 bg-emerald-50 dark:bg-emerald-900/20 border-t border-emerald-200 dark:border-emerald-800/40 flex items-start justify-between gap-3")
            }
          >
            <span className="leading-snug">{replyNotice.message}</span>
            <button
              type="button"
              onClick={() => setReplyNotice(null)}
              className="shrink-0 text-xs underline hover:no-underline transition-colors"
              aria-label={td.dismiss}
            >
              {td.dismiss}
            </button>
          </div>
        ) : null}

        {activeOtherTurnUser ? (
          <div className="px-5 py-2 text-xs text-muted-foreground bg-accent/40 border-t border-border animate-rise-in">
            <span className="font-medium text-foreground">
              @{memberNames.get(activeOtherTurnUser) ?? td.teammateCapitalized}
            </span>{" "}
            {td.otherTurnSuffix}
          </div>
        ) : null}

        <div className="border-t border-border bg-background px-3 py-4 md:px-6 md:py-5">
          <div className="max-w-[780px] mx-auto rounded-2xl border border-border bg-card focus-within:ring-2 focus-within:ring-ring transition-shadow">
            <textarea
              ref={inputRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={
                activeOtherTurnUser
                  ? format(td.waitingFor, {
                      name: memberNames.get(activeOtherTurnUser) ?? td.teammate,
                    })
                  : isStreaming
                    ? td.streamingPlaceholder
                    : format(td.composerPlaceholder, { platform: platformLabel })
              }
              rows={3}
              disabled={Boolean(activeOtherTurnUser)}
              // The card wrapper owns the focus ring via `focus-within:ring-2`.
              // globals.css adds a global `:focus-visible { box-shadow: ... }`
              // so every element draws its own focus ring — left enabled here
              // the textarea draws an inner ring inside the wrapper's, which
              // visually splits the outline. `focus-visible:shadow-none`
              // suppresses the inner ring; the wrapper's ring remains.
              className="block w-full resize-none bg-transparent px-4 py-3 text-[15px] leading-[1.55] focus:outline-none focus-visible:shadow-none disabled:opacity-60 disabled:cursor-not-allowed min-h-[88px] max-h-[24rem]"
            />
            <div className="flex items-center justify-between gap-2 px-3 pb-3">
              <span className="text-[11px] text-muted-foreground">
                {td.composerHint}
              </span>
              {isStreaming ? (
                <button
                  key="stop"
                  type="button"
                  onClick={stopStream}
                  className="inline-flex items-center gap-1.5 rounded-xl bg-card border border-border text-foreground px-4 h-10 text-sm font-medium hover:bg-accent transition-colors animate-fade-in"
                >
                  <Square size={14} />
                  {t.tuningChat.stop}
                </button>
              ) : (
                <button
                  key="send"
                  type="button"
                  onClick={() => void onSend()}
                  disabled={!input.trim() || Boolean(activeOtherTurnUser)}
                  className="rounded-xl bg-primary text-primary-foreground px-5 h-10 text-sm font-medium hover:bg-primary/90 disabled:opacity-40 transition-all duration-200 animate-fade-in"
                >
                  {t.tuningChat.send}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Middle (visual): cardboard — original post → current draft */}
      <aside className="hidden md:flex md:flex-1 md:min-w-0 flex-col border-r border-border">
        <div className="flex-1 overflow-y-auto">
          <div className="px-6 py-6 space-y-5">
          {(() => {
            // Pasted URL beats the Inspiration seed when both are present —
            // the operator's most recent action signals the active target.
            const replyTarget = pastedPreview ?? seed;
            if (replyTarget) {
              // The reply *target's* platform drives the badge + native embed,
              // not the account tab the operator is composing from — a pasted
              // x.com URL must render an X embed (and reply via X) even on a
              // Threads tab. Falls back to the tab platform when there's no
              // parseable permalink (inspiration seeds).
              const replyPlatform = replyTarget.permalink
                ? parsePostUrl(replyTarget.permalink)?.platform ?? platform
                : platform;
              return (
                <section className="max-w-2xl mx-auto space-y-2 animate-rise-in">
                  <div className="flex items-center justify-between">
                    <h3 className="text-[11px] uppercase tracking-wider text-muted-foreground">
                      {t.postEmbed.replyingTo}
                    </h3>
                    {replyTarget.permalink ? (
                      <a
                        href={replyTarget.permalink}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[10px] text-muted-foreground hover:text-foreground underline"
                      >
                        {td.openArrow}
                      </a>
                    ) : null}
                  </div>
                  <PostPreview
                    platform={replyPlatform}
                    authorHandle={replyTarget.authorHandle}
                    text={replyTarget.text}
                    permalink={replyTarget.permalink}
                    mediaUrl={replyTarget.mediaUrl}
                  />
                  {/* Visual link from the original post down to the drafts —
                      reinforces "your draft is replying to this". The actual
                      "did this resolve to a real reply target?" status is
                      surfaced after Save: a successful resolution leaves the
                      saved draft's status as "Ready for review" with a real
                      reply target; a failed one shows an inline notice
                      explaining why the draft saved as a fresh thread. */}
                  <div className="flex items-center gap-2 pl-5 pr-1 pt-1 text-[10px] text-muted-foreground">
                    <span className="block w-px h-4 bg-border" aria-hidden />
                    <span>{td.yourReply}</span>
                  </div>
                </section>
              );
            }
            return null;
          })()}

          <section className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-[11px] uppercase tracking-wider text-muted-foreground transition-colors">
                {hasAlternatives
                  ? format(td.draftsCountHeading, {
                      count: sortedAlternatives.length,
                    })
                  : td.currentDraft}
                {isStreaming ? ` · ${td.streamingSuffix}` : ""}
              </h3>
              {/* Topic-tag chip — Threads-only, post-intent only. Threads
                  limits to one topic per post (see docs/architecture/feed/
                  draft-sessions.md → API surface, save-draft topicTag). */}
              {sessionIntent === "post" && platform === "threads" && canDraft ? (
                <TopicTagChip
                  value={topicTag}
                  draft={topicTagDraft}
                  isEditing={isEditingTopic}
                  onStartEdit={() => {
                    setTopicTagDraft(topicTag);
                    setIsEditingTopic(true);
                  }}
                  onChangeDraft={setTopicTagDraft}
                  onCommit={() => {
                    // Strip Meta-forbidden chars and apply length cap so
                    // the operator never queues a save that the threads
                    // client will reject.
                    const trimmed = topicTagDraft
                      .trim()
                      .replace(/[.&]/g, "")
                      .slice(0, 50);
                    setTopicTag(trimmed);
                    setIsEditingTopic(false);
                  }}
                  onCancel={() => setIsEditingTopic(false)}
                  onClear={() => {
                    setTopicTag("");
                    setTopicTagDraft("");
                    setIsEditingTopic(false);
                  }}
                />
              ) : null}
            </div>

            {rationale ? (
              <p
                key={rationale}
                className="text-[11px] text-muted-foreground italic leading-relaxed animate-fade-in"
              >
                {rationale}
              </p>
            ) : null}

            {sortedAlternatives.length === 0 ? (
              isStreaming ? (
                <div className="grid grid-cols-2 gap-3 animate-fade-in">
                  {[0, 1, 2, 3].map((i) => (
                    <DraftPlaceholderCard key={i} />
                  ))}
                </div>
              ) : (
                <div className="rounded-xl border border-border bg-card p-3 min-h-[120px] animate-fade-in">
                  <p className="text-xs text-muted-foreground italic">
                    {td.noDraftsYet}
                  </p>
                </div>
              )
            ) : (
              <div className="space-y-2 animate-fade-in">
                {/* Paginated 2x2 grid — each "page" is a full-width slide
                    holding up to 4 drafts laid out in a 2-col grid. Native
                    scroll-snap handles swipe/trackpad; JS only computes the
                    active page index. */}
                <ul
                  ref={carouselRef}
                  onScroll={handleCarouselScroll}
                  className="flex overflow-x-auto snap-x snap-mandatory [&::-webkit-scrollbar]:hidden"
                  style={{ scrollbarWidth: "none" }}
                >
                  {draftPages.map((page, pageIdx) => (
                    <li
                      key={pageIdx}
                      className="snap-center shrink-0 w-full"
                    >
                      <div className="grid grid-cols-2 gap-3 animate-stagger">
                        {page.map((alt) => (
                          <DraftOptionCard
                            key={alt.index}
                            index={alt.index}
                            text={alt.text}
                            label={alt.label}
                            canDraft={canDraft}
                            saving={savingIndex === alt.index}
                            saved={savedIndices.has(alt.index)}
                            disabled={isStreaming || (savingIndex !== null && savingIndex !== alt.index)}
                            onSave={() => void saveAsDraft(alt.index, alt.text)}
                            animate={isStreaming}
                          />
                        ))}
                      </div>
                    </li>
                  ))}
                </ul>
                {hasMultiplePages ? (
                  <div className="flex items-center justify-between gap-2 px-1 pt-1">
                    <button
                      type="button"
                      aria-label={td.prevPage}
                      onClick={() => goToSlide(Math.max(0, activeSlide - 1))}
                      disabled={activeSlide === 0}
                      className="rounded-lg border border-border bg-card px-2 h-7 text-xs text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                    >
                      ←
                    </button>
                    <div className="flex items-center gap-1.5" role="tablist" aria-label={td.draftPagesAria}>
                      {draftPages.map((_, i) => (
                        <button
                          key={i}
                          type="button"
                          role="tab"
                          aria-selected={i === activeSlide}
                          aria-label={format(td.goToPage, { page: i + 1 })}
                          onClick={() => goToSlide(i)}
                          className={`h-1.5 rounded-full transition-all ${
                            i === activeSlide
                              ? "w-5 bg-primary"
                              : "w-1.5 bg-muted-foreground/40 hover:bg-muted-foreground/70"
                          }`}
                        />
                      ))}
                    </div>
                    <button
                      type="button"
                      aria-label={td.nextPage}
                      onClick={() => goToSlide(Math.min(draftPages.length - 1, activeSlide + 1))}
                      disabled={activeSlide === draftPages.length - 1}
                      className="rounded-lg border border-border bg-card px-2 h-7 text-xs text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                    >
                      →
                    </button>
                  </div>
                ) : null}
              </div>
            )}

            {canDraft && sortedAlternatives.length > 0 ? (
              <p className="text-[11px] text-muted-foreground leading-relaxed pt-1">
                {hasAlternatives ? td.saveHintMultiple : td.saveHintSingle}
              </p>
            ) : null}
          </section>

          <SavedDraftsPanel
            drafts={savedDrafts}
            canDraft={canDraft}
            sessionIntent={sessionIntent}
            actingOnDraftId={actingOnDraftId}
            editingDraftId={editingDraftId}
            editingDraftText={editingDraftText}
            onStartEdit={(d) => {
              setEditingDraftId(d.id);
              setEditingDraftText(d.draftText);
            }}
            onCancelEdit={() => {
              setEditingDraftId(null);
              setEditingDraftText("");
            }}
            onChangeEdit={setEditingDraftText}
            onApprove={(draft) =>
              void approveSavedDraft(
                draft.id,
                editingDraftId === draft.id ? editingDraftText : undefined,
              )
            }
            onReject={(draft) => void rejectSavedDraft(draft.id)}
            onDeletePosted={(draft) => void deleteOrRemovePostedDraft(draft)}
          />

          {/* References stockpile — post-intent sessions only. URLs the
              operator pastes into chat after creation accumulate here as
              creative inspiration; they never become reply targets. The
              parent post on reply-intent sessions is in the "Replying to"
              tile above; reference-cards are intentionally suppressed
              there to keep the cardboard focused on one target. */}
          {sessionIntent === "post" && references.length > 0 ? (
            <ReferencesPanel
              platform={platform}
              references={references}
              activeIdx={Math.min(activeReferenceIdx, references.length - 1)}
              onPick={setActiveReferenceIdx}
            />
          ) : null}
          </div>
        </div>
      </aside>
      </div>
    </div>
  );
}

// ── Post preview card (cardboard "original post" tile) ─────────

/**
 * Styled like a real Threads/X post — avatar circle, handle row, body. Used
 * in the cardboard so the operator can see at a glance which post their
 * draft is replying to without leaving the chat surface.
 */
function PostPreview({
  platform,
  authorHandle,
  text,
  permalink,
  mediaUrl,
}: {
  platform: FeedPlatform;
  authorHandle: string;
  text: string;
  permalink?: string;
  mediaUrl?: string;
}) {
  const t = useT().feedPage;
  const avatarInitial = authorHandle.charAt(0).toUpperCase() || "?";
  const platformLabel = t.platformLabels[platform];
  const isX = platform === "twitter";
  const platformBadgeClass = isX
    ? "bg-foreground text-background"
    : "bg-primary/15 text-primary";

  // Compact caption — sits as a single row above the embed, no card chrome
  // of its own. Native script-rendered embeds paint their own card, so any
  // outer border + bg around them created a "card-in-card" stack. The
  // caption keeps attribution visible during the brief moment the script
  // is loading (and is the only thing that renders in the og:-fallback
  // path's caption slot).
  const caption = (
    <div className="flex items-center gap-2 px-1 min-w-0">
      <div
        className={`w-6 h-6 shrink-0 rounded-full ${
          isX ? "bg-foreground text-background" : "bg-primary/20 text-primary"
        } flex items-center justify-center text-[11px] font-semibold`}
      >
        {avatarInitial}
      </div>
      <span className="text-xs font-semibold text-foreground truncate">@{authorHandle}</span>
      <span
        className={`shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-semibold ${platformBadgeClass}`}
      >
        {platformLabel}
      </span>
      {permalink ? (
        <span className="text-[10px] text-muted-foreground truncate">
          · {prettyDomain(permalink)}
        </span>
      ) : null}
    </div>
  );

  if (permalink) {
    return (
      <div className="space-y-2">
        {caption}
        <NativeEmbed platform={platform} permalink={permalink} />
      </div>
    );
  }

  // No permalink — fall back to an og:-style card built from the scraped
  // text/media. Outer chrome is fine here since there's no embed to
  // compete with.
  return (
    <article className="rounded-2xl border border-border bg-card overflow-hidden">
      <div className="flex items-center gap-3 px-4 pt-3 pb-2 border-b border-border/60">
        <div
          className={`w-9 h-9 shrink-0 rounded-full ${
            isX ? "bg-foreground text-background" : "bg-primary/20 text-primary"
          } flex items-center justify-center text-sm font-semibold`}
        >
          {avatarInitial}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-foreground truncate">@{authorHandle}</span>
            <span className={`shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-semibold ${platformBadgeClass}`}>
              {platformLabel}
            </span>
          </div>
        </div>
      </div>
      <div className="px-4 py-3">
        {text ? (
          <p className="text-[15px] leading-[1.55] whitespace-pre-wrap break-words">{text}</p>
        ) : (
          <p className="text-[13px] text-muted-foreground italic">
            {t.draftSessions.noPostBodyBefore}{" "}
            <span className="font-medium text-foreground">@{authorHandle}</span>
            {t.draftSessions.noPostBodyAfter}
          </p>
        )}
        {mediaUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={mediaUrl}
            alt=""
            className="mt-3 w-full max-h-72 object-cover rounded-xl border border-border"
            onError={(e) => {
              (e.currentTarget as HTMLImageElement).style.display = "none";
            }}
          />
        ) : null}
      </div>
    </article>
  );
}

/** Strip protocol + leading "www." for compact subtitle display. */
function prettyDomain(url: string): string {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "");
    return `${host}${u.pathname}`.slice(0, 64);
  } catch {
    return url.slice(0, 64);
  }
}

// ── Draft option card ──────────────────────────────────────────

/**
 * One alternative draft. Renders as its own selectable card so the operator
 * can pick from multiple options the assistant produced. Each card has its
 * own Save button — saving doesn't lock the others, so the operator can
 * promote multiple alternatives if they want both in the queue.
 */
function DraftOptionCard({
  index,
  text,
  label,
  canDraft,
  saving,
  saved,
  disabled,
  onSave,
  animate,
}: {
  index: number;
  text: string;
  label?: string;
  canDraft: boolean;
  saving: boolean;
  saved: boolean;
  disabled: boolean;
  onSave: () => void;
  /** When true, animate freshly-changed text in via a typewriter sweep. The
   *  page passes this as `isStreaming` so the animation only fires while a
   *  turn is in flight — once streaming ends we settle to the full text and
   *  later card mounts (history reload, page navigation) skip the effect. */
  animate?: boolean;
}) {
  const td = useT().feedPage.draftSessions;
  const displayText = useTypewriter(text, animate ?? false);
  const isTyping = animate && displayText.length < text.length;
  // Renders as `<article>` so the parent (carousel `<li>` or simple `<ul>` row)
  // can choose the list semantics.
  return (
    <article
      className={`rounded-xl border bg-card p-4 transition-all duration-300 ${
        saved
          ? "border-emerald-500/40 bg-emerald-500/5"
          : isTyping
            ? "border-primary/40 shadow-[0_0_0_1px_color-mix(in_srgb,var(--primary)_25%,transparent)]"
            : "border-border"
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">
          {format(td.optionLabel, { index })}{label ? ` · ${label}` : ""}
        </span>
        <span className="text-[10px] text-muted-foreground tabular-nums transition-opacity duration-200">
          {format(td.charsCount, { count: text.length })}
        </span>
      </div>
      <p className="mt-3 text-sm whitespace-pre-wrap leading-relaxed">
        {displayText}
        {isTyping ? (
          <span
            className="inline-block w-[2px] h-[14px] bg-primary rounded-full animate-pulse ml-0.5 align-text-bottom"
            aria-hidden
          />
        ) : null}
      </p>
      {canDraft ? (
        <div className="mt-4 flex justify-end">
          <button
            type="button"
            onClick={onSave}
            disabled={disabled || saving || saved || !text.trim()}
            className={`rounded-md px-3 h-7 text-[11px] font-medium transition-all duration-200 ${
              saved
                ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300 border border-emerald-500/40 cursor-default"
                : "bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40"
            }`}
          >
            <span key={saved ? "saved" : saving ? "saving" : "idle"} className="inline-block animate-fade-in">
              {saved ? td.savedBadge : saving ? td.savingBadge : td.saveAsDraft}
            </span>
          </button>
        </div>
      ) : null}
    </article>
  );
}

/**
 * Skeleton card shown in the cardboard while the assistant is mid-turn but
 * hasn't yet emitted a `proposeDrafts` tool call. The shimmering bars give
 * the operator a visual cue that the assistant is composing — preferable to
 * an empty panel or a static "Waiting…" line which read as "stuck".
 */
function DraftPlaceholderCard() {
  const td = useT().feedPage.draftSessions;
  return (
    <article className="rounded-xl border border-primary/20 bg-card p-4 animate-pulse-soft">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[10px] uppercase tracking-wider text-primary/70 font-semibold">
          {td.draftingLabel}
        </span>
        <span className="skeleton h-2 w-10" />
      </div>
      <div className="mt-3 space-y-1.5">
        <span className="skeleton block h-2.5 w-[92%]" />
        <span className="skeleton block h-2.5 w-[78%]" />
        <span className="skeleton block h-2.5 w-[60%]" />
      </div>
    </article>
  );
}

/**
 * Reveal `target` character-by-character when `enabled` is true, settling to
 * the full string the moment `enabled` flips off. Stable across re-renders:
 * if `target` extends an already-revealed prefix (e.g. proposeDrafts upserts
 * with longer text), the typewriter resumes from where we already are
 * instead of restarting. Pure animation — no scheduling beyond a short
 * setInterval; cleans up on unmount and on every `target` change.
 */
function useTypewriter(target: string, enabled: boolean): string {
  const [shown, setShown] = useState<string>(enabled ? "" : target);
  useEffect(() => {
    if (!enabled) {
      setShown(target);
      return;
    }
    setShown((prev) => (target.startsWith(prev) ? prev : ""));
    let cancelled = false;
    const tick = () => {
      if (cancelled) return;
      setShown((prev) => {
        if (prev.length >= target.length) return prev;
        // Reveal a small chunk per tick so longer drafts don't take seconds.
        const step = Math.max(2, Math.ceil((target.length - prev.length) / 60));
        return target.slice(0, prev.length + step);
      });
    };
    const id = setInterval(tick, 18);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [target, enabled]);
  return shown;
}

// ── Saved drafts panel (inline review) ─────────────────────────

const SAVED_STATUS_BADGE_CLASS: Record<FeedSavedDraftStatus, string> = {
  pending: "bg-primary/15 text-primary ring-1 ring-primary/30",
  posted: "bg-emerald-500/15 text-emerald-300 ring-1 ring-emerald-500/30",
  rejected: "bg-muted text-muted-foreground ring-1 ring-border",
  expired: "bg-muted text-muted-foreground ring-1 ring-border",
  superseded: "bg-muted text-muted-foreground ring-1 ring-border",
  deleted: "bg-muted text-muted-foreground ring-1 ring-border line-through",
};

function savedStatusLabel(
  td: DraftSessionsDict,
  status: FeedSavedDraftStatus,
): string {
  switch (status) {
    case "pending":
      return td.statusReady;
    case "posted":
      return td.statusPosted;
    case "rejected":
      return td.statusRejected;
    case "expired":
      return td.statusExpired;
    case "superseded":
      return td.statusSuperseded;
    case "deleted":
      return td.statusDeleted;
  }
}

/**
 * Inline review list — every saved draft from this session with its current
 * status. This panel is the canonical draft-review surface: pending drafts
 * get Approve/Reject buttons (and an inline edit toggle for last-mile
 * tweaks); posted drafts get a Delete control (take the live post down, or
 * just clear the row); resolved drafts stay visible as audit context with a
 * status badge so the team can see what was already actioned without
 * leaving the chat.
 */
function SavedDraftsPanel(props: {
  drafts: FeedSavedDraft[];
  canDraft: boolean;
  /** Drives the Approve button label: "Approve" for replies (it's a Threads/X
   *  reply on Meta's side) vs "Send post" for original posts (createPost on
   *  Meta's side). The backend already routes correctly based on whether
   *  `replyToId` is set — this is purely a label change so the operator
   *  knows what action they're confirming. */
  sessionIntent: "reply" | "post";
  actingOnDraftId: string | null;
  editingDraftId: string | null;
  editingDraftText: string;
  onStartEdit: (d: FeedSavedDraft) => void;
  onCancelEdit: () => void;
  onChangeEdit: (text: string) => void;
  onApprove: (d: FeedSavedDraft) => void;
  onReject: (d: FeedSavedDraft) => void;
  /** Opens the "delete the live post / remove this record" choice dialog
   *  for an already-posted draft. */
  onDeletePosted: (d: FeedSavedDraft) => void;
}) {
  const td = useT().feedPage.draftSessions;
  if (props.drafts.length === 0) return null;
  const pendingCount = props.drafts.filter((d) => d.status === "pending").length;

  return (
    <section className="space-y-2 pt-2 border-t border-border animate-rise-in">
      <div className="flex items-center justify-between">
        <h3 className="text-[11px] uppercase tracking-wider text-muted-foreground">
          {format(td.reviewHeading, { count: props.drafts.length })}
        </h3>
        {pendingCount > 0 ? (
          <span className="text-[10px] font-semibold text-primary tabular-nums animate-fade-in">
            {format(td.pendingCount, { count: pendingCount })}
          </span>
        ) : null}
      </div>
      <ul className="grid grid-cols-2 gap-3 animate-stagger">
        {props.drafts.map((d) => {
          const isPending = d.status === "pending";
          const isPosted = d.status === "posted";
          const isDeleted = d.status === "deleted";
          const isEditing = props.editingDraftId === d.id;
          const isActing = props.actingOnDraftId === d.id;
          // For posted (and posted-then-deleted) rows, show what actually
          // shipped (operator's edit wins over the model's original
          // proposal). For everything else, show the model's draft.
          const showsPostedText = (isPosted || isDeleted) && d.postedText !== null;
          const displayText = showsPostedText ? d.postedText! : d.draftText;
          const text = isEditing ? props.editingDraftText : displayText;
          const dirty = isEditing && props.editingDraftText !== d.draftText;
          const wasEdited = showsPostedText && d.postedText !== d.draftText;
          return (
            <li key={d.id}>
              <article
                className={
                  "rounded-xl border bg-card p-3 space-y-2 transition-colors duration-300 " +
                  (isPending ? "border-primary/30" : "border-border")
                }
              >
                <div className="flex items-center justify-between gap-2">
                  <span
                    className={
                      "inline-flex items-center rounded-full px-2 h-5 text-[10px] font-semibold uppercase tracking-wide transition-colors duration-300 " +
                      SAVED_STATUS_BADGE_CLASS[d.status]
                    }
                  >
                    {savedStatusLabel(td, d.status)}
                  </span>
                  <span className="text-[10px] text-muted-foreground tabular-nums">
                    {format(td.charsCount, { count: text.length })}
                  </span>
                </div>
                {isEditing ? (
                  <textarea
                    key="edit-textarea"
                    value={props.editingDraftText}
                    onChange={(e) => props.onChangeEdit(e.target.value)}
                    rows={Math.max(3, Math.min(10, text.split("\n").length + 2))}
                    maxLength={500}
                    className="w-full rounded-lg border border-border bg-background px-2.5 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-none animate-fade-in transition-colors"
                  />
                ) : (
                  <div key="view" className="space-y-1.5 animate-fade-in">
                    <p className="text-sm whitespace-pre-wrap leading-relaxed">
                      {displayText}
                    </p>
                    {wasEdited ? (
                      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                        {td.editedBeforePosting}
                      </p>
                    ) : null}
                  </div>
                )}
                {props.canDraft && isPending ? (
                  <div className="flex items-center justify-end gap-2 pt-0.5">
                    {isEditing ? (
                      <button
                        type="button"
                        onClick={props.onCancelEdit}
                        disabled={isActing}
                        className="rounded-lg border border-border bg-card px-3 h-8 text-xs hover:bg-accent disabled:opacity-40 transition-colors"
                      >
                        {td.cancel}
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => props.onStartEdit(d)}
                        disabled={isActing}
                        className="rounded-lg border border-border bg-card px-3 h-8 text-xs text-muted-foreground hover:text-foreground hover:bg-accent disabled:opacity-40 transition-colors"
                      >
                        {td.edit}
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => props.onReject(d)}
                      disabled={isActing}
                      className="rounded-lg border border-border bg-card px-3 h-8 text-xs hover:border-destructive/40 hover:text-destructive hover:bg-accent disabled:opacity-40 transition-colors"
                    >
                      {td.reject}
                    </button>
                    <button
                      type="button"
                      onClick={() => props.onApprove(d)}
                      disabled={isActing || (isEditing && !props.editingDraftText.trim())}
                      className="rounded-lg bg-primary text-primary-foreground px-3 h-8 text-xs font-medium hover:bg-primary/90 disabled:opacity-40 transition-colors"
                    >
                      {isActing
                        ? props.sessionIntent === "post"
                          ? td.sending
                          : td.posting
                        : props.sessionIntent === "post"
                          ? dirty
                            ? td.sendEdit
                            : td.sendPost
                          : dirty
                            ? td.approveEdit
                            : td.approve}
                    </button>
                  </div>
                ) : null}
                {props.canDraft && isPosted ? (
                  // Live on the platform. The Delete control opens the
                  // choice dialog (take the post down vs. just clear this
                  // row). When we only have a reply id (no permalink), the
                  // "View" link is omitted.
                  <div className="flex items-center justify-end gap-2 pt-0.5">
                    {d.postedPermalink ? (
                      <a
                        href={d.postedPermalink}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="mr-auto text-[11px] text-muted-foreground hover:text-foreground underline"
                      >
                        {td.viewOnPlatformArrow}
                      </a>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => props.onDeletePosted(d)}
                      disabled={isActing}
                      className="inline-flex items-center gap-1 rounded-lg border border-border bg-card px-3 h-8 text-xs hover:border-destructive/40 hover:text-destructive hover:bg-accent disabled:opacity-40 transition-colors"
                    >
                      <Trash2 className="h-3 w-3" />
                      {isActing ? td.working : td.delete}
                    </button>
                  </div>
                ) : isDeleted ? (
                  <div className="flex items-center justify-between gap-2 pt-0.5">
                    <span className="text-[11px] text-muted-foreground italic">
                      {td.removedFromPlatform}
                    </span>
                    {d.postedPermalink ? (
                      <a
                        href={d.postedPermalink}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[11px] text-muted-foreground hover:text-foreground underline"
                      >
                        {td.viewArrow}
                      </a>
                    ) : null}
                  </div>
                ) : null}
              </article>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

// ── Draft alternatives parser ──────────────────────────────────

/**
 * Defensive sweep of any literal `<draft>...</draft>` markers from text
 * intended for the chat thread display. The current contract sends drafts
 * via the proposeDrafts tool, not in message body — but old sessions and
 * occasional model regressions might still emit XML tags. Strip them so
 * the operator never sees raw markers in the conversation.
 */
// exported for tests
export function stripDraftMarkers(text: string): string {
  return text
    .replace(/<draft>\s*([\s\S]*?)\s*<\/draft>/gi, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ── Viewer presence avatars ────────────────────────────────────

/**
 * Compact stack of avatar bubbles for everyone currently viewing the
 * session. Renders up to 5 explicit avatars and collapses overflow into
 * a "+N" pill. The current user is shown last (overlapped under the
 * teammates) so the visual focus stays on collaborators. A typing user
 * gets a small animated dot underneath the avatar.
 */
function ActionButton({
  tooltip,
  onClick,
  children,
}: {
  tooltip: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      title={tooltip}
      onClick={onClick}
      className="h-7 w-7 inline-flex items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
    >
      {children}
    </button>
  );
}

function ViewerAvatars({
  viewers,
  meId,
}: {
  viewers: ViewerPresence[];
  meId: string;
}) {
  const td = useT().feedPage.draftSessions;
  if (viewers.length === 0) return null;
  // Sort: teammates first, me last; then by lastSeen recency.
  const sorted = [...viewers].sort((a, b) => {
    if (a.userId === meId && b.userId !== meId) return 1;
    if (b.userId === meId && a.userId !== meId) return -1;
    return Date.parse(b.lastSeen) - Date.parse(a.lastSeen);
  });
  const visible = sorted.slice(0, 5);
  const overflow = sorted.length - visible.length;
  return (
    <div className="flex items-center -space-x-2">
      {visible.map((v) => {
        const isMe = v.userId === meId;
        const initial = (v.name ?? "?").charAt(0).toUpperCase();
        return (
          <div
            key={v.userId}
            className={`relative w-7 h-7 rounded-full border-2 flex items-center justify-center text-[11px] font-semibold ${
              isMe
                ? "bg-primary text-primary-foreground border-background"
                : "bg-muted text-foreground border-background"
            }`}
            title={`${v.name ?? td.unknownViewer}${v.isTyping ? ` ${td.typing}` : ""}`}
          >
            {initial}
            {v.isTyping ? (
              <span
                className="absolute -bottom-1 -right-1 w-2 h-2 rounded-full bg-emerald-500 animate-pulse"
                aria-hidden
              />
            ) : null}
          </div>
        );
      })}
      {overflow > 0 ? (
        <div
          className="relative w-7 h-7 rounded-full border-2 border-background bg-muted text-muted-foreground flex items-center justify-center text-[10px] font-semibold"
          title={format(td.moreViewers, { count: overflow })}
        >
          +{overflow}
        </div>
      ) : null}
    </div>
  );
}

// ── Topic-tag chip (Threads, post-intent only) ───────────────────

/**
 * Inline chip for selecting a single Threads topic tag for the post.
 * Click to switch into edit mode; commit on Enter / blur / `Save`,
 * cancel on Esc, clear via the X button. The committed value is held
 * in parent state and forwarded as `topicTag` on every save-draft body.
 *
 * Validation matches the threads client: forbidden chars (`.`, `&`)
 * are stripped, length is capped at 50, all-whitespace is treated as
 * empty (no tag). The actual API call still re-validates server-side.
 */
function TopicTagChip(props: {
  value: string;
  draft: string;
  isEditing: boolean;
  onStartEdit: () => void;
  onChangeDraft: (next: string) => void;
  onCommit: () => void;
  onCancel: () => void;
  onClear: () => void;
}) {
  const td = useT().feedPage.draftSessions;
  if (props.isEditing) {
    return (
      <div className="flex items-center gap-1 rounded-full border border-primary/40 bg-card px-2 h-7 animate-fade-in">
        <span className="text-primary text-[12px] font-semibold leading-none">#</span>
        <input
          autoFocus
          type="text"
          value={props.draft}
          onChange={(e) => props.onChangeDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              props.onCommit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              props.onCancel();
            }
          }}
          onBlur={props.onCommit}
          maxLength={50}
          placeholder={td.topicPlaceholder}
          className="bg-transparent text-[12px] leading-none focus:outline-none w-28"
        />
      </div>
    );
  }
  if (props.value) {
    return (
      <div className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/5 pl-2 pr-1 h-7">
        <button
          type="button"
          onClick={props.onStartEdit}
          className="text-primary text-[12px] font-medium leading-none focus:outline-none"
          title={td.editTopic}
        >
          #{props.value}
        </button>
        <button
          type="button"
          onClick={props.onClear}
          className="text-muted-foreground hover:text-foreground rounded-full w-5 h-5 flex items-center justify-center text-[10px] leading-none"
          aria-label={td.clearTopic}
          title={td.clearTopic}
        >
          ×
        </button>
      </div>
    );
  }
  return (
    <button
      type="button"
      onClick={props.onStartEdit}
      className="inline-flex items-center gap-1 rounded-full border border-dashed border-border bg-transparent text-muted-foreground hover:text-foreground hover:border-primary/40 px-2 h-7 text-[11px] leading-none transition-colors"
      title={td.addTopicTitle}
    >
      <span className="text-[12px] leading-none">#</span>
      {td.addTopic}
    </button>
  );
}

// ── References stockpile (post-intent) ───────────────────────────

/**
 * Renders the row of reference chips + the active reference's embed.
 * One reference visible at a time so the operator can study a single
 * source without the cardboard becoming a wall of embeds. Click a chip
 * to swap. Newly pasted URLs auto-snap to active in the parent effect,
 * so this component stays presentational.
 */
function ReferencesPanel(props: {
  platform: FeedPlatform;
  references: ParsedPostUrl[];
  activeIdx: number;
  onPick: (idx: number) => void;
}) {
  const td = useT().feedPage.draftSessions;
  const active = props.references[props.activeIdx];
  if (!active) return null;
  return (
    <section className="max-w-2xl mx-auto space-y-2 animate-fade-in pt-2">
      <div className="flex items-center justify-between">
        <h3 className="text-[11px] uppercase tracking-wider text-muted-foreground">
          {format(td.referencesHeading, { count: props.references.length })}
        </h3>
        <a
          href={active.permalink}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[10px] text-muted-foreground hover:text-foreground underline"
        >
          {td.openArrow}
        </a>
      </div>
      {props.references.length > 1 ? (
        <ul className="flex flex-wrap gap-1.5">
          {props.references.map((r, i) => {
            const isActive = i === props.activeIdx;
            return (
              <li key={r.permalink}>
                <button
                  type="button"
                  onClick={() => props.onPick(i)}
                  className={`rounded-full px-2.5 h-6 text-[11px] leading-none border transition-colors ${
                    isActive
                      ? "bg-primary text-primary-foreground border-primary"
                      : "bg-card text-muted-foreground border-border hover:text-foreground hover:border-primary/40"
                  }`}
                  title={r.permalink}
                >
                  @{r.handle}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
      <NativeEmbed
        platform={active.platform}
        permalink={active.permalink}
      />
    </section>
  );
}
