"use client";

/**
 * Chunked Brain entries - the accumulating read behind the Brain list.
 *
 * The Brain page used to issue one `listBrain({ limit: 100 })` and render the
 * result. The route capped at 100 and always returned `nextCursor: null`, so a
 * workspace with thousands of entries showed the first 100, offered no way to
 * reach the rest, and printed `rows.length` as the count - confidently
 * reporting "100 entries" for a brain holding four thousand. That is silent
 * truncation, not slowness.
 *
 * This hook pages instead: it keeps every chunk received so far, and asks for
 * the next one when the list is scrolled near its end. Data populates
 * downward while the user reads, rather than arriving all at once or not at
 * all.
 *
 * Three things it has to get right:
 *
 *  - **Reset on query change.** Filters, search, workspace and the refresh
 *    tick all change WHAT is being listed, so they restart at page 1. The
 *    query identity is a single string (`queryKey`); anything that belongs in
 *    it and is missing would silently append rows from one query onto another.
 *  - **Discard stale responses.** A page in flight when the query changes must
 *    not append to the new query's list. Responses carry the key they were
 *    issued under and are dropped if it no longer matches - a plain `cancelled`
 *    flag is not enough here, because `loadMore` fires outside the effect that
 *    would own that flag.
 *  - **Dedupe on append.** Rows are keyed `kind:id` and merged as a set. The
 *    route's arms should not repeat a row across pages, but a duplicate React
 *    key is a hard render bug, and this is one line of insurance against one.
 *
 * `chunkStart` is the index where the most recent chunk begins. The list uses
 * it to animate only the newly arrived rows - re-animating the whole list on
 * every append would turn a quiet fill into a flicker.
 *
 * Spec: docs/architecture/features/perceived-performance.md → "Chunked lists"
 * [COMP:app-web/brain-entries]
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { listBrain, type BrainPrimitive, type BrainRow } from "@/lib/api/brain";
import {
  BRAIN_ENTRIES_RESOURCE,
  deleteBrainContentCache,
  isBrainEntriesSnapshot,
  isAuthoritativeBrainDenial,
  projectCachedBrainRows,
  readBrainContentCache,
  writeBrainContentCache,
  type BrainContentCacheScope,
} from "@/lib/offline/brain-content-cache";

/** Rows requested per arm, per page. See the route's `limit` semantics. */
const BRAIN_PAGE_SIZE = 60;

export type BrainEntriesState = {
  /** Every row received so far, in arrival order. */
  rows: BrainRow[] | null;
  /** First page still in flight - the only state that warrants a skeleton. */
  loading: boolean;
  /** A follow-on chunk is in flight. */
  loadingMore: boolean;
  /** The server has more; drives the sentinel and the "load more" affordance. */
  hasMore: boolean;
  /** Index of the newest chunk's first row, for the entrance animation. */
  chunkStart: number;
  /** Request the next chunk. No-op while one is in flight or when exhausted. */
  loadMore: () => void;
};

export type BrainEntriesParams = {
  workspaceId: string | null;
  /** Signed-in user id. Required for the persistent cache isolation key. */
  viewerId: string | null;
  primitives: BrainPrimitive[];
  search: string;
  viewpointAssistantId?: string | null;
  /** Bumped by the brain refresh bus; restarts from page 1. */
  refreshTick: number;
  /** Off switch - the Brain page only lists in its `entries` section. */
  enabled: boolean;
};

/** Stable identity for "what is being listed". Order-independent on kinds. */
function buildQueryKey(params: BrainEntriesParams): string {
  return JSON.stringify({
    w: params.workspaceId,
    u: params.viewerId,
    p: [...params.primitives].sort(),
    q: params.search,
    v: params.viewpointAssistantId ?? null,
    t: params.refreshTick,
  });
}

const rowKey = (row: BrainRow) => `${row.kind}:${row.id}`;

export function useBrainEntries(
  params: BrainEntriesParams,
): BrainEntriesState {
  const {
    workspaceId,
    viewerId,
    primitives,
    search,
    viewpointAssistantId,
    enabled,
  } = params;
  const queryKey = buildQueryKey(params);

  const [rows, setRows] = useState<BrainRow[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [chunkStart, setChunkStart] = useState(0);

  // The query a response must still belong to in order to be applied.
  const activeKeyRef = useRef(queryKey);
  activeKeyRef.current = queryKey;
  // Guards against a scroll sentinel firing repeatedly while a chunk is out.
  const inFlightRef = useRef(false);
  const seenRef = useRef<Set<string>>(new Set());
  const rowsRef = useRef<BrainRow[] | null>(null);

  const cacheScope: BrainContentCacheScope | null =
    workspaceId && viewerId
      ? { workspaceId, viewerId, viewpointAssistantId }
      : null;
  const isDefaultQuery = primitives.length === 0 && search.trim().length === 0;

  const fetchPage = useCallback(
    async (pageCursor: string | null, key: string) => {
      if (!workspaceId) return;
      inFlightRef.current = true;
      if (pageCursor) setLoadingMore(true);
      try {
        const result = await listBrain({
          workspaceId,
          primitives: primitives.length ? primitives : undefined,
          search: search || undefined,
          viewpointAssistantId,
          limit: BRAIN_PAGE_SIZE,
          cursor: pageCursor ?? undefined,
          failOnError: true,
        });
        // The query moved on while this was in flight - drop it rather than
        // append one query's rows onto another's list.
        if (activeKeyRef.current !== key) return;
        const base = pageCursor && rowsRef.current ? rowsRef.current : [];
        if (!pageCursor) seenRef.current = new Set();
        const fresh = result.rows.filter((row) => {
          const id = rowKey(row);
          if (seenRef.current.has(id)) return false;
          seenRef.current.add(id);
          return true;
        });
        const nextRows = [...base, ...fresh];
        rowsRef.current = nextRows;
        setChunkStart(base.length);
        setRows(nextRows);
        setCursor(result.nextCursor);
        setHasMore(result.nextCursor !== null);
        if (cacheScope && isDefaultQuery) {
          void writeBrainContentCache(cacheScope, BRAIN_ENTRIES_RESOURCE, {
            rows: nextRows,
            nextCursor: result.nextCursor,
          });
        }
      } catch (error) {
        // A failed page leaves what is already on screen and stops paging;
        // the next filter change or refresh retries from the top.
        if (activeKeyRef.current !== key) return;
        if (isAuthoritativeBrainDenial(error)) {
          rowsRef.current = [];
          seenRef.current = new Set();
          setRows([]);
          if (cacheScope) {
            void deleteBrainContentCache(cacheScope, BRAIN_ENTRIES_RESOURCE);
          }
        } else if (rowsRef.current === null) {
          rowsRef.current = [];
          setRows([]);
        }
        setHasMore(false);
      } finally {
        if (activeKeyRef.current === key) setLoadingMore(false);
        inFlightRef.current = false;
      }
    },
    [
      workspaceId,
      primitives,
      search,
      viewpointAssistantId,
      cacheScope,
      isDefaultQuery,
    ],
  );

  // First page. Re-runs whenever the query identity changes, which is also
  // what resets the accumulated list.
  useEffect(() => {
    if (!enabled || !workspaceId) return;
    setRows(null);
    rowsRef.current = null;
    setCursor(null);
    setHasMore(false);
    setChunkStart(0);
    seenRef.current = new Set();
    let cancelled = false;
    void (async () => {
      if (cacheScope) {
        const cached = await readBrainContentCache(
          cacheScope,
          BRAIN_ENTRIES_RESOURCE,
          isBrainEntriesSnapshot,
        );
        if (cancelled || activeKeyRef.current !== queryKey) return;
        if (cached) {
          const projected = projectCachedBrainRows(
            cached.value.rows,
            primitives,
            search,
          );
          rowsRef.current = projected;
          seenRef.current = new Set(projected.map(rowKey));
          setRows(projected);
          setChunkStart(0);
          // Only the default query can resume its opaque server cursor. A
          // filtered local projection has no corresponding server position.
          const nextCursor = isDefaultQuery ? cached.value.nextCursor : null;
          setCursor(nextCursor);
          setHasMore(nextCursor !== null);
        }
      }
      if (!cancelled && activeKeyRef.current === queryKey) {
        await fetchPage(null, queryKey);
      }
    })();
    return () => {
      cancelled = true;
    };
    // `fetchPage` is derived from the same inputs as `queryKey`; depending on
    // both would double-fire the first page on every filter change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryKey, enabled, workspaceId]);

  const loadMore = useCallback(() => {
    if (!enabled || inFlightRef.current || !cursor) return;
    void fetchPage(cursor, activeKeyRef.current);
  }, [enabled, cursor, fetchPage]);

  return {
    rows,
    loading: rows === null,
    loadingMore,
    hasMore,
    chunkStart,
    loadMore,
  };
}
