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
 * Backed by the already-ported `lib/api/brain-keys.ts` +
 * `lib/api/oauth-authorizations.ts`. Scoped to the route workspace via
 * `useWorkspaces().activeId` (`[COMP:app-web/workspaces-adapter]`).
 *
 * Spec: docs/architecture/features/programmatic-access.md.
 * [COMP:app-web/studio-programmatic-access]
 */

import { useCallback, useEffect, useState } from "react";
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
    <div className="space-y-6">
      {/* Intro row — the topbar breadcrumb names the section
          (docs/architecture/features/studio.md → "Page headers"). */}
      <header className="flex items-start justify-between gap-4">
        <p className="text-[13px] text-muted-foreground max-w-prose">
          {t.programmaticAccess.description}
        </p>
        {!adminOnly && (
          <Button
            onClick={() => setMode({ kind: "creating" })}
            disabled={!activeId}
            className="shrink-0"
          >
            {t.programmaticAccess.newKey}
          </Button>
        )}
      </header>

      <EndpointPanel t={t} />

      {adminOnly && (
        <div className="text-[13px] text-muted-foreground border border-dashed border-border rounded-lg px-4 py-8 text-center">
          {t.programmaticAccess.adminOnly}
        </div>
      )}

      {error && (
        <div className="text-[13px] text-destructive border border-destructive/30 rounded-lg px-3 py-2">
          {format(t.programmaticAccess.failedLoad, { error })}
        </div>
      )}

      {!adminOnly &&
        (keys === null ? (
          <div className="text-[13px] text-muted-foreground">{t.programmaticAccess.loading}</div>
        ) : activeKeys.length === 0 ? (
          <div className="text-[13px] text-muted-foreground border border-dashed border-border rounded-lg px-4 py-8 text-center">
            {t.programmaticAccess.noActive}
          </div>
        ) : (
          <ul className="border border-border rounded-lg divide-y divide-border">
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
        ))}

      {!adminOnly && revokedKeys.length > 0 && (
        <details
          open={showRevoked}
          onToggle={(e) => setShowRevoked((e.target as HTMLDetailsElement).open)}
          className="text-[13px]"
        >
          <summary className="cursor-pointer text-muted-foreground hover:text-foreground transition-colors">
            {format(showRevoked ? t.programmaticAccess.hideRevoked : t.programmaticAccess.showRevoked, {
              count: revokedKeys.length,
            })}
          </summary>
          <ul className="border border-border rounded-lg divide-y divide-border mt-3">
            {revokedKeys.map((k) => (
              <KeyRow key={k.id} row={k} t={t} />
            ))}
          </ul>
        </details>
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
    <section className="space-y-3 pt-2 border-t border-border">
      <header className="pt-4">
        <h3 className="text-[14px] font-semibold tracking-tight">
          {t.programmaticAccess.connectedApps.title}
        </h3>
        <p className="text-[13px] text-muted-foreground mt-1 max-w-prose">
          {t.programmaticAccess.connectedApps.description}
        </p>
      </header>

      {authorizations === null ? (
        <div className="text-[13px] text-muted-foreground">{t.programmaticAccess.loading}</div>
      ) : active.length === 0 ? (
        <div className="text-[13px] text-muted-foreground border border-dashed border-border rounded-lg px-4 py-8 text-center">
          {t.programmaticAccess.connectedApps.empty}
        </div>
      ) : (
        <ul className="border border-border rounded-lg divide-y divide-border">
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
    <li className="px-4 py-3 flex items-center gap-4">
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
      <div className="text-[12px] text-muted-foreground tabular-nums w-28 text-right hidden sm:block">
        {relative(auth.lastUsedAt, t)}
      </div>
      <div className="text-[12px] text-muted-foreground tabular-nums w-24 text-right hidden sm:block">
        {formatDate(auth.createdAt)}
      </div>
      <button
        onClick={onRevoke}
        className="text-[12px] text-destructive hover:text-destructive/80 transition-colors px-2 py-1"
      >
        {t.programmaticAccess.connectedApps.revoke}
      </button>
    </li>
  );
}

// ── Subcomponents ──────────────────────────────────────────────

/** Always-visible connection info — the MCP endpoint URL an external client
 *  (Claude Desktop, ChatGPT, …) points at, authenticating with a key from the
 *  list below. */
function EndpointPanel({ t }: { t: Dictionary }) {
  return (
    <div className="border border-border rounded-lg px-4 py-3 space-y-3">
      <div className="text-[13px] font-medium">{t.programmaticAccess.endpointLabel}</div>
      <CopyField label={t.programmaticAccess.endpointUrlLabel} value={BRAIN_MCP_URL} t={t} />
      <p className="text-[12px] text-muted-foreground">{t.programmaticAccess.endpointHint}</p>
      <p className="text-[12px] text-muted-foreground">
        {t.programmaticAccess.clearanceExplainer}
      </p>
    </div>
  );
}

function CopyField({ label, value, t }: { label: string; value: string; t: Dictionary }) {
  const [copied, setCopied] = useState(false);
  return (
    <div>
      <div className="text-[12px] text-muted-foreground mb-1">{label}</div>
      <div className="flex items-stretch gap-2">
        <code className="flex-1 font-mono text-[12px] bg-muted border border-border rounded px-2 py-1.5 break-all">
          {value}
        </code>
        <button
          type="button"
          title={t.programmaticAccess.copyEndpointTitle}
          onClick={async () => {
            if (await copyToClipboard(value)) {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 2000);
            }
          }}
          className="text-[12px] text-muted-foreground hover:text-foreground transition-colors px-2 shrink-0"
        >
          {copied ? t.programmaticAccess.copiedEndpoint : t.programmaticAccess.copyEndpoint}
        </button>
      </div>
    </div>
  );
}

function ScopeBadge({ scope, t }: { scope: BrainKeyScope; t: Dictionary }) {
  const label =
    scope === "read" ? t.programmaticAccess.scopeRead : t.programmaticAccess.scopeReadWrite;
  return (
    <span className="text-[11px] uppercase tracking-wide text-muted-foreground border border-border rounded px-1.5 py-0.5">
      {label}
    </span>
  );
}

/** Localized label for a key's clearance cap; null = the primary governs. */
function clearanceLabel(value: BrainKeyClearance | null, t: Dictionary): string {
  return value === null
    ? t.programmaticAccess.clearance.followsPrimary
    : t.programmaticAccess.clearance[value];
}

/** The per-key cap display: a static badge, or a compact select for
 *  owner/admins on active keys. Confidential is offered here (not in the
 *  create form) — an owner may deliberately opt a key up; the backend still
 *  applies min() with the primary assistant's clearance. */
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
      <span className="text-[11px] text-muted-foreground border border-border rounded px-1.5 py-0.5">
        {clearanceLabel(value, t)}
      </span>
    );
  }
  const items = {
    [CLEARANCE_FOLLOWS_PRIMARY]: t.programmaticAccess.clearance.followsPrimary,
    public: t.programmaticAccess.clearance.public,
    internal: t.programmaticAccess.clearance.internal,
    confidential: t.programmaticAccess.clearance.confidential,
  };
  return (
    <Select
      value={value ?? CLEARANCE_FOLLOWS_PRIMARY}
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
          {t.programmaticAccess.clearance.followsPrimary}
        </SelectItem>
        <SelectItem value="public">{t.programmaticAccess.clearance.public}</SelectItem>
        <SelectItem value="internal">{t.programmaticAccess.clearance.internal}</SelectItem>
        <SelectItem value="confidential">
          {t.programmaticAccess.clearance.confidential}
        </SelectItem>
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
    <li className="px-4 py-3 flex items-center gap-4">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span
            className={`text-[14px] font-medium truncate ${
              isRevoked ? "text-muted-foreground line-through" : ""
            }`}
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
            <span className="text-[11px] uppercase tracking-wide text-muted-foreground border border-border rounded px-1.5 py-0.5">
              {t.programmaticAccess.statusRevoked}
            </span>
          )}
        </div>
        <div className="text-[12px] text-muted-foreground mt-0.5 font-mono">{row.prefix}…</div>
      </div>
      <div className="text-[12px] text-muted-foreground tabular-nums w-28 text-right hidden sm:block">
        {relative(row.lastUsedAt, t)}
      </div>
      <div className="text-[12px] text-muted-foreground tabular-nums w-24 text-right hidden sm:block">
        {formatDate(row.createdAt)}
      </div>
      {!isRevoked && onRevoke && (
        <button
          onClick={onRevoke}
          className="text-[12px] text-destructive hover:text-destructive/80 transition-colors px-2 py-1"
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
    <form onSubmit={submit} className="space-y-4 max-w-md">
      <header>
        <h2 className="text-[15px] font-semibold tracking-tight">
          {t.programmaticAccess.create.title}
        </h2>
        <p className="text-[13px] text-muted-foreground mt-1">
          {t.programmaticAccess.create.description}
        </p>
      </header>

      <label className="block">
        <span className="text-[13px] text-muted-foreground">
          {t.programmaticAccess.create.nameLabel}
        </span>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t.programmaticAccess.create.placeholder}
          maxLength={120}
          className="mt-1 w-full bg-background border border-border rounded-lg px-3 py-2 text-[14px] focus:outline-none focus:ring-2 focus:ring-primary/40"
        />
      </label>

      <fieldset className="space-y-2">
        <legend className="text-[13px] text-muted-foreground">
          {t.programmaticAccess.create.scopeLabel}
        </legend>
        {(["read_write", "read"] as const).map((value) => (
          <label
            key={value}
            className={`flex items-start gap-2 border rounded-lg px-3 py-2 cursor-pointer transition-colors ${
              scope === value ? "border-primary/60 bg-primary/5" : "border-border hover:bg-muted/50"
            }`}
          >
            <input
              type="radio"
              name="scope"
              value={value}
              checked={scope === value}
              onChange={() => setScope(value)}
              className="mt-0.5"
            />
            <span className="text-[13px]">
              {value === "read_write"
                ? t.programmaticAccess.create.scopeReadWriteOption
                : t.programmaticAccess.create.scopeReadOption}
            </span>
          </label>
        ))}
      </fieldset>

      <div>
        <span className="text-[13px] text-muted-foreground">
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
          <SelectTrigger className="mt-1 w-full" aria-label={t.programmaticAccess.create.clearanceLabel}>
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
        <div className="text-[13px] text-destructive border border-destructive/30 rounded-lg px-3 py-2">
          {error}
        </div>
      )}

      <div className="flex gap-2">
        <Button type="submit" disabled={!name.trim() || submitting}>
          {submitting ? t.programmaticAccess.create.submitting : t.programmaticAccess.create.submit}
        </Button>
        <Button type="button" variant="outline" onClick={onCancel} disabled={submitting}>
          {t.programmaticAccess.create.cancel}
        </Button>
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
    <div className="space-y-4 max-w-2xl">
      <header>
        <h2 className="text-[15px] font-semibold tracking-tight">
          {format(t.programmaticAccess.reveal.title, { name: created.name })}
        </h2>
      </header>

      <div className="border border-destructive/40 bg-destructive/5 rounded-lg px-4 py-3">
        <p className="text-[13px] text-destructive font-medium">
          {t.programmaticAccess.reveal.bannerHeading}
        </p>
        <p className="text-[12px] text-destructive/80 mt-1">{t.programmaticAccess.reveal.bannerBody}</p>
      </div>

      <div className="space-y-2">
        <span className="text-[13px] text-muted-foreground">
          {t.programmaticAccess.reveal.keyLabel}
        </span>
        <div className="flex items-stretch gap-2">
          <code className="flex-1 bg-muted rounded-lg px-3 py-2 text-[13px] font-mono break-all border border-border">
            {created.key}
          </code>
          <Button
            type="button"
            onClick={async () => {
              if (await copyToClipboard(created.key)) setCopiedKey(true);
            }}
            className="shrink-0"
          >
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
