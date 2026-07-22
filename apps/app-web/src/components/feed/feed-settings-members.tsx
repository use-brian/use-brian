"use client";

/**
 * Feed settings → Members — per-member draft-access management, ported
 * faithfully from
 * `apps/feed-web/src/app/w/[workspaceId]/[platform]/settings/members/page.tsx`
 * (docs/plans/feed-web-consolidation.md §7.6). Lets a team admin/owner
 * toggle the per-member `canDraft` flag for non-admin members. Owners and
 * admins always have draft permission, so their toggle is shown read-only
 * with an explainer.
 *
 * The toggle calls PATCH /api/workspaces/:workspaceId/members/:userId/permissions
 * (admin/owner gated server-side; see
 * `use-brian/packages/api/src/routes/workspaces.ts`) with optimistic
 * update + revert-on-failure, one row in flight at a time.
 *
 * Port deltas (disposition rules §6):
 *   - `useWorkspaceContext()` → `useFeedWorkspace()`; inline `authFetch`
 *     RPCs → the feed SDK (`fetchFeedWorkspaceMembers` /
 *     `updateFeedMemberDraftPermission`).
 *   - feed-web's `ui/back-button` clone → app-web's `BackButton`; href via
 *     `feedPath()`; label reuses the `feedPage.sections.settings` nav key.
 *   - All copy via `useT().feedPage.settings` (+ shared `home.roles`).
 *
 * [COMP:app-web/feed-settings] (source cell covers settings + members)
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";
import { BackButton } from "@/components/ui/back-button";
import { useFeedWorkspace } from "@/contexts/feed-profiles-context";
import {
  fetchFeedWorkspaceMembers,
  updateFeedMemberDraftPermission,
  type FeedWorkspaceMember,
} from "@/lib/api/feed";
import { feedPath, type FeedPlatform } from "@/lib/feed-nav";
import { useT } from "@/lib/i18n/client";

/** Owner rows first, then admins, then members — feed-web's list order. */
// exported for tests
export function sortMembersByRole(
  members: readonly FeedWorkspaceMember[],
): FeedWorkspaceMember[] {
  const order = { owner: 0, admin: 1, member: 2 } as const;
  return [...members].sort((a, b) => order[a.role] - order[b.role]);
}

/** Display precedence: trimmed name → email → the first 8 id chars. */
// exported for tests
export function memberDisplayName(
  m: Pick<FeedWorkspaceMember, "userName" | "email" | "userId">,
): string {
  return m.userName?.trim() || m.email || m.userId.slice(0, 8);
}

/**
 * Effective draft permission as the toggle renders it: owner/admin always
 * on (and locked); members follow their `canDraft` column.
 */
// exported for tests
export function effectiveDraftAccess(
  m: Pick<FeedWorkspaceMember, "role" | "canDraft">,
): boolean {
  return m.role === "owner" || m.role === "admin" || m.canDraft;
}

export function FeedSettingsMembers() {
  const params = useParams<{ workspaceId: string; platform: string }>();
  const team = useFeedWorkspace();
  const t = useT().feedPage;
  const platform = params.platform as FeedPlatform;
  const isAdmin = team.role === "admin" || team.role === "owner";

  const [members, setMembers] = useState<FeedWorkspaceMember[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ userId: string; message: string } | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      setMembers(await fetchFeedWorkspaceMembers(team.workspaceId));
    } catch {
      setLoadError(t.settings.membersLoadFailed);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [team.workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const sortedMembers = useMemo(
    () => (members ? sortMembersByRole(members) : []),
    [members],
  );

  async function toggleCanDraft(member: FeedWorkspaceMember, next: boolean) {
    if (!isAdmin || pendingId) return;
    if (member.role !== "member") return;
    setPendingId(member.userId);
    setRowError(null);
    setMembers((prev) =>
      prev?.map((m) =>
        m.userId === member.userId ? { ...m, canDraft: next } : m,
      ) ?? null,
    );
    try {
      const result = await updateFeedMemberDraftPermission(
        team.workspaceId,
        member.userId,
        next,
      );
      if (!result.ok) throw new Error(result.error ?? t.settings.updateFailed);
    } catch (err) {
      setRowError({
        userId: member.userId,
        message: err instanceof Error ? err.message : t.settings.updateFailed,
      });
      setMembers((prev) =>
        prev?.map((m) =>
          m.userId === member.userId ? { ...m, canDraft: !next } : m,
        ) ?? null,
      );
    } finally {
      setPendingId(null);
    }
  }

  return (
    <div className="px-4 md:px-6 py-5 max-w-3xl mx-auto space-y-5">
      <header className="space-y-1.5">
        <BackButton
          href={feedPath(team.workspaceId, { platform, segment: "settings" })}
          label={t.sections.settings}
        />
        <h1
          className="text-[15px] font-semibold"        >
          {t.settings.membersTitle}
        </h1>
        <p className="text-sm text-muted-foreground">
          {t.settings.membersIntroBefore}{" "}
          <span className="font-medium text-foreground">{t.settings.draftAccess}</span>{" "}
          {t.settings.membersIntroAfter}
        </p>
      </header>

      {loadError ? (
        <div className="rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {loadError}
        </div>
      ) : null}

      {!isAdmin ? (
        <div className="rounded-xl border border-border bg-card p-4 text-sm text-muted-foreground">
          {t.settings.membersAdminOnly}
        </div>
      ) : null}

      {members === null && !loadError ? (
        <ul className="space-y-2">
          {[1, 2, 3].map((i) => (
            <li
              key={i}
              className="rounded-xl border border-border bg-card p-4 animate-pulse h-16"
            />
          ))}
        </ul>
      ) : null}

      {members !== null ? (
        <ul className="space-y-2">
          {sortedMembers.map((m) => {
            const isOwnerOrAdmin = m.role === "owner" || m.role === "admin";
            const display = memberDisplayName(m);
            return (
              <li
                key={m.userId}
                className="rounded-xl border border-border bg-card p-4 flex items-center gap-4"
              >
                <Avatar
                  src={m.avatarUrl}
                  fallback={(display[0] ?? "?").toUpperCase()}
                />
                <div className="flex-1 min-w-0 space-y-0.5">
                  <div className="text-sm font-medium truncate">{display}</div>
                  {m.email && m.email !== display ? (
                    <div className="text-xs text-muted-foreground truncate">
                      {m.email}
                    </div>
                  ) : null}
                  <div className="text-[11px] text-muted-foreground capitalize">
                    {t.home.roles[m.role]}
                  </div>
                  {rowError?.userId === m.userId ? (
                    <div className="text-[11px] text-destructive pt-0.5">
                      {rowError.message}
                    </div>
                  ) : null}
                </div>
                <div className="flex flex-col items-end gap-1 shrink-0">
                  <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    {t.settings.draftAccess}
                  </span>
                  <DraftAccessToggle
                    checked={effectiveDraftAccess(m)}
                    disabled={
                      !isAdmin ||
                      isOwnerOrAdmin ||
                      pendingId !== null
                    }
                    pending={pendingId === m.userId}
                    onChange={(v) => void toggleCanDraft(m, v)}
                    locked={isOwnerOrAdmin}
                    titles={{
                      locked: t.settings.toggleLockedTitle,
                      revoke: t.settings.toggleRevokeTitle,
                      grant: t.settings.toggleGrantTitle,
                    }}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

function DraftAccessToggle(props: {
  checked: boolean;
  disabled: boolean;
  pending: boolean;
  locked: boolean;
  onChange: (v: boolean) => void;
  titles: { locked: string; revoke: string; grant: string };
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.checked}
      disabled={props.disabled}
      onClick={() => props.onChange(!props.checked)}
      title={
        props.locked
          ? props.titles.locked
          : props.checked
            ? props.titles.revoke
            : props.titles.grant
      }
      className={
        "relative inline-flex h-6 w-11 items-center rounded-full transition-colors disabled:cursor-not-allowed " +
        (props.checked
          ? "bg-primary"
          : "bg-muted ring-1 ring-border") +
        (props.disabled && !props.locked ? " opacity-60" : "")
      }
    >
      <span
        className={
          "inline-block h-5 w-5 transform rounded-full bg-background shadow transition-transform " +
          (props.checked ? "translate-x-5" : "translate-x-0.5") +
          (props.pending ? " animate-pulse" : "")
        }
      />
    </button>
  );
}

function Avatar(props: { src: string | null; fallback: string }) {
  if (props.src) {
    // eslint-disable-next-line @next/next/no-img-element
    return (
      <img
        src={props.src}
        alt=""
        className="h-9 w-9 rounded-full object-cover ring-1 ring-border"
      />
    );
  }
  return (
    <span className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-primary/10 text-primary text-sm font-semibold ring-1 ring-primary/20">
      {props.fallback}
    </span>
  );
}
