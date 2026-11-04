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
 * Visual language follows the modern Studio sections (Knowledge / Channels):
 * `rounded-xl bg-card` cards with icon tiles, pill badges, and uppercase
 * section headers — see those pages for the reference styling.
 *
 * Backed by the already-ported `lib/api/brain-keys.ts` +
 * `lib/api/oauth-authorizations.ts`. Scoped to the route workspace via
 * `useWorkspaces().activeId` (`[COMP:app-web/workspaces-adapter]`).
 *
 * Spec: docs/architecture/features/programmatic-access.md.
 * [COMP:app-web/studio-programmatic-access]
 */

import { ProgrammaticAccessShell } from "@/components/studio/programmatic-access-shell";
import {invalidateSurfaceCache} from "@/lib/surface-cache";
import { useCallback, useState } from "react";
import {
  AppWindow,
  Check,
  ChevronDown,
  Copy,
  KeyRound,
  TriangleAlert,
} from "lucide-react";
import { useWorkspaces } from "@/contexts/workspace-context";
import { Button } from "@/components/ui/button";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { RailSurfaceSkeleton } from "@/components/chrome/surface-skeleton";
import { isPhoneViewport } from "@/lib/viewport";
import { useBrainKeysData } from "./use-brain-keys-data";
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
  revokeBrainKey,
  updateBrainKeyCaptureBinding,
  updateBrainKeyMaxClearance,
  type BrainKey,
  type BrainKeyClearance,
  type BrainKeyScope,
  type CreatedBrainKey,
} from "@/lib/api/brain-keys";
import {
  revokeOAuthAuthorization,
  updateOAuthCaptureBinding,
  type OAuthAuthorization,
} from "@/lib/api/oauth-authorizations";
import { ContextScopePicker } from "@/components/context/context-scope-picker";
import { ContextScopeChips } from "@/components/context/context-scope-chips";
import type { ContextProject, ContextTeam } from "@/lib/api/context-scopes";
import type { StudioAssistantSummary } from "@/lib/api/studio";
import type { CaptureProfile } from "@/lib/api/programmatic-capture";

type Mode =
  | { kind: "list" }
  | { kind: "creating" }
  | { kind: "revealed"; created: CreatedBrainKey };

/** Select sentinel for "no cap" — base-ui Select values must be strings. */
const CLEARANCE_FOLLOWS_PRIMARY = "primary";
const CAPTURE_NONE = "capture-none";
const CAPTURE_INHERIT = "capture-inherit";

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
  const { activeId } = useWorkspaces();
  return <ProgrammaticAccessShell active="connections"><Connections key={activeId} /></ProgrammaticAccessShell>;
}

function Connections() {
  const t = useT();
  const { activeId } = useWorkspaces();
  // Every list the page paints (keys, OAuth authorizations, context scopes,
  // assistants, capture profiles) lands in ONE cached key (instant-navigation
  // N1 / N7): a revisit paints on the first frame; the page's optimistic
  // edits write through it. `adminOnly` is the backend's 403.
  const {
    data,
    adminOnly,
    error: loadError,
    refresh: load,
    update,
  } = useBrainKeysData(activeId);
  const keys = data?.keys ?? null;
  const authorizations = data?.authorizations ?? null;
  const teams = data?.teams ?? [];
  const projects = data?.projects ?? [];
  const assistants = data?.assistants ?? [];
  const captureProfiles = data?.captureProfiles ?? [];
  const [mode, setMode] = useState<Mode>({ kind: "list" });
  const [showRevoked, setShowRevoked] = useState(false);
  // A failed ACTION (revoke, cap change); a failed first load reports through
  // `loadError` from the hook.
  const [actionError, setError] = useState<string | null>(null);
  const error = actionError ?? loadError;

  const setKeys = useCallback(
    (updater: (prev: BrainKey[]) => BrainKey[]) => {
      update((prev) => ({ ...prev, keys: updater(prev.keys) }));
    },
    [update],
  );
  const setAuthorizations = useCallback(
    (updater: (prev: OAuthAuthorization[]) => OAuthAuthorization[]) => {
      update((prev) => ({ ...prev, authorizations: updater(prev.authorizations) }));
    },
    [update],
  );
  const changeMaxClearance = useCallback(
    async (keyId: string, next: BrainKeyClearance | null) => {
      if (!activeId) return;
      // Optimistic: reflect the new cap immediately, reload on failure.
      setKeys((prev) =>
        prev.map((x) => (x.id === keyId ? { ...x, maxClearance: next } : x)),
      );
      try {
        await updateBrainKeyMaxClearance(activeId, keyId, next);
      } catch (err) {
        setError((err as Error).message);
        load();
      }
    },
    [activeId, load, setKeys],
  );

  if (mode.kind === "creating" && activeId) {
    return (
      <CreateKeyForm
        workspaceId={activeId}
        teams={teams}
        projects={projects}
        onCancel={() => setMode({ kind: "list" })}
        onCreated={(created) => {
          setMode({ kind: "revealed", created });
          // Optimistically prepend so the key is in the list after dismissing.
          setKeys((prev) => [created, ...prev]);
        }}
      />
    );
  }

  if (mode.kind === "revealed") {
    return <RevealKeyView created={mode.created} onAcknowledge={() => setMode({ kind: "list" })} />;
  }

  const activeKeys = (keys ?? []).filter((k) => k.status === "active");
  const revokedKeys = (keys ?? []).filter((k) => k.status === "revoked");
  // Cold: nothing cached for this workspace yet. The endpoint panel is static
  // and paints regardless; the lists below hold their geometry with a
  // skeleton (N4) until the first snapshot lands.
  const cold = data === undefined && !adminOnly && !loadError;

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

      {cold && <RailSurfaceSkeleton chrome={false} padded={false} rows={4} />}

      {!adminOnly && data && (
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

          {activeKeys.length === 0 ? (
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
                  teams={teams}
                  projects={projects}
                  assistants={assistants}
                  captureProfiles={captureProfiles}
                  onChangeCaptureBinding={async (assistantId, profileId) => {
                    if (!activeId) return;
                    setKeys((prev) => prev.map((row) => row.id === k.id
                      ? { ...row, captureAssistantId: assistantId, captureProfileId: profileId }
                      : row));
                    try {
                      await updateBrainKeyCaptureBinding(activeId, k.id, assistantId, profileId);
                      invalidateSurfaceCache(`engineering-history:${activeId}`);
                    } catch (err) {
                      setError((err as Error).message);
                      load();
                    }
                  }}
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
                      invalidateSurfaceCache(`engineering-history:${activeId}`);
                      setKeys((prev) =>
                        prev.map((x) =>
                          x.id === k.id ? { ...x, status: "revoked" as const } : x,
                        ),
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
                  <KeyRow
                    key={k.id}
                    row={k}
                    t={t}
                    teams={teams}
                    projects={projects}
                    assistants={assistants}
                    captureProfiles={captureProfiles}
                  />
                ))}
              </ul>
            </details>
          )}
        </section>
      )}

      {!adminOnly && data && (
        <ConnectedAppsSection
          authorizations={authorizations}
          assistants={assistants}
          captureProfiles={captureProfiles}
          onChangeCaptureBinding={async (auth, assistantId, profileId) => {
            if (!activeId) return;
            setAuthorizations((prev) => prev.map((row) => row.id === auth.id
              ? { ...row, captureAssistantId: assistantId, captureProfileId: profileId }
              : row));
            try {
              await updateOAuthCaptureBinding(activeId, auth.id, assistantId, profileId);
            } catch (err) {
              setError((err as Error).message);
              load();
            }
          }}
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
              setAuthorizations((prev) =>
                prev.map((x) =>
                  x.id === auth.id ? { ...x, status: "revoked" as const } : x,
                ),
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
  assistants,
  captureProfiles,
  onChangeCaptureBinding,
  onRevoke,
}: {
  authorizations: OAuthAuthorization[] | null;
  assistants: StudioAssistantSummary[];
  captureProfiles: CaptureProfile[];
  onChangeCaptureBinding: (
    auth: OAuthAuthorization,
    assistantId: string | null,
    profileId: string | null,
  ) => void;
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
        <RailSurfaceSkeleton chrome={false} padded={false} rows={2} />
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
            <ConnectedAppRow
              key={auth.id}
              auth={auth}
              assistants={assistants}
              captureProfiles={captureProfiles}
              onChangeCaptureBinding={(assistantId, profileId) =>
                onChangeCaptureBinding(auth, assistantId, profileId)}
              onRevoke={() => onRevoke(auth)}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function ConnectedAppRow({
  auth,
  assistants,
  captureProfiles,
  onChangeCaptureBinding,
  onRevoke,
}: {
  auth: OAuthAuthorization;
  assistants: StudioAssistantSummary[];
  captureProfiles: CaptureProfile[];
  onChangeCaptureBinding: (assistantId: string | null, profileId: string | null) => void;
  onRevoke: () => void;
}) {
  const t = useT();
  const name = auth.clientName ?? t.programmaticAccess.connectedApps.unnamedClient;
  return (
    <li className="px-4 py-3.5 flex flex-wrap items-center gap-3">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
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
      <CaptureBindingControl
        assistantId={auth.captureAssistantId}
        profileId={auth.captureProfileId}
        assistants={assistants}
        profiles={captureProfiles}
      />
      <MetaCell value={relative(auth.lastUsedAt, t)} label={t.programmaticAccess.lastUsedLabel} />
      <MetaCell value={formatDate(auth.createdAt)} label={t.programmaticAccess.createdLabel} />
      <details className="group w-full border-t border-border pt-1">
        <summary className="flex min-h-8 max-sm:min-h-11 cursor-pointer items-center text-sm font-medium focus-visible:outline-2 focus-visible:outline-ring">{t.programmaticAccess.navigation.manage}<ChevronDown aria-hidden className="ml-auto size-4 transition-transform group-open:rotate-180" /></summary>
        <div className="flex flex-wrap items-center gap-3 pb-2">
          <CaptureBindingControl assistantId={auth.captureAssistantId} profileId={auth.captureProfileId} assistants={assistants} profiles={captureProfiles} onChange={onChangeCaptureBinding} />
      <button
        onClick={onRevoke}
        className="min-h-8 max-sm:min-h-11 text-xs font-medium border border-border px-2.5 py-1 focus-visible:outline-2 focus-visible:outline-ring rounded-lg text-muted-foreground hover:text-destructive hover:border-destructive/30 transition-colors shrink-0"
      >
        {t.programmaticAccess.connectedApps.revoke}
      </button>
        </div>
      </details>
    </li>
  );
}

// ── Subcomponents ──────────────────────────────────────────────

/** Right-aligned meta column — value with a tiny label underneath, so the
 *  two dates in a row read unambiguously (Last used vs Created). Below `sm`
 *  the column becomes a "label: value" line stacked under the name (M1:
 *  never hidden with no alternative). */
function MetaCell({ value, label }: { value: string; label: string }) {
  return (
    <div className="order-last flex w-full items-baseline gap-1.5 pl-12 sm:order-none sm:w-28 sm:shrink-0 sm:flex-col sm:items-end sm:gap-0 sm:pl-0">
      <span className="order-first text-[10px] uppercase tracking-wide text-muted-foreground/70 sm:order-none">
        {label}
      </span>
      <span className="text-[12px] tabular-nums">{value}</span>
    </div>
  );
}

/** Always-visible connection info — the MCP endpoint URL an external client
 *  (Claude Desktop, ChatGPT, …) points at, authenticating with a key from the
 *  list below. */
function EndpointPanel({ t }: { t: Dictionary }) {
  const [copied, setCopied] = useState(false);
  return (
    <section className="rounded-xl border border-border bg-card p-4">
      <h2 className="mb-2 text-sm font-medium">{t.programmaticAccess.navigation.endpoint}</h2>
      <div>
        <div className="flex items-center gap-1.5 rounded-lg bg-muted/50 py-1 pl-3 pr-1">
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
            className="inline-flex min-h-8 max-sm:min-h-11 shrink-0 items-center gap-1 rounded-md px-3 py-1 focus-visible:outline-2 focus-visible:outline-ring text-[12px] font-medium text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          >
            {copied ? (
              <Check className="h-3.5 w-3.5 text-foreground" />
            ) : (
              <Copy className="h-3.5 w-3.5" />
            )}
            {copied ? t.programmaticAccess.copiedEndpoint : t.programmaticAccess.copyEndpoint}
          </button>
        </div>
      </div>

      <details className="group mt-2 text-xs text-muted-foreground">
        <summary className="flex min-h-8 max-sm:min-h-11 cursor-pointer items-center font-medium hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">{t.programmaticAccess.navigation.instructions}<ChevronDown aria-hidden className="ml-2 size-3.5 transition-transform group-open:rotate-180" /></summary>
        <div className="space-y-2 pb-2 leading-relaxed">
          <p>{t.programmaticAccess.endpointHint}</p>
          <p>{t.programmaticAccess.clearanceExplainer}</p>
        </div>
      </details>
    </section>
  );
}

function ScopeBadge({ scope, t }: { scope: BrainKeyScope; t: Dictionary }) {
  const readWrite = scope !== "read";
  return (
    <span
      className={cn(
        "shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium",
        readWrite ? "bg-muted text-muted-foreground" : "bg-muted text-muted-foreground",
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
        className="text-[16px] md:text-[11px] text-muted-foreground"
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

function CaptureBindingControl({
  assistantId,
  profileId,
  assistants,
  profiles,
  onChange,
}: {
  assistantId: string | null;
  profileId: string | null;
  assistants: StudioAssistantSummary[];
  profiles: CaptureProfile[];
  onChange?: (assistantId: string | null, profileId: string | null) => void;
}) {
  const t = useT();
  if (!onChange) {
    const assistant = assistants.find((row) => row.id === assistantId);
    const profile = profiles.find((row) => row.id === profileId);
    if (!assistant) return null;
    return (
      <div className="order-last w-full pl-12 text-[11px] text-muted-foreground lg:order-none lg:w-auto lg:max-w-44 lg:pl-0 lg:text-right">
        <div className="truncate">{assistant.name}</div>
        <div className="truncate">{profile?.name ?? t.programmaticAccess.capture.inherit}</div>
      </div>
    );
  }
  const assistantItems = Object.fromEntries([
    [CAPTURE_NONE, t.programmaticAccess.capture.noCapture],
    ...assistants.map((assistant) => [assistant.id, assistant.name]),
  ]);
  const profileItems = Object.fromEntries([
    [CAPTURE_INHERIT, t.programmaticAccess.capture.inherit],
    ...profiles.map((profile) => [profile.id, profile.name]),
  ]);
  return (
    <div className="order-last flex w-full shrink-0 flex-col gap-1 pl-12 lg:order-none lg:w-48 lg:pl-0">
      <Select
        value={assistantId ?? CAPTURE_NONE}
        items={assistantItems}
        onValueChange={(value) => {
          if (!value) return;
          onChange(value === CAPTURE_NONE ? null : value, value === CAPTURE_NONE ? null : profileId);
        }}
      >
        <SelectTrigger className="min-h-8 max-sm:min-h-11" size="sm" aria-label={t.programmaticAccess.capture.connectionAssistant}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={CAPTURE_NONE}>{t.programmaticAccess.capture.noCapture}</SelectItem>
          {assistants.map((assistant) => (
            <SelectItem key={assistant.id} value={assistant.id}>{assistant.name}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select
        value={profileId ?? CAPTURE_INHERIT}
        items={profileItems}
        disabled={!assistantId}
        onValueChange={(value) => {
          if (!value || !assistantId) return;
          onChange(assistantId, value === CAPTURE_INHERIT ? null : value);
        }}
      >
        <SelectTrigger className="min-h-8 max-sm:min-h-11" size="sm" aria-label={t.programmaticAccess.capture.connectionProfile}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={CAPTURE_INHERIT}>{t.programmaticAccess.capture.inherit}</SelectItem>
          {profiles.map((profile) => (
            <SelectItem key={profile.id} value={profile.id}>{profile.name}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function KeyRow({
  row,
  t,
  onRevoke,
  onChangeMaxClearance,
  teams,
  projects,
  assistants,
  captureProfiles,
  onChangeCaptureBinding,
}: {
  row: BrainKey;
  t: Dictionary;
  onRevoke?: () => void;
  onChangeMaxClearance?: (next: BrainKeyClearance | null) => void;
  teams: ContextTeam[];
  projects: ContextProject[];
  assistants: StudioAssistantSummary[];
  captureProfiles: CaptureProfile[];
  onChangeCaptureBinding?: (assistantId: string | null, profileId: string | null) => void;
}) {
  const isRevoked = row.status === "revoked";
  return (
    <li className="px-4 py-3.5 flex flex-wrap items-center gap-3">
      <div
        className={cn(
          "flex h-9 w-9 shrink-0 items-center justify-center rounded-lg",
          isRevoked ? "bg-muted text-muted-foreground" : "bg-muted text-muted-foreground",
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
          />
          {isRevoked && (
            <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
              {t.programmaticAccess.statusRevoked}
            </span>
          )}
        </div>
        <div className="text-[12px] text-muted-foreground mt-0.5 font-mono">{row.prefix}…</div>
        <div className="mt-1.5">
          <ContextScopeChips
            teamId={row.contextGroupId}
            projectId={row.contextProjectId}
            teams={teams}
            projects={projects}
          />
        </div>
      </div>
      <CaptureBindingControl
        assistantId={row.captureAssistantId}
        profileId={row.captureProfileId}
        assistants={assistants}
        profiles={captureProfiles}
      />
      <MetaCell value={relative(row.lastUsedAt, t)} label={t.programmaticAccess.lastUsedLabel} />
      <MetaCell value={formatDate(row.createdAt)} label={t.programmaticAccess.createdLabel} />
      {!isRevoked && <details className="group w-full border-t border-border pt-1">
        <summary className="flex min-h-8 max-sm:min-h-11 cursor-pointer items-center text-sm font-medium focus-visible:outline-2 focus-visible:outline-ring">{t.programmaticAccess.navigation.manage}<ChevronDown aria-hidden className="ml-auto size-4 transition-transform group-open:rotate-180" /></summary>
        <div className="flex flex-wrap items-center gap-3 pb-2">
          <ClearanceCapControl value={row.maxClearance} t={t} onChange={onChangeMaxClearance} />
          <CaptureBindingControl assistantId={row.captureAssistantId} profileId={row.captureProfileId} assistants={assistants} profiles={captureProfiles} onChange={onChangeCaptureBinding} />
      {!isRevoked && onRevoke && (
        <button
          onClick={onRevoke}
          className="min-h-8 max-sm:min-h-11 text-xs font-medium border border-border px-2.5 py-1 focus-visible:outline-2 focus-visible:outline-ring rounded-lg text-muted-foreground hover:text-destructive hover:border-destructive/30 transition-colors shrink-0"
        >
          {t.programmaticAccess.revoke}
        </button>
      )}
        </div>
      </details>}
    </li>
  );
}

function CreateKeyForm({
  workspaceId,
  teams,
  projects,
  onCancel,
  onCreated,
}: {
  workspaceId: string;
  teams: ContextTeam[];
  projects: ContextProject[];
  onCancel: () => void;
  onCreated: (created: CreatedBrainKey) => void;
}) {
  const t = useT();
  const [name, setName] = useState("");
  const [scope, setScope] = useState<BrainKeyScope>("read_write");
  const [maxClearance, setMaxClearance] = useState<BrainKeyClearance | null>(null);
  const [contextGroupId, setContextGroupId] = useState<string | null>(null);
  const [contextProjectId, setContextProjectId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      onCreated(
        await createBrainKey(workspaceId, {
          name: name.trim(),
          scope,
          maxClearance,
          contextGroupId,
          contextProjectId,
        }),
      );
    } catch (err) {
      setError(createKeyErrorMessage(t, (err as Error).message));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit} className="max-w-lg flex flex-col gap-4">
      <header className="flex items-start gap-3">
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
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
            autoFocus={!isPhoneViewport()}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t.programmaticAccess.create.placeholder}
            maxLength={120}
            className="w-full bg-muted/50 border border-border rounded-lg px-3 py-2 text-[16px] md:text-[14px] focus:outline-none focus:ring-2 focus:ring-ring"
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
                    ? "border-foreground/40 bg-muted"
                    : "border-border hover:bg-muted/50",
                )}
              >
                <input
                  type="radio"
                  name="scope"
                  value={value}
                  checked={scope === value}
                  onChange={() => setScope(value)}
                  className="mt-0.5 accent-foreground"
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

        <div className="flex flex-col gap-1.5">
          <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
            {t.programmaticAccess.create.contextLabel}
          </span>
          <p className="text-[12px] text-muted-foreground">
            {t.programmaticAccess.create.contextHint}
          </p>
          <ContextScopePicker
            teams={teams}
            projects={projects}
            teamId={contextGroupId}
            projectId={contextProjectId}
            onTeamChange={setContextGroupId}
            onProjectChange={setContextProjectId}
            disabled={submitting}
          />
        </div>

        {error && (
          <div className="text-[12px] text-destructive bg-destructive/10 rounded-lg px-3 py-2">
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
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
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

/** Name the cause of a refused create instead of rendering the API's code. */
function createKeyErrorMessage(t: ReturnType<typeof useT>, code: string): string {
  if (code === "context_activation_blocked") return t.programmaticAccess.createBlockedEnforcement;
  if (code === "context_not_available") return t.programmaticAccess.createContextUnavailable;
  return code;
}
