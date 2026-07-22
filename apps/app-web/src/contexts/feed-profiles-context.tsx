"use client";

/**
 * Feed workspace context — the app-web replacement for feed-web's
 * `TeamContextProvider` (`apps/feed-web/src/lib/workspace-context.tsx`).
 *
 * feed-web resolved this server-side in its workspace layout; here the fetch
 * is CLIENT-side (an effect over `authFetch`) so the same provider works in
 * the Vite desktop SPA, which has no server layouts
 * (docs/plans/feed-web-consolidation.md §4). `FeedSurfaceShell` gates its
 * children on `status === "ready"`, so ported feed pages keep their original
 * assumption that the context is synchronously populated.
 *
 * Value shape mirrors feed-web's `WorkspaceContextValue` (workspaceId, name,
 * role, canDraft, me, profiles) plus `refresh()` for post-connect reloads.
 * Workspace identity comes from `/api/workspaces/:id`; profiles from the
 * feed SDK. A profiles error (OSS/creds-less backend 404s the whole
 * `/api/distribution` family) degrades to an empty list — the home surface
 * renders its connect-account onboarding state.
 *
 * [COMP:app-web/feed-profiles-context]
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { authFetch } from "@/lib/auth-fetch";
import { fetchFeedTeamProfiles, type FeedProfile } from "@/lib/api/feed";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export type FeedWorkspaceValue = {
  workspaceId: string;
  name: string;
  role: "owner" | "admin" | "member";
  /**
   * Whether this user can interact with the feed/draft-app — create & save
   * drafts, approve/reject saved drafts. True for owner/admin
   * unconditionally; for `role === 'member'` it reflects the
   * `workspace_members.can_draft` column an admin/owner can toggle in the
   * feed settings members page.
   */
  canDraft: boolean;
  /** Identity of the requesting user — used by collaborative surfaces
   *  (team-shared draft sessions) to dedupe own-events from bus broadcasts
   *  and skip presence flicker for self. */
  me: { id: string };
  /** Per-platform connection summary; drives the sidebar platform pill and
   *  every per-platform page's assistant resolution. */
  profiles: FeedProfile[];
  /**
   * The workspace's distribution assistants (`kind='app'`,
   * `appType='distribution'`) regardless of connection state. The Create
   * surfaces (drafts / ready / voice) resolve their assistant from HERE, so
   * a brand voice created without any OAuth connection is fully usable
   * (docs/plans/feed-create-split.md D7).
   */
  assistants: Array<{ id: string; name: string }>;
  /** Re-fetch profiles + membership (after an OAuth connect / disconnect). */
  refresh: () => Promise<void>;
};

type FeedWorkspaceState =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; value: FeedWorkspaceValue };

type WorkspaceApiResponse = {
  id?: string;
  name?: string;
  role?: "owner" | "admin" | "member";
  me?: { id: string };
  members?: Array<{
    userId: string;
    role: "owner" | "admin" | "member";
    canDraft: boolean;
  }>;
};

const FeedWorkspaceContext = createContext<FeedWorkspaceState | null>(null);

/**
 * Effective draft permission: owner/admin always; for 'member' roles look up
 * the requester's row in the members list and read `canDraft` (the list is
 * gated to team members, so it's safe for the requester's own permission).
 * Falls back to false if the row is missing. Pure — unit-tested directly.
 */
export function deriveCanDraft(team: {
  role: "owner" | "admin" | "member";
  myUserId: string;
  members?: Array<{ userId: string; canDraft: boolean }>;
}): boolean {
  if (team.role === "owner" || team.role === "admin") return true;
  const myMember = team.members?.find((m) => m.userId === team.myUserId);
  return myMember?.canDraft === true;
}

async function loadWorkspace(workspaceId: string): Promise<{
  name: string;
  role: "owner" | "admin" | "member";
  myUserId: string;
  canDraft: boolean;
}> {
  const res = await authFetch(`${API_URL}/api/workspaces/${workspaceId}`);
  if (!res.ok) throw new Error(`workspace API ${res.status}`);
  const team = (await res.json()) as WorkspaceApiResponse;
  if (!team.id || !team.name || !team.role) {
    throw new Error("workspace API returned an incomplete payload");
  }
  const myUserId = team.me?.id ?? "";
  const canDraft = deriveCanDraft({
    role: team.role,
    myUserId,
    members: team.members,
  });
  return { name: team.name, role: team.role, myUserId, canDraft };
}

async function loadDistributionAssistants(
  workspaceId: string,
): Promise<Array<{ id: string; name: string }>> {
  const res = await authFetch(
    `${API_URL}/api/assistants?workspaceId=${encodeURIComponent(workspaceId)}`,
  );
  if (!res.ok) return [];
  const body = (await res.json().catch(() => ({}))) as {
    assistants?: Array<{
      id: string;
      name: string;
      kind?: string;
      appType?: string;
    }>;
  };
  return (body.assistants ?? [])
    .filter((a) => a.kind === "app" && a.appType === "distribution")
    .map((a) => ({ id: a.id, name: a.name }));
}

export function FeedProfilesProvider(props: {
  workspaceId: string;
  children: ReactNode;
}) {
  const { workspaceId } = props;
  const [state, setState] = useState<FeedWorkspaceState>({
    status: "loading",
  });

  const load = useCallback(async (): Promise<void> => {
    const [team, profiles, assistants] = await Promise.all([
      loadWorkspace(workspaceId),
      // Profiles failure ≠ surface failure: an OSS/creds-less backend 404s
      // the whole /api/distribution family — render the zero-profile
      // onboarding state instead of an error.
      fetchFeedTeamProfiles(workspaceId).catch(() => [] as FeedProfile[]),
      // Same degrade: the Create surfaces just see no brand voice yet.
      loadDistributionAssistants(workspaceId).catch(
        () => [] as Array<{ id: string; name: string }>,
      ),
    ]);
    setState({
      status: "ready",
      value: {
        workspaceId,
        name: team.name,
        role: team.role,
        canDraft: team.canDraft,
        me: { id: team.myUserId },
        profiles,
        assistants,
        refresh: async () => {
          await load();
        },
      },
    });
  }, [workspaceId]);

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    load().catch(() => {
      if (!cancelled) setState({ status: "error" });
    });
    return () => {
      cancelled = true;
    };
  }, [load]);

  const value = useMemo(() => state, [state]);
  return (
    <FeedWorkspaceContext.Provider value={value}>
      {props.children}
    </FeedWorkspaceContext.Provider>
  );
}

/** The raw load state — only the surface shell needs this (loading/error UI). */
export function useFeedWorkspaceState(): FeedWorkspaceState {
  const state = useContext(FeedWorkspaceContext);
  if (!state) {
    throw new Error(
      "useFeedWorkspaceState must be used inside a FeedProfilesProvider",
    );
  }
  return state;
}

/**
 * The resolved feed workspace. Ported feed pages call this where they called
 * feed-web's `useWorkspaceContext()`; the shell guarantees readiness below
 * it, so consumers never see the loading/error states.
 */
export function useFeedWorkspace(): FeedWorkspaceValue {
  const state = useFeedWorkspaceState();
  if (state.status !== "ready") {
    throw new Error(
      "useFeedWorkspace read before ready — mount it under FeedSurfaceShell",
    );
  }
  return state.value;
}
