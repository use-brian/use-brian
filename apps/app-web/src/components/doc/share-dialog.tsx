"use client";

/**
 * Share panel — Notion-style. Anchored popover opened from the page-header
 * "Share" button (not a centered modal, not buried in the overflow menu).
 * Two tabs:
 *   - Share   — invite workspace members / groups by name or email, each at a
 *               role (Full access / Can edit / Can comment / Can view); a
 *               "General access" row sets the workspace default. view/comment
 *               grants are server-enforced read-only on the live doc.
 *   - Publish — the anonymous "anyone with the link" web link (view/comment;
 *               page must be public; optional search indexing).
 *
 * Roles use the on-brand `DropdownMenu` (no native select); confirms use
 * confirmDialog. No em dashes in copy.
 *
 * [COMP:app-web/share-dialog]
 */

import { useEffect, useMemo, useState } from "react";
import { Check, ChevronDown, Globe, HelpCircle, Link2, Search, Users } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { useT, format } from "@/lib/i18n/client";
import { useWorkspaceContext } from "@/lib/workspace-context";
import { docPagePath } from "@/lib/doc-page-url";
import {
  listShareableMembers,
  listShareGrants,
  listWorkspaceGroups,
  publishPage,
  revokeGrant,
  unpublishPage,
  updateGrantRole,
  upsertIdentityGrant,
  type GrantRole,
  type IdentityGrant,
  type PublishState,
  type ShareMember,
  type WorkspaceGroup,
} from "@/lib/api/views";

type Tab = "share" | "publish";
type ShareT = ReturnType<typeof useT>["docPage"]["share"];

function roleLabel(role: string, t: ShareT): string {
  switch (role) {
    case "full":
      return t.roleFull;
    case "edit":
      return t.roleWrite;
    case "comment":
      return t.roleComment;
    default:
      return t.roleView;
  }
}

/** Notion-style role picker: a menu of role options plus an optional Remove. */
function RoleMenu({
  role,
  onChange,
  onRemove,
  t,
  includeFull = true,
}: {
  role: GrantRole;
  onChange: (r: GrantRole) => void;
  onRemove?: () => void;
  t: ShareT;
  includeFull?: boolean;
}) {
  const opts: GrantRole[] = includeFull ? ["full", "edit", "comment", "view"] : ["edit", "comment", "view"];
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            className="inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground aria-expanded:bg-muted"
          >
            {roleLabel(role, t)}
            <ChevronDown className="size-3" aria-hidden />
          </button>
        }
      />
      <DropdownMenuContent>
        {opts.map((o) => (
          <DropdownMenuItem key={o} onClick={() => onChange(o)}>
            <span className="flex-1">{roleLabel(o, t)}</span>
            {role === o ? <Check className="size-3.5" aria-hidden /> : null}
          </DropdownMenuItem>
        ))}
        {onRemove ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onClick={onRemove}>
              {t.remove}
            </DropdownMenuItem>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Avatar({ name, url }: { name: string; url?: string | null }) {
  if (url) {
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={url} alt="" className="size-7 shrink-0 rounded-full object-cover" />;
  }
  const initial = (name.trim()[0] ?? "?").toUpperCase();
  return (
    <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-medium text-muted-foreground">
      {initial}
    </span>
  );
}

export function ShareDialog({
  pageId,
  workspaceId,
  currentUser,
}: {
  pageId: string;
  workspaceId: string;
  currentUser: { id: string; name: string; avatarUrl?: string | null };
}) {
  const t = useT().docPage.share;
  const workspace = useWorkspaceContext();

  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<Tab>("share");
  const [error, setError] = useState<string | null>(null);

  // Grants + directory
  const [identityGrants, setIdentityGrants] = useState<IdentityGrant[]>([]);
  const [members, setMembers] = useState<ShareMember[]>([]);
  const [groups, setGroups] = useState<WorkspaceGroup[]>([]);

  // Share tab — invite box + Copy link feedback
  const [inviteQuery, setInviteQuery] = useState("");
  const [copiedPage, setCopiedPage] = useState(false);

  // Publish tab — one universal URL (the page published to the web)
  const [publish, setPublish] = useState<PublishState>({ published: false, indexable: false });
  const [busy, setBusy] = useState(false);
  const [copiedPublish, setCopiedPublish] = useState(false);

  const publishUrl =
    typeof window !== "undefined" ? `${window.location.origin}/share/p/${pageId}` : `/share/p/${pageId}`;

  async function reload() {
    try {
      const [g, m, gr] = await Promise.all([
        listShareGrants(pageId),
        listShareableMembers(pageId).catch(() => [] as ShareMember[]),
        listWorkspaceGroups(pageId).catch(() => [] as WorkspaceGroup[]),
      ]);
      setIdentityGrants(g.identityGrants);
      setMembers(m);
      setGroups(gr);
      setPublish(g.publish);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  useEffect(() => {
    if (!open) return;
    setError(null);
    setInviteQuery("");
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, pageId]);

  const workspaceGrant = identityGrants.find((g) => g.principalType === "workspace");
  const userGrants = identityGrants.filter((g) => g.principalType === "user");
  const groupGrants = identityGrants.filter((g) => g.principalType === "group");
  const grantedUserIds = new Set(userGrants.map((g) => g.principalRef));
  const grantedGroupIds = new Set(groupGrants.map((g) => g.principalRef));

  const suggestions = useMemo(() => {
    const q = inviteQuery.trim().toLowerCase();
    if (!q) return { members: [] as ShareMember[], groups: [] as WorkspaceGroup[] };
    return {
      members: members
        .filter((m) => m.userId !== currentUser.id && !grantedUserIds.has(m.userId))
        .filter((m) => (m.name ?? "").toLowerCase().includes(q) || (m.email ?? "").toLowerCase().includes(q))
        .slice(0, 5),
      groups: groups
        .filter((g) => !grantedGroupIds.has(g.id))
        .filter((g) => g.name.toLowerCase().includes(q))
        .slice(0, 3),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inviteQuery, members, groups, identityGrants, currentUser.id]);

  /** Run a mutation, surface errors, then refresh. */
  function guard(fn: () => Promise<void>) {
    return async () => {
      setError(null);
      try {
        await fn();
        await reload();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    };
  }

  const grantUser = (userId: string, role: GrantRole = "edit") =>
    guard(async () => {
      await upsertIdentityGrant(pageId, { principalType: "user", principalRef: userId, role });
      setInviteQuery("");
    })();

  const grantGroup = (groupId: string, role: GrantRole = "edit") =>
    guard(async () => {
      await upsertIdentityGrant(pageId, { principalType: "group", principalRef: groupId, role });
      setInviteQuery("");
    })();

  async function handleInvite() {
    const tokens = inviteQuery.split(",").map((s) => s.trim()).filter(Boolean);
    if (tokens.length === 0) return;
    setError(null);
    const notFound: string[] = [];
    try {
      for (const tok of tokens) {
        const low = tok.toLowerCase();
        const member = members.find(
          (m) => (m.email ?? "").toLowerCase() === low || (m.name ?? "").toLowerCase() === low,
        );
        const group = groups.find((g) => g.name.toLowerCase() === low);
        if (member) {
          await upsertIdentityGrant(pageId, { principalType: "user", principalRef: member.userId, role: "edit" });
        } else if (group) {
          await upsertIdentityGrant(pageId, { principalType: "group", principalRef: group.id, role: "edit" });
        } else {
          notFound.push(tok);
        }
      }
      setInviteQuery("");
      await reload();
      if (notFound.length > 0) setError(format(t.inviteNotFound, { names: notFound.join(", ") }));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  const setWorkspaceDefault = (role: GrantRole) =>
    guard(() => upsertIdentityGrant(pageId, { principalType: "workspace", principalRef: workspaceId, role }))();

  async function copyPageLink() {
    if (typeof window === "undefined") return;
    const url = `${window.location.origin}${docPagePath(workspaceId, pageId)}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopiedPage(true);
      window.setTimeout(() => setCopiedPage(false), 1600);
    } catch {
      setError(url);
    }
  }

  async function doPublish() {
    setError(null);
    setBusy(true);
    try {
      const next = await publishPage(pageId, publish.indexable);
      setPublish(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function doUnpublish() {
    setError(null);
    setBusy(true);
    try {
      await unpublishPage(pageId);
      setPublish({ published: false, indexable: false });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function setIndexing(indexable: boolean) {
    setError(null);
    setPublish((p) => ({ ...p, indexable }));
    try {
      const next = await publishPage(pageId, indexable);
      setPublish(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function copyPublishUrl() {
    if (typeof window === "undefined") return;
    try {
      await navigator.clipboard.writeText(publishUrl);
      setCopiedPublish(true);
      window.setTimeout(() => setCopiedPublish(false), 1600);
    } catch {
      setError(publishUrl);
    }
  }

  const tabs: { id: Tab; label: string }[] = [
    { id: "share", label: t.tabShare },
    { id: "publish", label: t.tabPublish },
  ];

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            type="button"
            aria-label={t.shareButton}
            className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground aria-expanded:bg-muted"
          >
            <Link2 className="size-4" aria-hidden />
            <span className="hidden sm:inline">{t.shareButton}</span>
          </button>
        }
      />
      <PopoverContent
        align="end"
        side="bottom"
        sideOffset={6}
        className="w-[26rem] max-w-[calc(100vw-2rem)] p-0"
      >
        <div className="flex items-center gap-1 border-b border-border px-2 pt-2">
          {tabs.map((tb) => (
            <button
              key={tb.id}
              type="button"
              onClick={() => setTab(tb.id)}
              className={`relative px-2.5 py-2 text-sm font-medium transition-colors ${
                tab === tb.id
                  ? "text-foreground after:absolute after:inset-x-2 after:-bottom-px after:h-0.5 after:rounded-full after:bg-foreground"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {tb.label}
            </button>
          ))}
        </div>

        {tab === "share" ? (
          <div className="p-3">
            {/* Invite row */}
            <div className="flex items-center gap-2">
              <input
                value={inviteQuery}
                onChange={(e) => setInviteQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    void handleInvite();
                  }
                }}
                placeholder={t.invitePlaceholder}
                className="min-w-0 flex-1 rounded-md border border-border bg-background px-3 py-1.5 text-sm outline-none focus:border-primary"
              />
              <button
                type="button"
                onClick={() => void handleInvite()}
                disabled={!inviteQuery.trim()}
                className="shrink-0 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
              >
                {t.invite}
              </button>
            </div>

            {/* Typeahead suggestions */}
            {inviteQuery.trim() && (suggestions.members.length > 0 || suggestions.groups.length > 0) ? (
              <ul className="mt-2 overflow-hidden rounded-md border border-border">
                {suggestions.members.map((m) => (
                  <li key={`m-${m.userId}`}>
                    <button
                      type="button"
                      onClick={() => void grantUser(m.userId)}
                      className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-sm hover:bg-muted"
                    >
                      <Avatar name={m.name ?? m.email ?? "?"} url={m.avatarUrl} />
                      <span className="min-w-0 flex-1 truncate">{m.name ?? m.email ?? m.userId}</span>
                    </button>
                  </li>
                ))}
                {suggestions.groups.map((g) => (
                  <li key={`g-${g.id}`}>
                    <button
                      type="button"
                      onClick={() => void grantGroup(g.id)}
                      className="flex w-full items-center gap-2 px-2 py-1.5 text-left text-sm hover:bg-muted"
                    >
                      <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                        <Users className="size-3.5" aria-hidden />
                      </span>
                      <span className="min-w-0 flex-1 truncate">
                        {g.name}
                        <span className="ml-1 text-xs text-muted-foreground">
                          {format(t.groupSubtitle, { count: g.memberCount })}
                        </span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}

            {/* Grantee list */}
            <ul className="mt-3 max-h-64 space-y-0.5 overflow-y-auto">
              {/* You (owner) */}
              <li className="flex items-center gap-2 rounded-md px-1 py-1.5">
                <Avatar name={currentUser.name} url={currentUser.avatarUrl} />
                <span className="min-w-0 flex-1 truncate text-sm">
                  {format(t.youLabel, { name: currentUser.name })}
                </span>
                <span className="shrink-0 px-1.5 text-xs text-muted-foreground">{t.roleFull}</span>
              </li>

              {/* Member grants */}
              {userGrants.map((g) => (
                <li key={g.id} className="flex items-center gap-2 rounded-md px-1 py-1.5">
                  <Avatar name={g.principalLabel ?? "?"} url={null} />
                  <span className="min-w-0 flex-1 truncate text-sm">{g.principalLabel ?? g.principalRef}</span>
                  <RoleMenu
                    role={g.role as GrantRole}
                    onChange={(r) => void guard(() => updateGrantRole(pageId, g.id, r))()}
                    onRemove={() => void guard(() => revokeGrant(pageId, g.id))()}
                    t={t}
                  />
                </li>
              ))}

              {/* Group grants */}
              {groupGrants.map((g) => {
                const count = groups.find((x) => x.id === g.principalRef)?.memberCount ?? 0;
                return (
                  <li key={g.id} className="flex items-center gap-2 rounded-md px-1 py-1.5">
                    <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                      <Users className="size-3.5" aria-hidden />
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm">
                      {g.principalLabel ?? g.principalRef}
                      <span className="ml-1 text-xs text-muted-foreground">
                        {format(t.groupSubtitle, { count })}
                      </span>
                    </span>
                    <RoleMenu
                      role={g.role as GrantRole}
                      onChange={(r) => void guard(() => updateGrantRole(pageId, g.id, r))()}
                      onRemove={() => void guard(() => revokeGrant(pageId, g.id))()}
                      t={t}
                    />
                  </li>
                );
              })}
            </ul>

            {/* General access */}
            <div className="mt-3 border-t border-border pt-3">
              <div className="px-1 text-xs font-medium text-muted-foreground">{t.generalAccess}</div>
              <div className="mt-1 flex items-center gap-2 rounded-md px-1 py-1.5">
                <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                  <Users className="size-3.5" aria-hidden />
                </span>
                <span className="min-w-0 flex-1 truncate text-sm">
                  {format(t.everyoneAt, { workspace: workspace.name })}
                </span>
                <RoleMenu
                  role={(workspaceGrant?.role as GrantRole) ?? "edit"}
                  onChange={(r) => void setWorkspaceDefault(r)}
                  onRemove={
                    workspaceGrant ? () => void guard(() => revokeGrant(pageId, workspaceGrant.id))() : undefined
                  }
                  t={t}
                />
              </div>
            </div>

            {error ? <p role="alert" className="mt-2 break-all text-xs text-destructive">{error}</p> : null}

            {/* Footer */}
            <div className="mt-3 flex items-center justify-between border-t border-border pt-3">
              <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                <HelpCircle className="size-3.5" aria-hidden />
                {t.learnAboutSharing}
              </span>
              <button
                type="button"
                onClick={() => void copyPageLink()}
                className="inline-flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-sm font-medium transition-colors hover:bg-muted"
              >
                {copiedPage ? <Check className="size-3.5 text-emerald-600 dark:text-emerald-400" aria-hidden /> : <Link2 className="size-3.5" aria-hidden />}
                {copiedPage ? t.copied : t.copyLink}
              </button>
            </div>
          </div>
        ) : null}

        {tab === "publish" ? (
          <div className="space-y-3 p-3">
            {publish.published ? (
              <>
                {/* One universal URL */}
                <div className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-2.5 py-1.5">
                  <Globe className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="min-w-0 flex-1 truncate text-sm">{publishUrl}</span>
                  <button
                    type="button"
                    onClick={() => void copyPublishUrl()}
                    aria-label={t.copyLink}
                    className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                  >
                    {copiedPublish ? (
                      <Check className="size-4 text-emerald-600 dark:text-emerald-400" aria-hidden />
                    ) : (
                      <Link2 className="size-4" aria-hidden />
                    )}
                  </button>
                </div>

                {/* Search engine indexing */}
                <label className="flex items-center justify-between gap-3 rounded-md px-1 py-1.5 text-sm">
                  <span className="inline-flex items-center gap-2">
                    <Search className="size-4 text-muted-foreground" aria-hidden />
                    {t.searchIndexing}
                  </span>
                  <Switch
                    checked={publish.indexable}
                    onCheckedChange={(v) => void setIndexing(v)}
                    aria-label={t.searchIndexing}
                  />
                </label>

                {error ? <p role="alert" className="break-all text-xs text-destructive">{error}</p> : null}

                {/* Footer actions */}
                <div className="flex items-center gap-2 border-t border-border pt-3">
                  <button
                    type="button"
                    onClick={() => void doUnpublish()}
                    disabled={busy}
                    className="flex-1 rounded-md border border-border px-3 py-2 text-sm font-medium transition-colors hover:bg-muted disabled:opacity-50"
                  >
                    {t.unpublish}
                  </button>
                  <a
                    href={publishUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex-1 rounded-md bg-primary px-3 py-2 text-center text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90"
                  >
                    {t.viewSite}
                  </a>
                </div>
              </>
            ) : (
              <>
                <p className="text-sm text-muted-foreground">{t.publishHint}</p>
                {error ? <p role="alert" className="break-all text-xs text-destructive">{error}</p> : null}
                <button
                  type="button"
                  onClick={() => void doPublish()}
                  disabled={busy}
                  className="inline-flex w-full items-center justify-center gap-1.5 rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
                >
                  <Globe className="size-4" aria-hidden />
                  {t.publishCta}
                </button>
              </>
            )}
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
