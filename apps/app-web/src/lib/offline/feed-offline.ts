import { applyFeedEdits, importLegacyFeed, projectFeed, diffFeedComposition, duplicateFeedNode, feedParagraph, proposeFeedReplacement, walkFeed } from '@use-brian/doc-model';
import { feedMediaSchema, type FeedLinkedInContext, type FeedComposition, type FeedCommand, type FeedCommandRequest, type FeedEdit, type FeedCollaborationReceipt } from '@use-brian/shared';
/** Durable Feed working copies and reconnect replay. [COMP:app-web/feed-offline] */
import { authFetch } from "@/lib/auth-fetch";
import type { FeedDraftSessionSummary } from "@/lib/api/feed";
import type { FeedPlatform } from "@/lib/feed-nav";
import type { FeedArticleFields, FeedPostFormat } from "@/lib/feed-post-versions";
import type { PostMedia } from "@/lib/feed-media";
import { notifyFeedPostsChanged } from "@/lib/feed-posts-events";
import { idbGet, idbUpdate } from "./idb";
import { FEED_API_URL, feedCachedJson, feedOwner } from "./feed-cache";

export const FEED_LOCAL_CHANGED = "feed:local-changed";
export type FeedWorkingContent = {
  sourceSensitivity?: 'public' | 'internal' | 'confidential'; selectedMemoryIds?: string[];
  sourceCompartments?: string[]; sourceProjectIds?: string[]; sourceFileIds?: string[]; sourceMemoryIds?: string[];
  linkedin?: FeedLinkedInContext;
  schemaVersion?: 2; composition?: FeedComposition; goalId?: string | null; reviewMonth?: string;
  title: string; privateBrief: string; text: string; textEdited?: boolean; postFormat: FeedPostFormat;
  threadSegments: string[]; article: FeedArticleFields; media: PostMedia[];
};
type FeedWorkingCopy = { revision: number; mutationId: string; content: FeedWorkingContent };
export type LocalFeedPost = FeedWorkingCopy & {
  assistantId: string; session: FeedDraftSessionSummary;
  inFlight?: FeedWorkingCopy & { baseTitle?: string; create?: { platform: FeedPlatform } };
  collaborationQueue?: Array<{ mutationId: string; commands: FeedCommand[] }>;
  commandFlight?: FeedCommandRequest;
  dirty: boolean; newSession: boolean; error?: "conflict" | "blocked"; errorCode?: string;
};
type Records = Record<string, LocalFeedPost>;
const key = (owner: string) => `feed:working:${owner}`;
const recordKey = (assistantId: string, sessionId: string) => `${assistantId}:${sessionId}`;
const changed = () => { if (typeof window !== "undefined") window.dispatchEvent(new Event(FEED_LOCAL_CHANGED)); };
function ownerRequired() { const owner = feedOwner(); if (!owner) throw new Error("No local identity"); return owner; }
export const blankFeedContent = (): FeedWorkingContent => ({ title: "", privateBrief: "", text: "", textEdited: false, postFormat: "post", threadSegments: ["", ""], article: { sourceUrl: "", title: "", description: "" }, media: [] });

export async function readLocalFeedPosts(): Promise<LocalFeedPost[]> {
  const owner = feedOwner();
  const records = owner ? await idbGet<Records>(key(owner)) : null;
  return feedOwner() === owner ? Object.values(records ?? {}) : [];
}
export async function readLocalFeedPost(assistantId: string, sessionId: string): Promise<LocalFeedPost | null> {
  return (await readLocalFeedPosts()).find(p => p.assistantId === assistantId && p.session.id === sessionId) ?? null;
}
export async function createLocalFeedPost(assistantId: string, platform: FeedPlatform, content: FeedWorkingContent): Promise<LocalFeedPost> {
  const owner = ownerRequired();
  const id = crypto.randomUUID();
  const time = new Date().toISOString();
  const record: LocalFeedPost = {
    assistantId, revision: 0, mutationId: crypto.randomUUID(),
    content: { ...content, textEdited: content.textEdited || Boolean(content.text) },
    dirty: true, newSession: true,
    session: { id, platform, title: `[${platform}] ${content.title || "New draft"}`,
      startedBy: { id: owner, name: null }, createdAt: time, lastActiveAt: time,
      preview: content.privateBrief, replyTarget: null, draftText: content.text,
      selectedDraft: null, seedKind: "freeform",
      draftCounts: { pending: 0, ready: 0, posted: 0, rejected: 0, deleted: 0 } },
  };
  if (content.schemaVersion === 2 && content.composition) {
    const seed = crypto.randomUUID();
    const base = importLegacyFeed({ ...content, media: content.media.map(item => feedMediaSchema.parse(item)) }, seed);
    const target: FeedComposition = { version: 1, segments: content.composition.segments.map(segment => ({ id: crypto.randomUUID(), content: segment.content.map(duplicateFeedNode) })) };
    const edits = diffFeedComposition(base, target);
    const commands: FeedCommand[] = [{ kind: 'upgrade', seed }];
    for (let i = 0; i < edits.length; i += 100) commands.push({ kind: 'edit', edits: edits.slice(i, i + 100) });
    if (content.goalId !== undefined || content.reviewMonth !== undefined || content.selectedMemoryIds !== undefined) commands.push({ kind: 'context', goalId: content.goalId, reviewMonth: content.reviewMonth, selectedMemoryIds: content.selectedMemoryIds });
    record.content = { ...content, composition: target };
    record.collaborationQueue = [{ mutationId: crypto.randomUUID(), commands }];
  }
  await idbUpdate<Records>(key(owner), old => {
    if (feedOwner() !== owner) throw new Error("Local identity changed");
    return { ...old, [recordKey(assistantId, id)]: record };
  });
  changed(); notifyFeedPostsChanged();
  return record;
}

/** Initial restore must not overwrite a keystroke from another window. */
export async function loadFeedWorkingCopy(assistantId: string, session: FeedDraftSessionSummary, fallback: FeedWorkingContent): Promise<LocalFeedPost> {
  const owner = ownerRequired();
  const local = await readLocalFeedPost(assistantId, session.id);
  if (local?.dirty) return local;
  const remote = await feedCachedJson<{ copy: FeedWorkingCopy | null }>(
    `/api/distribution/${assistantId}/post-working-copies/${session.id}`,
  ).catch(() => null);
  if (feedOwner() !== owner) throw new Error("Local identity changed");
  const id = recordKey(assistantId, session.id);
  const records = await idbUpdate<Records>(key(owner), old => {
    if (feedOwner() !== owner) throw new Error("Local identity changed");
    if (old?.[id]?.dirty) return old;
    const baseline = { revision: 0, mutationId: crypto.randomUUID(), content: fallback };
    const copy = remote ? remote.copy ?? baseline : local ?? baseline;
    return { ...old, [id]: { ...copy, assistantId, session, dirty: false, newSession: false } };
  });
  return records[id];
}

/** Partial patches merge inside one IndexedDB transaction, including empty fields. */
export async function patchFeedWorkingCopy(assistantId: string, sessionId: string, patch: Partial<FeedWorkingContent>): Promise<LocalFeedPost> {
  const owner = ownerRequired();
  const id = recordKey(assistantId, sessionId);
  const records = await idbUpdate<Records>(key(owner), old => {
    if (feedOwner() !== owner) throw new Error("Local identity changed");
    const current = old?.[id];
    if (!current) throw new Error("Working copy not loaded");
    if (current.content.schemaVersion === 2) {
      const commands = feedPatchCommands(current.content, patch);
      return commands.length ? { ...old, [id]: applyQueuedFeedCommands(current, commands) } : old!;
    }
    const content = { ...current.content, ...patch, ...(patch.text !== undefined ? { textEdited: true } : {}) };
    if (JSON.stringify(content) === JSON.stringify(current.content)) return old!;
    return { ...old, [id]: { ...current, content, dirty: true, mutationId: crypto.randomUUID() } };
  });
  changed(); return records[id];
}

/** Open writable legacy drafts in the current editor without a migration prompt. */
export async function ensureFeedComposition(assistantId: string, sessionId: string, displayed: { mutationId: string; text: string }): Promise<void> {
  if (!navigator.onLine) return;
  const owner = ownerRequired(); const id = recordKey(assistantId, sessionId);
  let prepared = false;
  await idbUpdate<Records>(key(owner), old => {
    if (feedOwner() !== owner) throw new Error('Local identity changed');
    const current = old?.[id];
    if (!current || current.content.schemaVersion === 2 || current.error || current.revision || current.inFlight) return old ?? {};
    // A restored session may not have a server working-copy row. Seed its
    // visible proposal only if no newer local edit has taken ownership.
    const content = !current.content.textEdited && current.mutationId === displayed.mutationId
      ? { ...current.content, text: displayed.text, textEdited: true } : current.content;
    if (current.dirty && content === current.content) return old!;
    prepared = true;
    return { ...old, [id]: { ...current, content, dirty: true, mutationId: crypto.randomUUID() } };
  });
  if (prepared) changed();
  await flushFeedWorkingCopies();
  let upgraded = false;
  await idbUpdate<Records>(key(owner), old => {
    if (feedOwner() !== owner) throw new Error('Local identity changed');
    const current = old?.[id];
    // Check inside the transaction, not against the render that started us.
    // This also makes two local opens converge on the same IDs and queue entry.
    if (!navigator.onLine || !current || current.content.schemaVersion === 2 || current.error || current.dirty || current.newSession || !current.revision || current.inFlight || current.commandFlight) return old ?? {};
    upgraded = true;
    return { ...old, [id]: applyQueuedFeedCommands(current, [{ kind: 'upgrade', seed: crypto.randomUUID() }]) };
  });
  if (upgraded) { changed(); await flushFeedWorkingCopies(); }
}

export async function mergeLocalFeedSessions(assistantId: string, sessions: FeedDraftSessionSummary[], platform?: FeedPlatform) {
  const merged = new Map(sessions.map(s => [s.id, s]));
  for (const post of await readLocalFeedPosts()) {
    if (post.assistantId !== assistantId || (platform && post.session.platform !== platform)) continue;
    const remote = merged.get(post.session.id);
    if (!remote && !post.dirty) continue;
    merged.set(post.session.id, { ...(remote ?? post.session),
      ...(post.dirty ? { title: `[${post.session.platform}] ${post.content.title || "New draft"}` } : {}),
      draftText: post.content.text || remote?.draftText || null,
    });
  }
  return [...merged.values()];
}

let flushing: Promise<void> | null = null;
export function flushFeedWorkingCopies(): Promise<void> {
  if (flushing) return flushing;
  flushing = replay().finally(() => { flushing = null; });
  return flushing;
}
async function replay() {
  const owner = feedOwner();
  if (!owner || !navigator.onLine) return;
  for (const post of await readLocalFeedPosts()) {
    if (!post.dirty || post.error) continue;
    if (!navigator.onLine || feedOwner() !== owner) return;
    try {
      if (!post.newSession && post.collaborationQueue?.length) { await replayFeedCommands(post, owner); continue; }
      const id = recordKey(post.assistantId, post.session.id);
      // Persist the exact request before sending. A response can disappear
      // while newer keystrokes are saved; retry the old request first.
      const records = await idbUpdate<Records>(key(owner), old => {
        if (feedOwner() !== owner) throw new Error("Local identity changed");
        const current = old?.[id];
        if (!current?.dirty) return old ?? {};
        return { ...old, [id]: { ...current, inFlight: current.inFlight ?? {
          revision: current.revision, mutationId: current.mutationId, content: current.newSession && current.content.schemaVersion === 2 ? { ...current.content, schemaVersion: undefined, composition: undefined, goalId: undefined, reviewMonth: undefined } : current.content,
          baseTitle: current.session.title,
          ...(current.newSession ? { create: { platform: current.session.platform } } : {}),
        } } };
      });
      const flight = records[id]?.inFlight;
      if (!flight || feedOwner() !== owner) continue;
      const response = await authFetch(`${FEED_API_URL}/api/distribution/${post.assistantId}/post-working-copies/${post.session.id}`, {
        method: "PUT", headers: { "Content-Type": "application/json" }, signal: AbortSignal.timeout(10_000),
        body: JSON.stringify(flight),
      });
      if (feedOwner() !== owner) return;
      if (!response.ok) {
        if ([400, 403, 404, 409].includes(response.status)) {
          let updated = false;
          await idbUpdate<Records>(key(owner), old => {
            if (feedOwner() !== owner) throw new Error("Local identity changed");
            const current = old?.[id];
            const error = response.status === 409 ? "conflict" : "blocked";
            if (!current || current.inFlight?.mutationId !== flight.mutationId || current.error === error) return old ?? {};
            updated = true;
            return { ...old, [id]: { ...current, error } };
          });
          if (updated) changed();
        }
        continue;
      }
      const { copy } = await response.json() as { copy: FeedWorkingCopy };
      if (copy.mutationId !== flight.mutationId || copy.revision !== flight.revision + 1) continue;
      await idbUpdate<Records>(key(owner), old => {
        if (feedOwner() !== owner) throw new Error("Local identity changed");
        const current = old?.[id];
        if (!current || current.inFlight?.mutationId !== flight.mutationId) return old ?? {};
        return { ...old, [id]: { ...current, revision: copy.revision, newSession: false, inFlight: undefined,
          dirty: current.mutationId !== flight.mutationId || Boolean(current.collaborationQueue?.length), error: undefined, errorCode: undefined } };
      });
      changed(); notifyFeedPostsChanged();
    } catch { /* Durable work remains pending. Other posts may still sync. */ }
  }
}

/** Retry the exact saved request; never change its revision, identity or preimages. */
export async function retryFeedWorkingCopy(assistantId: string, sessionId: string): Promise<void> {
  const owner = ownerRequired(); const id = recordKey(assistantId, sessionId);
  if (!navigator.onLine) return;
  if (flushing) await flushing;
  await idbUpdate<Records>(key(owner), old => {
    if (feedOwner() !== owner) throw new Error('Local identity changed');
    const current = old?.[id];
    if (!current?.dirty || !current.error) return old ?? {};
    return { ...old, [id]: { ...current, error: undefined, errorCode: undefined } };
  });
  changed();
  await flushFeedWorkingCopies();
}

/** Resolve a conflict without overwriting the shared copy. */
export async function forkLocalFeedPost(post: LocalFeedPost) {
  const owner = ownerRequired();
  const current = await readLocalFeedPost(post.assistantId, post.session.id);
  if (!current || feedOwner() !== owner) throw new Error("Local identity changed");
  const created = await createLocalFeedPost(post.assistantId, post.session.platform, current.content);
  await idbUpdate<Records>(key(owner), old => {
    if (feedOwner() !== owner) throw new Error("Local identity changed");
    const id = recordKey(post.assistantId, post.session.id);
    // Another window may still be editing the original during recovery.
    if (old?.[id]?.mutationId !== current.mutationId) return old ?? {};
    const next = { ...old }; delete next[id]; return next;
  });
  changed(); return created;
}

export async function readFeedNewPostForm(assistantId: string, platform: FeedPlatform) {
  const owner = feedOwner();
  const form = await idbGet<FeedWorkingContent>(`feed:form:${owner}:${assistantId}:${platform}`);
  return feedOwner() === owner ? form : null;
}
export async function writeFeedNewPostForm(assistantId: string, platform: FeedPlatform, content: FeedWorkingContent) {
  const owner = ownerRequired();
  await idbUpdate(`feed:form:${owner}:${assistantId}:${platform}`, () => {
    if (feedOwner() !== owner) throw new Error("Local identity changed");
    return content;
  });
}

/** Structured mutations share the existing per-viewer durable record/replay driver. */
export async function queueFeedCommands(assistantId: string, sessionId: string, commands: FeedCommand[], optimisticEdits: FeedEdit[] = []): Promise<LocalFeedPost> {
  const owner = ownerRequired(); const id = recordKey(assistantId, sessionId);
  const records = await idbUpdate<Records>(key(owner), old => {
    if (feedOwner() !== owner) throw new Error('Local identity changed');
    const current = old?.[id]; if (!current) throw new Error('Working copy not loaded');
    return { ...old, [id]: applyQueuedFeedCommands(current, commands, optimisticEdits) };
  });
  changed(); return records[id];
}
async function replayFeedCommands(post: LocalFeedPost, owner: string) {
  const id = recordKey(post.assistantId, post.session.id);
  while (navigator.onLine && feedOwner() === owner) {
    const records = await idbUpdate<Records>(key(owner), old => {
      if (feedOwner() !== owner) throw new Error('Local identity changed');
      const current = old?.[id]; const next = current?.collaborationQueue?.[0];
      if (!current || !next || current.error) return old ?? {};
      return { ...old, [id]: { ...current, commandFlight: current.commandFlight ?? { ...next, expectedRevision: current.revision } } };
    });
    const flight = records[id]?.commandFlight; if (!flight || records[id]?.error) return;
    const response = await authFetch(`${FEED_API_URL}/api/distribution/${post.assistantId}/draft-sessions/${post.session.id}/commands`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(10_000), body: JSON.stringify(flight),
    });
    if (feedOwner() !== owner) return;
    if (!response.ok) {
      const detail = await response.json().catch(() => null) as { code?: string; error?: string } | null;
      if ([400,403,404,409].includes(response.status)) {
        await idbUpdate<Records>(key(owner), old => {
          if (feedOwner() !== owner) throw new Error('Local identity changed');
          const current = old?.[id]; if (!current || current.commandFlight?.mutationId !== flight.mutationId) return old ?? {};
          return { ...old, [id]: { ...current, error: response.status === 409 ? 'conflict' : 'blocked', errorCode: detail?.code ?? detail?.error } };
        }); changed();
      }
      return;
    }
    const { receipt, sourceSensitivity, sourceAuthority } = await response.json() as { receipt: FeedCollaborationReceipt; sourceSensitivity?: FeedWorkingContent['sourceSensitivity']; sourceAuthority?: Pick<FeedWorkingContent, 'sourceFileIds' | 'sourceMemoryIds' | 'sourceCompartments' | 'sourceProjectIds'> };
    if (receipt.mutationId !== flight.mutationId || receipt.revision < flight.expectedRevision) return;
    await idbUpdate<Records>(key(owner), old => {
      if (feedOwner() !== owner) throw new Error('Local identity changed');
      const current = old?.[id]; if (!current || current.commandFlight?.mutationId !== flight.mutationId) return old ?? {};
      const remaining = (current.collaborationQueue ?? []).slice(1);
      return { ...old, [id]: { ...current, content: { ...current.content, ...sourceAuthority, ...(sourceSensitivity ? { sourceSensitivity } : {}) }, revision: receipt.revision, commandFlight: undefined, collaborationQueue: remaining, dirty: remaining.length > 0, error: undefined, errorCode: undefined } };
    });
    changed(); notifyFeedPostsChanged();
  }
}

/** A remote invalidation refreshes only clean state, never pending author work. */
export async function adoptFeedServerCopy(assistantId: string, sessionId: string, copy: FeedWorkingCopy) {
  const owner = feedOwner(); if (!owner) return; let updated = false; const id = recordKey(assistantId, sessionId);
  await idbUpdate<Records>(key(owner), old => {
    if (feedOwner() !== owner) return old ?? {};
    const current = old?.[id];
    if (!current || current.dirty || copy.revision < current.revision || (copy.mutationId === current.mutationId && JSON.stringify(copy.content) === JSON.stringify(current.content))) return old ?? {};
    updated = true; return { ...old, [id]: { ...current, ...copy, dirty: false } };
  });
  if (updated) changed();
}

function applyQueuedFeedCommands(current: LocalFeedPost, commands: FeedCommand[], optimisticEdits: FeedEdit[] = []): LocalFeedPost {
    let content = current.content;
    for (const command of commands) {
      if (command.kind === 'upgrade') {
        if (current.dirty || current.newSession || current.revision === 0 || !command.seed) throw new Error('Sync legacy work before upgrade');
        content = { ...content, schemaVersion: 2, composition: importLegacyFeed({ ...content, media: content.media.map(m => feedMediaSchema.parse(m)) }, command.seed) };
      } else if (command.kind === 'edit') {
        if (!content.composition) throw new Error('Upgrade required');
        content = { ...content, composition: applyFeedEdits(content.composition, command.edits).composition };
      } else if (command.kind === 'linkedin') {
        content = { ...content, linkedin: command.metadata ?? undefined, postFormat: command.metadata?.mode === 'post' ? 'post' : command.metadata ? 'article' : content.postFormat };
      } else if (command.kind === 'context') {
        const { kind: _kind, ...patch } = command; content = { ...content, ...patch };
      }
    }
    if (optimisticEdits.length && content.composition) content = { ...content, composition: applyFeedEdits(content.composition, optimisticEdits).composition };
    if (!content.composition) throw new Error('Upgrade required');
    const projection = projectFeed(content.composition);
    content = { ...content, text: projection.text, threadSegments: projection.threadSegments, media: projection.media, textEdited: true };
    const queue = [...(current.collaborationQueue ?? [])]; const last = queue.at(-1);
    const edit = commands.length === 1 && commands[0]?.kind === 'edit' ? commands[0] : null;
    const priorEdit = last?.commands.length === 1 && last.commands[0]?.kind === 'edit' ? last.commands[0] : null;
    if (last && edit && priorEdit && edit.reasonThreadId === priorEdit.reasonThreadId && edit.applicationId === priorEdit.applicationId && current.commandFlight?.mutationId !== last.mutationId && priorEdit.edits.length + edit.edits.length <= 100) {
      queue[queue.length - 1] = { ...last, commands: [{ ...priorEdit, edits: [...priorEdit.edits, ...edit.edits] }] };
    } else queue.push({ mutationId: crypto.randomUUID(), commands });
    return { ...current, content, collaborationQueue: queue, dirty: true, mutationId: queue.at(-1)!.mutationId };

}

/** Legacy controls emit typed context/media changes once a draft is upgraded. */
function feedPatchCommands(content: FeedWorkingContent, patch: Partial<FeedWorkingContent>): FeedCommand[] {
  if (!content.composition) throw new Error('Upgrade required');
  const commands: FeedCommand[] = [];
  const { title, privateBrief, goalId, reviewMonth, postFormat, article, selectedMemoryIds } = patch;
  const context = Object.fromEntries(Object.entries({ title, privateBrief, goalId, reviewMonth, postFormat, article, selectedMemoryIds }).filter(([, value]) => value !== undefined));
  if (Object.keys(context).length && postFormat !== 'post' && postFormat !== 'article') commands.push({ kind: 'context', ...context });
  let composition = content.composition;
  if (patch.text !== undefined) { const edits = proposeFeedReplacement(composition, { kind: 'post' }, patch.text); commands.push({ kind: 'edit', edits }); composition = applyFeedEdits(composition, edits).composition; }
  if (patch.media) {
    const images = walkFeed(composition).filter(row => row.node.type === 'image');
    const edits: FeedEdit[] = [];
    for (const row of images) {
      if (row.node.type !== 'image') continue;
      const fileId = row.node.attrs.fileId;
      const media = patch.media.find(item => item.fileId === fileId);
      if (!media) edits.push({ kind: 'replaceBlock', segmentId: row.segmentId, blockId: row.node.attrs.id, preimage: row.node, replacement: [] });
      else if ((media.alt ?? '') !== (row.node.attrs.alt ?? '')) edits.push({ kind: 'replaceBlock', segmentId: row.segmentId, blockId: row.node.attrs.id, preimage: row.node, replacement: [{ ...row.node, attrs: { ...row.node.attrs, alt: media.alt } }] });
    }
    for (const media of patch.media) if (!images.some(row => row.node.type === 'image' && row.node.attrs.fileId === media.fileId)) {
      const first = composition.segments[0]!;
      edits.push({ kind: 'insertBlock', segmentId: first.id, afterId: first.content.at(-1)!.attrs.id, node: { type: 'image', attrs: { ...feedMediaSchema.parse(media), id: crypto.randomUUID(), placement: 'attachment' } } });
    }
    if (edits.length) commands.push({ kind: 'edit', edits });
  }
  if (postFormat && postFormat !== content.postFormat) {
    const target = structuredClone(composition);
    if (postFormat === 'thread' && target.segments.length === 1) target.segments.push({ id: crypto.randomUUID(), content: [feedParagraph('')] });
    if (postFormat !== 'thread' && target.segments.length > 1) target.segments = [{ ...target.segments[0]!, content: target.segments.flatMap(segment => segment.content) }];
    const edits = diffFeedComposition(composition, target);
    if (edits.length) commands.push({ kind: 'edit', edits });
  }
  if (Object.keys(context).length && (postFormat === 'post' || postFormat === 'article')) commands.push({ kind: 'context', ...context });
  return commands;
}
