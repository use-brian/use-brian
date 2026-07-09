"use client";

/**
 * Teamspace settings modal + "New teamspace" dialog
 * (docs/architecture/features/teamspaces.md → UI).
 *
 * A compact portaled modal (the `prompt-dialog` Dialog treatment, not the
 * full two-rail settings shell) with two tabs, like Notion's teamspace
 * settings:
 *  - **General** — name, icon (the shared `EmojiPicker`), description,
 *    sensitivity (themed `Select`, never native), and a "Delete
 *    teamspace" danger row (hidden for the default General teamspace).
 *  - **Members** — search filter, roster rows (avatar initial + name +
 *    email + workspace-role pill, mirroring the workspace members tab),
 *    per-row remove/leave (confirmDialog; hidden on the default
 *    teamspace), and an Add-members block offering workspace members not
 *    yet in the teamspace.
 *
 * Mutations call the teamspaces SDK directly and raise `onChanged` so the
 * chrome reloads the sidebar (`reloadSidebar`) — page visibility can
 * change with membership. Server policy errors (clearance / sensitivity
 * gates) surface as friendly inline copy via `teamspaceErrorMessage`.
 *
 * The modal is opened from the sidebar section `⋯` menu, which is gated
 * by `canManage` — the single management gate off the list response.
 *
 * [COMP:app-web/teamspace-settings]
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { Plus, X } from "lucide-react";

import { cn } from "@/lib/utils";
import { authFetch } from "@/lib/auth-fetch";
import { useT, format } from "@/lib/i18n/client";
import { getUserInfo } from "@/lib/user";
import {
  addTeamspaceMember,
  createTeamspace,
  deleteTeamspace,
  listTeamspaceMembers,
  removeTeamspaceMember,
  updateTeamspace,
  type Teamspace,
  type TeamspaceMember,
  type TeamspaceSensitivity,
} from "@/lib/api/teamspaces";
import { teamspaceErrorCopyKey } from "@/lib/teamspace-errors";
import { Button } from "@/components/ui/button";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { EmojiPicker } from "@/components/ui/emoji-picker";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export type TeamspaceSettingsTab = "general" | "members";

const SENSITIVITIES: TeamspaceSensitivity[] = [
  "public",
  "internal",
  "confidential",
];

/** The docPage dictionary slice both dialogs read. */
type DocPageDict = ReturnType<typeof useT>["docPage"];

/** Map a server policy error code to friendly copy; fall back to the raw
 *  message for anything unrecognised (network, 500s). The code→key mapping is
 *  the pure `teamspaceErrorCopyKey` (unit-tested); this only resolves the key
 *  against the live dictionary. */
function teamspaceErrorMessage(err: unknown, t: DocPageDict): string {
  const key = teamspaceErrorCopyKey(err);
  if (key) return t[key];
  return err instanceof Error ? err.message : String(err);
}

function sensitivityLabel(
  value: TeamspaceSensitivity,
  t: DocPageDict,
): string {
  switch (value) {
    case "public":
      return t.teamspaceSensitivityPublic;
    case "confidential":
      return t.teamspaceSensitivityConfidential;
    default:
      return t.teamspaceSensitivityInternal;
  }
}

/** Shared themed sensitivity picker (General tab + create dialog). */
function SensitivitySelect({
  value,
  onChange,
  disabled,
}: {
  value: TeamspaceSensitivity;
  onChange: (next: TeamspaceSensitivity) => void;
  disabled?: boolean;
}) {
  const t = useT().docPage;
  return (
    <Select
      value={value}
      onValueChange={(v) => onChange((v ?? "internal") as TeamspaceSensitivity)}
      disabled={disabled}
    >
      <SelectTrigger className="w-44 bg-muted/50" aria-label={t.teamspaceSensitivityLabel}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {SENSITIVITIES.map((s) => (
          <SelectItem key={s} value={s}>
            {sensitivityLabel(s, t)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/** Shared portaled dialog frame (backdrop + centered popup), matching the
 *  `prompt-dialog` treatment so both teamspace dialogs look native. */
function DialogFrame({
  open,
  onOpenChange,
  wide,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The settings modal needs more room than the create dialog. */
  wide?: boolean;
  children: React.ReactNode;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop
          className={cn(
            "fixed inset-0 z-50 bg-background/80 backdrop-blur-sm transition-opacity duration-150",
            "data-[starting-style]:opacity-0 data-[ending-style]:opacity-0",
          )}
        />
        <Dialog.Popup
          className={cn(
            "fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2",
            wide ? "max-w-lg" : "max-w-md",
            "rounded-2xl border border-border bg-background p-6 shadow-xl ring-1 ring-foreground/5",
            "transition-all duration-150",
            "data-[starting-style]:opacity-0 data-[starting-style]:scale-95",
            "data-[ending-style]:opacity-0 data-[ending-style]:scale-95",
          )}
        >
          {children}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// ── New teamspace ──────────────────────────────────────────────────────

export function TeamspaceCreateDialog({
  workspaceId,
  open,
  onOpenChange,
  onCreated,
}: {
  workspaceId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Fired with the created teamspace (the chrome reloads the sidebar). */
  onCreated: (teamspace: Teamspace) => void;
}) {
  const t = useT().docPage;
  const [name, setName] = useState("");
  const [sensitivity, setSensitivity] =
    useState<TeamspaceSensitivity>("internal");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // Fresh form per open.
  useEffect(() => {
    if (!open) return;
    setName("");
    setSensitivity("internal");
    setBusy(false);
    setError("");
  }, [open]);

  async function create() {
    const trimmed = name.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    setError("");
    try {
      const created = await createTeamspace(workspaceId, {
        name: trimmed,
        sensitivity,
      });
      onOpenChange(false);
      onCreated(created);
    } catch (err) {
      setError(
        format(t.teamspaceCreateFailed, {
          message: teamspaceErrorMessage(err, t),
        }),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <DialogFrame open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <Dialog.Title className="text-base font-semibold text-foreground">
        {t.teamspaceCreateTitle}
      </Dialog.Title>
      <Dialog.Description className="mt-2 text-sm leading-relaxed text-muted-foreground">
        {t.teamspaceCreateHint}
      </Dialog.Description>
      <label className="mt-4 block text-[13px] font-medium text-foreground">
        {t.teamspaceNameLabel}
        <input
          type="text"
          value={name}
          autoFocus
          placeholder={t.teamspaceNamePlaceholder}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void create();
            }
          }}
          className="mt-1.5 h-9 w-full rounded-md border border-border bg-background px-3 text-sm font-normal text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
        />
      </label>
      <div className="mt-3">
        <div className="text-[13px] font-medium text-foreground">
          {t.teamspaceSensitivityLabel}
        </div>
        <div className="mt-1.5">
          <SensitivitySelect value={sensitivity} onChange={setSensitivity} disabled={busy} />
        </div>
      </div>
      {error && <div className="mt-3 text-xs text-destructive">{error}</div>}
      <div className="mt-6 flex justify-end gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => onOpenChange(false)}
        >
          {t.cancel}
        </Button>
        <Button
          variant="default"
          size="sm"
          disabled={busy || !name.trim()}
          onClick={create}
        >
          {busy ? t.teamspaceCreating : t.teamspaceCreateAction}
        </Button>
      </div>
    </DialogFrame>
  );
}

// ── Teamspace settings ─────────────────────────────────────────────────

export function TeamspaceSettingsModal({
  workspaceId,
  teamspace,
  initialTab,
  open,
  onOpenChange,
  onChanged,
}: {
  workspaceId: string;
  teamspace: Teamspace;
  initialTab: TeamspaceSettingsTab;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Fired after any committed mutation (the chrome reloads the sidebar). */
  onChanged: () => void;
}) {
  const t = useT().docPage;
  const [tab, setTab] = useState<TeamspaceSettingsTab>(initialTab);

  useEffect(() => {
    if (open) setTab(initialTab);
  }, [open, initialTab]);

  return (
    <DialogFrame open={open} onOpenChange={onOpenChange} wide>
      <div className="flex items-start justify-between gap-3">
        <Dialog.Title className="min-w-0 truncate text-base font-semibold text-foreground">
          {t.teamspaceSettingsTitle}
        </Dialog.Title>
        <Dialog.Close
          aria-label={t.teamspaceModalCloseAria}
          className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X className="size-4" />
        </Dialog.Close>
      </div>

      {/* Tab strip — General / Members. */}
      <div className="mt-3 flex items-center gap-4 border-b border-border">
        {(["general", "members"] as const).map((id) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            aria-selected={tab === id}
            className={cn(
              "-mb-px border-b-2 pb-2 text-[13px] font-medium transition-colors",
              tab === id
                ? "border-primary text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {id === "general" ? t.teamspaceTabGeneral : t.teamspaceTabMembers}
          </button>
        ))}
      </div>

      <div className="mt-4 max-h-[min(60vh,32rem)] overflow-y-auto">
        {tab === "general" ? (
          <GeneralTab
            teamspace={teamspace}
            onChanged={onChanged}
            onDeleted={() => {
              onOpenChange(false);
              onChanged();
            }}
          />
        ) : (
          <MembersTab
            workspaceId={workspaceId}
            teamspace={teamspace}
            onChanged={onChanged}
            onSelfLeft={() => {
              onOpenChange(false);
              onChanged();
            }}
          />
        )}
      </div>
    </DialogFrame>
  );
}

// ── General tab ────────────────────────────────────────────────────────

function GeneralTab({
  teamspace,
  onChanged,
  onDeleted,
}: {
  teamspace: Teamspace;
  onChanged: () => void;
  onDeleted: () => void;
}) {
  const t = useT().docPage;
  const [name, setName] = useState(teamspace.name);
  const [icon, setIcon] = useState<string | null>(teamspace.icon);
  const [description, setDescription] = useState(teamspace.description ?? "");
  const [sensitivity, setSensitivity] = useState<TeamspaceSensitivity>(
    teamspace.sensitivity,
  );
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");

  // Re-seed when the modal is pointed at a DIFFERENT teamspace — not on
  // every list refresh, so an in-progress edit isn't clobbered by a reload.
  const teamspaceId = teamspace.id;
  useEffect(() => {
    setName(teamspace.name);
    setIcon(teamspace.icon);
    setDescription(teamspace.description ?? "");
    setSensitivity(teamspace.sensitivity);
    setSaving(false);
    setSaved(false);
    setError("");
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed by id on purpose (see above)
  }, [teamspaceId]);

  async function save() {
    if (saving) return;
    const trimmedName = name.trim();
    if (!trimmedName) return;
    const patch: Parameters<typeof updateTeamspace>[1] = {
      ...(trimmedName !== teamspace.name ? { name: trimmedName } : {}),
      ...(icon !== teamspace.icon ? { icon } : {}),
      ...(description.trim() !== (teamspace.description ?? "")
        ? { description: description.trim() }
        : {}),
      ...(sensitivity !== teamspace.sensitivity ? { sensitivity } : {}),
    };
    if (Object.keys(patch).length === 0) {
      setSaved(true);
      return;
    }
    setSaving(true);
    setError("");
    setSaved(false);
    try {
      const updated = await updateTeamspace(teamspace.id, patch);
      setName(updated.name);
      setIcon(updated.icon);
      setDescription(updated.description ?? "");
      setSensitivity(updated.sensitivity);
      setSaved(true);
      onChanged();
    } catch (err) {
      setError(
        format(t.teamspaceUpdateFailed, {
          message: teamspaceErrorMessage(err, t),
        }),
      );
    } finally {
      setSaving(false);
    }
  }

  async function removeTeamspace() {
    const ok = await confirmDialog({
      title: t.teamspaceDeleteConfirmTitle,
      description: format(t.teamspaceDeleteConfirm, { name: teamspace.name }),
      confirmLabel: t.teamspaceDeleteAction,
      cancelLabel: t.cancel,
      variant: "destructive",
    });
    if (!ok) return;
    setError("");
    try {
      await deleteTeamspace(teamspace.id);
      onDeleted();
    } catch (err) {
      setError(
        format(t.teamspaceUpdateFailed, {
          message: teamspaceErrorMessage(err, t),
        }),
      );
    }
  }

  return (
    <div className="space-y-4">
      {/* Icon + name on one row, Notion-style. */}
      <div>
        <div className="text-[13px] font-medium text-foreground">
          {t.teamspaceNameLabel}
        </div>
        <div className="mt-1.5 flex items-center gap-2">
          <EmojiPicker
            onPick={(emoji) => {
              setIcon(emoji);
              setSaved(false);
            }}
            trigger={
              <button
                type="button"
                aria-label={t.teamspaceIconLabel}
                title={t.teamspaceIconLabel}
                className="flex size-9 shrink-0 items-center justify-center rounded-md border border-border bg-muted/50 text-[17px] leading-none text-muted-foreground hover:bg-muted"
              >
                {icon ?? <Plus className="size-4" />}
              </button>
            }
          />
          <input
            type="text"
            value={name}
            placeholder={t.teamspaceNamePlaceholder}
            onChange={(e) => {
              setName(e.target.value);
              setSaved(false);
            }}
            className="h-9 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
          />
        </div>
      </div>

      <div>
        <div className="text-[13px] font-medium text-foreground">
          {t.teamspaceDescriptionLabel}
        </div>
        <textarea
          value={description}
          rows={2}
          placeholder={t.teamspaceDescriptionPlaceholder}
          onChange={(e) => {
            setDescription(e.target.value);
            setSaved(false);
          }}
          className="mt-1.5 w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
        />
      </div>

      <div>
        <div className="text-[13px] font-medium text-foreground">
          {t.teamspaceSensitivityLabel}
        </div>
        <div className="mt-1.5">
          <SensitivitySelect
            value={sensitivity}
            onChange={(next) => {
              setSensitivity(next);
              setSaved(false);
            }}
            disabled={saving}
          />
        </div>
      </div>

      {error && <div className="text-xs text-destructive">{error}</div>}

      <div className="flex items-center justify-end gap-2">
        {saved && !error && (
          <span className="text-xs text-muted-foreground">
            {t.teamspaceSavedNotice}
          </span>
        )}
        <Button
          variant="default"
          size="sm"
          disabled={saving || !name.trim()}
          onClick={save}
        >
          {saving ? t.teamspaceSaving : t.teamspaceSaveAction}
        </Button>
      </div>

      {/* Danger row — never for the default (General) teamspace. */}
      {!teamspace.isDefault && (
        <div className="flex items-center justify-between gap-3 border-t border-border pt-4">
          <p className="text-[12px] text-muted-foreground">
            {t.teamspaceDeleteDangerHint}
          </p>
          <Button variant="destructive" size="sm" onClick={removeTeamspace}>
            {t.teamspaceMenuDelete}
          </Button>
        </div>
      )}
    </div>
  );
}

// ── Members tab ────────────────────────────────────────────────────────

/** The slice of `GET /api/workspaces/:id` the Add-members picker needs —
 *  the same detail fetch the workspace settings members tab uses. */
type WorkspaceMemberLite = {
  userId: string;
  role: "owner" | "admin" | "member";
  email?: string | null;
  userName?: string | null;
};

function MembersTab({
  workspaceId,
  teamspace,
  onChanged,
  onSelfLeft,
}: {
  workspaceId: string;
  teamspace: Teamspace;
  onChanged: () => void;
  onSelfLeft: () => void;
}) {
  const t = useT().docPage;
  const [members, setMembers] = useState<TeamspaceMember[] | null>(null);
  const [wsMembers, setWsMembers] = useState<WorkspaceMemberLite[]>([]);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const [busyUserId, setBusyUserId] = useState<string | null>(null);
  const me = getUserInfo();

  const refetchMembers = useCallback(async () => {
    try {
      setMembers(await listTeamspaceMembers(teamspace.id));
    } catch {
      setMembers([]);
      setError(t.teamspaceMembersLoadFailed);
    }
  }, [teamspace.id, t]);

  useEffect(() => {
    setMembers(null);
    setError("");
    void refetchMembers();
  }, [refetchMembers]);

  // Workspace roster for the Add-members picker (managers only need it,
  // but the fetch is cheap and the detail route is member-readable).
  useEffect(() => {
    let cancelled = false;
    authFetch(`${API_URL}/api/workspaces/${workspaceId}`)
      .then(async (res) => {
        if (!res.ok || cancelled) return;
        const json = (await res.json()) as { members?: WorkspaceMemberLite[] };
        if (!cancelled) setWsMembers(json.members ?? []);
      })
      .catch(() => {
        // Non-fatal — the roster still renders without the add picker.
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  const q = query.trim().toLowerCase();
  const matches = useCallback(
    (name: string | null | undefined, email: string | null | undefined) =>
      !q ||
      (name ?? "").toLowerCase().includes(q) ||
      (email ?? "").toLowerCase().includes(q),
    [q],
  );

  const roster = useMemo(
    () => (members ?? []).filter((m) => matches(m.name, m.email)),
    [members, matches],
  );
  const candidates = useMemo(() => {
    const inTeamspace = new Set((members ?? []).map((m) => m.userId));
    return wsMembers
      .filter((m) => !inTeamspace.has(m.userId))
      .filter((m) => matches(m.userName, m.email));
  }, [wsMembers, members, matches]);

  /** Is this roster row the caller? Id match first, email fallback (older
   *  `user` cookies predate the id field). */
  const isSelf = useCallback(
    (m: TeamspaceMember) =>
      (me?.id && m.userId === me.id) || (!!me?.email && m.email === me.email),
    [me],
  );

  async function add(userId: string) {
    setBusyUserId(userId);
    setError("");
    try {
      await addTeamspaceMember(teamspace.id, userId);
      await refetchMembers();
      onChanged();
    } catch (err) {
      setError(teamspaceErrorMessage(err, t));
    } finally {
      setBusyUserId(null);
    }
  }

  async function remove(member: TeamspaceMember) {
    const self = isSelf(member);
    const ok = await confirmDialog({
      title: self ? t.teamspaceLeaveConfirmTitle : undefined,
      description: self
        ? format(t.teamspaceLeaveConfirm, { name: teamspace.name })
        : format(t.teamspaceMemberRemoveConfirm, {
            name: member.name ?? member.email ?? member.userId,
          }),
      confirmLabel: self ? t.teamspaceLeaveAction : t.teamspaceMemberRemove,
      cancelLabel: t.cancel,
      variant: "destructive",
    });
    if (!ok) return;
    setBusyUserId(member.userId);
    setError("");
    try {
      await removeTeamspaceMember(teamspace.id, member.userId);
      if (self) {
        onSelfLeft();
        return;
      }
      await refetchMembers();
      onChanged();
    } catch (err) {
      setError(teamspaceErrorMessage(err, t));
    } finally {
      setBusyUserId(null);
    }
  }

  return (
    <div className="space-y-4">
      <input
        type="text"
        value={query}
        placeholder={t.teamspaceMemberSearchPlaceholder}
        onChange={(e) => setQuery(e.target.value)}
        className="h-8 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40"
      />

      {error && <div className="text-xs text-destructive">{error}</div>}

      {/* Roster */}
      <div className="space-y-1.5">
        <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
          {format(t.teamspaceMembersCount, {
            count: members?.length ?? teamspace.memberCount,
          })}
        </h3>
        {members === null ? (
          <div className="text-sm text-muted-foreground">
            {t.teamspaceMembersLoading}
          </div>
        ) : (
          roster.map((m) => {
            const self = isSelf(m);
            // Removing OTHERS needs manage clearance; removing yourself
            // (= leaving) is open to any member. Neither on General.
            const removable =
              !teamspace.isDefault && (self || teamspace.canManage);
            return (
              <div
                key={m.userId}
                className="flex items-center justify-between rounded-lg bg-muted/30 px-3 py-2"
              >
                <div className="flex min-w-0 items-center gap-2.5">
                  <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-[11px] font-bold text-primary">
                    {(m.name ?? m.email ?? "?").charAt(0).toUpperCase()}
                  </div>
                  <div className="min-w-0">
                    <div className="truncate text-[13px] font-medium">
                      {m.name ?? m.email ?? m.userId}
                      {self && (
                        <span className="ml-1 text-muted-foreground">
                          {t.teamspaceMemberYou}
                        </span>
                      )}
                    </div>
                    {m.email && m.name && (
                      <div className="truncate text-[11px] text-muted-foreground">
                        {m.email}
                      </div>
                    )}
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] capitalize text-muted-foreground">
                    {m.role}
                  </span>
                  {removable && (
                    <button
                      type="button"
                      disabled={busyUserId === m.userId}
                      onClick={() => void remove(m)}
                      className="text-[11px] text-destructive/80 hover:text-destructive disabled:opacity-50"
                    >
                      {self ? t.teamspaceLeaveAction : t.teamspaceMemberRemove}
                    </button>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Add members — workspace members not yet in the teamspace. The
          server re-checks clearance (409 when the target sits below the
          teamspace's sensitivity), surfaced via `teamspaceErrorMessage`. */}
      {teamspace.canManage && (
        <div className="space-y-1.5 border-t border-border pt-4">
          <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            {t.teamspaceAddMembersHeading}
          </h3>
          {candidates.length === 0 ? (
            <div className="text-[12px] text-muted-foreground">
              {t.teamspaceAddMembersEmpty}
            </div>
          ) : (
            candidates.map((m) => (
              <div
                key={m.userId}
                className="flex items-center justify-between rounded-lg px-3 py-2 hover:bg-muted/30"
              >
                <div className="flex min-w-0 items-center gap-2.5">
                  <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-[11px] font-bold text-muted-foreground">
                    {(m.userName ?? m.email ?? "?").charAt(0).toUpperCase()}
                  </div>
                  <div className="min-w-0">
                    <div className="truncate text-[13px] font-medium">
                      {m.userName ?? m.email ?? m.userId}
                    </div>
                    {m.email && m.userName && (
                      <div className="truncate text-[11px] text-muted-foreground">
                        {m.email}
                      </div>
                    )}
                  </div>
                </div>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busyUserId === m.userId}
                  onClick={() => void add(m.userId)}
                  className="h-6 shrink-0 px-2 text-[11px]"
                >
                  {t.teamspaceMemberAdd}
                </Button>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
