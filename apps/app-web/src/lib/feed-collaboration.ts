"use client";
/** Shared cached Feed collaboration client. [COMP:app-web/feed-composition-editor] */
import { useEffect, useRef } from 'react';
import type { FeedAnchor, FeedEdit, FeedEditorialRunSummary, FeedReviewFinding, FeedLearnedDecisions } from '@use-brian/shared';
import { useCachedResource, SurfaceCacheEvictionError, invalidateSurfaceCache } from '@/lib/surface-cache';
import { feedCollaborationCacheKey, feedLearningCacheKey, feedSessionsCacheFamily } from '@/lib/surface-prefetch';
import { feedCachedJson, feedPaintFirst, readFeedCachedJson, isAuthoritativeFeedDenial } from '@/lib/offline/feed-cache';
import { FEED_LOCAL_CHANGED, adoptFeedServerCopy, readLocalFeedPost, type FeedWorkingContent } from '@/lib/offline/feed-offline';
export type FeedCommentThread = { id: string; transcriptSessionId: string; anchor: FeedAnchor; resolved: boolean; authorUserId: string; authorName?: string | null; authorKind: 'user' | 'assistant'; createdAt: string };
export type FeedDraftSuggestion = { sourceRunId?: string | null; id: string; sourceProposal?: { index: number; text: string; label?: string; imageBrief?: string } | null; edits: FeedEdit[]; rationale: string; status: string; threadId: string | null; parentId: string | null; sourceRevision: number; authorUserId: string; authorName?: string | null; authorKind: 'user' | 'assistant'; acceptanceReceipt?: { revision: number } | null };
export type FeedCollaborationSnapshot = { runs?: FeedEditorialRunSummary[]; reviewFindings?: { threadId: string; runId: string; finding: FeedReviewFinding & { sources?: { id: string; title: string; date?: string; link?: string; hash?: string }[] } }[]; copy: { revision: number; mutationId: string; sequence: number; content: FeedWorkingContent } | null; threads: FeedCommentThread[]; suggestions: FeedDraftSuggestion[] };
export const feedCollaborationPath = (assistantId: string, sessionId: string) => `/api/distribution/${assistantId}/draft-sessions/${sessionId}`;
export function useFeedCollaboration(workspaceId: string, assistantId: string, sessionId: string, enabled: boolean) {
  const key = feedCollaborationCacheKey(workspaceId, assistantId, sessionId); const path = feedCollaborationPath(assistantId, sessionId) + '/collaboration';
  const resource = useCachedResource<FeedCollaborationSnapshot>(enabled ? key : null, () => feedPaintFirst(key,
    () => readFeedCachedJson<FeedCollaborationSnapshot>(path),
    async () => { try { return await feedCachedJson<FeedCollaborationSnapshot>(path); } catch (error) { if (isAuthoritativeFeedDenial(error)) throw new SurfaceCacheEvictionError(error); throw error; } },
  ));
  const previousDenial = useRef({ key, denied: false });
  useEffect(() => {
    const denied = isAuthoritativeFeedDenial(resource.error);
    const wasDenied = previousDenial.current.key === key && previousDenial.current.denied;
    previousDenial.current = { key, denied };
    if (denied !== wasDenied) invalidateSurfaceCache(feedSessionsCacheFamily(workspaceId));
  }, [key, workspaceId, resource.error]);
  useEffect(() => {
    if (resource.data?.copy) void adoptFeedServerCopy(assistantId, sessionId, resource.data.copy);
  }, [assistantId, sessionId, resource.data]);
  useEffect(() => {
    const refresh = () => { void readLocalFeedPost(assistantId, sessionId).then(post => { if (enabled && post && !post.dirty) void resource.refresh(); }); };
    window.addEventListener(FEED_LOCAL_CHANGED, refresh); window.addEventListener('online', refresh);
    return () => { window.removeEventListener(FEED_LOCAL_CHANGED, refresh); window.removeEventListener('online', refresh); };
  }, [assistantId, sessionId, enabled, resource.refresh]);
  useEffect(() => {
    if (!enabled || isAuthoritativeFeedDenial(resource.error)) return;
    const renew = () => {
      if (document.visibilityState === 'visible' && navigator.onLine) void resource.refresh();
    };
    const timer = window.setInterval(renew, 15000);
    document.addEventListener('visibilitychange', renew);
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', renew); };
  }, [enabled, resource.error, resource.refresh]);
  return resource;
}

/** Learning shares the Feed event family and native offline cache. */
export function useFeedLearning(workspaceId: string, assistantId: string, sessionId: string, enabled: boolean) {
  const key = feedLearningCacheKey(workspaceId, assistantId, sessionId);
  const path = feedCollaborationPath(assistantId, sessionId) + '/learning';
  const resource = useCachedResource<FeedLearnedDecisions>(enabled ? key : null, () => feedPaintFirst(key,
    () => readFeedCachedJson<FeedLearnedDecisions>(path),
    async () => { try { return await feedCachedJson<FeedLearnedDecisions>(path); } catch (error) { if (isAuthoritativeFeedDenial(error)) throw new SurfaceCacheEvictionError(error); throw error; } },
  ));
  useEffect(() => {
    const refresh = () => { if (enabled) void resource.refresh(); };
    window.addEventListener(FEED_LOCAL_CHANGED, refresh); window.addEventListener('online', refresh);
    return () => { window.removeEventListener(FEED_LOCAL_CHANGED, refresh); window.removeEventListener('online', refresh); };
  }, [enabled, resource.refresh]);
  return resource;
}
