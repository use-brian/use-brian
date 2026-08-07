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
import {
  Check,
  Copy,
  Heart,
  Link2,
  MessageCircle,
  Plus,
  Repeat2,
  Trash2,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n/format";
import { useFeedWorkspace } from "@/contexts/feed-profiles-context";
import { brandPreviewIdentity } from "@/lib/feed-brand";
import type { BrandRecord } from "@use-brian/shared/brand";
import { PlatformIcon } from "@/components/feed/platform-icon";
import { StatusLabel } from "@/components/feed/feed-status";
import { CaptionEditor } from "@/components/feed/caption-editor";
import { BrandCheck } from "@/components/feed/brand-check";
import { PostMediaTray } from "@/components/feed/post-media-tray";
import type { PostMedia } from "@/lib/feed-media";
import { TuningChatPanel } from "@/components/feed/tuning-chat-panel";
import { Button } from "@/components/ui/button";
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
import {
  extractMessageText,
  fetchSessionMessages,
} from "@/lib/api/sessions";
import { feedPath, feedPostPath, type FeedPlatform } from "@/lib/feed-nav";
import {
  displayPostTitle,
  postQueueStatus,
  type PostQueueStatus,
} from "@/lib/feed-posts";
import { notifyFeedPostsChanged } from "@/lib/feed-posts-events";
import {
  buildVersions,
  counterState,
  parseFeedPostBriefSeed,
  postFormatsForPlatform,
  resolveSelectedVersion,
  type FeedArticleFields,
  type FeedPostFormat,
  type ProposedDraft,
} from "@/lib/feed-post-versions";
import { useGlobalDockRecorder } from "@/lib/recorder/dock-recorder-bridge";

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

type SavedComposition = Pick<
  FeedSavedDraft,
  "draftText" | "postedText" | "postFormat" | "threadSegments" | "article" | "media"
>;

/** Compare editor state with the persisted review version. Article fields are
 * checked individually because jsonb does not preserve object-key order. */
export function compositionHasChanges(args: {
  format: FeedPostFormat;
  text: string;
  threadSegments: string[];
  article: FeedArticleFields;
  saved: SavedComposition | null;
}): boolean {
  const { format, text, threadSegments, article, saved } = args;
  if (!saved) return false;
  if (format !== (saved.postFormat ?? "post")) return true;
  if (text.trim() !== (saved.draftText ?? saved.postedText ?? "").trim()) return true;
  if (format === "thread") {
    return JSON.stringify(threadSegments.map((part) => part.trim()))
      !== JSON.stringify((saved.threadSegments ?? []).map((part) => part.trim()));
  }
  if (format === "article") {
    return article.sourceUrl !== (saved.article?.sourceUrl ?? "")
      || article.title !== (saved.article?.title ?? "")
      || article.description !== (saved.article?.description ?? "");
  }
  return false;
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
      assistantIconSeed={
        assistant && "iconSeed" in assistant ? assistant.iconSeed : undefined
      }
      platform={platform}
      sessionId={sessionId}
      workspaceId={team.workspaceId}
      connected={team.profiles.some((profile) => profile.platform === platform)}
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
  const t = useT().feedPage;
  const te = t.postEditor;
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [brief, setBrief] = useState("");
  const [postFormat, setPostFormat] = useState<FeedPostFormat>("post");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const formats = postFormatsForPlatform(platform);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const trimmed = title.trim();
      const result = await createFeedDraftSession(assistantId, {
        platform,
        ...(trimmed ? { title: trimmed } : {}),
        ...(
          brief.trim() || postFormat !== "post"
            ? {
                seed: {
                  kind: "freeform" as const,
                  format: postFormat,
                  ...(brief.trim() ? { brief: brief.trim() } : {}),
                },
              }
            : {}
        ),
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
    <div className="h-full overflow-y-auto bg-muted/15">
      <div className="grid min-h-full w-full lg:grid-cols-[minmax(0,1.08fr)_minmax(340px,0.92fr)]">
        <main className="flex items-center border-b border-border/60 bg-background px-5 py-8 sm:px-8 lg:border-b-0 lg:border-r lg:px-10 xl:px-14">
          <div className="mx-auto w-full max-w-2xl space-y-8 lg:mx-0">
            <header className="space-y-3">
              <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                <PlatformIcon platform={platform} className="size-3.5" />
                {te.newPostEyebrow}
              </div>
              <div className="space-y-2">
                <h1 className="text-xl font-semibold tracking-tight">
                  {te.newPost}
                </h1>
                <p className="max-w-xl text-sm leading-relaxed text-muted-foreground">
                  {te.newPostBody}
                </p>
              </div>
            </header>

            <div className="space-y-2">
              <div>
                <label htmlFor="feed-post-title" className="text-[12.5px] font-medium">
                  {te.newPostTitleLabel}
                </label>
                <p className="mt-0.5 text-[11px] text-muted-foreground">
                  {te.newPostTitleHint}
                </p>
              </div>
              <input
                id="feed-post-title"
                type="text"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder={te.newPostTitlePlaceholder}
                disabled={busy}
                className="h-10 w-full rounded-xl border border-border/70 bg-background px-3.5 text-sm shadow-xs focus:border-ring disabled:opacity-50"
              />
            </div>

            <FormatPicker
              platform={platform}
              value={postFormat}
              onChange={setPostFormat}
            />

            <div className="space-y-2">
              <div>
                <label htmlFor="feed-post-brief" className="text-[12.5px] font-medium">
                  {te.newPostBriefLabel}
                </label>
                <p className="mt-0.5 max-w-xl text-[11px] leading-relaxed text-muted-foreground">
                  {te.newPostBriefHint}
                </p>
              </div>
              <textarea
                id="feed-post-brief"
                value={brief}
                onChange={(e) => setBrief(e.target.value)}
                placeholder={te.newPostBriefPlaceholder}
                disabled={busy}
                rows={6}
                className="w-full resize-y rounded-xl border border-border/70 bg-background px-3.5 py-3 text-sm leading-relaxed shadow-xs focus:border-ring disabled:opacity-50"
              />
            </div>

            {error ? (
              <p role="alert" className="text-sm text-destructive">{error}</p>
            ) : null}

            <Button
              type="button"
              onClick={() => void create()}
              disabled={busy}
              className="bg-foreground text-background !shadow-none [background-image:none] hover:bg-foreground/90 hover:!shadow-none"
            >
              {busy ? te.creating : te.createPost}
            </Button>
          </div>
        </main>

        <aside className="flex min-h-[420px] items-center justify-center px-5 py-8 sm:px-8 lg:px-10 xl:px-14">
          <div className="w-full max-w-md space-y-3">
            <div className="flex items-center justify-between text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
              <span>{te.previewLabel}</span>
              <span className="normal-case tracking-normal">{t.platformLabels[platform]}</span>
            </div>
            <PlatformPostPreview
              platform={platform}
              postFormat={postFormat}
              text=""
              threadSegments={["", ""]}
              article={{ sourceUrl: "", title: "", description: "" }}
              accountName={te.previewAccount}
            />
          </div>
        </aside>
      </div>
    </div>
  );
}

function PostPane({
  assistantId,
  assistantName,
  assistantIconSeed,
  platform,
  sessionId,
  workspaceId,
  connected,
}: {
  assistantId: string;
  assistantName: string;
  assistantIconSeed?: number;
  platform: FeedPlatform;
  sessionId: string;
  workspaceId: string;
  connected: boolean;
}) {
  // PostPane always renders inside FeedSurfaceShell's provider, so the brand
  // read is a context lookup rather than another prop threaded through.
  const workspace = useFeedWorkspace();
  const t = useT().feedPage;
  const te = t.postEditor;
  const router = useRouter();
  const dockRecorder = useGlobalDockRecorder();

  const [session, setSession] = useState<FeedDraftSessionSummary | null>(null);
  const [drafts, setDrafts] = useState<FeedSavedDraft[]>([]);
  const [proposals, setProposals] = useState<ProposedDraft[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [postFormat, setPostFormat] = useState<FeedPostFormat>("post");
  const [privateBrief, setPrivateBrief] = useState("");
  const [threadSegments, setThreadSegments] = useState<string[]>(["", ""]);
  const [article, setArticle] = useState<FeedArticleFields>({
    sourceUrl: "",
    title: "",
    description: "",
  });
  const compositionLoadedRef = useRef(false);

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
    const savedDrafts = saved ?? [];
    setDrafts(savedDrafts);
    setProposals(replayProposals(rows));
    if (!compositionLoadedRef.current) {
      const firstUser = rows.find((row) => row.role === "user");
      const seedIntent = parseFeedPostBriefSeed(
        firstUser ? extractMessageText(firstUser.content) : null,
      );
      const savedComposition =
        savedDrafts.find((draft) => draft.status === "pending" || draft.status === "ready")
        ?? savedDrafts[0]
        ?? null;
      setMedia(savedComposition?.media ?? []);
      const restoredFormat = savedComposition?.postFormat ?? seedIntent?.format ?? "post";
      const supported = postFormatsForPlatform(platform).includes(restoredFormat)
        ? restoredFormat
        : "post";
      setPostFormat(supported);
      setPrivateBrief(seedIntent?.brief ?? "");
      if (supported === "thread") {
        const restored = savedComposition?.threadSegments?.filter(Boolean) ?? [];
        setThreadSegments(restored.length >= 2 ? restored : ["", ""]);
      }
      if (supported === "article" && savedComposition?.article) {
        setArticle(savedComposition.article);
      }
      compositionLoadedRef.current = true;
    }
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
  // D32. Media lives beside the caption, not inside formatData: saveDraft
  // rewrites formatData wholesale from postFormat, so a Post<->Thread switch
  // would silently erase it.
  const [media, setMedia] = useState<PostMedia[]>([]);

  useEffect(() => {
    if (
      postFormat === "thread"
      && selected?.text
      && threadSegments.every((part) => part.length === 0)
    ) {
      setThreadSegments([selected.text, ""]);
    }
  }, [postFormat, selected?.text, threadSegments]);

  /** Idle autosave from the caption editor. Writes the operator's fork. */
  const saveCaption = useCallback(
    async (text: string) => {
      const result = await saveFeedSessionDraft(assistantId, sessionId, {
        text,
        platform,
        postFormat,
        media,
        ...(postFormat === "thread" ? { threadSegments } : {}),
        ...(postFormat === "article" ? { article } : {}),
      });
      if (result.ok) {
        notifyFeedPostsChanged();
        void load();
        return true;
      }
      setError(result.error ?? te.actionFailed);
      return false;
    },
    [assistantId, sessionId, platform, postFormat, media, threadSegments, article, load, te.actionFailed],
  );

  async function commitVersion() {
    const text = postFormat === "thread"
      ? threadSegments.map((part) => part.trim()).filter(Boolean).join("\n\n")
      : selected?.text ?? "";
    if (!text) return;
    setBusy(true);
    try {
      const ok = await saveCaption(text);
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
    const copy = postFormat === "thread"
      ? threadSegments
          .map((part, index) => `${index + 1}/${threadSegments.length} ${part.trim()}`)
          .join("\n\n")
      : postFormat === "article"
        ? [selected?.text ?? "", article.sourceUrl].filter(Boolean).join("\n\n")
        : selected?.text ?? "";
    if (!copy) return;
    try {
      await navigator.clipboard.writeText(copy);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError(te.actionFailed);
    }
  }

  const compositionText = postFormat === "thread"
    ? threadSegments.map((part) => part.trim()).filter(Boolean).join("\n\n")
    : selected?.text ?? "";
  const threadValid =
    threadSegments.length >= 2
    && threadSegments.every(
      (part) => part.trim().length > 0 && !counterState(part, "twitter").over,
    );
  let articleUrlValid = false;
  if (article.sourceUrl) {
    try {
      const url = new URL(article.sourceUrl);
      articleUrlValid = url.protocol === "http:" || url.protocol === "https:";
    } catch {
      articleUrlValid = false;
    }
  }
  const compositionValid = postFormat === "thread"
    ? threadValid
    : postFormat === "article"
      ? Boolean(compositionText.trim() && articleUrlValid && article.title.trim())
      : Boolean(compositionText.trim() && !counterState(compositionText, platform).over);
  const compositionDirty = compositionHasChanges({
    format: postFormat,
    text: compositionText,
    threadSegments,
    article,
    saved: committed,
  });

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
    <div className="grid min-h-full lg:h-full lg:min-h-0 lg:grid-cols-[minmax(0,1fr)_390px] 2xl:grid-cols-[minmax(0,1fr)_420px]">
      <main className="min-w-0 bg-background lg:overflow-y-auto">
        <div className="min-h-full p-4 sm:p-6 xl:p-8">
          <div className="space-y-6">
            <header className="flex flex-wrap items-start gap-3 border-b border-border/60 pb-5">
              <div className="flex min-w-0 flex-1 items-center gap-2.5">
                <span className="inline-flex size-8 items-center justify-center rounded-xl border border-border/60 bg-muted/40">
                  <PlatformIcon platform={platform} className="size-4" />
                </span>
                <div className="min-w-0">
                  <h1 className="truncate text-[15px] font-semibold">
                    {session ? displayPostTitle(session.title) : te.newPost}
                  </h1>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">
                    {session?.replyTarget
                      ? format(te.replyingTo, { handle: session.replyTarget.authorHandle })
                      : t.platformLabels[platform]}
                  </p>
                </div>
              </div>
              <StatusLabel status={status} label={t.posts.status[status]} />
            </header>

            {error ? (
              <div role="alert" className="rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
                {error}
              </div>
            ) : null}

            {privateBrief ? (
              <section className="rounded-xl border border-border/60 bg-muted/25 p-3.5">
                <div className="flex items-center gap-2 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                  <span className="rounded-full bg-foreground px-2 py-0.5 text-background">
                    {te.privateBriefBadge}
                  </span>
                  {te.privateBriefNotice}
                </div>
                <p className="mt-2 whitespace-pre-wrap text-[12.5px] leading-relaxed text-foreground/80">
                  {privateBrief}
                </p>
              </section>
            ) : null}

            <div className="grid min-w-0 gap-6 2xl:grid-cols-[minmax(420px,1fr)_minmax(320px,0.72fr)]">
              <section className="min-w-0 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <span className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                    {te.editorLabel}
                  </span>
                  {!readOnly ? (
                    <FormatPicker
                      platform={platform}
                      value={postFormat}
                      onChange={(next) => {
                        setPostFormat(next);
                        if (next === "thread" && threadSegments.every((part) => !part)) {
                          setThreadSegments([selected?.text ?? "", ""]);
                        }
                      }}
                      compact
                    />
                  ) : null}
                </div>

                {versions.length > 1 && postFormat !== "thread" ? (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="mr-1 text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
                      {te.versionsLabel}
                    </span>
                    {versions.map((version, index) => {
                      const active = selected?.id === version.id;
                      return (
                        <button
                          key={version.id}
                          type="button"
                          onClick={() => setSelectedId(version.id)}
                          aria-pressed={active}
                          className={cn(
                            "inline-flex h-7 items-center rounded-full border px-2.5 text-[11px] font-medium transition-colors",
                            active
                              ? "border-transparent bg-foreground text-background"
                              : "border-border bg-background text-muted-foreground hover:bg-muted",
                          )}
                        >
                          {version.origin === "operator"
                            ? te.versionYours
                            : (version.label ?? format(te.versionAssistant, { n: String(index + 1) }))}
                        </button>
                      );
                    })}
                  </div>
                ) : null}

                {postFormat === "thread" ? (
                  <ThreadComposer
                    segments={threadSegments}
                    readOnly={readOnly}
                    onChange={setThreadSegments}
                  />
                ) : (
                  <div className="rounded-xl border border-border/60 bg-card p-5 shadow-xs transition focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/25">
                    <CaptionEditor
                      value={selected?.text ?? ""}
                      platform={platform}
                      readOnly={readOnly}
                      onChange={(next) => {
                        setOwnText(next);
                        setSelectedId("mine");
                      }}
                      onSave={saveCaption}
                      deferSave={postFormat === "article"}
                    />
                  </div>
                )}

                {postFormat === "article" ? (
                  <ArticleFields
                    value={article}
                    readOnly={readOnly}
                    onChange={setArticle}
                  />
                ) : null}

                {postFormat === "thread" ? (
                  <p className="text-[11px] leading-relaxed text-muted-foreground">
                    {te.threadHint}
                  </p>
                ) : null}

                {/*
                  D38. Under the copy it describes, warn-only, and silent
                  unless the workspace has an approved brand AND the text
                  actually contains a flagged phrase.
                */}
                <BrandCheck
                  brand={workspace.brand}
                  text={
                    postFormat === "thread"
                      ? threadSegments.join("\n\n")
                      : (selected?.text ?? "")
                  }
                />

                <PostMediaTray
                  workspaceId={workspaceId}
                  platform={platform}
                  media={media}
                  imageBrief={selected?.imageBrief ?? null}
                  readOnly={readOnly}
                  onChange={(next) => {
                    setMedia(next);
                    // Media is a deliberate act, so it persists immediately
                    // rather than waiting for the caption's idle autosave.
                    void saveFeedSessionDraft(assistantId, sessionId, {
                      text: selected?.text ?? "",
                      platform,
                      postFormat,
                      media: next,
                      ...(postFormat === "thread" ? { threadSegments } : {}),
                      ...(postFormat === "article" ? { article } : {}),
                    }).then((r) => {
                      if (r.ok) {
                        notifyFeedPostsChanged();
                        void load();
                      } else {
                        setError(r.error ?? te.actionFailed);
                      }
                    });
                  }}
                />

                <div className="flex flex-wrap items-center gap-2 border-t border-border/60 pt-4">
                  {status === "drafting" ? (
                    <Button
                      type="button"
                      onClick={() => void commitVersion()}
                      disabled={busy || !compositionValid}
                      className="bg-foreground text-background !shadow-none [background-image:none] hover:bg-foreground/90 hover:!shadow-none"
                    >
                      {te.useThisVersion}
                    </Button>
                  ) : status === "review" ? (
                    <>
                      {compositionDirty ? (
                        <Button
                          type="button"
                          onClick={() => void commitVersion()}
                          disabled={busy || !compositionValid}
                          className="bg-foreground text-background !shadow-none [background-image:none] hover:bg-foreground/90 hover:!shadow-none"
                        >
                          {te.saveChanges}
                        </Button>
                      ) : null}
                      <Button
                        type="button"
                        onClick={() => void act("approve")}
                        disabled={busy || compositionDirty}
                        title={compositionDirty ? te.saveBeforeApprove : undefined}
                        className="bg-foreground text-background !shadow-none [background-image:none] hover:bg-foreground/90 hover:!shadow-none"
                      >
                        <Check className="size-3.5" aria-hidden />
                        {te.approve}
                      </Button>
                      <Button variant="outline" type="button" onClick={() => void act("reject")} disabled={busy}>
                        <X className="size-3.5" aria-hidden />
                        {te.reject}
                      </Button>
                    </>
                  ) : status === "ready" ? (
                    <Button
                      type="button"
                      onClick={() => void act("posted")}
                      disabled={busy}
                      className="bg-foreground text-background !shadow-none [background-image:none] hover:bg-foreground/90 hover:!shadow-none"
                    >
                      {te.markPosted}
                    </Button>
                  ) : null}

                  <Button variant="outline" type="button" onClick={() => void copyCaption()} disabled={!compositionText}>
                    {copied ? <Check className="size-3.5" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
                    {copied ? te.copied : te.copyCaption}
                  </Button>
                  <div className="flex-1" />
                  <Button variant="outline" size="icon" type="button" onClick={() => void removePost()} disabled={busy} aria-label={te.delete} title={te.delete} className="text-muted-foreground hover:text-destructive">
                    <Trash2 className="size-3.5" aria-hidden />
                  </Button>
                </div>
              </section>

              <aside className="min-w-0 space-y-3 2xl:sticky 2xl:top-0 2xl:self-start">
                <div className="flex items-center justify-between text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                  <span>{te.previewLabel}</span>
                  <span className="normal-case tracking-normal">
                    {postFormat === "post" && connected
                      ? te.connectedDelivery
                      : te.manualDelivery}
                  </span>
                </div>
                <PlatformPostPreview
                  platform={platform}
                  postFormat={postFormat}
                  text={selected?.text ?? ""}
                  threadSegments={threadSegments}
                  article={article}
                  accountName={assistantName || te.previewAccount}
                  brand={workspace.brand}
                />
              </aside>
            </div>
          </div>
        </div>
      </main>

      <aside className="h-[min(680px,85dvh)] min-h-[520px] border-t border-border/60 bg-muted/10 lg:h-auto lg:min-h-0 lg:border-l lg:border-t-0">
        <TuningChatPanel
          assistantId={assistantId}
          assistantName={assistantName}
          iconSeed={assistantIconSeed}
          workspaceId={workspaceId}
          sessionId={sessionId}
          title={te.chatTitle}
          composerPlaceholder={te.chatPlaceholder}
          headline={te.chatHeadline}
          emptyTitle={te.chatEmptyTitle}
          emptyBody={te.chatEmptyBody}
          emptySuggestionsLabel={te.chatTry}
          suggestions={[
            te.chatSuggestion1,
            te.chatSuggestion2,
            te.chatSuggestion3,
          ]}
          onTurnComplete={() => void load()}
          renderPlanGate={planGate}
          dockRecorder={dockRecorder ?? undefined}
          ownsDockRecorderTarget
        />
      </aside>
    </div>
  );
}

function FormatPicker({
  platform,
  value,
  onChange,
  compact = false,
}: {
  platform: FeedPlatform;
  value: FeedPostFormat;
  onChange: (next: FeedPostFormat) => void;
  compact?: boolean;
}) {
  const te = useT().feedPage.postEditor;
  const formats = postFormatsForPlatform(platform);
  const label = (postFormat: FeedPostFormat) =>
    postFormat === "thread"
      ? te.formatThread
      : postFormat === "article"
        ? te.formatArticle
        : te.formatPost;
  const description = (postFormat: FeedPostFormat) =>
    postFormat === "thread"
      ? te.formatThreadDesc
      : postFormat === "article"
        ? te.formatArticleDesc
        : te.formatPostDesc;

  return (
    <div className={cn("space-y-2", compact && "space-y-0")}>
      {!compact ? (
        <div className="text-[12.5px] font-medium">{te.formatLabel}</div>
      ) : null}
      <div className={cn("grid gap-2", compact ? "grid-flow-col auto-cols-max" : "sm:grid-cols-2")}>
        {formats.map((option) => {
          const active = option === value;
          return (
            <button
              key={option}
              type="button"
              onClick={() => onChange(option)}
              aria-pressed={active}
              className={cn(
                "rounded-xl border text-left transition-colors",
                compact ? "h-7 px-2.5 text-[11px]" : "p-3.5",
                active
                  ? "border-foreground bg-foreground text-background"
                  : "border-border/70 bg-background text-foreground hover:bg-muted/50",
              )}
            >
              <span className="block font-medium">{label(option)}</span>
              {!compact ? (
                <span className={cn("mt-1 block text-[11px] leading-relaxed", active ? "text-background/70" : "text-muted-foreground")}>
                  {description(option)}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ThreadComposer({
  segments,
  readOnly,
  onChange,
}: {
  segments: string[];
  readOnly: boolean;
  onChange: (next: string[]) => void;
}) {
  const te = useT().feedPage.postEditor;
  return (
    <div className="space-y-3">
      {segments.map((segment, index) => {
        const counter = counterState(segment, "twitter");
        return (
          <div key={index} className="relative rounded-xl border border-border/60 bg-card p-4 shadow-xs focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/25">
            <div className="mb-3 flex items-center justify-between gap-3">
              <span className="text-[11px] font-medium text-muted-foreground">
                {format(te.threadPostLabel, { n: String(index + 1) })}
              </span>
              <div className="flex items-center gap-2">
                <span className={cn("text-[11px] tabular-nums text-muted-foreground", counter.over && "font-medium text-destructive")}>
                  {counter.count}/280
                </span>
                {!readOnly && segments.length > 2 ? (
                  <button
                    type="button"
                    onClick={() => onChange(segments.filter((_, partIndex) => partIndex !== index))}
                    aria-label={format(te.removeThreadPost, { n: String(index + 1) })}
                    title={format(te.removeThreadPost, { n: String(index + 1) })}
                    className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-destructive"
                  >
                    <X className="size-3.5" aria-hidden />
                  </button>
                ) : null}
              </div>
            </div>
            <textarea
              value={segment}
              readOnly={readOnly}
              onChange={(event) => {
                const next = [...segments];
                next[index] = event.target.value;
                onChange(next);
              }}
              rows={4}
              placeholder={te.captionPlaceholder}
              className="w-full resize-y bg-transparent text-[15px] leading-relaxed placeholder:text-muted-foreground/50 focus-visible:shadow-none"
            />
          </div>
        );
      })}
      {!readOnly ? (
        <Button variant="outline" size="sm" type="button" onClick={() => onChange([...segments, ""])}>
          <Plus className="size-3.5" aria-hidden />
          {te.addThreadPost}
        </Button>
      ) : null}
    </div>
  );
}

function ArticleFields({
  value,
  readOnly,
  onChange,
}: {
  value: FeedArticleFields;
  readOnly: boolean;
  onChange: (next: FeedArticleFields) => void;
}) {
  const te = useT().feedPage.postEditor;
  return (
    <div className="space-y-4 rounded-xl border border-border/60 bg-muted/20 p-4">
      <label className="block space-y-1.5">
        <span className="text-[12px] font-medium">{te.articleSourceLabel}</span>
        <div className="relative">
          <Link2 className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden />
          <input
            type="url"
            value={value.sourceUrl}
            readOnly={readOnly}
            onChange={(event) => onChange({ ...value, sourceUrl: event.target.value })}
            placeholder={te.articleSourcePlaceholder}
            className="h-9 w-full rounded-lg border border-border/70 bg-background pl-9 pr-3 text-sm"
          />
        </div>
        <span className="block text-[11px] leading-relaxed text-muted-foreground">
          {te.articleSourceHint}
        </span>
      </label>
      <label className="block space-y-1.5">
        <span className="text-[12px] font-medium">{te.articleTitleLabel}</span>
        <input
          type="text"
          value={value.title}
          readOnly={readOnly}
          onChange={(event) => onChange({ ...value, title: event.target.value })}
          placeholder={te.articleTitlePlaceholder}
          className="h-9 w-full rounded-lg border border-border/70 bg-background px-3 text-sm"
        />
      </label>
      <label className="block space-y-1.5">
        <span className="text-[12px] font-medium">{te.articleDescriptionLabel}</span>
        <textarea
          value={value.description}
          readOnly={readOnly}
          onChange={(event) => onChange({ ...value, description: event.target.value })}
          placeholder={te.articleDescriptionPlaceholder}
          rows={3}
          className="w-full resize-y rounded-lg border border-border/70 bg-background px-3 py-2 text-sm leading-relaxed"
        />
      </label>
    </div>
  );
}

function PlatformPostPreview({
  platform,
  postFormat,
  text,
  threadSegments,
  article,
  accountName,
  brand = null,
}: {
  platform: FeedPlatform;
  postFormat: FeedPostFormat;
  text: string;
  threadSegments: string[];
  article: FeedArticleFields;
  accountName: string;
  /** The workspace's APPROVED brand record, or null (D36). */
  brand?: BrandRecord | null;
}) {
  const t = useT().feedPage;
  const te = t.postEditor;
  const identity = brandPreviewIdentity(brand);
  const displayName =
    identity.displayName || accountName.trim() || te.previewAccount;
  /*
    D36. This used to be `displayName.toLowerCase().replace(...)` -- a handle
    invented from the assistant's name, shown confidently on the one surface
    whose whole job is previewing how the post appears in public. A workspace
    whose real handle differed saw a lie. Now it is the brand's actual handle
    or nothing at all; no handle renders no handle.
  */
  const handle = identity.handle;
  const parts = postFormat === "thread" ? threadSegments : [text];
  let sourceHost = "";
  try {
    sourceHost = article.sourceUrl ? new URL(article.sourceUrl).hostname.replace(/^www\./, "") : "";
  } catch {
    sourceHost = "";
  }

  return (
    <div className="overflow-hidden rounded-2xl border border-border/70 bg-background shadow-xs">
      <div className="flex items-center gap-2 border-b border-border/50 px-4 py-3 text-[11px] text-muted-foreground">
        <PlatformIcon platform={platform} className="size-3.5" />
        <span>{t.platformLabels[platform]}</span>
        <span aria-hidden>·</span>
        <span>{te.previewNow}</span>
      </div>
      <div className="p-4 sm:p-5">
        {parts.map((part, index) => (
          <article key={index} className={cn("relative flex gap-3", index > 0 && "pt-5")}>
            {postFormat === "thread" && index < parts.length - 1 ? (
              <span className="absolute bottom-[-20px] left-[17px] top-9 w-px bg-border" aria-hidden />
            ) : null}
            <div className="relative z-10 inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-foreground text-xs font-semibold text-background">
              {displayName.slice(0, 1).toUpperCase()}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 flex-wrap items-baseline gap-x-1.5 text-sm">
                <span className="truncate font-semibold">{displayName}</span>
                {handle ? (
                  <span className="truncate text-[12px] text-muted-foreground">@{handle}</span>
                ) : null}
              </div>
              <p className={cn("mt-1.5 whitespace-pre-wrap break-words text-[14px] leading-relaxed", !part && "text-muted-foreground/60")}>
                {part || te.previewEmpty}
              </p>
              {postFormat === "article" && index === 0 ? (
                <div className="mt-3 overflow-hidden rounded-xl border border-border/70 bg-muted/25">
                  <div className="flex aspect-[2.2/1] items-center justify-center border-b border-border/60 bg-muted/50 text-muted-foreground">
                    <Link2 className="size-5" aria-hidden />
                  </div>
                  <div className="space-y-1 p-3">
                    {sourceHost ? <div className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground">{sourceHost}</div> : null}
                    <div className="text-[13px] font-medium leading-snug">
                      {article.title || te.articleFallbackTitle}
                    </div>
                    <div className="line-clamp-2 text-[11px] leading-relaxed text-muted-foreground">
                      {article.description || te.articleFallbackDescription}
                    </div>
                  </div>
                </div>
              ) : null}
              <div className="mt-3 flex items-center gap-6 text-[10px] text-muted-foreground/70">
                <MessageCircle className="size-3.5" aria-hidden />
                <Repeat2 className="size-3.5" aria-hidden />
                <Heart className="size-3.5" aria-hidden />
              </div>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}
