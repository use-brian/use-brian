"use client";

/**
 * One post, edited in place (feed-revamp.md §8a, D15-D18).
 *
 * Left: the post itself — title, version chips, the caption editor, and the
 * actions its state allows. Right: the refine chat, hosted by the shared
 * `TuningChatPanel` against THIS post's session rather than a sticky channel.
 * There is no "open to iterate" any more: this IS the surface, and the post
 * list that used to sit beside it lives in the sidebar.
 *
 * Versions (D17): the assistant's `proposeDrafts` alternatives are immutable
 * chips; the first keystroke forks one into the operator's own version, so an
 * edit never overwrites what the model wrote and a re-proposal never
 * overwrites the edit. `Use this version` commits whichever is shown.
 *
 * [COMP:app-web/feed-post-editor]
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Check, Copy, Trash2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n/format";
import { useFeedWorkspace } from "@/contexts/feed-profiles-context";
import { PlatformIcon } from "@/components/feed/platform-icon";
import { StatusLabel } from "@/components/feed/feed-status";
import { CaptionEditor } from "@/components/feed/caption-editor";
import { TuningChatPanel } from "@/components/feed/tuning-chat-panel";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { webAppUrl } from "@/lib/primary-auth";
import {
  approveFeedDraft,
  createFeedDraftSession,
  deleteFeedDraftSession,
  fetchFeedDraftSessions,
  fetchFeedSavedDrafts,
  markFeedReadyPostPosted,
  rejectFeedDraft,
  saveFeedSessionDraft,
  type FeedDraftSessionSummary,
  type FeedSavedDraft,
} from "@/lib/api/feed";
import { fetchSessionMessages } from "@/lib/api/sessions";
import { feedPath, feedPostPath, type FeedPlatform } from "@/lib/feed-nav";
import {
  displayPostTitle,
  postQueueStatus,
  type PostQueueStatus,
} from "@/lib/feed-posts";
import { notifyFeedPostsChanged } from "@/lib/feed-posts-events";
import {
  buildVersions,
  resolveSelectedVersion,
  type ProposedDraft,
} from "@/lib/feed-post-versions";

const PROPOSE_DRAFTS_TOOL = "proposeDrafts";

/**
 * Replay `proposeDrafts` tool calls out of the session history into the
 * current alternatives. Upsert by index: reusing an index revises that
 * alternative, a new index adds one. Defensive throughout — a half-streamed
 * or malformed call must be ignored, never crash the pane.
 */
export function replayProposals(
  rows: readonly { role?: string; content?: unknown }[],
): ProposedDraft[] {
  const byIndex = new Map<number, ProposedDraft>();
  for (const row of rows) {
    if (row.role !== "assistant" || !Array.isArray(row.content)) continue;
    for (const block of row.content) {
      if (typeof block !== "object" || block === null) continue;
      const b = block as { type?: string; name?: string; input?: unknown };
      if (b.type !== "tool_use" || b.name !== PROPOSE_DRAFTS_TOOL) continue;
      const input = b.input as { drafts?: unknown } | null;
      if (!input || !Array.isArray(input.drafts)) continue;
      for (const entry of input.drafts) {
        if (typeof entry !== "object" || entry === null) continue;
        const d = entry as Record<string, unknown>;
        const index =
          typeof d.index === "number" && Number.isInteger(d.index)
            ? d.index
            : null;
        const text = typeof d.text === "string" ? d.text : null;
        if (index === null || index < 1 || !text) continue;
        byIndex.set(index, {
          index,
          text,
          ...(typeof d.label === "string" ? { label: d.label } : {}),
          ...(typeof d.imageBrief === "string"
            ? { imageBrief: d.imageBrief }
            : {}),
        });
      }
    }
  }
  return [...byIndex.values()].sort((a, b) => a.index - b.index);
}

export function PostEditor({
  platform,
  sessionId,
}: {
  platform: FeedPlatform;
  sessionId: string | null;
}) {
  const team = useFeedWorkspace();
  const t = useT().feedPage;
  const te = t.postEditor;

  const assistant = team.profiles[0]?.assistant ?? team.assistants[0] ?? null;
  const assistantId = assistant?.id ?? null;

  if (!assistantId) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
        {te.loadFailed}
      </div>
    );
  }
  if (!sessionId) {
    return (
      <NewPost
        assistantId={assistantId}
        platform={platform}
        workspaceId={team.workspaceId}
      />
    );
  }
  return (
    <PostPane
      key={sessionId}
      assistantId={assistantId}
      assistantName={assistant?.name ?? ""}
      platform={platform}
      sessionId={sessionId}
      workspaceId={team.workspaceId}
    />
  );
}

/** The `+ New post` target: name it, then the editor opens on the real post. */
function NewPost({
  assistantId,
  platform,
  workspaceId,
}: {
  assistantId: string;
  platform: FeedPlatform;
  workspaceId: string;
}) {
  const te = useT().feedPage.postEditor;
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const trimmed = title.trim();
      const result = await createFeedDraftSession(assistantId, {
        platform,
        ...(trimmed ? { title: trimmed } : {}),
      });
      if (!result.ok) {
        setError(result.error ?? te.createFailed);
        return;
      }
      notifyFeedPostsChanged();
      router.push(feedPostPath(workspaceId, platform, result.session.id));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full items-center justify-center px-6">
      <div className="w-full max-w-sm space-y-4 text-center">
        <h1 className="text-[15px] font-semibold">{te.newPost}</h1>
        <p className="text-sm leading-relaxed text-muted-foreground">
          {te.newPostBody}
        </p>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={te.newPostTitlePlaceholder}
          disabled={busy}
          className="h-9 w-full rounded-lg border border-border bg-background px-3 text-sm focus:border-primary/50 focus:outline-none disabled:opacity-50"
        />
        <button
          type="button"
          onClick={() => void create()}
          disabled={busy}
          className="inline-flex h-8 w-full items-center justify-center rounded-lg bg-primary px-3 text-[12.5px] font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
        >
          {busy ? te.creating : te.createPost}
        </button>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
      </div>
    </div>
  );
}

function PostPane({
  assistantId,
  assistantName,
  platform,
  sessionId,
  workspaceId,
}: {
  assistantId: string;
  assistantName: string;
  platform: FeedPlatform;
  sessionId: string;
  workspaceId: string;
}) {
  const t = useT().feedPage;
  const te = t.postEditor;
  const router = useRouter();

  const [session, setSession] = useState<FeedDraftSessionSummary | null>(null);
  const [drafts, setDrafts] = useState<FeedSavedDraft[]>([]);
  const [proposals, setProposals] = useState<ProposedDraft[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  // The operator's fork. Null until they diverge from a proposal (D17).
  const [ownText, setOwnText] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    const [sessions, saved, rows] = await Promise.all([
      fetchFeedDraftSessions(assistantId, platform).catch(
        () => [] as FeedDraftSessionSummary[],
      ),
      fetchFeedSavedDrafts(assistantId, sessionId),
      fetchSessionMessages(sessionId),
    ]);
    const found = sessions.find((s) => s.id === sessionId) ?? null;
    if (!found) setError(te.loadFailed);
    setSession(found);
    setDrafts(saved ?? []);
    setProposals(replayProposals(rows));
    setLoading(false);
  }, [assistantId, platform, sessionId, te.loadFailed]);

  useEffect(() => {
    void load();
  }, [load]);

  const committed = useMemo(
    () =>
      drafts.find((d) => d.status === "pending" || d.status === "ready")
      ?? drafts.find((d) => d.status === "posted")
      ?? null,
    [drafts],
  );

  const versions = useMemo(
    () =>
      buildVersions({
        proposals,
        ownText,
        savedText: committed?.postedText ?? committed?.draftText ?? null,
      }),
    [proposals, ownText, committed],
  );
  const selected = resolveSelectedVersion(versions, selectedId);
  const status: PostQueueStatus = session
    ? postQueueStatus(session)
    : "drafting";

  // A committed post is read-only: editing something already approved or
  // posted would let the copy drift away from what was actually reviewed.
  const readOnly = status === "ready" || status === "posted";

  /** Idle autosave from the caption editor. Writes the operator's fork. */
  const saveCaption = useCallback(
    async (text: string) => {
      const result = await saveFeedSessionDraft(assistantId, sessionId, {
        text,
        platform,
      });
      if (result.ok) {
        notifyFeedPostsChanged();
        void load();
        return true;
      }
      setError(result.error ?? te.actionFailed);
      return false;
    },
    [assistantId, sessionId, platform, load, te.actionFailed],
  );

  async function commitVersion() {
    if (!selected) return;
    setBusy(true);
    try {
      const ok = await saveCaption(selected.text);
      if (ok) setOwnText(null);
    } finally {
      setBusy(false);
    }
  }

  async function act(kind: "approve" | "reject" | "posted") {
    const target = drafts.find((d) =>
      kind === "posted" ? d.status === "ready" : d.status === "pending",
    );
    if (!target) return;

    if (kind === "reject") {
      const ok = await confirmDialog({
        title: te.rejectTitle,
        description: te.rejectBody,
        confirmLabel: te.reject,
        variant: "destructive",
      });
      if (!ok) return;
    }
    let permalink = "";
    if (kind === "posted") {
      // The dialog hosts the input; this closure owns the value (the
      // `content` contract in confirm-dialog.tsx).
      const ok = await confirmDialog({
        title: te.markPostedTitle,
        description: te.markPostedBody,
        confirmLabel: te.markPosted,
        content: (
          <input
            type="url"
            placeholder={te.permalinkPlaceholder}
            onChange={(e) => {
              permalink = e.target.value;
            }}
            className="h-9 w-full rounded-lg border border-border bg-background px-3 text-sm focus:border-primary/50 focus:outline-none"
          />
        ),
      });
      if (!ok) return;
    }

    setBusy(true);
    setError(null);
    try {
      const result =
        kind === "approve"
          ? await approveFeedDraft(assistantId, target.id)
          : kind === "reject"
            ? await rejectFeedDraft(assistantId, target.id)
            : await markFeedReadyPostPosted(
                assistantId,
                target.id,
                permalink.trim() ? { permalink: permalink.trim() } : {},
              );
      if (!result.ok) {
        setError(result.error ?? te.actionFailed);
        return;
      }
      notifyFeedPostsChanged();
      await load();
    } finally {
      setBusy(false);
    }
  }

  async function removePost() {
    const ok = await confirmDialog({
      title: te.deleteTitle,
      description: te.deleteBody,
      confirmLabel: te.delete,
      variant: "destructive",
    });
    if (!ok) return;
    setBusy(true);
    try {
      const result = await deleteFeedDraftSession(assistantId, sessionId);
      if (!result.ok) {
        setError(result.error ?? te.actionFailed);
        return;
      }
      notifyFeedPostsChanged();
      router.push(feedPath(workspaceId, { platform, segment: "posts" }));
    } finally {
      setBusy(false);
    }
  }

  async function copyCaption() {
    if (!selected) return;
    try {
      await navigator.clipboard.writeText(selected.text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError(te.actionFailed);
    }
  }

  const planGate = useCallback(
    () => (
      // A billing state, not a crash (D18): quiet, explains what is and is not
      // affected, and offers the one action that resolves it.
      <div className="rounded-xl border border-border/60 bg-muted/40 p-3">
        <div className="text-[12.5px] font-medium">{te.planGateTitle}</div>
        <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
          {te.planGateBody}
        </p>
        <a
          href={`${webAppUrl()}/plans`}
          target="_blank"
          rel="noreferrer"
          className="mt-2 inline-flex h-7 items-center rounded-lg border border-border bg-background px-2.5 text-[11px] font-medium transition-colors hover:bg-accent"
        >
          {te.planGateCta}
        </a>
      </div>
    ),
    [te],
  );

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
        {te.loading}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0">
      {/* ── The post ─────────────────────────────────────────────────────── */}
      <div className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-2xl space-y-5 p-4 md:p-6">
          <header className="space-y-2">
            <div className="flex items-center gap-2">
              <PlatformIcon
                platform={platform}
                className="size-3.5 shrink-0"
              />
              <h1 className="min-w-0 flex-1 truncate text-[15px] font-semibold">
                {session ? displayPostTitle(session.title) : te.newPost}
              </h1>
              <StatusLabel status={status} label={t.posts.status[status]} />
            </div>
            {session?.replyTarget ? (
              <p className="text-[11px] text-muted-foreground">
                {format(te.replyingTo, {
                  handle: session.replyTarget.authorHandle,
                })}
              </p>
            ) : null}
          </header>

          {error ? (
            <div
              role="alert"
              className="rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
            >
              {error}
            </div>
          ) : null}

          {/* Version chips (D17) — only when there is a choice to make. */}
          {versions.length > 1 ? (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] uppercase tracking-[0.12em] text-muted-foreground">
                {te.versionsLabel}
              </span>
              {versions.map((v, i) => {
                const active = selected?.id === v.id;
                return (
                  <button
                    key={v.id}
                    type="button"
                    onClick={() => setSelectedId(v.id)}
                    aria-pressed={active}
                    className={cn(
                      "inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[11px] font-medium transition-colors",
                      active
                        ? "border-transparent bg-foreground text-background"
                        : "border-border bg-background text-muted-foreground hover:bg-accent",
                    )}
                  >
                    {v.origin === "operator"
                      ? te.versionYours
                      : (v.label
                        ?? format(te.versionAssistant, { n: String(i + 1) }))}
                  </button>
                );
              })}
            </div>
          ) : null}

          <div className="rounded-xl border border-border/60 bg-card p-4 shadow-xs">
            <CaptionEditor
              value={selected?.text ?? ""}
              platform={platform}
              readOnly={readOnly}
              onChange={(next) => {
                // The first keystroke on a proposal forks it: the model's
                // original stays selectable, the edit becomes "Yours".
                setOwnText(next);
                setSelectedId("mine");
              }}
              onSave={saveCaption}
            />
          </div>

          {selected?.imageBrief ? (
            <div className="space-y-1 rounded-xl border border-border/60 bg-muted/30 p-3">
              <div className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                {te.imageBriefLabel}
              </div>
              <p className="whitespace-pre-wrap text-xs text-muted-foreground">
                {selected.imageBrief}
              </p>
            </div>
          ) : null}

          <div className="flex flex-wrap items-center gap-2 border-t border-border/60 pt-4">
            {status === "drafting" ? (
              <button
                type="button"
                onClick={() => void commitVersion()}
                disabled={busy || !selected?.text.trim()}
                className="inline-flex h-8 items-center rounded-lg bg-primary px-3 text-[12.5px] font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
              >
                {te.useThisVersion}
              </button>
            ) : status === "review" ? (
              <>
                <button
                  type="button"
                  onClick={() => void act("approve")}
                  disabled={busy}
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-[12.5px] font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
                >
                  <Check className="size-3.5" aria-hidden />
                  {te.approve}
                </button>
                <button
                  type="button"
                  onClick={() => void act("reject")}
                  disabled={busy}
                  className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border px-3 text-[12.5px] font-medium transition-colors hover:bg-accent disabled:opacity-50"
                >
                  <X className="size-3.5" aria-hidden />
                  {te.reject}
                </button>
              </>
            ) : status === "ready" ? (
              <button
                type="button"
                onClick={() => void act("posted")}
                disabled={busy}
                className="inline-flex h-8 items-center rounded-lg bg-primary px-3 text-[12.5px] font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
              >
                {te.markPosted}
              </button>
            ) : null}

            <button
              type="button"
              onClick={() => void copyCaption()}
              disabled={!selected?.text}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border px-3 text-[12.5px] font-medium transition-colors hover:bg-accent disabled:opacity-50"
            >
              {copied ? (
                <Check className="size-3.5" aria-hidden />
              ) : (
                <Copy className="size-3.5" aria-hidden />
              )}
              {copied ? te.copied : te.copyCaption}
            </button>

            <div className="flex-1" />

            <button
              type="button"
              onClick={() => void removePost()}
              disabled={busy}
              aria-label={te.delete}
              title={te.delete}
              className="inline-flex size-8 items-center justify-center rounded-lg border border-border text-muted-foreground transition-colors hover:border-destructive/40 hover:text-destructive disabled:opacity-50"
            >
              <Trash2 className="size-3.5" aria-hidden />
            </button>
          </div>
        </div>
      </div>

      {/* ── Refine chat, against THIS post's session ─────────────────────── */}
      <aside className="hidden w-[380px] shrink-0 border-l border-border/60 lg:block">
        <TuningChatPanel
          assistantId={assistantId}
          assistantName={assistantName}
          workspaceId={workspaceId}
          sessionId={sessionId}
          title={te.chatTitle}
          composerPlaceholder={te.chatPlaceholder}
          headline={te.chatHeadline}
          onTurnComplete={() => void load()}
          renderPlanGate={planGate}
        />
      </aside>
    </div>
  );
}
