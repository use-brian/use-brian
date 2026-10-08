"use client";

import { useEffect } from "react";
import { parseBrainDeepLink } from "./brain-deep-link";
import { fetchBrainRow } from "./api/brain-inbox";
import { projectInboxRowToBrainRow, type BrainRow } from "./api/brain";
import type { BrainContentCacheScope } from "./offline/brain-content-cache";

/** Authority-scoped row navigation. [COMP:app-web/brain-deep-link] */
export function useBrainRowDeepLink(
  query: string,
  scope: BrainContentCacheScope | null,
  select: (row: BrainRow | null) => void,
) {
  const link = parseBrainDeepLink(new URLSearchParams(query));
  const rowId = link?.rowId;
  const primitive = link?.primitive;
  const viewerId = scope?.viewerId;
  const workspaceId = scope?.workspaceId;
  const viewpointAssistantId = scope?.viewpointAssistantId;
  useEffect(() => {
    if (!rowId || !primitive) return;
    select(null);
    if (!viewerId || !workspaceId) return;
    let cancelled = false;
    void fetchBrainRow(workspaceId, primitive, rowId, {
      viewerId, workspaceId, viewpointAssistantId: viewpointAssistantId ?? null,
    }).then((detail) => {
      if (cancelled || !detail) return;
      select({ ...projectInboxRowToBrainRow(detail), hasPending: detail.verifiedAt == null });
    }).catch(() => {
      // An unavailable or denied link cannot retain a previous selection.
      if (!cancelled) select(null);
    });
    return () => { cancelled = true; };
  }, [rowId, primitive, viewerId, workspaceId, viewpointAssistantId, select]);
}
