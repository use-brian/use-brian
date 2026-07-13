"use client";

/**
 * Account + workspace switcher for app-web's top-left chrome.
 *
 * Visually matches `apps/web`'s chrome switcher: the active workspace
 * name + plan, Settings + Invite-members buttons, the signed-in account
 * row, the full workspace list, "+ Add workspace", "Add another account",
 * and "Log out".
 *
 * Most actions are local now: Settings + Invite members open the in-app
 * settings modal, Add workspace opens an in-popover create form
 * (`CreateWorkspaceForm` -> `POST /api/workspaces`) so creation never
 * leaves the switcher and behaves identically on web and the desktop
 * shell, switching the active workspace is a doc-internal navigation to
 * `/w/<id>/p`, and Log out clears the local session. Only account
 * management (Add another account, switching accounts) still bounces to
 * the **main web app** / the primary (`sidan.ai`) — rewriting the shared
 * `.sidan.ai` cookies is the primary's job (sub-app rule).
 *
 * **Multi-account** — the account section lists every account signed in on
 * this browser, read from the JS-readable `accounts_dir` cookie the primary
 * (sidan.ai) writes on `.sidan.ai` (so it rides along to app.sidan.ai).
 * The active row gets a checkmark; clicking another row switches to it.
 * Switching rewrites the shared `.sidan.ai` cookies, which only the primary
 * may do (sub-app rule), so it's a top-level redirect to the primary's
 * `/api/auth/switch-account-and-return` endpoint, landing back on this app's
 * workspace picker. In dev (no shared cookie scope, "Add account" punts to
 * the web app) `accounts_dir` is usually absent, so the list falls back to
 * the single active user — the prior single-account behaviour. Account
 * management (add / remove) stays on the web app.
 *
 * [COMP:app-web/workspace-switcher]
 */

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { docPagePath } from "@/lib/doc-page-url";
import { routeProgress } from "@/lib/route-progress";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n/format";
import { authFetch } from "@/lib/auth-fetch";
import { primaryAuthUrl, webAppUrl } from "@/lib/primary-auth";
import { getUserInfo, getInitials } from "@/lib/user";
import { signOutActiveAccount } from "@/lib/account-logout";
import { getAccountsDir, type AccountDirEntry } from "@/lib/accounts";
import { TeamAvatar } from "@/components/team-avatar";
import {
  CreateWorkspaceForm,
  type CreatedWorkspace,
} from "@/components/create-workspace-form";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { useWorkspaceContext } from "@/lib/workspace-context";
import {
  SettingsModal,
  type SettingsSection,
  OPEN_SETTINGS_EVENT,
  type OpenSettingsDetail,
} from "@/components/settings-modal/settings-modal";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

// `webAppUrl()` (the app→marketing deep-link base) is shared from
// `@/lib/primary-auth` so billing-section / composer-controls resolve the same
// prod-safe default. Don't reintroduce a local `?? "http://localhost:3000"`.

/** Mirror of `apps/web` `formatPlanLabel` — pretty-prints the raw plan tier.
 *  `'free'` is handled by the caller (it is the no-active-plan state, not a
 *  plan name, since the 2026-07-10 Free-plan removal). */
function formatPlanLabel(plan: string): string {
  if (plan === "max_5x") return "max 5x";
  if (plan === "max_10x") return "max 10x";
  if (plan === "max_plus") return "max+";
  return plan;
}

type Workspace = {
  id: string;
  name: string;
  iconSeed: number | null;
  plan?: string | null;
};

function cn(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

export function WorkspaceSwitcher() {
  const t = useT().workspaceSwitcher;
  const router = useRouter();
  const ctx = useWorkspaceContext();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Create-workspace mode: swaps the popover body for the in-app
  // `CreateWorkspaceForm` instead of routing out to the `/teams` picker
  // (which has no create affordance, so it just re-listed workspaces).
  const [creating, setCreating] = useState(false);
  // In-doc settings modal (ported from apps/web — opens here, no redirect).
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] =
    useState<SettingsSection>("ws-general");
  // Multi-account state. `accountsDir` lists every account signed in on this
  // browser (from the JS-readable `accounts_dir` cookie the primary writes on
  // `.sidan.ai`); re-read each time the popover opens. `switching` drives the
  // per-row spinner before the switch redirect navigates away; `accountError`
  // surfaces a failed switch bounced back via `?accountError=`.
  const [accountsDir, setAccountsDir] = useState<AccountDirEntry[]>(() =>
    getAccountsDir(),
  );
  const [switching, setSwitching] = useState<string | null>(null);
  const [accountError, setAccountError] = useState<string | null>(null);

  const user = getUserInfo();
  const activeAccountId = user?.id ?? null;
  // Accounts to show: the saved-account directory, or — for a session with no
  // `accounts_dir` cookie (single-account, or dev where the store lives on the
  // web app) — a synthetic entry for the active user so the section is never
  // empty.
  const accountRows: AccountDirEntry[] =
    accountsDir.length > 0
      ? accountsDir
      : user
        ? [
            {
              id: user.id ?? "",
              name: user.name,
              email: user.email,
            },
          ]
        : [];
  const isActiveAccount = (acct: AccountDirEntry) =>
    activeAccountId ? acct.id === activeAccountId : acct.email === user?.email;

  function openSettings(section: SettingsSection) {
    setOpen(false);
    setSettingsSection(section);
    setSettingsOpen(true);
  }

  // Open the settings modal when another surface asks for it (e.g. the sidebar
  // theme picker's "edit" pencil → "preferences"). This component owns the modal
  // state; the requester dispatches `OPEN_SETTINGS_EVENT` (see settings-modal).
  // Only setState setters run here, so an empty dep list is correct.
  useEffect(() => {
    function onOpenSettings(e: Event) {
      const section = (e as CustomEvent<OpenSettingsDetail>).detail?.section;
      if (!section) return;
      setOpen(false);
      setSettingsSection(section);
      setSettingsOpen(true);
    }
    window.addEventListener(OPEN_SETTINGS_EVENT, onOpenSettings);
    return () => window.removeEventListener(OPEN_SETTINGS_EVENT, onOpenSettings);
  }, []);

  // Re-read the account directory each time the popover opens so it reflects
  // accounts added/switched in another tab (or on the web app) since the last
  // render. Also clears any transient switch state.
  useEffect(() => {
    if (!open) {
      setSwitching(null);
      setCreating(false);
      return;
    }
    setAccountsDir(getAccountsDir());
  }, [open]);

  // Surface a failed switch bounced back from the primary's
  // switch-account-and-return endpoint (`?accountError=switch|reauth`). Open
  // the switcher with the message in context, then strip the param so it
  // doesn't survive a reload. Runs once on mount.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get("accountError");
    if (code !== "switch" && code !== "reauth") return;
    setAccountError(code === "reauth" ? t.accountSessionExpired : t.switchError);
    setOpen(true);
    params.delete("accountError");
    const qs = params.toString();
    window.history.replaceState(
      null,
      "",
      window.location.pathname + (qs ? `?${qs}` : "") + window.location.hash,
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Switch the active account. Rewriting the shared `.sidan.ai` cookies is the
  // primary's job (sub-app rule), so bounce the browser to its
  // switch-account-and-return endpoint and land back on this app's workspace
  // picker (`/`) — the newly-active account may not have access to the
  // current workspace/page. In dev there's no primary (no shared cookie
  // scope) so the switch can't happen here; fall back to the app root,
  // which re-resolves the session + workspace.
  function handleSwitchAccount(accountId: string) {
    if (switching || accountId === activeAccountId) return;
    if (typeof window === "undefined") return;
    setAccountError(null);
    setSwitching(accountId);
    // In the Electron shell the switch happens in the shell's OWN cookie jar (the
    // primary's shared `.sidan.ai` cookies are unreachable from it), so route
    // through the bridge instead of bouncing to the primary. It resolves with the
    // outcome: on success the shell reloads the window; on failure we surface the
    // message inline and clear the spinner. Same shell-takes-precedence pattern
    // as `desktopSignOut()`.
    const switchViaShell = window.sidanclawDesktop?.switchAccount;
    if (typeof switchViaShell === "function") {
      void switchViaShell(accountId).then((res) => {
        if (!res.ok) {
          setAccountError(
            res.error === "reauth" ? t.accountSessionExpired : t.switchError,
          );
          setSwitching(null);
        }
      });
      return;
    }
    const primary = primaryAuthUrl();
    if (primary) {
      const u = new URL("/api/auth/switch-account-and-return", primary);
      u.searchParams.set("accountId", accountId);
      u.searchParams.set("next", `${window.location.origin}/`);
      window.location.assign(u.toString());
      return;
    }
    window.location.assign("/");
  }

  // Lazy-fetch the workspace list on first open (carries `plan` per row).
  useEffect(() => {
    if (!open || workspaces !== null || loading) return;
    setLoading(true);
    setError(null);
    authFetch(`${API_URL}/api/workspaces`)
      .then((r) => r.json())
      .then((data: { workspaces?: Workspace[]; teams?: Workspace[] }) => {
        setWorkspaces(data.workspaces ?? data.teams ?? []);
      })
      .catch(() => setError(t.loadError))
      .finally(() => setLoading(false));
  }, [open, workspaces, loading, t.loadError]);

  const activeWorkspace = workspaces?.find((w) => w.id === ctx.workspaceId);
  // Plan label: the active workspace's plan once the workspaces list loads;
  // null (no label) before that. Billing is per-workspace only.
  const planRaw = activeWorkspace?.plan ?? null;

  /** Hard-navigate to the main web app for a deep config action. */
  function goToWebApp(path: string) {
    setOpen(false);
    if (typeof window === "undefined") return;
    window.location.assign(`${webAppUrl()}${path}`);
  }

  // Add another account. In the Electron shell this must go through the bridge:
  // a hard-nav to the primary's `/login` opens in the system browser AND the
  // shell can't see the primary's shared cookies, so it would silently replace
  // the active account in the shell's own jar (the reported bug). The shell's
  // `addAccount` stashes the active account first. On the web, bounce to
  // `/login?addAccount=1` as before.
  function handleAddAccount() {
    setOpen(false);
    const addViaShell =
      typeof window !== "undefined" ? window.sidanclawDesktop?.addAccount : undefined;
    if (typeof addViaShell === "function") {
      addViaShell();
      return;
    }
    goToWebApp("/login?addAccount=1");
  }

  function switchTo(workspaceId: string) {
    setOpen(false);
    if (workspaceId === ctx.workspaceId) return;
    // Button-driven nav (no `<a>` for the document click listener to catch).
    routeProgress.start();
    router.push(docPagePath(workspaceId));
  }

  // The in-popover create form succeeded: close the switcher, drop the
  // cached workspace list so the next open refetches with the new row, and
  // navigate into the new workspace's doc surface.
  function handleWorkspaceCreated(created: CreatedWorkspace) {
    setCreating(false);
    setOpen(false);
    setWorkspaces(null);
    routeProgress.start();
    router.push(docPagePath(created.id));
  }

  // Sign out — desktop shell clears its own session in place; dev clears local
  // cookies + cache → /login; prod bounces to the primary's logout. See the
  // route + auth-fetch `getValidAccessToken`.
  // "Log out" signs out only the ACTIVE account and switches into the next
  // saved one (full sign-out only when it's the last). Transport (shell bridge /
  // primary bounce / dev clear) lives in the shared `signOutActiveAccount` so
  // this button and the settings account section can't drift.
  function handleLogOut() {
    setOpen(false);
    signOutActiveAccount();
  }

  return (
    <>
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        ref={triggerRef}
        aria-label={format(t.switcherAriaLabel, { name: ctx.name })}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-md",
          "px-1.5 py-1 text-sm hover:bg-muted transition-colors",
        )}
      >
        <TeamAvatar id={ctx.workspaceId} name={ctx.name} size="xs" />
        <span className="font-semibold text-[13px] truncate max-w-[140px]">
          {ctx.name}
        </span>
        <svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          aria-hidden
          className={cn(
            "transition-transform text-muted-foreground/60 shrink-0",
            open && "rotate-180",
          )}
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </PopoverTrigger>

      <PopoverContent
        role="menu"
        side="bottom"
        align="start"
        sideOffset={8}
        // Anchor to the full-width sidebar head ROW, not the trigger button.
        // In the desktop shell the head is indented past the macOS traffic
        // lights (`--doc-titlebar-lights`, ~76px), so anchoring to the button
        // would land the popup's left edge mid-sidebar and leave a partial,
        // clipped strip of sidebar showing on the left. The head row's border
        // box starts at the window/sidebar left edge (x=0), so aligning to it
        // makes the popup open flush-left and fully cover the sidebar beneath.
        // Falls back to the trigger if the head ancestor isn't found.
        anchor={() =>
          triggerRef.current?.closest("[data-doc-sidebar-head]") ??
          triggerRef.current
        }
        className="w-80 gap-3 p-3"
      >
        {creating ? (
          <CreateWorkspacePanel
            t={t}
            onBack={() => setCreating(false)}
            onCreated={handleWorkspaceCreated}
          />
        ) : (
          <>
        {/* Workspace header — name + plan */}
          <div className="px-1">
            <div className="font-semibold text-sm truncate">{ctx.name}</div>
            <div className="text-xs text-muted-foreground">
              {planRaw === null
                ? ""
                : planRaw === "free"
                  ? t.noPlanLabel
                  : format(t.planLabel, { plan: formatPlanLabel(planRaw) })}
            </div>
          </div>

          {/* Settings + Invite members → in-app settings modal */}
          <div className="flex gap-2">
            <button
              type="button"
              role="menuitem"
              onClick={() => openSettings("ws-general")}
              className={cn(
                "flex-1 inline-flex items-center justify-center gap-1.5",
                "rounded-md border border-border bg-card hover:bg-muted",
                "px-2 py-1.5 text-xs transition-colors",
              )}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
              <span>{t.settings}</span>
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => openSettings("ws-members")}
              className={cn(
                "flex-1 inline-flex items-center justify-center gap-1.5",
                "rounded-md border border-border bg-card hover:bg-muted",
                "px-2 py-1.5 text-xs transition-colors",
              )}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
                <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
                <circle cx="8.5" cy="7" r="4" />
                <path d="M20 8v6M23 11h-6" />
              </svg>
              <span>{t.inviteMembers}</span>
            </button>
          </div>

          <div className="border-t border-border" />

          {/* Signed-in accounts — active row checkmarked, others click to switch */}
          {accountRows.length > 0 && (
            <div className="flex flex-col gap-0.5">
              {accountRows.map((acct) => (
                <AccountRow
                  key={acct.id || acct.email}
                  account={acct}
                  isActive={isActiveAccount(acct)}
                  switching={switching === acct.id}
                  onSwitch={() => handleSwitchAccount(acct.id)}
                  t={t}
                />
              ))}
              {accountError && (
                <div className="px-2 pt-1 text-[12px] text-destructive">
                  {accountError}
                </div>
              )}
            </div>
          )}

          {/* Workspace list + Add workspace */}
          {loading && (
            <div className="px-2 py-1 text-xs text-muted-foreground">{t.loading}</div>
          )}
          {error && (
            <div className="px-2 py-1 text-xs text-destructive">{error}</div>
          )}
          <ul className="flex flex-col gap-0.5">
            {(workspaces ?? []).map((ws) => (
              <li key={ws.id}>
                <WorkspaceRow
                  workspace={ws}
                  isActive={ws.id === ctx.workspaceId}
                  onSelect={() => switchTo(ws.id)}
                />
              </li>
            ))}
            <li>
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  // Swap the popover body to the in-app create form
                  // (no navigation): routing to `/teams` only re-listed
                  // workspaces, since the picker has no create affordance.
                  setError(null);
                  setCreating(true);
                }}
                className="w-full inline-flex items-center gap-2 px-2 py-1.5 rounded text-sm text-primary hover:bg-muted transition-colors"
              >
                <span aria-hidden>+</span>
                <span>{t.addWorkspace}</span>
              </button>
            </li>
          </ul>

          <div className="border-t border-border" />

          {/* Footer — add another account (→ main app) + log out */}
          <div className="flex flex-col">
            <button
              type="button"
              role="menuitem"
              onClick={handleAddAccount}
              className="text-left px-2 py-1.5 text-sm hover:bg-muted rounded transition-colors"
            >
              {t.addAnotherAccount}
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={handleLogOut}
              className="inline-flex items-center gap-2 text-left px-2 py-1.5 text-sm text-muted-foreground hover:bg-muted hover:text-foreground rounded transition-colors"
            >
              <LogOutIcon />
              <span>{t.logOut}</span>
            </button>
          </div>
          </>
        )}
      </PopoverContent>
    </Popover>
    <SettingsModal
      open={settingsOpen}
      initialSection={settingsSection}
      onClose={() => setSettingsOpen(false)}
    />
    </>
  );
}

/**
 * One row in the account switcher: the active account (checkmark, not
 * clickable) or a switchable account (click to switch, spinner while the
 * switch redirect navigates away). Removal lives on the web app, so there's
 * no remove affordance here.
 */
function AccountRow({
  account,
  isActive,
  switching,
  onSwitch,
  t,
}: {
  account: AccountDirEntry;
  isActive: boolean;
  switching: boolean;
  onSwitch: () => void;
  t: ReturnType<typeof useT>["workspaceSwitcher"];
}) {
  const initials = getInitials(account.name || account.email || "?");
  return (
    <button
      type="button"
      role="menuitem"
      onClick={isActive ? undefined : onSwitch}
      disabled={isActive || switching}
      aria-current={isActive ? "true" : undefined}
      aria-label={
        isActive
          ? undefined
          : format(t.switchAccountAria, { email: account.email })
      }
      className={cn(
        "w-full inline-flex items-center gap-2 rounded px-2 py-1.5 text-left transition-colors min-w-0",
        isActive ? "bg-muted/60 cursor-default" : "hover:bg-muted cursor-pointer",
      )}
    >
      <div
        className="h-6 w-6 rounded-full bg-muted text-xs flex items-center justify-center font-medium shrink-0"
        aria-hidden
      >
        {initials}
      </div>
      <span className="flex-1 truncate text-xs text-muted-foreground">
        {account.email || account.name}
      </span>
      {switching ? (
        <Spinner />
      ) : isActive ? (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden className="shrink-0 text-primary">
          <path d="M5 12l5 5L20 7" />
        </svg>
      ) : null}
    </button>
  );
}

function Spinner() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      className="shrink-0 animate-spin text-muted-foreground"
      aria-hidden
    >
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" fill="none" opacity="0.25" />
      <path d="M12 3a9 9 0 0 1 9 9" stroke="currentColor" strokeWidth="2.5" fill="none" strokeLinecap="round" />
    </svg>
  );
}

function WorkspaceRow({
  workspace,
  isActive,
  onSelect,
}: {
  workspace: Workspace;
  isActive: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onSelect}
      className={cn(
        "w-full inline-flex items-center gap-2 px-2 py-1.5 rounded text-sm transition-colors text-left",
        isActive ? "bg-muted" : "hover:bg-muted",
      )}
      aria-current={isActive ? "true" : undefined}
    >
      <TeamAvatar
        id={workspace.id}
        name={workspace.name}
        iconSeed={workspace.iconSeed}
        size="sm"
      />
      <span className="flex-1 truncate">{workspace.name}</span>
      {isActive && (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden className="text-primary">
          <path d="M5 12l5 5L20 7" />
        </svg>
      )}
    </button>
  );
}

/**
 * Create-workspace mode for the switcher popover. Replaces the menu body
 * with a back affordance + the shared `CreateWorkspaceForm`; on success the
 * caller (`onCreated`) navigates into the new workspace. Hosting creation
 * here — rather than routing to the `/teams` picker, which lists workspaces
 * but has no create affordance — keeps it one click and identical on web and
 * the desktop shell.
 */
function CreateWorkspacePanel({
  t,
  onBack,
  onCreated,
}: {
  t: ReturnType<typeof useT>["workspaceSwitcher"];
  onBack: () => void;
  onCreated: (workspace: CreatedWorkspace) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2 px-1">
        <button
          type="button"
          onClick={onBack}
          aria-label={t.create.back}
          className="inline-flex items-center justify-center -ml-1 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
        <div className="font-semibold text-sm">{t.create.title}</div>
      </div>
      <CreateWorkspaceForm autoFocus onCreated={onCreated} onCancel={onBack} />
    </div>
  );
}

function LogOutIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className="shrink-0"
    >
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <polyline points="16 17 21 12 16 7" />
      <line x1="21" y1="12" x2="9" y2="12" />
    </svg>
  );
}
