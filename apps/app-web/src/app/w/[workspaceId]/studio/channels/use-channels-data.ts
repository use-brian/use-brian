"use client";

/**
 * Studio -> Channels data layer (instant-navigation contract N1 / N2 / N7).
 *
 * The page used to run a two-round waterfall on mount - channels + assistants
 * + membership, then one `listChannelAssistants` per channel - into local
 * `useState`, so every visit painted "Loading channels..." for two round
 * trips. Three cache keys now hold the surface's data, fetched in parallel:
 *
 *  - `channelsCacheKey`: the channel list WITH its per-channel routing rows,
 *    folded into one fetcher (the routing fetch depends on the channel ids,
 *    so it is a data dependency inside the fetcher, not an effect waterfall).
 *  - `assistantsCacheKey`: shared with Studio -> Assistants, so the attach
 *    picker and the rail read one slot.
 *  - `workspaceMembershipCacheKey`: the caller's clearance + role, which gate
 *    the clearance picker and the rename affordance.
 *
 * Local edits (connect, rename, detach, disconnect) write through
 * `mutateSurfaceCache` so the next visit paints them. The key is built in
 * `lib/surface-prefetch.ts`, never here (N2).
 *
 * [COMP:app-web/studio-lists-cache]
 */

import { publicRuntimeConfig } from "@/lib/runtime-public-config";
import { useCallback } from "react";
import { authFetch } from "@/lib/auth-fetch";
import {
  listChannelAssistants,
  listChannels,
  type Channel,
  type ChannelAssistant,
  type ChannelClearance,
} from "@/lib/api/channels";
import { listAssistants, type StudioAssistantSummary } from "@/lib/api/studio";
import type { WorkspaceRole } from "@/lib/api/workspaces";
import { mutateSurfaceCache, useCachedResource } from "@/lib/surface-cache";
import {
  assistantsCacheKey,
  channelsCacheKey,
  workspaceMembershipCacheKey,
} from "@/lib/surface-prefetch";

const API_URL = publicRuntimeConfig().apiUrl ?? "http://localhost:4000";

export type ChannelsSnapshot = {
  channels: Channel[];
  routing: Record<string, ChannelAssistant[]>;
};

export type WorkspaceMembership = {
  clearance: ChannelClearance | null;
  role: WorkspaceRole | null;
};

/** The channel list plus every channel's routing rows, in one fetcher. */
async function fetchChannelsSnapshot(workspaceId: string): Promise<ChannelsSnapshot> {
  const channels = await listChannels(workspaceId);
  const entries = await Promise.all(
    channels.map(
      async (c) => [c.id, await listChannelAssistants(workspaceId, c.id)] as const,
    ),
  );
  return { channels, routing: Object.fromEntries(entries) };
}

/**
 * Pull the caller's own `workspace_members` row for `workspaceId` off the
 * existing `GET /workspaces/:id` endpoint. The endpoint returns `members[]`
 * with one row per workspace member; we match on `me.id` to find ours.
 *
 * Two fields are read from it. `clearance` filters the clearance dropdown to
 * the caller's own tier (RLS would reject a higher one anyway). `role` gates
 * the rename affordance - the PATCH route refuses `displayName` from a plain
 * member, so showing the pencil to one would only produce a 403.
 *
 * Returns nulls on any failure: the UI then keeps its safe 'internal' default
 * and treats the caller as a non-admin, so a failed probe never *grants* an
 * affordance the server would reject.
 */
async function fetchWorkspaceMembership(workspaceId: string): Promise<WorkspaceMembership> {
  try {
    const res = await authFetch(
      `${API_URL}/api/workspaces/${encodeURIComponent(workspaceId)}`,
    );
    if (!res.ok) return { clearance: null, role: null };
    const data = (await res.json()) as {
      me?: { id?: string };
      members?: {
        userId: string;
        clearance?: ChannelClearance;
        role?: WorkspaceRole;
      }[];
    };
    const meId = data.me?.id;
    if (!meId || !Array.isArray(data.members)) return { clearance: null, role: null };
    const mine = data.members.find((m) => m.userId === meId);
    return { clearance: mine?.clearance ?? null, role: mine?.role ?? null };
  } catch {
    return { clearance: null, role: null };
  }
}

export function useChannelsData(workspaceId: string | null) {
  const channelsKey = workspaceId ? channelsCacheKey(workspaceId) : null;
  const assistantsKey = workspaceId ? assistantsCacheKey(workspaceId) : null;
  const membershipKey = workspaceId ? workspaceMembershipCacheKey(workspaceId) : null;

  const channels = useCachedResource<ChannelsSnapshot>(channelsKey, () =>
    fetchChannelsSnapshot(workspaceId as string),
  );
  const assistants = useCachedResource<StudioAssistantSummary[]>(assistantsKey, () =>
    listAssistants(workspaceId as string),
  );
  const membership = useCachedResource<WorkspaceMembership>(membershipKey, () =>
    fetchWorkspaceMembership(workspaceId as string),
  );

  const updateChannels = useCallback(
    (updater: (prev: Channel[]) => Channel[]) => {
      mutateSurfaceCache<ChannelsSnapshot>(channelsKey, (prev) => ({
        ...prev,
        channels: updater(prev.channels),
      }));
    },
    [channelsKey],
  );

  const updateRouting = useCallback(
    (
      updater: (
        prev: Record<string, ChannelAssistant[]>,
      ) => Record<string, ChannelAssistant[]>,
    ) => {
      mutateSurfaceCache<ChannelsSnapshot>(channelsKey, (prev) => ({
        ...prev,
        routing: updater(prev.routing),
      }));
    },
    [channelsKey],
  );

  const refreshRouting = useCallback(
    async (channelId: string) => {
      if (!workspaceId) return;
      const rows = await listChannelAssistants(workspaceId, channelId);
      updateRouting((prev) => ({ ...prev, [channelId]: rows }));
    },
    [workspaceId, updateRouting],
  );

  return {
    /** null until the first snapshot lands (cold) - the skeleton state. */
    channels: channels.data?.channels ?? null,
    routing: channels.data?.routing ?? {},
    loading: channels.loading,
    revalidating: channels.revalidating,
    /** Set only when the list has never loaded; a failed revalidation keeps the last rows. */
    error: channels.data === undefined ? channels.error : undefined,
    refresh: channels.refresh,
    assistants: assistants.data ?? [],
    myClearance: membership.data?.clearance ?? null,
    myRole: membership.data?.role ?? null,
    updateChannels,
    updateRouting,
    refreshRouting,
  };
}
