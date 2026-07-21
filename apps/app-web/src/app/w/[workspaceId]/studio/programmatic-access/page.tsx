"use client";

/**
 * Studio ▸ Programmatic access (app-web).
 *
 * Ported from `apps/web/src/app/(app)/studio/programmatic-access/page.tsx` as
 * part of the studio surface migration
 * (docs/architecture/features/doc.md §9 #5). Workspace-admin
 * management of `sk_brain_` keys — the credentials external MCP clients
 * (Claude Code, Claude Desktop, ChatGPT) use to read from and write to the
 * workspace brain over `POST /api/brain/mcp`.
 *
 * Three render states, mirroring the assistant API-keys tab: list (default),
 * creating (name + scope form), revealed (the one-time plaintext key).
 * Plaintext is shown ONCE — the GET endpoint never returns it.
 *
 * Visual language follows the modern Studio sections (Mini-apps / Knowledge /
 * Channels): `rounded-xl bg-card` cards with icon tiles, pill badges, and
 * uppercase section headers — see those pages for the reference styling.
 *
 * Backed by the already-ported `lib/api/brain-keys.ts` +
 * `lib/api/oauth-authorizations.ts`. Scoped to the route workspace via
 * `useWorkspaces().activeId` (`[COMP:app-web/workspaces-adapter]`).
 *
 * Spec: docs/architecture/features/programmatic-access.md.
 * [COMP:app-web/studio-programmatic-access]
 */

import { useCallback, useEffect, useState } from "react";
import {
  AppWindow,
  Check,
  Copy,
  KeyRound,
  Plug,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import { useWorkspaces } from "@/contexts/workspace-context";
import { Button } from "@/components/ui/button";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n";
import type { Dictionary } from "@/lib/i18n";
import {
  BRAIN_MCP_URL,
  createBrainKey,
  listBrainKeys,
  revokeBrainKey,
  updateBrainKeyMaxClearance,
  type BrainKey,
  type BrainKeyClearance,
  type BrainKeyScope,
  type CreatedBrainKey,
} from "@/lib/api/brain-keys";
import {
  listOAuthAuthorizations,
  revokeOAuthAuthorization,
  type OAuthAuthorization,
} from "@/lib/api/oauth-authorizations";

type Mode =
  | { kind: "list" }
  | { kind: "creating" }
  | { kind: "revealed"; created: CreatedBrainKey };

/** Select sentinel for "no cap" — base-ui Select values must be strings. */
const CLEARANCE_FOLLOWS_PRIMARY = "primary";

function formatDate(iso: string | null): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function relative(iso: string | null, t: Dictionary): string {
  if (!iso) return t.programmaticAccess.neverUsed;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return t.programmaticAccess.neverUsed;
  const mins = Math.round((Date.now() - d.getTime()) / 60000);
  if (mins < 1) return t.programmaticAccess.relativeJustNow;
  if (mins < 60) return format(t.programmaticAccess.relativeMinutes, { count: mins });
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return format(t.programmaticAccess.relativeHours, { count: hrs });
  const days = Math.round(hrs / 24);
  if (days < 30) return format(t.programmaticAccess.relativeDays, { count: days });
  return formatDate(iso);
}

async function copyToClipboard(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

export default function ProgrammaticAccessPage() {
  const t = useT();
  const { activeId } = useWorkspaces();
  const [keys, setKeys] = useState<BrainKey[] | null>(null);
  const [authorizations, setAuthorizations] = useState<OAuthAuthorization[] | null>(null);
  const [mode, setMode] = useState<Mode>({ kind: "list" });
  const [showRevoked, setShowRevoked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adminOnly, setAdminOnly] = useState(false);

  const load = useCallback(async () => {
    if (!activeId) return;
    setError(null);
    setAdminOnly(false);
    try {
      const [loadedKeys, loadedAuths] = await Promise.all([
        listBrainKeys(activeId),
        listOAuthAuthorizations(activeId),
      ]);
      setKeys(loadedKeys);
      setAuthorizations(loadedAuths);
    } catch (err) {
      const message = (err as Error).message;
      // The backend 403s non-admins — show the targeted message, not a
      // generic load error.
      if (message.includes("403")) setAdminOnly(true);
      else setError(message);
      setKeys([]);
      setAuthorizations([]);
    }
  }, [activeId]);

  useEffect(() => {
    load();
  }, [load]);

  const changeMaxClearance = useCallback(
    async (keyId: string, next: BrainKeyClearance | null) => {
      if (!activeId) return;
      // Optimistic: reflect the new cap immediately, reload on failure.
      setKeys(
        (prev) =>
          prev?.map((x) => (x.id === keyId ? { ...x, maxClearance: next } : x)) ?? null,
      );
      try {
        await updateBrainKeyMaxClearance(activeId, keyId, next);
      } catch (err) {
        setError((err as Error).message);
        load();
      }
    },
    [activeId, load],
  );

  if (mode.kind === "creating" && activeId) {
    return (
      <CreateKeyForm
        workspaceId={activeId}
        onCancel={() => setMode({ kind: "list" })}
        onCreated={(created) => {
          setMode({ kind: "revealed", created });
          // Optimistically prepend so the key is in the list after dismissing.
          setKeys((prev) => (prev ? [created, ...prev] : [created]));
        }}
      />
    );
  }

  if (mode.kind === "revealed") {
    return <RevealKeyView created={mode.created} onAcknowledge={() => setMode({ kind: "list" })} />;
  }

  const activeKeys = (keys ?? []).filter((k) => k.status === "active");
  const revokedKeys = (keys ?? []).filter((k) => k.status === "revoked");

  return (
    <div className="flex flex-col gap-6">
      <EndpointPanel t={t} />

      {adminOnly && (
        <div className="rounded-xl border border-dashed border-border px-5 py-10 text-center text-[13px] text-muted-foreground">
          {t.programmaticAccess.adminOnly}
        </div>
      )}

      {error && (
        <div className="text-[13px] text-destructive bg-destructive/10 border border-destructive/20 rounded-lg px-4 py-3">
          {format(t.programmaticAccess.failedLoad, { error })}
        </div>
      )}

      {!adminOnly && (
        <section className="flex flex-col gap-3">
          {/* Section header carries the one primary action, mirroring the
              Knowledge sources header; the topbar breadcrumb names the page
              (docs/architecture/features/studio.md → "Page headers"). */}
          <div className="flex items-center justify-between">
            <h2 className="text-[13px] font-semibold tracking-tight uppercase text-muted-foreground">
              {t.programmaticAccess.keysTitle}
            </h2>
            <Button
              size="sm"
              onClick={() => setMode({ kind: "creating" })}
              disabled={!activeId}
              className="shrink-0"
            >
              {t.programmaticAccess.newKey}
            </Button>
          </div>

          {keys === null ? (
            <div className="text-sm text-muted-foreground">{t.programmaticAccess.loading}</div>
          ) : activeKeys.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border px-5 py-10 text-center">
              <div className="mx-auto mb-3 flex h-9 w-9 items-center justify-center rounded-lg bg-muted text-muted-foreground">
                <KeyRound className="h-4 w-4" />
              </div>
              <p className="text-[13px] text-muted-foreground">{t.programmaticAccess.noActive}</p>
            </div>
          ) : (
            <ul className="rounded-xl border border-border bg-card divide-y divide-border overflow-hidden">
              {activeKeys.map((k) => (
                <KeyRow
                  key={k.id}
                  row={k}
                  t={t}
                  onChangeMaxClearance={(next) => changeMaxClearance(k.id, next)}
                  onRevoke={async () => {
                    const ok = await confirmDialog({
                      title: t.programmaticAccess.confirmRevokeTitle,
                      description: format(t.programmaticAccess.confirmRevokeBody, { name: k.name }),
                      confirmLabel: t.programmaticAccess.revoke,
                      variant: "destructive",
                    });
                    if (!ok || !activeId) return;
                    try {
                      await revokeBrainKey(activeId, k.id);
                      setKeys(
                        (prev) =>
                          prev?.map((x) =>
                            x.id === k.id ? { ...x, status: "revoked" as const } : x,
                          ) ?? null,
                      );
                    } catch (err) {
                      setError((err as Error).message);
                    }
                  }}
                />
              ))}
            </ul>
          )}

          {revokedKeys.length > 0 && (
            <details
              open={showRevoked}
              onToggle={(e) => setShowRevoked((e.target as HTMLDetailsElement).open)}
              className="text-[13px]"
            >
              <summary className="cursor-pointer text-muted-foreground hover:text-foreground transition-colors select-none">
                {format(showRevoked ? t.programmaticAccess.hideRevoked : t.programmaticAccess.showRevoked, {
                  count: revokedKeys.length,
                })}
              </summary>
              <ul className="rounded-xl border border-border bg-card divide-y divide-border overflow-hidden mt-3 opacity-80">
                {revokedKeys.map((k) => (
                  <KeyRow key={k.id} row={k} t={t} />
                ))}
              </ul>
            </details>
          )}
        </section>
      )}

      {!adminOnly && (
        <ConnectedAppsSection
          authorizations={authorizations}
          onRevoke={async (auth) => {
            const ok = await confirmDialog({
              title: t.programmaticAccess.connectedApps.confirmRevokeTitle,
              description: format(t.programmaticAccess.connectedApps.confirmRevokeBody, {
                name: auth.clientName ?? t.programmaticAccess.connectedApps.unnamedClient,
              }),
              confirmLabel: t.programmaticAccess.connectedApps.revoke,
              variant: "destructive",
            });
            if (!ok || !activeId) return;
            try {
              await revokeOAuthAuthorization(activeId, auth.id);
              setAuthorizations(
                (prev) =>
                  prev?.map((x) =>
                    x.id === auth.id ? { ...x, status: "revoked" as const } : x,
                  ) ?? null,
              );
            } catch (err) {
              setError((err as Error).message);
            }
          }}
        />
      )}
    </div>
  );
}

function ConnectedAppsSection({
  authorizations,
  onRevoke,
}: {
  authorizations: OAuthAuthorization[] | null;
  onRevoke: (auth: OAuthAuthorization) => void;
}) {
  const t = useT();
  const active = (authorizations ?? []).filter((a) => a.status === "active");
  return (
    <section className="flex flex-col gap-3">
      <header>
        <h2 className="text-[13px] font-semibold tracking-tight uppercase text-muted-foreground">
          {t.programmaticAccess.connectedApps.title}
        </h2>
        <p className="text-[13px] text-muted-foreground mt-1 max-w-prose">
          {t.programmaticAccess.connectedApps.description}
        </p>
      </header>

      {authorizations === null ? (
        <div className="text-sm text-muted-foreground">{t.programmaticAccess.loading}</div>
      ) : active.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border px-5 py-10 text-center">
          <div className="mx-auto mb-3 flex h-9 w-9 items-center justify-center rounded-lg bg-muted text-muted-foreground">
            <AppWindow className="h-4 w-4" />
          </div>
          <p className="text-[13px] text-muted-foreground">
            {t.programmaticAccess.connectedApps.empty}
          </p>
        </div>
      ) : (
        <ul className="rounded-xl border border-border bg-card divide-y divide-border overflow-hidden">
          {active.map((auth) => (
            <ConnectedAppRow key={auth.id} auth={auth} onRevoke={() => onRevoke(auth)} />
          ))}
        </ul>
      )}
    </section>
  );
}

function ConnectedAppRow({
  auth,
  onRevoke,
}: {
  auth: OAuthAuthorization;
  onRevoke: () => void;
}) {
  const t = useT();
  const name = auth.clientName ?? t.programmaticAccess.connectedApps.unnamedClient;
  return (
    <li className="px-4 py-3.5 flex items-center gap-3">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
        <AppWindow className="h-4 w-4" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[14px] font-medium truncate">{name}</span>
          <ScopeBadge scope={auth.scope} t={t} />
        </div>
        {auth.clientUri && (
          <div className="text-[12px] text-muted-foreground mt-0.5 truncate">
            {auth.clientUri}
          </div>
        )}
      </div>
      <MetaCell value={relative(auth.lastUsedAt, t)} label={t.programmaticAccess.lastUsedLabel} />
      <MetaCell value={formatDate(auth.createdAt)} label={t.programmaticAccess.createdLabel} />
      <button
        onClick={onRevoke}
        className="text-xs font-medium border border-border px-2.5 py-1 rounded-lg text-muted-foreground hover:text-destructive hover:border-destructive/30 transition-colors shrink-0"
      >
        {t.programmaticAccess.connectedApps.revoke}
      </button>
    </li>
  );
}

// ── Subcomponents ──────────────────────────────────────────────

/** Right-aligned meta column — value with a tiny label underneath, so the
 *  two dates in a row read unambiguously (Last used vs Created). */
function MetaCell({ value, label }: { value: string; label: string }) {
  return (
    <div className="hidden sm:flex w-28 shrink-0 flex-col items-end">
      <span className="text-[12px] tabular-nums">{value}</span>
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground/70">
        {label}
      </span>
    </div>
  );
}

/** Always-visible connection info — the MCP endpoint URL an external client
 *  (Claude Desktop, ChatGPT, …) points at, authenticating with a key from the
 *  list below. */
function EndpointPanel({ t }: { t: Dictionary }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="rounded-xl border border-border bg-card p-5">
      <div className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Plug className="h-[18px] w-[18px]" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[14px] font-medium">{t.programmaticAccess.endpointLabel}</div>
          <p className="text-[12px] text-muted-foreground mt-0.5 leading-relaxed max-w-prose">
            {t.programmaticAccess.endpointHint}
          </p>
        </div>
      </div>

      <div className="mt-4">
        <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground mb-1.5">
          {t.programmaticAccess.endpointUrlLabel}
        </div>
        <div className="flex items-center gap-1.5 rounded-lg border border-border bg-muted/50 py-1 pl-3 pr-1">
          <code className="flex-1 font-mono text-[12px] break-all py-1">{BRAIN_MCP_URL}</code>
          <button
            type="button"
            title={t.programmaticAccess.copyEndpointTitle}
            onClick={async () => {
              if (await copyToClipboard(BRAIN_MCP_URL)) {
                setCopied(true);
                window.setTimeout(() => setCopied(false), 2000);
              }
            }}
            className="inline-flex shrink-0 items-center gap-1 rounded-md px-2 py-1 text-[12px] font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          >
            {copied ? (
              <Check className="h-3.5 w-3.5 text-primary" />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )}
            {copied ? t.programmaticAccess.copiedEndpoint : t.programmaticAccess.copyEndpoint}
          </button>
        </div>
      </div>

      <div className="mt-3 flex items-start gap-2 text-[12px] text-muted-foreground">
        <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <p className="max-w-prose">{t.programmaticAccess.clearanceExplainer}</p>
      </div>
    </div>
  );
}

function ScopeBadge({ scope, t }: { scope: BrainKeyScope; t: Dictionary }) {
  const readWrite = scope !== "read";
  return (
    <span
      className={cn(
        "shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium",
        readWrite ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground",
      )}
    >
      {readWrite ? t.programmaticAccess.scopeReadWrite : t.programmaticAccess.scopeRead}
    </span>
  );
}

/** Localized label for a key's clearance cap. Copy never surfaces the
 *  primary-clearance concept: a NULL cap and an explicit 'confidential' cap
 *  are equivalent (the cap only ever lowers the ceiling), so both render as
 *  Confidential. */
function clearanceLabel(value: BrainKeyClearance | null, t: Dictionary): string {
  return value === null || value === "confidential"
    ? t.programmaticAccess.clearance.confidential
    : t.programmaticAccess.clearance[value];
}

/** The per-key cap display: a static badge, or a compact select for
 *  owner/admins on active keys. Confidential (the top tier) writes NULL —
 *  no cap; a stored explicit 'confidential' displays identically and is
 *  normalized to NULL on the next change. */
function ClearanceCapControl({
  value,
  t,
  onChange,
}: {
  value: BrainKeyClearance | null;
  t: Dictionary;
  onChange?: (next: BrainKeyClearance | null) => void;
}) {
  if (!onChange) {
    return (
      <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
        {clearanceLabel(value, t)}
      </span>
    );
  }
  const items = {
    [CLEARANCE_FOLLOWS_PRIMARY]: t.programmaticAccess.clearance.confidential,
    internal: t.programmaticAccess.clearance.internal,
    public: t.programmaticAccess.clearance.public,
  };
  const selected =
    value === null || value === "confidential" ? CLEARANCE_FOLLOWS_PRIMARY : value;
  return (
    <Select
      value={selected}
      items={items}
      onValueChange={(v) => {
        if (!v) return;
        const next =
          v === CLEARANCE_FOLLOWS_PRIMARY ? null : (v as BrainKeyClearance);
        if (next !== value) onChange(next);
      }}
    >
      <SelectTrigger
        size="sm"
        className="text-[11px] text-muted-foreground"
        aria-label={t.programmaticAccess.clearance.label}
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={CLEARANCE_FOLLOWS_PRIMARY}>
          {t.programmaticAccess.clearance.confidential}
        </SelectItem>
        <SelectItem value="internal">{t.programmaticAccess.clearance.internal}</SelectItem>
        <SelectItem value="public">{t.programmaticAccess.clearance.public}</SelectItem>
      </SelectContent>
    </Select>
  );
}

function KeyRow({
  row,
  t,
  onRevoke,
  onChangeMaxClearance,
}: {
  row: BrainKey;
  t: Dictionary;
  onRevoke?: () => void;
  onChangeMaxClearance?: (next: BrainKeyClearance | null) => void;
}) {
  const isRevoked = row.status === "revoked";
  return (
    <li className="px-4 py-3.5 flex items-center gap-3">
      <div
        className={cn(
          "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg",
          isRevoked ? "bg-muted text-muted-foreground" : "bg-primary/10 text-primary",
        )}
      >
        <KeyRound className="h-4 w-4" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span
            className={cn(
              "text-[14px] font-medium truncate",
              isRevoked && "text-muted-foreground line-through",
            )}
          >
            {row.name}
          </span>
          <ScopeBadge scope={row.scope} t={t} />
          <ClearanceCapControl
            value={row.maxClearance}
            t={t}
            onChange={isRevoked ? undefined : onChangeMaxClearance}
          />
          {isRevoked && (
            <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
              {t.programmaticAccess.statusRevoked}
            </span>
          )}
        </div>
        <div className="text-[12px] text-muted-foreground mt-0.5 font-mono">{row.prefix}…</div>
      </div>
      <MetaCell value={relative(row.lastUsedAt, t)} label={t.programmaticAccess.lastUsedLabel} />
      <MetaCell value={formatDate(row.createdAt)} label={t.programmaticAccess.createdLabel} />
      {!isRevoked && onRevoke && (
        <button
          onClick={onRevoke}
          className="text-xs font-medium border border-border px-2.5 py-1 rounded-lg text-muted-foreground hover:text-destructive hover:border-destructive/30 transition-colors shrink-0"
        >
          {t.programmaticAccess.revoke}
        </button>
      )}
    </li>
  );
}

function CreateKeyForm({
  workspaceId,
  onCancel,
  onCreated,
}: {
  workspaceId: string;
  onCancel: () => void;
  onCreated: (created: CreatedBrainKey) => void;
}) {
  const t = useT();
  const [name, setName] = useState("");
  const [scope, setScope] = useState<BrainKeyScope>("read_write");
  const [maxClearance, setMaxClearance] = useState<BrainKeyClearance | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      onCreated(
        await createBrainKey(workspaceId, { name: name.trim(), scope, maxClearance }),
      );
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} className="max-w-lg flex flex-col gap-4">
      <header className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <KeyRound className="h-4 w-4" />
        </div>
        <div>
          <h2 className="text-[15px] font-semibold tracking-tight">
            {t.programmaticAccess.create.title}
          </h2>
          <p className="text-[13px] text-muted-foreground mt-0.5">
            {t.programmaticAccess.create.description}
          </p>
        </div>
      </header>

      <div className="rounded-xl border border-border bg-card p-5 flex flex-col gap-4">
        <label className="flex flex-col gap-1.5">
          <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {t.programmaticAccess.create.nameLabel}
          </span>
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t.programmaticAccess.create.placeholder}
            maxLength={120}
            className="w-full bg-muted/50 border border-border rounded-lg px-3 py-2 text-[14px] focus:outline-none focus:ring-2 focus:ring-primary/30"
          />
        </label>

        <fieldset>
          <legend className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground mb-1.5">
            {t.programmaticAccess.create.scopeLabel}
          </legend>
          <div className="flex flex-col gap-2">
            {(["read_write", "read"] as const).map((value) => (
              <label
                key={value}
                className={cn(
                  "flex items-start gap-2.5 border rounded-lg px-3 py-2.5 cursor-pointer transition-colors",
                  scope === value
                    ? "border-primary/60 bg-primary/5"
                    : "border-border hover:bg-muted/50",
                )}
              >
                <input
                  type="radio"
                  name="scope"
                  value={value}
                  checked={scope === value}
                  onChange={() => setScope(value)}
                  className="mt-0.5 accent-primary"
                />
                <span className="text-[13px]">
                  {value === "read_write"
                    ? t.programmaticAccess.create.scopeReadWriteOption
                    : t.programmaticAccess.create.scopeReadOption}
                </span>
              </label>
            ))}
          </div>
        </fieldset>

        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {t.programmaticAccess.create.clearanceLabel}
          </span>
          <Select
            value={maxClearance ?? CLEARANCE_FOLLOWS_PRIMARY}
            items={{
              [CLEARANCE_FOLLOWS_PRIMARY]: t.programmaticAccess.create.clearanceDefaultOption,
              internal: t.programmaticAccess.clearance.internal,
              public: t.programmaticAccess.clearance.public,
            }}
            onValueChange={(v) => {
              if (!v) return;
              setMaxClearance(
                v === CLEARANCE_FOLLOWS_PRIMARY ? null : (v as BrainKeyClearance),
              );
            }}
          >
            <SelectTrigger className="w-full" aria-label={t.programmaticAccess.create.clearanceLabel}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={CLEARANCE_FOLLOWS_PRIMARY}>
                {t.programmaticAccess.create.clearanceDefaultOption}
              </SelectItem>
              <SelectItem value="internal">{t.programmaticAccess.clearance.internal}</SelectItem>
              <SelectItem value="public">{t.programmaticAccess.clearance.public}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {error && (
          <div className="text-[12px] text-destructive bg-destructive/10 border border-destructive/20 rounded-lg px-3 py-2">
            {error}
          </div>
        )}

        <div className="flex gap-2 justify-end pt-1">
          <Button type="button" variant="outline" onClick={onCancel} disabled={submitting}>
            {t.programmaticAccess.create.cancel}
          </Button>
          <Button type="submit" disabled={!name.trim() || submitting}>
            {submitting ? t.programmaticAccess.create.submitting : t.programmaticAccess.create.submit}
          </Button>
        </div>
      </div>
    </form>
  );
}

function RevealKeyView({
  created,
  onAcknowledge,
}: {
  created: CreatedBrainKey;
  onAcknowledge: () => void;
}) {
  const t = useT();
  const [copiedKey, setCopiedKey] = useState(false);

  return (
    <div className="max-w-2xl flex flex-col gap-4">
      <header className="flex items-center gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <KeyRound className="h-4 w-4" />
        </div>
        <h2 className="text-[15px] font-semibold tracking-tight">
          {format(t.programmaticAccess.reveal.title, { name: created.name })}
        </h2>
      </header>

      <div className="flex items-start gap-2.5 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3">
        <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
        <div>
          <p className="text-[13px] font-medium text-amber-700 dark:text-amber-300">
            {t.programmaticAccess.reveal.bannerHeading}
          </p>
          <p className="text-[12px] text-amber-700/80 dark:text-amber-400/80 mt-0.5">
            {t.programmaticAccess.reveal.bannerBody}
          </p>
        </div>
      </div>

      <div className="rounded-xl border border-border bg-card p-5 flex flex-col gap-1.5">
        <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
          {t.programmaticAccess.reveal.keyLabel}
        </span>
        <div className="flex items-center gap-2">
          <code className="flex-1 bg-muted/50 rounded-lg px-3 py-2 text-[13px] font-mono break-all border border-border">
            {created.key}
          </code>
          <Button
            type="button"
            onClick={async () => {
              if (await copyToClipboard(created.key)) setCopiedKey(true);
            }}
            className="shrink-0"
          >
            {copiedKey ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            {copiedKey ? t.programmaticAccess.reveal.copied : t.programmaticAccess.reveal.copy}
          </Button>
        </div>
      </div>

      <div>
        <Button
          onClick={onAcknowledge}
          disabled={!copiedKey}
          variant={copiedKey ? "default" : "outline"}
        >
          {copiedKey
            ? t.programmaticAccess.reveal.acknowledge
            : t.programmaticAccess.reveal.acknowledgeWaiting}
        </Button>
      </div>
    </div>
  );
}
