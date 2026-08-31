"use client";

/**
 * Shared Live-roster loader. Both the persistent sidebar and the route-owned
 * detail pane consume the same endpoint and refresh vocabulary; keeping the
 * lifecycle here prevents the two chrome regions from drifting even though
 * they mount on opposite sides of the workspace layout boundary.
 *
 * [COMP:app-web/live-app]
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { fetchLiveRoster, type LiveWorkItem } from "@/lib/api/live";
import {
  LIVE_REFRESH_EVENT,
  SCHEDULED_JOB_REFRESH_EVENT,
} from "@/lib/workspace-events";
import { WORKFLOW_REFRESH_EVENT } from "@/lib/workflow-events";

const REFRESH_EVENTS = [
  LIVE_REFRESH_EVENT,
  WORKFLOW_REFRESH_EVENT,
  SCHEDULED_JOB_REFRESH_EVENT,
] as const;

export type LiveRosterState = {
  items: LiveWorkItem[];
  loaded: boolean;
  error: boolean;
};

export function useLiveRoster(workspaceId: string): LiveRosterState {
  const [items, setItems] = useState<LiveWorkItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);
  const cancelledRef = useRef(false);

  const load = useCallback(async () => {
    try {
      const roster = await fetchLiveRoster(workspaceId);
      if (cancelledRef.current) return;
      setItems(roster);
      setError(false);
    } catch {
      if (!cancelledRef.current) setError(true);
    } finally {
      if (!cancelledRef.current) setLoaded(true);
    }
  }, [workspaceId]);

  useEffect(() => {
    if (!workspaceId) return;
    // Strict Mode runs mount -> cleanup -> mount. Reset on entry so the second
    // mount is live rather than inheriting the first cleanup's latch.
    cancelledRef.current = false;
    void load();
    const onRefresh = () => void load();
    for (const event of REFRESH_EVENTS) {
      window.addEventListener(event, onRefresh);
    }
    window.addEventListener("focus", onRefresh);
    return () => {
      cancelledRef.current = true;
      for (const event of REFRESH_EVENTS) {
        window.removeEventListener(event, onRefresh);
      }
      window.removeEventListener("focus", onRefresh);
    };
  }, [load, workspaceId]);

  return { items, loaded, error };
}
