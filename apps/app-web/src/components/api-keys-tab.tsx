"use client";

/**
 * API keys tab for the assistant detail page (app-web).
 *
 * Ported from `apps/web/src/components/api-keys-tab.tsx`
 * (app consolidation §9 #5). Spec: docs/architecture/features/public-api.md.
 *
 * Three render states: list (default), creating (name form), revealed
 * (one-time plaintext display with copy + acknowledge). The plaintext is
 * shown ONCE at creation; the GET endpoint never returns plaintext.
 *
 * Rotation = create new + revoke old. The Rotate affordance on each row is
 * sugar for "open the create form pre-filled with `<name>-rotated`."
 *
 * Keys carry an immutable `scope` (migration 263): 'chat' = /messages only
 * (external embedding); 'agent' = also opens the assistant MCP endpoint.
 * The create form picks the scope via radio-style cards; rotate to change it.
 *
 * i18n: all user-facing strings come from `t.apiKeys`, mirrored from
 * apps/web into the app-web dictionaries with en/ja/zh parity. The
 * `DOCS_HREF` points at `/docs/api` on the marketing origin (apps/web) via
 * `webAppUrl()` - the docs surface stays there per the consolidation plan.
 *
 * [COMP:app-web/api-keys-tab]
 */

import { useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { authFetch } from "@/lib/auth-fetch";
import { Button } from "@/components/ui/button";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n";
import type { Dictionary } from "@/lib/i18n";
import { DISPLAY_API_URL } from "@/lib/display-api-url";
import { webAppUrl } from "@/lib/primary-auth";

const DOCS_HREF = `${webAppUrl()}/docs/api`;

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

type ApiKeyScope = "chat" | "agent";

type ApiKeyRow = {
  id: string;
  name: string;
  prefix: string;
  /** 'chat' = /messages only; 'agent' = also opens the assistant MCP endpoint.
   *  Optional to tolerate older cached responses — treat undefined as 'chat'. */
  scope?: ApiKeyScope;
  status: "active" | "revoked";
  createdAt: string;
  lastUsedAt: string | null;
};

function rowScope(row: Pick<ApiKeyRow, "scope">): ApiKeyScope {
  return row.scope ?? "chat";
}

type CreatedKey = ApiKeyRow & { key: string };

type Mode =
  | { kind: "list" }
  | { kind: "creating"; defaultName: string }
  | { kind: "revealed"; created: CreatedKey };

function formatDate(iso: string | null): string {
  if (!iso) return "-";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function relative(iso: string | null, t: Dictionary): string {
  if (!iso) return t.apiKeys.neverUsed;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return t.apiKeys.neverUsed;
  const diffMs = Date.now() - d.getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return t.apiKeys.relativeJustNow;
  if (mins < 60) return format(t.apiKeys.relativeMinutes, { count: mins });
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return format(t.apiKeys.relativeHours, { count: hrs });
  const days = Math.round(hrs / 24);
  if (days < 30) return format(t.apiKeys.relativeDays, { count: days });
  return formatDate(iso);
}

export function ApiKeysTab({ assistantId }: { assistantId: string }) {
  const t = useT();
  const [keys, setKeys] = useState<ApiKeyRow[] | null>(null);
  const [mode, setMode] = useState<Mode>({ kind: "list" });
  const [showRevoked, setShowRevoked] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const r = await authFetch(`${API_URL}/api/assistants/${assistantId}/integrations/api-keys`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = (await r.json()) as { keys: ApiKeyRow[] };
      setKeys(data.keys);
    } catch (err) {
      setError((err as Error).message);
      setKeys([]);
    }
  }, [assistantId]);

  useEffect(() => {
    load();
  }, [load]);

  if (mode.kind === "creating") {
    return (
      <CreateKeyForm
        defaultName={mode.defaultName}
        assistantId={assistantId}
        onCancel={() => setMode({ kind: "list" })}
        onCreated={(created) => {
          setMode({ kind: "revealed", created });
          // Optimistically add to the list so the user sees it after dismissing the reveal.
          setKeys((prev) => (prev ? [created, ...prev] : [created]));
        }}
      />
    );
  }

  if (mode.kind === "revealed") {
    return (
      <RevealKeyView
        created={mode.created}
        assistantId={assistantId}
        onAcknowledge={() => setMode({ kind: "list" })}
      />
    );
  }

  const activeKeys = (keys ?? []).filter((k) => k.status === "active");
  const revokedKeys = (keys ?? []).filter((k) => k.status === "revoked");

  return (
    <div className="space-y-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-[15px] font-semibold tracking-tight">{t.apiKeys.title}</h2>
          <p className="text-[13px] text-muted-foreground mt-1 max-w-prose">
            {t.apiKeys.description}
          </p>
        </div>
        <Button
          onClick={() => setMode({ kind: "creating", defaultName: "" })}
          className="shrink-0"
        >
          {t.apiKeys.newKey}
        </Button>
      </header>

      <AssistantIdPanel assistantId={assistantId} t={t} />

      <McpEndpointPanel assistantId={assistantId} t={t} />

      {error && (
        <div className="text-[13px] text-red-500 border border-red-500/30 rounded-lg px-3 py-2">
          {format(t.apiKeys.failedLoad, { error })}
        </div>
      )}

      {keys === null ? (
        <div className="text-[13px] text-muted-foreground">{t.apiKeys.loading}</div>
      ) : activeKeys.length === 0 ? (
        <div className="text-[13px] text-muted-foreground border border-dashed border-border rounded-lg px-4 py-8 text-center">
          {t.apiKeys.noActive}
        </div>
      ) : (
        <ul className="border border-border rounded-lg divide-y divide-border">
          {activeKeys.map((k) => (
            <KeyRow
              key={k.id}
              row={k}
              t={t}
              onRevoke={async () => {
                const ok = await confirmDialog({
                  title: t.apiKeys.confirmRevokeTitle,
                  description: format(t.apiKeys.confirmRevokeBody, { name: k.name }),
                  confirmLabel: t.apiKeys.revoke,
                  variant: "destructive",
                });
                if (!ok) return;
                const r = await authFetch(
                  `${API_URL}/api/assistants/${assistantId}/integrations/api-keys/${k.id}`,
                  { method: "DELETE" },
                );
                if (r.ok) {
                  setKeys((prev) => prev?.map((x) => (x.id === k.id ? { ...x, status: "revoked" } : x)) ?? null);
                }
              }}
              onRotate={() => setMode({ kind: "creating", defaultName: `${k.name}-rotated` })}
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
          <summary className="cursor-pointer text-muted-foreground hover:text-foreground transition-colors">
            {format(
              showRevoked ? t.apiKeys.hideRevoked : t.apiKeys.showRevoked,
              { count: revokedKeys.length },
            )}
          </summary>
          <ul className="border border-border rounded-lg divide-y divide-border mt-3">
            {revokedKeys.map((k) => (
              <KeyRow key={k.id} row={k} t={t} />
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

// ── Subcomponents ──────────────────────────────────────────────

function AssistantIdPanel({ assistantId, t }: { assistantId: string; t: Dictionary }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(assistantId);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fall through — user can select & copy manually
    }
  }

  return (
    <div className="border border-border rounded-lg px-4 py-3 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0 flex-1">
        <div className="text-[13px] text-muted-foreground">{t.apiKeys.assistantIdLabel}</div>
        <div className="mt-1 flex items-center gap-2 flex-wrap">
          <code className="font-mono text-[12px] bg-muted border border-border rounded px-2 py-1 break-all">
            {assistantId}
          </code>
          <button
            type="button"
            onClick={copy}
            title={t.apiKeys.copyAssistantIdTitle}
            className="text-[12px] text-muted-foreground hover:text-foreground transition-colors px-2 py-1"
          >
            {copied ? t.apiKeys.copiedAssistantId : t.apiKeys.copyAssistantId}
          </button>
        </div>
        <p className="text-[12px] text-muted-foreground mt-2">{t.apiKeys.assistantIdHint}</p>
      </div>
      <Link
        href={DOCS_HREF}
        target="_blank"
        rel="noopener noreferrer"
        title={t.apiKeys.docsLinkTitle}
        className="text-[13px] text-foreground hover:text-foreground/70 underline underline-offset-4 shrink-0"
      >
        {t.apiKeys.docsLinkLabel}
      </Link>
    </div>
  );
}

function McpEndpointPanel({ assistantId, t }: { assistantId: string; t: Dictionary }) {
  const [copied, setCopied] = useState(false);
  const endpoint = `${DISPLAY_API_URL}/api/v1/assistants/${assistantId}/mcp`;

  async function copy() {
    try {
      await navigator.clipboard.writeText(endpoint);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Fall through — user can select & copy manually
    }
  }

  return (
    <div className="border border-border rounded-lg px-4 py-3">
      <div className="text-[13px] text-muted-foreground">{t.apiKeys.mcpEndpointTitle}</div>
      <div className="mt-1 flex items-center gap-2 flex-wrap">
        <code className="font-mono text-[12px] bg-muted border border-border rounded px-2 py-1 break-all">
          {endpoint}
        </code>
        <button
          type="button"
          onClick={copy}
          className="text-[12px] text-muted-foreground hover:text-foreground transition-colors px-2 py-1"
        >
          {copied ? t.apiKeys.copiedAssistantId : t.apiKeys.copyAssistantId}
        </button>
      </div>
      <p className="text-[12px] text-muted-foreground mt-2">{t.apiKeys.mcpEndpointDesc}</p>
      <p className="text-[12px] text-muted-foreground mt-1">{t.apiKeys.mcpEndpointScopeNote}</p>
    </div>
  );
}

function ScopeBadge({ scope, t }: { scope: ApiKeyScope; t: Dictionary }) {
  const label = scope === "agent" ? t.apiKeys.scopeBadgeAgent : t.apiKeys.scopeBadgeChat;
  return (
    <span className="text-[11px] uppercase tracking-wide text-muted-foreground border border-border rounded px-1.5 py-0.5">
      {label}
    </span>
  );
}

function KeyRow({
  row,
  t,
  onRevoke,
  onRotate,
}: {
  row: ApiKeyRow;
  t: Dictionary;
  onRevoke?: () => void;
  onRotate?: () => void;
}) {
  const isRevoked = row.status === "revoked";
  return (
    <li className="px-4 py-3 flex items-center gap-4">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className={`text-[14px] font-medium truncate ${isRevoked ? "text-muted-foreground line-through" : ""}`}>
            {row.name}
          </span>
          <ScopeBadge scope={rowScope(row)} t={t} />
          {isRevoked && (
            <span className="text-[11px] uppercase tracking-wide text-muted-foreground border border-border rounded px-1.5 py-0.5">
              {t.apiKeys.statusRevoked}
            </span>
          )}
        </div>
        <div className="text-[12px] text-muted-foreground mt-0.5 font-mono">
          {row.prefix}…
        </div>
      </div>
      <div className="text-[12px] text-muted-foreground tabular-nums w-28 text-right">
        {relative(row.lastUsedAt, t)}
      </div>
      <div className="text-[12px] text-muted-foreground tabular-nums w-24 text-right">
        {formatDate(row.createdAt)}
      </div>
      {!isRevoked && (
        <div className="flex items-center gap-2">
          {onRotate && (
            <button
              onClick={onRotate}
              title={t.apiKeys.rotateTitle}
              className="text-[12px] text-muted-foreground hover:text-foreground transition-colors px-2 py-1"
            >
              {t.apiKeys.rotate}
            </button>
          )}
          {onRevoke && (
            <button
              onClick={onRevoke}
              className="text-[12px] text-red-500 hover:text-red-400 transition-colors px-2 py-1"
            >
              {t.apiKeys.revoke}
            </button>
          )}
        </div>
      )}
    </li>
  );
}

function CreateKeyForm({
  defaultName,
  assistantId,
  onCancel,
  onCreated,
}: {
  defaultName: string;
  assistantId: string;
  onCancel: () => void;
  onCreated: (created: CreatedKey) => void;
}) {
  const t = useT();
  const [name, setName] = useState(defaultName);
  const [scope, setScope] = useState<ApiKeyScope>("chat");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const r = await authFetch(`${API_URL}/api/assistants/${assistantId}/integrations/api-keys`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), scope }),
      });
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error ?? `HTTP ${r.status}`);
      }
      const created = (await r.json()) as CreatedKey;
      onCreated(created);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4 max-w-md">
      <header>
        <h2 className="text-[15px] font-semibold tracking-tight">{t.apiKeys.create.title}</h2>
        <p className="text-[13px] text-muted-foreground mt-1">{t.apiKeys.create.description}</p>
      </header>

      <div role="radiogroup" aria-label={t.apiKeys.scopeLabel} className="space-y-2">
        <span className="text-[13px] text-muted-foreground">{t.apiKeys.scopeLabel}</span>
        <ScopeCard
          selected={scope === "chat"}
          label={t.apiKeys.scopeChatLabel}
          description={t.apiKeys.scopeChatDesc}
          disabled={submitting}
          onSelect={() => setScope("chat")}
        />
        <ScopeCard
          selected={scope === "agent"}
          label={t.apiKeys.scopeAgentLabel}
          description={t.apiKeys.scopeAgentDesc}
          disabled={submitting}
          onSelect={() => setScope("agent")}
        />
      </div>

      <label className="block">
        <span className="text-[13px] text-muted-foreground">{t.apiKeys.create.nameLabel}</span>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t.apiKeys.create.placeholder}
          maxLength={120}
          className="mt-1 w-full bg-background border border-border rounded-lg px-3 py-2 text-[14px] focus:outline-none focus:ring-2 focus:ring-primary/40"
        />
      </label>

      {error && (
        <div className="text-[13px] text-red-500 border border-red-500/30 rounded-lg px-3 py-2">
          {error}
        </div>
      )}

      <div className="flex gap-2">
        <Button type="submit" disabled={!name.trim() || submitting}>
          {submitting ? t.apiKeys.create.submitting : t.apiKeys.create.submit}
        </Button>
        <Button type="button" variant="outline" onClick={onCancel} disabled={submitting}>
          {t.apiKeys.create.cancel}
        </Button>
      </div>
    </form>
  );
}

function ScopeCard({
  selected,
  label,
  description,
  disabled,
  onSelect,
}: {
  selected: boolean;
  label: string;
  description: string;
  disabled?: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      disabled={disabled}
      onClick={onSelect}
      className={`w-full text-left border rounded-lg px-3 py-2.5 transition-colors focus:outline-none focus:ring-2 focus:ring-primary/40 disabled:opacity-60 ${
        selected
          ? "border-primary/60 bg-muted"
          : "border-border hover:border-foreground/30"
      }`}
    >
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          className={`size-3 shrink-0 rounded-full border ${
            selected ? "border-primary bg-primary" : "border-border bg-background"
          }`}
        />
        <span className="text-[14px] font-medium">{label}</span>
      </div>
      <p className="text-[12px] text-muted-foreground mt-1 pl-5">{description}</p>
    </button>
  );
}

function RevealKeyView({
  created,
  assistantId,
  onAcknowledge,
}: {
  created: CreatedKey;
  assistantId: string;
  onAcknowledge: () => void;
}) {
  const t = useT();
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(created.key);
      setCopied(true);
    } catch {
      // Fall through — user can select & copy manually
    }
  }

  return (
    <div className="space-y-4 max-w-2xl">
      <header className="flex items-center gap-2 flex-wrap">
        <h2 className="text-[15px] font-semibold tracking-tight">
          {format(t.apiKeys.reveal.title, { name: created.name })}
        </h2>
        <ScopeBadge scope={rowScope(created)} t={t} />
      </header>

      <div className="border border-red-500/40 bg-red-500/5 rounded-lg px-4 py-3">
        <p className="text-[13px] text-red-400 font-medium">{t.apiKeys.reveal.bannerHeading}</p>
        <p className="text-[12px] text-red-400/80 mt-1">{t.apiKeys.reveal.bannerBody}</p>
      </div>

      <div className="space-y-2">
        <span className="text-[13px] text-muted-foreground">{t.apiKeys.reveal.keyLabel}</span>
        <div className="flex items-stretch gap-2">
          <code className="flex-1 bg-muted rounded-lg px-3 py-2 text-[13px] font-mono break-all border border-border">
            {created.key}
          </code>
          <Button type="button" onClick={copy} className="shrink-0">
            {copied ? t.apiKeys.reveal.copied : t.apiKeys.reveal.copy}
          </Button>
        </div>
      </div>

      <div className="text-[12px] text-muted-foreground">
        {t.apiKeys.reveal.usageHintPrefix}
        <code className="bg-muted px-1 py-0.5 rounded">
          {format(t.apiKeys.reveal.usageHintAuth, { prefix: created.key.slice(0, 18) })}
        </code>
        {t.apiKeys.reveal.usageHintMid}
        <code className="bg-muted px-1 py-0.5 rounded">
          {format(t.apiKeys.reveal.usageHintEndpoint, { id: assistantId })}
        </code>
        {t.apiKeys.reveal.usageHintSuffix}
      </div>

      <div>
        <Button onClick={onAcknowledge} disabled={!copied} variant={copied ? "default" : "outline"}>
          {copied ? t.apiKeys.reveal.acknowledge : t.apiKeys.reveal.acknowledgeWaiting}
        </Button>
      </div>
    </div>
  );
}
