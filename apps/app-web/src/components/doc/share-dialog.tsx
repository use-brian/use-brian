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
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { openWorkspaceSettings } from "@/components/settings-modal/settings-modal";
import {
  checkSlugAvailability,
  getSiteState,
  listShareableMembers,
  listShareGrants,
  listWorkspaceGroups,
  publishPage,
  revokeGrant,
  setPageSlug,
  unpublishPage,
  updateGrantRole,
  upsertIdentityGrant,
  type GrantRole,
  type IdentityGrant,
  type PublishState,
  type ShareMember,
  type SiteDomainRow,
  type SiteState,
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

/** One connected workspace domain from this page's perspective (workspace-
 *  first lifecycle): a read-only home-page chip when this page is the domain's
 *  default, plus the alias editor. The home/default page is set and cleared
 *  only in Settings → Domains (and cleared automatically on unpublish) — it is
 *  workspace infrastructure, not per-page state. Connecting/claiming also lives
 *  in Settings → Domains. */
function PageDomainCard({
  pageId,
  row,
  t,
  onChanged,
}: {
  pageId: string;
  row: SiteDomainRow;
  t: ShareT;
  onChanged: () => Promise<void>;
}) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);

  const href = row.isDefault
    ? `https://${row.hostname}`
    : row.slug
      ? `https://${row.hostname}/${row.slug}`
      : `https://${row.hostname}/p/${pageId}`;

  async function copyHref() {
    if (typeof window === "undefined") return;
    try {
      await navigator.clipboard.writeText(href);
      setCopied(true);
      setCopyFailed(false);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopyFailed(true);
    }
  }

  return (
    <div className="rounded-md border border-border p-3 space-y-2">
      <div className="flex items-center gap-2">
        <Globe className="size-4 shrink-0 text-muted-foreground" aria-hidden />
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          className="min-w-0 flex-1 truncate text-sm hover:underline"
        >
          {row.hostname}
          {row.isDefault ? "" : row.slug ? `/${row.slug}` : ""}
        </a>
        {row.isDefault ? (
          <span className="shrink-0 text-xs font-medium text-emerald-600 dark:text-emerald-400">
            {t.site.homeChip}
          </span>
        ) : row.status !== "live" ? (
          <span className="shrink-0 text-xs font-medium text-muted-foreground">
            {t.site.statusPending}
          </span>
        ) : null}
        <button
          type="button"
          onClick={() => void copyHref()}
          aria-label={t.copyLink}
          className="shrink-0 rounded p-1 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          {copied ? (
            <Check className="size-4 text-emerald-600 dark:text-emerald-400" aria-hidden />
          ) : (
            <Link2 className="size-4" aria-hidden />
          )}
        </button>
      </div>
      {copyFailed ? <p className="break-all text-xs text-muted-foreground">{href}</p> : null}
      {row.isDefault ? null : (
        <SlugRow pageId={pageId} ctx={row} t={t} onChanged={onChanged} />
      )}
    </div>
  );
}

/** The Publish tab's domain area: every connected workspace domain with this
 *  page's address on it, or a pointer to Settings when none are connected. */
function PageDomainsSection({
  pageId,
  site,
  t,
  onChanged,
}: {
  pageId: string;
  site: SiteState | null;
  t: ShareT;
  onChanged: () => Promise<void>;
}) {
  if (!site) return null;
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-muted-foreground">{t.site.domainsLabel}</p>
      {site.domains.length === 0 ? (
        <>
          <p className="text-xs text-muted-foreground">{t.site.noDomainsHint}</p>
          <button
            type="button"
            onClick={() => openWorkspaceSettings("ws-domains")}
            className="rounded-md border border-border px-3 py-1.5 text-xs font-medium transition-colors hover:bg-muted"
          >
            {t.site.openSettingsCta}
          </button>
        </>
      ) : (
        <div className="space-y-2">
          {site.domains.map((row) => (
            <PageDomainCard
              key={row.domainId}
              pageId={pageId}
              row={row}
              t={t}
              onChanged={onChanged}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** The page's pretty URL on a connected domain: a bare `/` prefix (the
 *  hostname already shows once in the card header) + slug input with a
 *  debounced availability check. Renames keep the old slug as a 301 (the note
 *  under the field). */
function SlugRow({
  pageId,
  ctx,
  t,
  onChanged,
}: {
  pageId: string;
  ctx: SiteDomainRow;
  t: ShareT;
  onChanged: () => Promise<void>;
}) {
  const [draft, setDraft] = useState(ctx.slug ?? ctx.suggestedSlug ?? "");
  const [state, setState] = useState<"idle" | "checking" | "available" | "taken" | "invalid" | "saving">(
    "idle",
  );
  const [renamed, setRenamed] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    setDraft(ctx.slug ?? ctx.suggestedSlug ?? "");
    setState("idle");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx.domainId, ctx.slug]);

  // Debounced availability check while typing (400ms).
  useEffect(() => {
    const slug = draft.trim();
    if (!slug || slug === ctx.slug) {
      setState("idle");
      return;
    }
    setState("checking");
    const timer = window.setTimeout(async () => {
      try {
        const r = await checkSlugAvailability(pageId, ctx.domainId, slug);
        setState(!r.valid ? "invalid" : r.available ? "available" : "taken");
      } catch {
        setState("idle");
      }
    }, 400);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft]);

  const save = async () => {
    const slug = draft.trim();
    if (!slug || slug === ctx.slug) return;
    setState("saving");
    setErr(null);
    try {
      const r = await setPageSlug(pageId, ctx.domainId, slug);
      setRenamed(Boolean(r.previousSlug));
      setState("idle");
      await onChanged();
    } catch (e) {
      const code = e instanceof Error ? e.message : String(e);
      if (code === "slug_taken") setState("taken");
      else if (code === "invalid_slug") setState("invalid");
      else {
        setState("idle");
        setErr(code);
      }
    }
  };

  const hint =
    state === "checking"
      ? t.site.slugChecking
      : state === "available"
        ? t.site.slugAvailable
        : state === "taken"
          ? t.site.slugTaken
          : state === "invalid"
            ? t.site.slugInvalid
            : null;

  return (
    <div className="space-y-1.5 border-t border-border pt-3">
      <p className="text-xs font-medium text-muted-foreground">{t.site.pageLinkLabel}</p>
      <div className="flex items-center gap-2">
        <div className="flex min-w-0 flex-1 items-center rounded-md border border-border bg-background text-sm transition-[border-color,box-shadow] focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/30">
          <span className="shrink-0 pl-3 text-muted-foreground">/</span>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void save();
              }
            }}
            className="min-w-0 flex-1 bg-transparent py-1.5 pr-3 outline-none focus-visible:shadow-none"
            aria-label={t.site.pageLinkLabel}
          />
        </div>
        <button
          type="button"
          onClick={() => void save()}
          disabled={state === "saving" || state === "taken" || state === "invalid" || !draft.trim() || draft.trim() === ctx.slug}
          className="shrink-0 rounded-md border border-border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-muted disabled:opacity-50"
        >
          {state === "saving" ? t.site.slugSaving : t.site.slugSave}
        </button>
      </div>
      {hint ? (
        <p className={`text-xs ${state === "taken" || state === "invalid" ? "text-destructive" : "text-muted-foreground"}`}>
          {hint}
        </p>
      ) : null}
      {renamed ? <p className="text-xs text-muted-foreground">{t.site.redirectNote}</p> : null}
      {err ? (
        <p role="alert" className="break-all text-xs text-destructive">
          {err}
        </p>
      ) : null}
    </div>
  );
}

export function ShareDialog({
  pageId,
  workspaceId,
  currentUser,
  onPublishChanged,
}: {
  pageId: string;
  workspaceId: string;
  currentUser: { id: string; name: string; avatarUrl?: string | null };
  /** Raised after a successful publish/unpublish so the page header can
   *  re-resolve its Published badge (the resolved state is cascade-aware,
   *  so the header re-fetches rather than trusting the direct flag). */
  onPublishChanged?: () => void;
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

  // Custom domains + page slug (docs/architecture/features/custom-domains.md)
  const [site, setSite] = useState<SiteState | null>(null);
  const refreshSite = async () => {
    setSite(await getSiteState(pageId).catch(() => null));
  };

  const publishUrl =
    typeof window !== "undefined" ? `${window.location.origin}/share/p/${pageId}` : `/share/p/${pageId}`;

  async function reload() {
    try {
      const [g, m, gr, st] = await Promise.all([
        listShareGrants(pageId),
        listShareableMembers(pageId).catch(() => [] as ShareMember[]),
        listWorkspaceGroups(pageId).catch(() => [] as WorkspaceGroup[]),
        getSiteState(pageId).catch(() => null),
      ]);
      setIdentityGrants(g.identityGrants);
      setMembers(m);
      setGroups(gr);
      setPublish(g.publish);
      setSite(st);
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
      onPublishChanged?.();
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
      onPublishChanged?.();
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
            {/* Address on a connected domain (custom-domains.md +
                platform-subdomains.md). Outside the published branch on
                purpose: a child under a served anchor is publicly reachable
                via the cascade without being individually published, so its
                alias stays editable either way. */}
            {!publish.published && site?.domains.some((d) => d.servable || d.slug) ? (
              <PageDomainsSection
                pageId={pageId}
                site={site}
                t={t}
                onChanged={refreshSite}
              />
            ) : null}
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

                {/* This page's address on each connected workspace domain
                    (workspace-first: connect/claim lives in Settings). */}
                <PageDomainsSection
                  pageId={pageId}
                  site={site}
                  t={t}
                  onChanged={refreshSite}
                />

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
