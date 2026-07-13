/**
 * SDK for the Feed (distribution) surface — thin typed wrappers around the
 * closed `/api/distribution/*` routes (`packages/api-platform/src/routes/feed*.ts`),
 * plus the Voice surface's team-memory + tuning-session wrappers over open
 * platform routes (see "Voice (team-scope memories)" below).
 * All calls go through `authFetch` for transparent token refresh.
 *
 * The hosted backend mounts these routes only when distribution platform
 * credentials are configured; an OSS/local backend 404s the whole family.
 * Callers that probe availability (the sidebar's `feedProfiles` signal) treat
 * any error as "feed not available" rather than surfacing it.
 *
 * Wire types are declared locally, mirroring feed-web's context types
 * (`apps/feed-web/src/lib/workspace-context.tsx` pre-port); the server is
 * authoritative. Grows per ported surface (docs/plans/feed-web-consolidation.md §4).
 *
 * [COMP:app-web/feed-sdk]
 */

import { authFetch } from "@/lib/auth-fetch";
import type { FeedPlatform } from "@/lib/feed-nav";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

/** One connected platform account (a `distribution_profiles` row + assistant). */
export type FeedProfile = {
  assistantId: string;
  platform: FeedPlatform;
  platformHandle: string;
  /** Avatar URL fetched from the platform's `/me` call at OAuth time.
   *  Threads populates this; X (Twitter) doesn't yet. Null for connections
   *  established before migration 105 — until they reconnect, components
   *  fall back to the letter-circle avatar. */
  profilePictureUrl: string | null;
  enabled: boolean;
  assistant: {
    id: string;
    name: string;
    /** Deterministic seed for `AssistantAvatar`'s pixel-creature SVG; rows
     *  produced before the column existed return 0, which still renders a
     *  stable creature. */
    iconSeed: number;
  };
};

type ProfilesApiResponse = {
  profiles?: Array<{
    assistantId: string;
    platform: FeedPlatform;
    platformHandle: string;
    profilePictureUrl: string | null;
    enabled: boolean;
    assistant: {
      id: string;
      name: string;
      kind: string;
      appType: string | null;
      iconSeed?: number | null;
    };
  }>;
};

/**
 * The workspace's connected feed profiles. Throws on any non-OK response —
 * including the 404 an OSS/creds-less backend returns for the whole
 * `/api/distribution` family — so availability probes catch and degrade.
 */
export async function fetchFeedTeamProfiles(
  workspaceId: string,
): Promise<FeedProfile[]> {
  const res = await authFetch(
    `${API_URL}/api/distribution/team/${workspaceId}/profiles`,
  );
  if (!res.ok) throw new Error(`feed API ${res.status}`);
  const body = (await res.json()) as ProfilesApiResponse;
  return (body.profiles ?? []).map((p) => ({
    assistantId: p.assistantId,
    platform: p.platform,
    platformHandle: p.platformHandle,
    profilePictureUrl: p.profilePictureUrl ?? null,
    enabled: p.enabled,
    assistant: {
      id: p.assistant.id,
      name: p.assistant.name,
      iconSeed: p.assistant.iconSeed ?? 0,
    },
  }));
}

/**
 * One assistant activity row (a `feed_events` row / a pending approval),
 * narrowed to the fields the home dashboard and the inbox render.
 */
export type FeedActivityEvent = {
  id: string;
  /** Owning assistant. The inbox aggregates approvals across every
   *  connected assistant, so each row carries its own id for action
   *  routing (reject/approve are assistant-scoped endpoints). */
  assistantId: string;
  platform: string;
  eventType: string;
  metadata: {
    text?: string;
    replyText?: string;
    draftText?: string;
    replyAuthor?: string;
    /** Present on L0-human chat-saved drafts; the parent-post permalink
     *  that lets `ExternalPostCard` render the cached structured embed.
     *  L5 pipeline drafts lack this. */
    replyPermalink?: string;
    /** Present on L0-human drafts; drives the deep link into the
     *  unified session view. L5 pipeline drafts lack this. */
    sessionId?: string;
  } | null;
  createdAt: string;
};

/**
 * Recent events for one assistant, optionally filtered by event type.
 * Degrades to `[]` on a non-OK response — feed-web's dashboard contract: a
 * failed panel renders empty, it never errors the page.
 */
export async function fetchFeedAssistantEvents(
  assistantId: string,
  opts: { limit?: number; eventTypes?: readonly string[] } = {},
): Promise<FeedActivityEvent[]> {
  const url = new URL(`${API_URL}/api/distribution/${assistantId}/events`);
  if (opts.limit !== undefined) {
    url.searchParams.set("limit", String(opts.limit));
  }
  if (opts.eventTypes && opts.eventTypes.length > 0) {
    url.searchParams.set("eventTypes", opts.eventTypes.join(","));
  }
  const res = await authFetch(url.toString());
  if (!res.ok) return [];
  const body = (await res.json()) as { events?: FeedActivityEvent[] };
  return body.events ?? [];
}

/**
 * Pending approval rows for one assistant (the dashboard counts them; the
 * inbox surface renders them). Same `[]`-on-error degrade as events.
 */
export async function fetchFeedAssistantApprovals(
  assistantId: string,
  opts: { limit?: number } = {},
): Promise<FeedActivityEvent[]> {
  const url = new URL(`${API_URL}/api/distribution/${assistantId}/approvals`);
  if (opts.limit !== undefined) {
    url.searchParams.set("limit", String(opts.limit));
  }
  const res = await authFetch(url.toString());
  if (!res.ok) return [];
  const body = (await res.json()) as { approvals?: FeedActivityEvent[] };
  return body.approvals ?? [];
}

/**
 * Result of an approve/reject action on a pending draft approval. Non-OK
 * responses surface the server's `error` message and machine `code` (e.g.
 * `DRAFT_NOT_PENDING`, `REPLY_TARGET_UNRESOLVED`, `PUBLISH_AMBIGUOUS`) so
 * callers pick their own user-facing copy; network failures still throw.
 */
export type FeedApprovalActionResult =
  | { ok: true }
  | { ok: false; error: string | null; code: string | null };

async function postFeedApprovalAction(
  url: string,
  body: Record<string, unknown>,
): Promise<FeedApprovalActionResult> {
  const res = await authFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.ok) return { ok: true };
  const data = (await res.json().catch(() => ({}))) as {
    error?: string;
    code?: string;
  };
  return { ok: false, error: data.error ?? null, code: data.code ?? null };
}

/**
 * Approve a pending draft — mints the approval token and posts to the
 * platform (`POST /:assistantId/approvals/:eventId/approve`). Pass `text`
 * only when the approver edited the draft before posting; omitted, the
 * model's saved draft text posts verbatim.
 */
export async function approveFeedDraft(
  assistantId: string,
  eventId: string,
  opts: { text?: string } = {},
): Promise<FeedApprovalActionResult> {
  return postFeedApprovalAction(
    `${API_URL}/api/distribution/${assistantId}/approvals/${eventId}/approve`,
    opts.text !== undefined ? { text: opts.text } : {},
  );
}

/**
 * Reject (dismiss) a pending draft (`POST /:assistantId/approvals/:eventId/reject`).
 * The optional `reason` is recorded on the rejected linker event (the server
 * truncates it to 200 chars) — the inbox passes `"dismissed-from-inbox"`.
 */
export async function rejectFeedDraft(
  assistantId: string,
  eventId: string,
  opts: { reason?: string } = {},
): Promise<FeedApprovalActionResult> {
  return postFeedApprovalAction(
    `${API_URL}/api/distribution/${assistantId}/approvals/${eventId}/reject`,
    opts.reason !== undefined ? { reason: opts.reason } : {},
  );
}

/** Blur range over `FeedExternalPost.text` — Threads' `SPOILER` entity shape. */
export type FeedExternalPostSpoiler = { offset: number; length: number };

/**
 * Structured parent-post data served by the external-post cache
 * (`GET /:assistantId/external-post` — scraped once server-side and cached
 * system-wide, so rendering it costs no per-IP embed-CDN quota).
 */
export type FeedExternalPost = {
  permalink: string;
  authorHandle: string | null;
  authorProfilePictureUrl: string | null;
  text: string | null;
  /** Only present when the parser sourced `text` from the noscript body
   *  walk; null when text came from JSON-LD / og:description (those flatten
   *  spoilers upstream of us). */
  spoilerRanges: FeedExternalPostSpoiler[] | null;
  mediaUrl: string | null;
  mediaType: "TEXT" | "IMAGE" | "VIDEO" | "CAROUSEL" | "AUDIO" | null;
  timestamp: string | null;
  likes: number | null;
  replies: number | null;
  reposts: number | null;
  quotes: number | null;
};

/**
 * Fetch the cached structured post for a permalink. Throws on any non-OK
 * response with the server's `error` reason when present (`HTTP <status>`
 * otherwise) — `ExternalPostCard` catches and degrades to its seed-data
 * shell with the message in the footer (feed-web's card contract).
 */
export async function fetchFeedExternalPost(
  assistantId: string,
  opts: { permalink: string; platform: FeedPlatform },
): Promise<FeedExternalPost> {
  const url = new URL(
    `${API_URL}/api/distribution/${assistantId}/external-post`,
  );
  url.searchParams.set("permalink", opts.permalink);
  url.searchParams.set("platform", opts.platform);
  const res = await authFetch(url.toString());
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  const body = (await res.json()) as { data: FeedExternalPost };
  return body.data;
}

/**
 * Cross-platform pending-approval total for the Feed inbox badge. Returns 0
 * on any error so the badge degrades silently (same contract as
 * `fetchInboxBadgeCount`).
 */
export async function fetchFeedApprovalsCount(
  assistantIds: string[],
): Promise<number> {
  if (assistantIds.length === 0) return 0;
  try {
    const totals = await Promise.all(
      assistantIds.map(async (id) => {
        const res = await authFetch(
          `${API_URL}/api/distribution/${id}/approvals?limit=200`,
        );
        if (!res.ok) return 0;
        const body = (await res.json()) as { approvals?: unknown[] };
        return Array.isArray(body.approvals) ? body.approvals.length : 0;
      }),
    );
    return totals.reduce((a, b) => a + b, 0);
  } catch {
    return 0;
  }
}

// ── Voice (team-scope memories) ──────────────────────────────────────────
//
// Scope exception: the Voice surface edits the assistant's team-scope
// memories through the OPEN platform routes `/api/assistants/:id/memories/*`
// (not `/api/distribution/*`). No other app-web SDK module wraps them, so
// they live here with the rest of the feed surface's wrappers
// (docs/plans/feed-web-consolidation.md §7.3).

/** One team-scope memory row as the Voice page renders it. */
export type FeedVoiceMemory = {
  id: string;
  type: string;
  summary: string | null;
  detail: string | null;
  tags: string[] | null;
  sensitivity: string | null;
  updatedAt: string;
};

/** Fields the Voice form writes. `detail` is dropped server-side when empty. */
export type FeedVoiceMemoryInput = {
  summary: string;
  detail?: string;
  type?: string;
  tags: string[];
  sensitivity: string;
};

/**
 * Result of a voice-memory create/update. Non-OK responses surface the
 * server's `error` message so the form picks its own fallback copy;
 * network failures still throw (feed-web's form contract).
 */
export type FeedVoiceMutationResult =
  | { ok: true }
  | { ok: false; error: string | null };

/**
 * The assistant's team-scope memories (`GET /:id/memories/team`). Throws on
 * any non-OK response — the Voice page catches and shows its load-failed
 * banner.
 */
export async function fetchFeedVoiceMemories(
  assistantId: string,
  opts: { limit?: number } = {},
): Promise<{ memories: FeedVoiceMemory[]; total: number }> {
  const url = new URL(`${API_URL}/api/assistants/${assistantId}/memories/team`);
  if (opts.limit !== undefined) {
    url.searchParams.set("limit", String(opts.limit));
  }
  const res = await authFetch(url.toString());
  if (!res.ok) throw new Error(`memories API ${res.status}`);
  const body = (await res.json()) as {
    memories?: FeedVoiceMemory[];
    total?: number;
  };
  return { memories: body.memories ?? [], total: body.total ?? 0 };
}

async function sendFeedVoiceMutation(
  url: string,
  method: "POST" | "PATCH",
  body: Record<string, unknown>,
): Promise<FeedVoiceMutationResult> {
  const res = await authFetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.ok) return { ok: true };
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  return { ok: false, error: data.error ?? null };
}

/** Create a team-scope voice rule (`POST /:id/memories/team`). */
export async function createFeedVoiceMemory(
  assistantId: string,
  input: FeedVoiceMemoryInput,
): Promise<FeedVoiceMutationResult> {
  return sendFeedVoiceMutation(
    `${API_URL}/api/assistants/${assistantId}/memories/team`,
    "POST",
    input,
  );
}

/**
 * Update a voice rule (`PATCH /:id/memories/:memoryId`). Mirrors feed-web's
 * edit form: `type` is never sent (the form shows it, the PATCH omits it).
 */
export async function updateFeedVoiceMemory(
  assistantId: string,
  memoryId: string,
  input: Omit<FeedVoiceMemoryInput, "type">,
): Promise<FeedVoiceMutationResult> {
  return sendFeedVoiceMutation(
    `${API_URL}/api/assistants/${assistantId}/memories/${memoryId}`,
    "PATCH",
    input,
  );
}

/**
 * Delete a voice rule (`DELETE /:id/memories/:memoryId`). Fire-and-forget
 * parity with feed-web: the HTTP status is ignored (the row is removed
 * optimistically); only a network failure throws, which keeps the row
 * visible.
 */
export async function deleteFeedVoiceMemory(
  assistantId: string,
  memoryId: string,
): Promise<void> {
  await authFetch(`${API_URL}/api/assistants/${assistantId}/memories/${memoryId}`, {
    method: "DELETE",
  });
}

/**
 * The persisted session id for one user + assistant + channel
 * (`GET /api/sessions/by-channel` — the tuning chat resumes
 * `channelId='tuning'`, same semantics as feed-web's standalone /chat page).
 * Returns `null` when none exists (404) or on any error — the panel starts
 * a fresh chat; the composer still works.
 */
export async function fetchFeedSessionIdByChannel(
  assistantId: string,
  channelId: string,
): Promise<string | null> {
  try {
    const res = await authFetch(
      `${API_URL}/api/sessions/by-channel?assistantId=${encodeURIComponent(assistantId)}&channelId=${encodeURIComponent(channelId)}`,
    );
    if (!res.ok) return null;
    const body = (await res.json()) as { id?: string };
    return body.id ?? null;
  } catch {
    return null;
  }
}

// ── Draft sessions (per-draft refine chat) ────────────────────────────────
//
// Wrappers over `packages/api/src/routes/feed-draft-sessions.ts` +
// `feed.ts`'s delete-published family, mirroring the calls feed-web's
// draft-sessions pages made inline (docs/plans/feed-web-consolidation.md
// §7.4). The session SSE stream (`GET .../:sessionId/stream`) and the
// `/api/chat` fetch-stream deliberately stay INLINE in
// `draft-session-detail.tsx` — streams don't belong in the RPC SDK.

/** Mirrors `ReplyTarget` in `packages/api/src/db/draft-session-store.ts`. */
type FeedReplyTargetSummary = {
  authorHandle: string;
  text: string;
  permalink: string | null;
};

export type FeedSavedDraftStatus =
  | "pending"
  | "posted"
  | "rejected"
  | "expired"
  | "superseded"
  /** Was posted, then the live post was deleted from the platform. */
  | "deleted";

/** Persisted seed intent (`sessions.seed_kind`, migration 107). */
export type FeedDraftSeedKind =
  | "inspiration-reply"
  | "inspiration-original"
  | "freeform"
  | "freeform-reply";

/**
 * Subset of `DraftSessionSeed` (`packages/api/src/db/draft-session-store.ts`)
 * the list + inspiration pages send at create time. Keep aligned with the
 * server-side parser in `feed-draft-sessions.ts` → `parseSeed`. Inspiration
 * seeds carry no permalink — their `externalId` is already the platform id
 * the scan returned (for Threads, the Graph API media id).
 */
export type FeedDraftSessionSeed =
  | { kind: "freeform" }
  | {
      kind: "freeform-reply";
      candidate: {
        platform: FeedPlatform;
        externalId: string;
        authorHandle: string;
        text: string;
        permalink: string;
      };
    }
  | {
      kind: "inspiration-reply" | "inspiration-original";
      candidate: {
        platform: FeedPlatform;
        externalId: string;
        authorHandle: string;
        text: string;
      };
    };

/** One row of `GET /:assistantId/draft-sessions` as the list page renders it. */
export type FeedDraftSessionSummary = {
  id: string;
  platform: FeedPlatform;
  title: string;
  startedBy: { id: string; name: string | null };
  createdAt: string;
  lastActiveAt: string;
  preview: string | null;
  /** Parsed from the seed message — drives the per-card parent-post preview
   *  when the original post permalink is known. Older sessions return null
   *  (or a null permalink) and fall back to the post-draft / chat-preview
   *  path. */
  replyTarget: FeedReplyTargetSummary | null;
  /** First option from the latest `proposeDrafts` call. */
  draftText: string | null;
  /** The saved draft the team committed to — wins over `draftText` in the
   *  card body. For posted/deleted drafts `text` is the actually published
   *  body (edits-on-approve included). */
  selectedDraft: { text: string; status: FeedSavedDraftStatus } | null;
  draftCounts: {
    pending: number;
    posted: number;
    rejected: number;
    /** Posted, then the live post was taken down. */
    deleted: number;
  };
  /** Persisted intent; `undefined` on older API responses, `null` on
   *  pre-migration-107 rows (the detail page's legacy fallback derivation). */
  seedKind?: FeedDraftSeedKind | null;
};

/**
 * Saved draft surfaced inline on the session detail page — mirrors a
 * `drafted/safety-pass` event promoted from the session via "Save as draft"
 * (`GET /:assistantId/draft-sessions/:sessionId/saved-drafts`).
 */
export type FeedSavedDraft = {
  id: string;
  platform: FeedPlatform;
  platformReplyId: string | null;
  /** The model's original proposal — preserved for audit. */
  draftText: string;
  /** What actually posted (after any approver edit); non-null when status
   *  is `posted` or `deleted`. */
  postedText: string | null;
  /** Platform media id of the published post — the delete-published handle. */
  postedMediaId: string | null;
  postedPermalink: string | null;
  replyAuthor: string | null;
  replyText: string | null;
  status: FeedSavedDraftStatus;
  createdAt: string;
  resolvedAt: string | null;
};

/**
 * Generic non-throwing mutation result for the draft-session RPCs — the
 * server's `error` message is surfaced so callers pick their own fallback
 * copy (feed-web's inline-`setError` contract); network failures still throw.
 */
export type FeedDraftMutationResult =
  | { ok: true }
  | { ok: false; error: string | null };

/**
 * The platform-scoped draft sessions
 * (`GET /:assistantId/draft-sessions?platform=`). Throws on any non-OK
 * response — the list page catches and shows its load-failed banner.
 */
export async function fetchFeedDraftSessions(
  assistantId: string,
  platform: FeedPlatform,
): Promise<FeedDraftSessionSummary[]> {
  const res = await authFetch(
    `${API_URL}/api/distribution/${assistantId}/draft-sessions?platform=${platform}`,
  );
  if (!res.ok) throw new Error(`draft sessions API ${res.status}`);
  const body = (await res.json()) as { sessions?: FeedDraftSessionSummary[] };
  return body.sessions ?? [];
}

/**
 * Create a draft session (`POST /:assistantId/draft-sessions`). The seed is
 * the operator's **explicit** intent ("+ New post" vs "Reply to URL") —
 * persisted on `sessions.seed_kind`, never re-classified by later URL pastes.
 */
export async function createFeedDraftSession(
  assistantId: string,
  body: { platform: FeedPlatform; seed?: FeedDraftSessionSeed },
): Promise<
  | { ok: true; session: FeedDraftSessionSummary }
  | { ok: false; error: string | null }
> {
  const res = await authFetch(
    `${API_URL}/api/distribution/${assistantId}/draft-sessions`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        platform: body.platform,
        ...(body.seed ? { seed: body.seed } : {}),
      }),
    },
  );
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    return { ok: false, error: data.error ?? null };
  }
  const data = (await res.json()) as { session: FeedDraftSessionSummary };
  return { ok: true, session: data.session };
}

/** Discard a draft session (`DELETE /:assistantId/draft-sessions/:sessionId`). */
export async function deleteFeedDraftSession(
  assistantId: string,
  sessionId: string,
): Promise<FeedDraftMutationResult> {
  const res = await authFetch(
    `${API_URL}/api/distribution/${assistantId}/draft-sessions/${sessionId}`,
    { method: "DELETE" },
  );
  if (res.ok) return { ok: true };
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  return { ok: false, error: data.error ?? null };
}

/**
 * The session's saved drafts with resolution status
 * (`GET /:assistantId/draft-sessions/:sessionId/saved-drafts`). Returns
 * `null` on any non-OK response — both callers treat a failed refresh as
 * non-fatal (the panel stays stale; the next action refreshes it).
 */
export async function fetchFeedSavedDrafts(
  assistantId: string,
  sessionId: string,
): Promise<FeedSavedDraft[] | null> {
  const res = await authFetch(
    `${API_URL}/api/distribution/${assistantId}/draft-sessions/${sessionId}/saved-drafts`,
  );
  if (!res.ok) return null;
  const body = (await res.json().catch(() => ({}))) as {
    drafts?: FeedSavedDraft[];
  };
  return body.drafts ?? [];
}

/** Decode outcome the save-draft route reports for URL-paste reply targets. */
export type FeedSaveDraftReply =
  | { resolved: true; mediaId: string }
  | { resolved: false; reason: string };

/**
 * Promote a draft option into the approval queue
 * (`POST /:assistantId/draft-sessions/:sessionId/save-draft`). The optional
 * `reply` carries the target the operator sees on the cardboard (including
 * the canonical permalink so the backend can resolve a Threads shortcode to
 * the Graph media id); `topicTag` is Threads/post-intent only.
 */
export async function saveFeedSessionDraft(
  assistantId: string,
  sessionId: string,
  body: {
    text: string;
    platform: FeedPlatform;
    topicTag?: string;
    reply?: {
      externalId: string;
      authorHandle: string;
      text: string;
      permalink?: string;
    };
  },
): Promise<
  | { ok: true; reply?: FeedSaveDraftReply }
  | { ok: false; error: string | null }
> {
  const res = await authFetch(
    `${API_URL}/api/distribution/${assistantId}/draft-sessions/${sessionId}/save-draft`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    return { ok: false, error: data.error ?? null };
  }
  const data = (await res.json().catch(() => ({}))) as {
    reply?: FeedSaveDraftReply;
  };
  return { ok: true, reply: data.reply };
}

/**
 * Take a published post down on the platform
 * (`DELETE /:assistantId/posts/:mediaId`).
 */
export async function deleteFeedPublishedPost(
  assistantId: string,
  mediaId: string,
): Promise<FeedDraftMutationResult> {
  const res = await authFetch(
    `${API_URL}/api/distribution/${assistantId}/posts/${mediaId}`,
    { method: "DELETE" },
  );
  if (res.ok) return { ok: true };
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  return { ok: false, error: data.error ?? null };
}

/**
 * Clear a posted draft's audit row without touching the live post
 * (`POST /:assistantId/saved-drafts/:eventId/remove`).
 */
export async function removeFeedSavedDraftRecord(
  assistantId: string,
  eventId: string,
): Promise<FeedDraftMutationResult> {
  const res = await authFetch(
    `${API_URL}/api/distribution/${assistantId}/saved-drafts/${eventId}/remove`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    },
  );
  if (res.ok) return { ok: true };
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  return { ok: false, error: data.error ?? null };
}

/**
 * Typing beacon (`POST /:assistantId/draft-sessions/:sessionId/typing`).
 * Fire-and-forget: every failure is swallowed (feed-web's `.catch(() => {})`
 * contract) — presence is best-effort.
 */
export async function sendFeedDraftTypingPing(
  assistantId: string,
  sessionId: string,
  isTyping: boolean,
): Promise<void> {
  try {
    await authFetch(
      `${API_URL}/api/distribution/${assistantId}/draft-sessions/${sessionId}/typing`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isTyping }),
      },
    );
  } catch {
    // best-effort
  }
}

// ── Insights (per-post metrics dashboard) ─────────────────────────────────
//
// Wrappers over `packages/api-platform/src/routes/feed-insights.ts`,
// mirroring the calls feed-web's insights page made inline
// (docs/plans/feed-web-consolidation.md §7.5).

/** Flat profile / per-post metric bag — the server omits what a platform
 *  doesn't report (Threads has no quote counts on old rows, etc.). */
export type FeedInsightsMetrics = Partial<{
  views: number;
  likes: number;
  replies: number;
  reposts: number;
  quotes: number;
  followers_count: number;
}>;

export type FeedInsightsPostKind = "post" | "reply" | "quote";

export type FeedInsightsPost = {
  id: string;
  kind: FeedInsightsPostKind;
  permalink: string | null;
  text: string | null;
  timestamp: string | null;
  repliedToId: string | null;
  insights: FeedInsightsMetrics;
  /** Set when the platform refused per-post insights for this row. */
  error?: string;
};

/** One day of the profile trend series. `followers` is a snapshot column and
 *  is null on days without a snapshot; the aggregates default to 0. */
export type FeedInsightsTrendDay = {
  day: string;
  followers: number | null;
  views: number;
  likes: number;
  replies: number;
  reposts: number;
  quotes: number;
};

export type FeedInsightsResponse = {
  handle: string;
  range: { since: string; until: string };
  priorRange: { since: string; until: string } | null;
  profile: FeedInsightsMetrics;
  priorProfile: FeedInsightsMetrics | null;
  trends: FeedInsightsTrendDay[];
  posts: FeedInsightsPost[];
};

/**
 * The account + per-post insights dashboard for one platform and range
 * (`GET /:assistantId/:platform/insights?since&until`). Throws on any non-OK
 * response with the server's `error` reason when present (`HTTP <status>`
 * otherwise) — the page catches and shows its error banner.
 */
export async function fetchFeedInsights(
  assistantId: string,
  platform: FeedPlatform,
  opts: { since: string; until: string },
): Promise<FeedInsightsResponse> {
  const qs = new URLSearchParams({ since: opts.since, until: opts.until });
  const res = await authFetch(
    `${API_URL}/api/distribution/${assistantId}/${platform}/insights?${qs.toString()}`,
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as FeedInsightsResponse;
}

/** One recent @-mention / quote row from the distribution audit log. */
export type FeedMentionItem = {
  id: string;
  text: string | null;
  username: string | null;
  /** ISO-8601 — platform timestamp when available, else ingest time. */
  timestamp: string | null;
};

/**
 * Recent @-mentions in the range (`GET /:assistantId/:platform/mentions`).
 * Degrades to `[]` on a non-OK response — feed-web's panel contract: a
 * failed mentions panel renders empty, it never errors the page.
 */
export async function fetchFeedMentions(
  assistantId: string,
  platform: FeedPlatform,
  opts: { days: number; limit: number },
): Promise<FeedMentionItem[]> {
  const res = await authFetch(
    `${API_URL}/api/distribution/${assistantId}/${platform}/mentions?days=${opts.days}&limit=${opts.limit}`,
  );
  if (!res.ok) return [];
  const body = (await res.json()) as { mentions?: FeedMentionItem[] };
  return body.mentions ?? [];
}

/**
 * Recent quote tweets in the range (`GET /:assistantId/twitter/quotes`) —
 * X only (Threads has no quote concept; the backend route is
 * twitter-scoped). Same `[]`-on-error degrade as mentions.
 */
export async function fetchFeedQuotes(
  assistantId: string,
  opts: { days: number; limit: number },
): Promise<FeedMentionItem[]> {
  const res = await authFetch(
    `${API_URL}/api/distribution/${assistantId}/twitter/quotes?days=${opts.days}&limit=${opts.limit}`,
  );
  if (!res.ok) return [];
  const body = (await res.json()) as { quotes?: FeedMentionItem[] };
  return body.quotes ?? [];
}

// ── Inspiration (keyword scan + config) ───────────────────────────────────
//
// Wrappers over `packages/api-platform/src/routes/feed-inspiration.ts`,
// mirroring the calls feed-web's inspiration page made inline
// (docs/plans/feed-web-consolidation.md §7.5). The config is shared between
// both platforms server-side (two reserved-key team memory rows); the
// `platform` argument picks the route family and the connection payload.

/** The shared keyword/topic scan config. */
export type FeedInspirationConfig = {
  keywords: string[];
  resultCount: number;
};

/**
 * Connection summary the GET returns next to the config. `scope` and
 * `hasListReadScope` are Twitter-only (the Threads payload carries just
 * `connected` + `handle`).
 */
export type FeedInspirationConnection = {
  connected: boolean;
  handle: string | null;
  scope?: string | null;
  hasListReadScope?: boolean;
};

/** One scan hit — a platform post worth replying to / quoting. */
export type FeedInspirationCandidate = {
  platform: string;
  externalId: string;
  text: string;
  author: { handle: string; displayName?: string };
  publishedAt: string;
  engagement: { likes?: number; reposts?: number; replies?: number };
  source: string;
  whyMatch?: string;
  score?: number;
};

/** Per-keyword scan failure the server reports without failing the scan. */
export type FeedInspirationScanWarning = { keyword: string; message: string };

/**
 * The inspiration config + connection summary
 * (`GET /:assistantId/:platform/inspiration`). Throws on any non-OK
 * response — the page's config loader catches into its load-failed copy;
 * the Twitter connection probe catches and stays null.
 */
export async function fetchFeedInspiration(
  assistantId: string,
  platform: FeedPlatform,
): Promise<{
  config: FeedInspirationConfig | undefined;
  connection: FeedInspirationConnection | undefined;
}> {
  const res = await authFetch(
    `${API_URL}/api/distribution/${assistantId}/${platform}/inspiration`,
  );
  if (!res.ok) throw new Error(`inspiration API ${res.status}`);
  const body = (await res.json()) as {
    config?: FeedInspirationConfig;
    connection?: FeedInspirationConnection;
  };
  return { config: body.config, connection: body.connection };
}

/**
 * Upsert the inspiration config (`PUT /:assistantId/:platform/inspiration`,
 * draft permission required). Returns the server-echoed config; throws on
 * any non-OK response — the form catches into its save-failed copy.
 */
export async function saveFeedInspirationConfig(
  assistantId: string,
  platform: FeedPlatform,
  config: FeedInspirationConfig,
): Promise<FeedInspirationConfig | undefined> {
  const res = await authFetch(
    `${API_URL}/api/distribution/${assistantId}/${platform}/inspiration`,
    {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(config),
    },
  );
  if (!res.ok) throw new Error(`inspiration API ${res.status}`);
  const body = (await res.json()) as { config?: FeedInspirationConfig };
  return body.config;
}

/**
 * Run a keyword scan (`POST /:assistantId/:platform/inspiration/scan`).
 * Non-OK responses surface the server's `error` message so the page picks
 * its own fallback copy (feed-web's inline-`setScanError` contract);
 * network failures still throw. `warnings` maps the server's per-keyword
 * `errors` list.
 */
export async function runFeedInspirationScan(
  assistantId: string,
  platform: FeedPlatform,
): Promise<
  | {
      ok: true;
      candidates: FeedInspirationCandidate[];
      warnings: FeedInspirationScanWarning[];
    }
  | { ok: false; error: string | null }
> {
  const res = await authFetch(
    `${API_URL}/api/distribution/${assistantId}/${platform}/inspiration/scan`,
    { method: "POST" },
  );
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    return { ok: false, error: data.error ?? null };
  }
  const body = (await res.json()) as {
    candidates?: FeedInspirationCandidate[];
    errors?: FeedInspirationScanWarning[];
  };
  return {
    ok: true,
    candidates: body.candidates ?? [],
    warnings: body.errors ?? [],
  };
}

// ── Connection + reply policy + members (settings surfaces) ───────────────────
//
// Wrappers over the profile-detail slice of the distribution routes
// (`GET /:assistantId`, `PATCH`/`DELETE /:assistantId/:platform` in
// `packages/api-platform/src/routes/feed.ts`) plus — scope exception, same
// as Voice above — the OPEN workspace members routes
// (`GET /api/workspaces/:id`, `PATCH .../members/:userId/permissions` in
// `sidanclaw/packages/api/src/routes/workspaces.ts`), which no other app-web
// SDK module wraps (docs/plans/feed-web-consolidation.md §7.6).

/** `distribution_profiles.auto_reply_mode` — how inbound replies are handled. */
export type FeedAutoReplyMode = "disabled" | "draft-only" | "auto-whitelisted";

/** The structured `reply_policy` JSON the policy editor round-trips. */
export type FeedReplyPolicy = {
  whitelistHandles?: string[];
  blockedTopics?: string[];
};

/**
 * One per-assistant profile row with its policy fields — the
 * `GET /:assistantId` detail shape (the team profiles list omits
 * `autoReplyMode`/`replyPolicy`; this one carries them).
 */
export type FeedProfilePolicy = {
  assistantId: string;
  platform: FeedPlatform;
  platformHandle: string;
  enabled: boolean;
  autoReplyMode: FeedAutoReplyMode;
  replyPolicy: FeedReplyPolicy;
};

/**
 * Generic non-throwing mutation result for the settings-surface RPCs — the
 * server's `error` message is surfaced so callers pick their own fallback
 * copy (feed-web's inline-`setError` contract); network failures still throw.
 */
export type FeedSettingsMutationResult =
  | { ok: true }
  | { ok: false; error: string | null };

/**
 * All profiles for one assistant with policy fields (`GET /:assistantId`).
 * Throws on any non-OK response — the policy page catches into its
 * load-failed banner.
 */
export async function fetchFeedAssistantProfiles(
  assistantId: string,
): Promise<FeedProfilePolicy[]> {
  const res = await authFetch(`${API_URL}/api/distribution/${assistantId}`);
  if (!res.ok) throw new Error(`profile API ${res.status}`);
  const body = (await res.json()) as { profiles?: FeedProfilePolicy[] };
  return body.profiles ?? [];
}

/**
 * Update a profile's reply policy (`PATCH /:assistantId/:platform`, team
 * admin gated server-side). The body ships `autoReplyMode` + the whole
 * `replyPolicy` object verbatim (feed-web's save contract).
 */
export async function updateFeedProfilePolicy(
  assistantId: string,
  platform: FeedPlatform,
  body: { autoReplyMode: FeedAutoReplyMode; replyPolicy: FeedReplyPolicy },
): Promise<FeedSettingsMutationResult> {
  const res = await authFetch(
    `${API_URL}/api/distribution/${assistantId}/${platform}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
  if (res.ok) return { ok: true };
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  return { ok: false, error: data.error ?? null };
}

/**
 * Disconnect one platform (`DELETE /:assistantId/:platform`, team admin
 * gated server-side). Drops the profile row and its encrypted credentials.
 */
export async function disconnectFeedProfile(
  assistantId: string,
  platform: FeedPlatform,
): Promise<FeedSettingsMutationResult> {
  const res = await authFetch(
    `${API_URL}/api/distribution/${assistantId}/${platform}`,
    { method: "DELETE" },
  );
  if (res.ok) return { ok: true };
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  return { ok: false, error: data.error ?? null };
}

/** One workspace member row as the feed settings members page renders it.
 *  `id` is the `workspace_members` row id — what `tasks.assignee_id` stores,
 *  distinct from the account-level `userId`. */
export type FeedWorkspaceMember = {
  id: string;
  userId: string;
  email: string | null;
  userName: string | null;
  avatarUrl: string | null;
  role: "owner" | "admin" | "member";
  canDraft: boolean;
};

/**
 * The workspace's member list (`GET /api/workspaces/:workspaceId` — the
 * detail response's `members`). Throws on any non-OK response — the members
 * page catches into its load-failed banner.
 */
export async function fetchFeedWorkspaceMembers(
  workspaceId: string,
): Promise<FeedWorkspaceMember[]> {
  const res = await authFetch(`${API_URL}/api/workspaces/${workspaceId}`);
  if (!res.ok) throw new Error(`workspace API ${res.status}`);
  const body = (await res.json()) as { members?: FeedWorkspaceMember[] };
  return body.members ?? [];
}

/**
 * Toggle a member's `can_draft` flag
 * (`PATCH /api/workspaces/:workspaceId/members/:userId/permissions`,
 * admin/owner gated server-side; the backend 400s admin/owner targets).
 */
export async function updateFeedMemberDraftPermission(
  workspaceId: string,
  userId: string,
  canDraft: boolean,
): Promise<FeedSettingsMutationResult> {
  const res = await authFetch(
    `${API_URL}/api/workspaces/${workspaceId}/members/${userId}/permissions`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ canDraft }),
    },
  );
  if (res.ok) return { ok: true };
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  return { ok: false, error: data.error ?? null };
}
