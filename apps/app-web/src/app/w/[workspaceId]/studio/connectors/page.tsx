"use client";

/**
 * Studio -> Connectors (app-web) — the master-detail connectors surface.
 *
 * Ported from `apps/web/src/app/(app)/studio/connectors/page.tsx`
 * (app consolidation §9 #5), redesigned 2026-06-11 from a one-at-a-time
 * accordion into a master-detail: a rail grouping every connector by sharing
 * state (Shared with workspace / Personal / Available; the first two merge
 * into "Connected" in a solo workspace — `lib/connector-groups.ts`; plus an
 * always-on Built-in group for first-party workspace primitives like
 * Workspace Files, which carry no connect/disconnect state), with the
 * selected connector's management panel beside it. Every connector is
 * personal; connecting one auto-exposes it to the active shared workspace,
 * and the detail panel's "Workspace access" card states the sharing status
 * explicitly (incl. the solo-workspace explainer). See
 * docs/architecture/integrations/mcp.md → "Unified connectors — the
 * master-detail Studio surface".
 *
 * app-web deltas vs apps/web:
 *   - `active` comes from the app-web `useWorkspaces()` adapter (route-
 *     derived id + fetched workspace list); the Studio layout mounts
 *     `useWorkspaceFetch` so `active.memberCount` resolves (the share
 *     control gates on shared-vs-solo, keyed on member count).
 *   - The per-assistant-permissions link is workspace-scoped
 *     (`/w/[workspaceId]/studio/assistants?...`).
 *   - `OFFICIAL_OAUTH_SCOPES` is the local mirror (app-web has no
 *     `@sidanclaw/shared` dep). Every user-facing string flows through
 *     `useT()`.
 *
 * INFRA NOTE (degraded — connector OAuth): the OAuth connect paths build the
 * provider authorize URL client-side from `NEXT_PUBLIC_GOOGLE_CLIENT_ID` /
 * `NEXT_PUBLIC_NOTION_CLIENT_ID` / `NEXT_PUBLIC_FATHOM_CLIENT_ID` and rely on
 * the server callback routes `/api/auth/callback/{google-connector,notion,
 * fathom}`. Those callbacks ARE ported (workspace-aware via `state`), but the
 * `NEXT_PUBLIC_*` client ids + the matching server secrets are not yet set in
 * app-web's environment. PAT connectors (GitHub) and custom MCP servers
 * need no OAuth and work today. See `degraded` in the chunk report for the
 * exact env vars still required.
 *
 * Rendered inside the Studio full-page layout, NOT the doc three-column
 * page shell (consolidation §9 #5).
 *
 * [COMP:app-web/studio-connectors]
 */

import { useState, useEffect, useCallback, useRef } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Check, Pencil, X } from "lucide-react";
import { authFetch } from "@/lib/auth-fetch";
import { BrowseDirectory } from "./browse-directory";
import { DrivePicker, type PickedFile } from "@/components/drive-picker";
import { ConnectorToolList, type ToolPolicy } from "@/components/connectors/connector-tool-list";
import { ConnectorIcon } from "@/components/connectors/connector-icon";
import { AddConnectorMenu } from "@/components/connectors/add-connector-menu";
import { PreflightHeadersSection } from "@/components/connectors/preflight-headers-section";
import { readPreflightHeaders } from "@/lib/connector-preflight-headers";
import { ActorIdentityToggle } from "@/components/connectors/actor-identity-toggle";
import { useWorkspaces } from "@/contexts/workspace-context";
import { isSharedWorkspace } from "@/lib/workspace-permissions";
import { groupConnectors } from "@/lib/connector-groups";
import { cn } from "@/lib/utils";
import { OFFICIAL_OAUTH_SCOPES, type ConnectorAuthType } from "@sidanclaw/shared/builtin-connectors";
import { BUILTIN_PRIMITIVE_CONNECTOR_IDS } from "@sidanclaw/shared/connector-registry";
import { useT } from "@/lib/i18n/client";
import { resolveAutoExpose } from "@/lib/connector-auto-expose";
import {
  buildCustomConnectorPayload,
  type ConnectorAuthFormError,
  type CurrentConnectorAuth,
} from "@/lib/connector-auth-form";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
const GOOGLE_CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ?? "";
const NOTION_CLIENT_ID = process.env.NEXT_PUBLIC_NOTION_CLIENT_ID ?? "";
const FATHOM_CLIENT_ID = process.env.NEXT_PUBLIC_FATHOM_CLIENT_ID ?? "";
const FATHOM_AUTHORIZE_URL =
  process.env.NEXT_PUBLIC_FATHOM_AUTHORIZE_URL ??
  "https://fathom.video/oauth2/authorize";

/**
 * Frontend shortcut: build the OAuth authorize URL client-side when the page
 * needs to redirect directly. The backend `POST /connectors/:id/connect`
 * returns the same URL (with `userinfo.email` prepended) — use it when the
 * request already has an auth context.
 */
const OAUTH_SCOPES_WITH_EMAIL: Record<string, string[]> = Object.fromEntries(
  Object.entries(OFFICIAL_OAUTH_SCOPES).map(([id, scopes]) => [
    id,
    ["https://www.googleapis.com/auth/userinfo.email", ...scopes],
  ]),
);

/** Connectors that authenticate via a Personal Access Token (not OAuth). */
const PAT_CONNECTORS = new Set(["github"]);

/**
 * First-party workspace primitives (Workspace Files). Always-on — no
 * connect/disconnect, no account, tools gated by assistant capabilities at
 * runtime. Rendered in the rail's Built-in group with an "Always on" pill.
 * Derived from the registry (never a hardcoded slug list); the `custom`
 * guard keeps a slug-colliding custom MCP row out of the bucket.
 */
function isBuiltinPrimitive(c: { id: string; custom?: boolean }): boolean {
  return !c.custom && BUILTIN_PRIMITIVE_CONNECTOR_IDS.has(c.id);
}

/** Built-in connectors that have a configurable settings tab. */
const CONFIGURABLE_CONNECTORS = new Set(["gcal", "gdrive"]);

type Connector = {
  id: string;
  /**
   * The connector_instance UUID — distinct from `id`, the provider slug.
   * Workspace-expose / grant calls key on this. Absent only for
   * never-connected built-in placeholders.
   */
  connectorInstanceId?: string;
  name: string;
  /** Per-instance, user-editable nickname (defaults to the provider name). */
  label?: string;
  /** Oldest instance of this provider — keeps canonical tools at runtime. */
  isPrimary?: boolean;
  /** Whether the user can connect ANOTHER instance of this provider. */
  addable?: boolean;
  /** A built-in provider with no instance yet (the bare connect affordance). */
  isPlaceholder?: boolean;
  description?: string;
  connected: boolean;
  /**
   * Liveness (migration 294). "auth_failed" means the credentials stopped
   * working (a 401/403 at call time) and the connector needs reconnecting even
   * though `connected` is still true - drives the "Reconnect needed" state.
   */
  healthStatus?: "ok" | "auth_failed" | "unknown";
  custom?: boolean;
  url?: string;
  oauthRequired?: boolean;
  icon_url?: string;
  category?: "official" | "community";
  connectedEmail?: string;
  /**
   * Tracks which OAuth scope revision was used when the user last connected.
   * `gdrive` migrated from documents+spreadsheets+presentations to
   * `drive.file` + Picker (scopeVersion = 2). Unset / older values on a
   * connected row mean the user needs to reconnect to use the new flow.
   */
  scopeVersion?: number;
  /** Custom connectors only — how outbound MCP calls authenticate. */
  authType?: ConnectorAuthType;
  /** Custom-header connectors only — the non-secret header name. */
  authHeaderName?: string;
  /**
   * Read-only workspace-shared row — a connector available to you in this
   * workspace that you do NOT own (a teammate exposed it, or a legacy
   * team-native instance). No manage/connect/remove affordances; credentials
   * never leave the server. Set by the backend's "Available in this workspace"
   * list.
   */
  readonly?: boolean;
  /** Read-only rows only — how it reaches you: 'granted' | 'team_native'. */
  source?: "granted" | "team_native";
  /** Read-only granted rows only — display name of the member who shared it. */
  sharedBy?: string | null;
};

/** Current scope revision for each OAuth connector. Bump when scopes change. */
const CURRENT_SCOPE_VERSION: Record<string, number> = {
  gdrive: 2,
};

type ToolPermission = {
  name: string;
  description: string;
  classification: "read" | "write" | "destructive" | "unknown";
  policy: "allow" | "ask" | "block";
};

function getTransportLabel(url?: string): string {
  if (!url) return "";
  if (url.endsWith("/sse") || url.includes("/sse?")) return "SSE";
  if (url.endsWith("/mcp") || url.includes("/mcp?")) return "Streamable HTTP";
  return "HTTP";
}

/**
 * Stable per-row identity. With multi-instance, several rows share the same
 * provider slug (`id`), so UI state (expanded / connecting) and optimistic
 * updates key on the connector_instance UUID when present, falling back to the
 * slug for never-connected built-in placeholders.
 */
function rowId(c: { connectorInstanceId?: string; id: string }): string {
  return c.connectorInstanceId ?? c.id;
}

/** True when `x` is the same row as `c` (instance UUID if known, else slug). */
function isSameRow(x: Connector, c: Connector): boolean {
  return c.connectorInstanceId
    ? x.connectorInstanceId === c.connectorInstanceId
    : x.id === c.id && !x.connectorInstanceId;
}

// ── Google Drive authorized files ──────────────────────────────
//
// Under the drive.file scope the assistant can only touch files the user has
// explicitly picked. This panel shows the picked set and lets the user add
// more (via the Google Picker) or remove access to individual files.

type AuthorizedFile = { id: string; name: string; mimeType: string; addedAt: string };

const AUTHORIZED_FILES_PAGE_SIZE = 20;

type GDriveTab = "docs" | "sheets" | "slides" | "other";

const TAB_MIMES: Record<Exclude<GDriveTab, "other">, string> = {
  docs: "application/vnd.google-apps.document",
  sheets: "application/vnd.google-apps.spreadsheet",
  slides: "application/vnd.google-apps.presentation",
};

function tabForMime(mimeType: string): GDriveTab {
  if (mimeType === TAB_MIMES.docs) return "docs";
  if (mimeType === TAB_MIMES.sheets) return "sheets";
  if (mimeType === TAB_MIMES.slides) return "slides";
  return "other";
}

function GDriveAuthorizedFiles() {
  const t = useT();
  const gd = t.settings.connectors.gdrivePanel;
  const [files, setFiles] = useState<AuthorizedFile[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const [tab, setTab] = useState<GDriveTab>("docs");

  function mimeLabel(mimeType: string): string {
    if (mimeType === "application/vnd.google-apps.document") return gd.mimeDoc;
    if (mimeType === "application/vnd.google-apps.spreadsheet") return gd.mimeSheet;
    if (mimeType === "application/vnd.google-apps.presentation") return gd.mimeSlides;
    if (mimeType === "application/pdf") return gd.mimePdf;
    if (mimeType.startsWith("image/")) return gd.mimeImage;
    return gd.mimeFile;
  }

  // Per-service tabs filter a single fetched list in-memory.
  // Backend route caps `limit` at 200; fetch up to that — if a user has more,
  // we show a one-line banner and defer to backend filtering as a follow-up.
  const FETCH_LIMIT = 200;

  const fetchAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await authFetch(
        `${API_URL}/api/connectors/gdrive/authorized-files?limit=${FETCH_LIMIT}&offset=0`,
      );
      if (!res.ok) throw new Error(gd.loadFailed);
      const data = (await res.json()) as { files: AuthorizedFile[]; total: number };
      setFiles(data.files);
      setTotal(data.total);
    } catch (err) {
      setError(err instanceof Error ? err.message : gd.unknownError);
    } finally {
      setLoading(false);
    }
  }, [gd.loadFailed, gd.unknownError]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  const handlePicked = useCallback(
    async (picked: PickedFile[]) => {
      try {
        const res = await authFetch(`${API_URL}/api/connectors/gdrive/authorized-files`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ files: picked }),
        });
        if (!res.ok) throw new Error(gd.saveFailed);
        await fetchAll();
        // Jump to the tab matching the first picked file so the user sees it.
        const first = picked[0];
        if (first?.mimeType) setTab(tabForMime(first.mimeType));
        setPage(0);
      } catch (err) {
        setError(err instanceof Error ? err.message : gd.unknownError);
      }
    },
    [fetchAll, gd.saveFailed, gd.unknownError],
  );

  async function handleRemove(id: string) {
    setRemovingId(id);
    try {
      const res = await authFetch(
        `${API_URL}/api/connectors/gdrive/authorized-files/${encodeURIComponent(id)}`,
        { method: "DELETE" },
      );
      if (!res.ok) throw new Error(gd.removeFailed);
      setFiles((prev) => prev.filter((f) => f.id !== id));
      setTotal((tt) => Math.max(0, tt - 1));
    } catch (err) {
      setError(err instanceof Error ? err.message : gd.unknownError);
    } finally {
      setRemovingId(null);
    }
  }

  // Reset local page when switching tabs so users don't land on an empty page.
  useEffect(() => { setPage(0); }, [tab]);

  const filesByTab: Record<GDriveTab, AuthorizedFile[]> = {
    docs: files.filter((f) => f.mimeType === TAB_MIMES.docs),
    sheets: files.filter((f) => f.mimeType === TAB_MIMES.sheets),
    slides: files.filter((f) => f.mimeType === TAB_MIMES.slides),
    other: files.filter((f) =>
      f.mimeType !== TAB_MIMES.docs &&
      f.mimeType !== TAB_MIMES.sheets &&
      f.mimeType !== TAB_MIMES.slides,
    ),
  };
  const visibleFiles = filesByTab[tab];
  const pageFiles = visibleFiles.slice(
    page * AUTHORIZED_FILES_PAGE_SIZE,
    page * AUTHORIZED_FILES_PAGE_SIZE + AUTHORIZED_FILES_PAGE_SIZE,
  );
  const pageCount = Math.max(1, Math.ceil(visibleFiles.length / AUTHORIZED_FILES_PAGE_SIZE));
  const truncated = total > files.length;

  const emptyTabLabel =
    tab === "docs" ? gd.emptyDocs
      : tab === "sheets" ? gd.emptySheets
        : tab === "slides" ? gd.emptySlides
          : gd.emptyOther;

  return (
    <div className="space-y-4 py-1">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[13px] font-medium">{gd.title}</div>
          <div className="text-[11px] text-muted-foreground mt-0.5">{gd.desc}</div>
        </div>
        <DrivePicker onPicked={handlePicked} onError={(msg) => setError(msg)}>
          {({ open, isOpening, disabled, disabledReason }) => (
            <button
              onClick={open}
              disabled={isOpening || disabled}
              title={disabledReason}
              className="text-[11px] font-medium px-3 py-1 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-40 transition-colors shrink-0"
            >
              {isOpening ? gd.opening : gd.addFromDrive}
            </button>
          )}
        </DrivePicker>
      </div>

      {error && (
        <div className="text-[11px] text-destructive bg-destructive/10 border border-destructive/30 rounded-lg px-3 py-2">
          {error}
        </div>
      )}

      {truncated && (
        <div className="text-[11px] text-amber-600 dark:text-amber-400 bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2">
          {gd.truncated.replace("{shown}", String(files.length)).replace("{total}", String(total))}
        </div>
      )}

      {/* Service tabs — filter by mime type. No backend changes; all files
          come from a single fetch and are partitioned client-side. */}
      <div className="flex gap-0 border-b border-border">
        {([
          { id: "docs", label: gd.tabDocs },
          { id: "sheets", label: gd.tabSheets },
          { id: "slides", label: gd.tabSlides },
          { id: "other", label: gd.tabOther },
        ] as const).map(({ id, label }) => {
          const count = filesByTab[id].length;
          if (id === "other" && count === 0) return null;
          return (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={`text-[11px] font-medium px-3 py-1.5 border-b-2 transition-colors ${
                tab === id
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              {label} {count > 0 && <span className="opacity-60">({count})</span>}
            </button>
          );
        })}
      </div>

      {loading && files.length === 0 ? (
        <div className="text-[12px] text-muted-foreground text-center py-6">{gd.loading}</div>
      ) : visibleFiles.length === 0 ? (
        <div className="text-[12px] text-muted-foreground text-center py-6">
          {files.length === 0 ? gd.emptyAll : emptyTabLabel}
        </div>
      ) : (
        <div className="space-y-1.5">
          {pageFiles.map((f) => (
            <div
              key={f.id}
              className="flex items-center justify-between gap-2 bg-muted/50 rounded-lg px-3 py-2"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground bg-muted px-1.5 py-0.5 rounded shrink-0">
                    {mimeLabel(f.mimeType)}
                  </span>
                  <span className="text-[13px] font-medium truncate">{f.name}</span>
                </div>
                <div className="text-[10px] text-muted-foreground/60 mt-0.5 font-mono truncate">
                  {gd.added} {new Date(f.addedAt).toLocaleDateString()}
                </div>
              </div>
              <button
                onClick={() => handleRemove(f.id)}
                disabled={removingId === f.id}
                className="text-[11px] text-muted-foreground hover:text-destructive transition-colors shrink-0 disabled:opacity-50"
              >
                {removingId === f.id ? gd.removing : gd.remove}
              </button>
            </div>
          ))}
        </div>
      )}

      {pageCount > 1 && (
        <div className="flex items-center justify-between pt-1">
          <div className="text-[11px] text-muted-foreground">
            {gd.pageOf
              .replace("{page}", String(page + 1))
              .replace("{count}", String(pageCount))
              .replace("{inTab}", String(visibleFiles.length))}
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0}
              className="text-[11px] px-2 py-1 rounded border border-border text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {gd.previous}
            </button>
            <button
              onClick={() => setPage((p) => p + 1)}
              disabled={page + 1 >= pageCount}
              className="text-[11px] px-2 py-1 rounded border border-border text-muted-foreground hover:text-foreground hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {gd.next}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Chevron icon ──────────────────────────────────────────────
function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="14" height="14" viewBox="0 0 14 14" fill="none"
      stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
      className={`transition-transform duration-200 ${open ? "rotate-180" : ""}`}
    >
      <path d="M3 5l4 4 4-4" />
    </svg>
  );
}

// ── Custom-connector auth section (shared by add form + settings tab) ──
//
// Auth-type Select + per-type secret fields. Validation lives in the pure
// `buildCustomConnectorPayload` (lib/connector-auth-form.ts); this only
// renders inputs and the mapped inline error. Secrets render as password
// fields and are never prefilled — in edit mode a blank secret means
// "keep the current one" (the keep-secret hint communicates that).
function ConnectorAuthSection(props: {
  fieldClass: string;
  authType: ConnectorAuthType;
  onAuthType: (v: ConnectorAuthType) => void;
  oauthId: string; onOauthId: (v: string) => void;
  oauthSecret: string; onOauthSecret: (v: string) => void;
  bearerToken: string; onBearerToken: (v: string) => void;
  headerName: string; onHeaderName: (v: string) => void;
  headerValue: string; onHeaderValue: (v: string) => void;
  /** Edit mode — blank secrets keep the stored ones. */
  editing: boolean;
  error: ConnectorAuthFormError | "saveFailed" | null;
}) {
  const t = useT();
  const tc = t.settings.connectors;
  const secretPlaceholder = (label: string) => (props.editing ? tc.keepSecretPlaceholder : label);
  const errorText =
    props.error === "secretRequired" ? tc.authSecretRequired
    : props.error === "invalidHeaderName" ? tc.authInvalidHeaderName
    : props.error === "saveFailed" ? tc.authSaveFailed
    : null;
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <span className="text-xs text-muted-foreground shrink-0">{tc.authTypeLabel}</span>
        <Select value={props.authType} onValueChange={(v) => { if (v) props.onAuthType(v as ConnectorAuthType); }}>
          <SelectTrigger size="sm" className="text-sm">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none">{tc.authTypeNone}</SelectItem>
            <SelectItem value="bearer">{tc.authTypeBearer}</SelectItem>
            <SelectItem value="custom_header">{tc.authTypeCustomHeader}</SelectItem>
            <SelectItem value="oauth">{tc.authTypeOauth}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {props.authType === "oauth" && (
        <>
          <input
            type="text" placeholder={tc.oauthIdPlaceholder} value={props.oauthId}
            onChange={(e) => props.onOauthId(e.target.value)}
            className={props.fieldClass}
          />
          <input
            type="password" placeholder={secretPlaceholder(tc.oauthSecretPlaceholder)} value={props.oauthSecret}
            onChange={(e) => props.onOauthSecret(e.target.value)}
            autoComplete="new-password"
            className={props.fieldClass}
          />
        </>
      )}
      {props.authType === "bearer" && (
        <input
          type="password" placeholder={secretPlaceholder(tc.bearerTokenPlaceholder)} value={props.bearerToken}
          onChange={(e) => props.onBearerToken(e.target.value)}
          autoComplete="new-password"
          className={props.fieldClass}
        />
      )}
      {props.authType === "custom_header" && (
        <>
          <input
            type="text" placeholder={tc.headerNamePlaceholder} value={props.headerName}
            onChange={(e) => props.onHeaderName(e.target.value)}
            className={props.fieldClass}
          />
          <input
            type="password" placeholder={secretPlaceholder(tc.headerValuePlaceholder)} value={props.headerValue}
            onChange={(e) => props.onHeaderValue(e.target.value)}
            autoComplete="new-password"
            className={props.fieldClass}
          />
        </>
      )}
      {errorText && (
        <div className="text-[11px] text-destructive bg-destructive/10 border border-destructive/30 rounded-lg px-3 py-2">
          {errorText}
        </div>
      )}
    </div>
  );
}

// ── Connectors list — the signed-in account's connectors ──
//
// The single unified Studio -> Connectors list. Backed by `GET /api/connectors`
// (scope='user' rows). Every connector is personal; connecting one
// auto-exposes it to the active *shared* workspace (a `connector_grant` at the
// member's clearance, computed server-side). Each exposed row carries a
// "Workspace" badge and a control to stop sharing.
function ConnectorsList() {
  const t = useT();
  const tc = t.settings.connectors;
  const { active } = useWorkspaces();
  const params = useParams<{ workspaceId: string }>();
  const workspaceId = params?.workspaceId ?? "";
  const [connectors, setConnectors] = useState<Connector[]>([]);
  const [loading, setLoading] = useState(true);
  const [connecting, setConnecting] = useState<string | null>(null);
  // Master-detail selection — a rowId (instance UUID, slug for placeholders)
  // OR a bare provider slug from the OAuth `?connected=` return (resolution
  // below tries both). Null = no explicit pick yet → first rail row.
  const [selected, setSelected] = useState<string | null>(null);
  const [expandTab, setExpandTab] = useState<"tools" | "settings">("tools");
  const [toolsMap, setToolsMap] = useState<Record<string, { tools: ToolPermission[]; serverName: string; loading: boolean }>>({});

  // Edit form state (for custom connector settings tab)
  const [editName, setEditName] = useState("");
  const [editUrl, setEditUrl] = useState("");
  const [editAuthType, setEditAuthType] = useState<ConnectorAuthType>("none");
  const [editOauthId, setEditOauthId] = useState("");
  const [editOauthSecret, setEditOauthSecret] = useState("");
  const [editBearerToken, setEditBearerToken] = useState("");
  const [editHeaderName, setEditHeaderName] = useState("");
  const [editHeaderValue, setEditHeaderValue] = useState("");
  const [editAuthError, setEditAuthError] = useState<ConnectorAuthFormError | "saveFailed" | null>(null);

  // Add form
  const [showAddForm, setShowAddForm] = useState(false);
  const [newName, setNewName] = useState("");
  const [newUrl, setNewUrl] = useState("");
  const [newAuthType, setNewAuthType] = useState<ConnectorAuthType>("none");
  const [newOauthId, setNewOauthId] = useState("");
  const [newOauthSecret, setNewOauthSecret] = useState("");
  const [newBearerToken, setNewBearerToken] = useState("");
  const [newHeaderName, setNewHeaderName] = useState("");
  const [newHeaderValue, setNewHeaderValue] = useState("");
  const [addAuthError, setAddAuthError] = useState<ConnectorAuthFormError | "saveFailed" | null>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);

  // Connection probe (custom connectors) — per-connector-id result of
  // POST /custom/:id/test. `connected` on the row is flipped from the
  // probe response, so the pill reflects a real MCP handshake.
  const [probeState, setProbeState] = useState<Record<string, { status: "testing" | "ok" | "fail"; toolCount?: number; error?: string }>>({});

  const [activeAssistantId, setActiveAssistantId] = useState<string | null>(null);
  const [showBrowse, setShowBrowse] = useState(false);

  // Workspace exposure — connectorInstanceId → grantId for the active
  // workspace. Drives the "Share with workspace" control in each row.
  const [exposedGrants, setExposedGrants] = useState<Record<string, string>>({});
  // connector_instance id whose last expose/revoke failed — drives the
  // inline error shown under that row's Share control.
  const [exposeError, setExposeError] = useState<string | null>(null);
  // Slug of a connector the user JUST connected — drives the one-time
  // auto-expose to the active shared workspace.
  const [justConnectedId, setJustConnectedId] = useState<string | null>(null);

  // PAT input state (for connectors like GitHub that use API keys)
  const [patInput, setPatInput] = useState("");
  const [showPatInput, setShowPatInput] = useState<string | null>(null);

  // Bring-your-own GCS storage form state (the `gcs` connector). Unlike PAT,
  // it needs a service-account key + bucket and validates on the server.
  const [showGcsForm, setShowGcsForm] = useState<string | null>(null);
  const [gcsKey, setGcsKey] = useState("");
  const [gcsBucket, setGcsBucket] = useState("");
  const [gcsProjectId, setGcsProjectId] = useState("");
  const [gcsError, setGcsError] = useState<string | null>(null);

  // "Add another account" state — provider slug whose add-another form is open,
  // plus the nickname + secret for the new instance.
  const [addAnotherFor, setAddAnotherFor] = useState<string | null>(null);
  const [addLabel, setAddLabel] = useState("");
  const [addPat, setAddPat] = useState("");
  // Inline rename — connector_instance UUID being renamed + its draft label.
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameLabel, setRenameLabel] = useState("");

  // Connector config state (e.g. gcal sendUpdates)
  const [configMap, setConfigMap] = useState<Record<string, Record<string, unknown>>>({});

  // Drive-picker error (e.g. not-configured / token failure). Rendered as a
  // transient banner in any panel that wraps a DrivePicker trigger.
  const [gdriveError, setGdriveError] = useState<string | null>(null);
  useEffect(() => {
    if (!gdriveError) return;
    const tm = setTimeout(() => setGdriveError(null), 6000);
    return () => clearTimeout(tm);
  }, [gdriveError]);

  // ── Fetch ────────────────────────────────────────────────────
  const fetchConnectors = useCallback(() => {
    // Pass the active workspace so the API includes workspace-scoped connectors
    // (e.g. the BYO `gcs` storage binding) in the list, not just personal ones.
    const listUrl = workspaceId
      ? `${API_URL}/api/connectors?workspaceId=${encodeURIComponent(workspaceId)}`
      : `${API_URL}/api/connectors`;
    authFetch(listUrl)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { connectors?: Connector[] } | null) => {
        if (!data?.connectors) return;
        let rows = data.connectors;
        // BYO `gcs` storage is workspace-scoped, so it surfaces BOTH as an
        // official "Connect" placeholder and as the workspace binding instance.
        // Collapse to the single manageable instance row (which carries the
        // connected state + Remove affordance) whenever a binding exists.
        if (rows.some((r) => r.id === "gcs" && r.connectorInstanceId)) {
          rows = rows.filter((r) => !(r.id === "gcs" && !r.connectorInstanceId));
        }
        setConnectors(rows);
      })
      .catch(() => {})
      .finally(() => setLoading(false));

    // Read active assistant from localStorage (same key as app-sidebar)
    try {
      const saved = localStorage.getItem("active-assistant-id");
      if (saved) setActiveAssistantId(saved);
    } catch {}
    // Fallback: fetch first assistant if localStorage is empty
    if (!localStorage.getItem("active-assistant-id")) {
      authFetch(`${API_URL}/api/assistants`)
        .then((r) => (r.ok ? r.json() : null))
        .then((data: { assistants?: Array<{ id: string }> } | null) => {
          if (data?.assistants?.[0]) setActiveAssistantId(data.assistants[0].id);
        })
        .catch(() => {});
    }
  }, [workspaceId]);

  useEffect(() => {
    fetchConnectors();
    // Reset stuck "Connecting..." state when page regains visibility
    // (e.g. user navigated back from OAuth without completing it)
    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        setConnecting(null);
        fetchConnectors();
      }
    };
    // Handle bfcache restoration (browser back button from OAuth page)
    const onPageShow = (e: PageTransitionEvent) => {
      if (e.persisted) {
        setConnecting(null);
        fetchConnectors();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pageshow", onPageShow);
    };
  }, [fetchConnectors]);

  // Load this account's connector-exposure grants and index the ones
  // pointing at the active workspace, so each row knows if it's shared.
  const fetchGrants = useCallback(() => {
    if (!active) {
      setExposedGrants({});
      return;
    }
    const wsId = active.id;
    authFetch(`${API_URL}/api/connector-instances/me/grants`)
      .then((r) => (r.ok ? r.json() : null))
      .then(
        (data: {
          grants?: Array<{ id: string; connectorInstanceId: string; targetId: string }>;
        } | null) => {
          const map: Record<string, string> = {};
          for (const g of data?.grants ?? []) {
            if (g.targetId === wsId) map[g.connectorInstanceId] = g.id;
          }
          setExposedGrants(map);
        },
      )
      .catch(() => {});
  }, [active]);

  useEffect(() => {
    fetchGrants();
  }, [fetchGrants]);

  // ── Auto-trigger from `?connect=<id>` ───────────────────────────
  //
  // The Telegram `/connect <id>` flow hands users here. When the connectors
  // list has loaded, check for the query param and auto-fire `handleConnect(id)`
  // once — but only if the connector is known and not already connected, to
  // avoid loop-on-refresh. After firing we strip the param from the URL so a
  // subsequent reload doesn't re-trigger.
  const [autoTriggered, setAutoTriggered] = useState(false);
  useEffect(() => {
    if (loading || autoTriggered || connectors.length === 0) return;
    const sp = new URLSearchParams(window.location.search);
    const target = sp.get("connect");
    if (!target) return;
    const c = connectors.find((x) => x.id === target);
    if (!c) {
      setAutoTriggered(true);
      return;
    }
    // Select so the user sees the status; connect if not already connected.
    // Built-in primitives are always-on — selection is the whole flow.
    setSelected(rowId(c));
    if (!c.connected && !isBuiltinPrimitive(c)) handleConnect(c);
    setAutoTriggered(true);
    const url = new URL(window.location.href);
    url.searchParams.delete("connect");
    window.history.replaceState({}, "", url.toString());
    // handleConnect identity is stable enough for this one-shot effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, connectors, autoTriggered]);

  // ── Arm the post-connect nudge from `?connected=<id>` ───────────
  //
  // The OAuth callbacks (google-connector / notion / fathom) redirect back to
  // `?connected=<id>` on success. Read it once on mount, arm the auto-expose
  // for that connector, expand its row, and strip the param so a refresh /
  // bfcache restore can't re-fire it.
  useEffect(() => {
    const sp = new URLSearchParams(window.location.search);
    const justConnected = sp.get("connected");
    if (!justConnected) return;
    setJustConnectedId(justConnected);
    setSelected(justConnected);
    const url = new URL(window.location.href);
    url.searchParams.delete("connected");
    window.history.replaceState({}, "", url.toString());
  }, []);

  // ── Auto-expose a just-connected connector to the active workspace ──
  useEffect(() => {
    if (!justConnectedId) return;
    const c = connectors.find((x) => x.id === justConnectedId);
    // Not in the list yet (post-OAuth refetch pending) — wait for a later run.
    if (!c) return;
    const decision = resolveAutoExpose({ connector: c, workspace: active, exposedGrants });
    if (decision.expose) {
      setJustConnectedId(null);
      void handleExpose(decision.connectorInstanceId);
    } else if (c.connected && c.connectorInstanceId) {
      // Resolved + connected but ineligible — clear so the effect doesn't spin.
      setJustConnectedId(null);
    }
    // handleExpose is stable for this one-shot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [justConnectedId, connectors, active, exposedGrants]);

  const loadTools = useCallback(async (connectorId: string) => {
    setToolsMap((prev) => ({ ...prev, [connectorId]: { tools: [], serverName: "", loading: true } }));
    try {
      const res = await authFetch(`${API_URL}/api/connectors/${connectorId}/tools`);
      if (res.ok) {
        const data = await res.json();
        setToolsMap((prev) => ({ ...prev, [connectorId]: { tools: data.tools ?? [], serverName: data.serverName ?? "", loading: false } }));
      } else {
        setToolsMap((prev) => ({ ...prev, [connectorId]: { ...prev[connectorId], loading: false } }));
      }
    } catch {
      setToolsMap((prev) => ({ ...prev, [connectorId]: { ...prev[connectorId], loading: false } }));
    }
  }, []);

  const loadConfig = useCallback(async (connectorId: string) => {
    try {
      const res = await authFetch(`${API_URL}/api/connectors/${connectorId}/config`);
      if (res.ok) {
        const data = await res.json();
        setConfigMap((prev) => ({ ...prev, [connectorId]: data.config ?? {} }));
      }
    } catch {}
  }, []);

  async function saveConfig(connectorId: string, config: Record<string, unknown>) {
    try {
      const res = await authFetch(`${API_URL}/api/connectors/${connectorId}/config`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      });
      if (res.ok) {
        const data = await res.json();
        setConfigMap((prev) => ({ ...prev, [connectorId]: data.config ?? {} }));
      }
    } catch {}
  }

  // ── Actions ──────────────────────────────────────────────────
  // `opts.addAnother` connects a NEW account for a provider that already has
  // one (OAuth state carries an `:add` suffix so the callback creates a fresh
  // instance instead of overwriting the first).
  async function handleConnect(c: Connector, opts?: { addAnother?: boolean }) {
    const id = c.id;
    const rid = rowId(c);
    const addState = opts?.addAnother ? ":add" : "";
    setConnecting(rid);

    // PAT connectors — show inline token input instead of connecting immediately
    if (PAT_CONNECTORS.has(id)) {
      setShowPatInput(rid);
      setConnecting(null);
      return;
    }

    // GCS bring-your-own storage — show the SA-key + bucket form (validated
    // server-side) instead of the generic mark-connected POST.
    if (id === "gcs") {
      setShowGcsForm(rid);
      setGcsError(null);
      setConnecting(null);
      return;
    }

    // Notion OAuth — separate flow (different auth URL, no scopes). The
    // workspaceId is threaded through `state` so the server callback can
    // redirect back to this workspace-scoped route.
    if (id === "notion") {
      const redirectUri = `${window.location.origin}/api/auth/callback/notion`;
      const sp = new URLSearchParams({
        client_id: NOTION_CLIENT_ID,
        redirect_uri: redirectUri,
        response_type: "code",
        owner: "user",
        state: `notion${addState}:${workspaceId}`,
      });
      window.location.href = `https://api.notion.com/v1/oauth/authorize?${sp}`;
      return;
    }

    // Fathom OAuth — single coarse `public_api` scope, refresh-token rotation.
    if (id === "fathom") {
      const redirectUri = `${window.location.origin}/api/auth/callback/fathom`;
      const sp = new URLSearchParams({
        client_id: FATHOM_CLIENT_ID,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: "public_api",
        state: `fathom${addState}:${workspaceId}`,
      });
      window.location.href = `${FATHOM_AUTHORIZE_URL}?${sp}`;
      return;
    }

    // Google OAuth connectors — build Google OAuth URL client-side. The
    // connector id + workspaceId ride in `state` (`gcal:<workspaceId>`).
    const scopes = OAUTH_SCOPES_WITH_EMAIL[id];
    if (scopes) {
      const redirectUri = `${window.location.origin}/api/auth/callback/google-connector`;
      const sp = new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: scopes.join(" "),
        access_type: "offline",
        prompt: "consent",
        state: `${id}:${workspaceId}`,
      });
      window.location.href = `https://accounts.google.com/o/oauth2/v2/auth?${sp}`;
      return;
    }

    // Non-OAuth connectors — call backend directly. A specific instance
    // (custom / directory) reconnects by UUID; a placeholder connects by slug.
    try {
      const connectUrl = c.connectorInstanceId
        ? `${API_URL}/api/connectors/instances/${c.connectorInstanceId}/connect`
        : `${API_URL}/api/connectors/${id}/connect`;
      const res = await authFetch(connectUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (res.ok) {
        setConnectors((prev) => prev.map((x) => (isSameRow(x, c) ? { ...x, connected: true } : x)));
        setSelected(rid);
        loadTools(id);
        // Refetch so the new connector_instance UUID lands in state, then arm
        // the auto-expose.
        fetchConnectors();
        setJustConnectedId(id);
      }
    } catch {
      // silently fail
    }
    setConnecting(null);
  }

  // Connect ANOTHER account for a provider that already has one.
  async function handleAddAnother(c: Connector) {
    if (PAT_CONNECTORS.has(c.id)) {
      // GitHub PAT → inline label + token form (createNew).
      setAddAnotherFor(c.id);
      setAddLabel("");
      setAddPat("");
      setSelected(rowId(c));
      return;
    }
    if (c.oauthRequired) {
      // Notion / Fathom → OAuth with the `:add` intent.
      handleConnect(c, { addAnother: true });
      return;
    }
    // Directory remote MCP → create a fresh instance, then refresh.
    try {
      await authFetch(`${API_URL}/api/connectors/directory/${c.id}/add`, { method: "POST" });
      fetchConnectors();
    } catch {
      // silently fail
    }
  }

  // Save a brand-new GitHub PAT instance ("Add another").
  async function handleSaveAddAnother(provider: string) {
    if (!addPat.trim()) return;
    setConnecting(`add:${provider}`);
    try {
      const res = await authFetch(`${API_URL}/api/connectors/${provider}/store-credentials`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pat: addPat.trim(), createNew: true, label: addLabel.trim() || undefined }),
      });
      if (res.ok) {
        setAddAnotherFor(null);
        setAddPat("");
        setAddLabel("");
        fetchConnectors();
      }
    } catch {
      // silently fail
    }
    setConnecting(null);
  }

  // Rename a connector instance (nickname).
  async function handleRename(c: Connector) {
    const iid = c.connectorInstanceId;
    if (!iid || !renameLabel.trim()) return;
    try {
      const res = await authFetch(`${API_URL}/api/connectors/instances/${iid}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ label: renameLabel.trim() }),
      });
      if (res.ok) {
        setConnectors((prev) => prev.map((x) => (isSameRow(x, c) ? { ...x, label: renameLabel.trim() } : x)));
        setRenamingId(null);
      }
    } catch {
      // silently fail
    }
  }

  // Saves the PAT for the primary / placeholder GitHub row. "Add another"
  // uses `handleSaveAddAnother` (createNew + nickname) instead.
  async function handleSavePat(c: Connector) {
    if (!patInput.trim()) return;
    const rid = rowId(c);
    setConnecting(rid);
    try {
      const body: Record<string, unknown> = { pat: patInput.trim() };
      if (c.connectorInstanceId) body.instanceId = c.connectorInstanceId;
      const res = await authFetch(`${API_URL}/api/connectors/${c.id}/store-credentials`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        setConnectors((prev) => prev.map((x) => (isSameRow(x, c) ? { ...x, connected: true } : x)));
        setSelected(rid);
        loadTools(c.id);
        // Refetch so the new connector_instance UUID lands in state, then arm
        // the auto-expose.
        fetchConnectors();
        setJustConnectedId(c.id);
      }
    } catch {}
    setPatInput("");
    setShowPatInput(null);
    setConnecting(null);
  }

  // Connect the workspace's own GCS bucket. The server validates the key with
  // a write/read/delete probe before persisting, so a bad key surfaces here.
  async function handleSaveGcs(c: Connector) {
    if (!gcsKey.trim() || !gcsBucket.trim()) return;
    const rid = rowId(c);
    setConnecting(rid);
    setGcsError(null);
    try {
      const res = await authFetch(`${API_URL}/api/connectors/gcs/connect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          workspaceId,
          serviceAccountKey: gcsKey.trim(),
          bucket: gcsBucket.trim(),
          projectId: gcsProjectId.trim() || undefined,
        }),
      });
      if (res.ok) {
        setConnectors((prev) => prev.map((x) => (isSameRow(x, c) ? { ...x, connected: true } : x)));
        setSelected(rid);
        setShowGcsForm(null);
        setGcsKey(""); setGcsBucket(""); setGcsProjectId("");
        fetchConnectors();
        setJustConnectedId(c.id);
      } else {
        const data = (await res.json().catch(() => ({}))) as { code?: string };
        setGcsError(
          data.code === "permission_denied" ? tc.gcs.errPermission
          : data.code === "bucket_unreachable" ? tc.gcs.errBucket
          : data.code === "invalid_key" ? tc.gcs.errKey
          : tc.gcs.errGeneric,
        );
      }
    } catch {
      setGcsError(tc.gcs.errGeneric);
    }
    setConnecting(null);
  }

  async function handlePolicyChange(connectorId: string, serverName: string, toolName: string, policy: "allow" | "ask" | "block") {
    setToolsMap((prev) => {
      const entry = prev[connectorId];
      if (!entry) return prev;
      return { ...prev, [connectorId]: { ...entry, tools: entry.tools.map((tool) => (tool.name === toolName ? { ...tool, policy } : tool)) } };
    });
    try {
      await authFetch(`${API_URL}/api/connectors/${connectorId}/tools/policy`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serverName, toolName, policy }),
      });
    } catch { loadTools(connectorId); }
  }

  async function handleSaveCustom(id: string) {
    if (!editName.trim() || !editUrl.trim()) return;
    setEditAuthError(null);
    const row = connectors.find((c) => c.id === id);
    const current: CurrentConnectorAuth = {
      authType: row?.authType ?? "none",
      authHeaderName: row?.authHeaderName,
    };
    const built = buildCustomConnectorPayload(
      {
        name: editName, url: editUrl, authType: editAuthType,
        oauthClientId: editOauthId, oauthClientSecret: editOauthSecret,
        bearerToken: editBearerToken, headerName: editHeaderName, headerValue: editHeaderValue,
      },
      current,
    );
    if (!built.ok) { setEditAuthError(built.error); return; }
    try {
      const res = await authFetch(`${API_URL}/api/connectors/custom/${id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(built.payload),
      });
      if (res.ok) {
        setConnectors((prev) => prev.map((c) => c.id === id
          ? {
              ...c,
              name: editName.trim(),
              url: editUrl.trim(),
              authType: editAuthType,
              authHeaderName: editAuthType === "custom_header"
                ? (editHeaderName.trim() || c.authHeaderName)
                : undefined,
            }
          : c));
        // Clear ALL credential inputs (incl. the non-secret OAuth id) so a
        // follow-up save doesn't hit the half-pair-required branch.
        setEditBearerToken(""); setEditOauthId(""); setEditOauthSecret(""); setEditHeaderValue("");
      } else {
        setEditAuthError("saveFailed");
      }
    } catch {
      setEditAuthError("saveFailed");
    }
  }

  async function handleAddCustom() {
    if (!newName.trim() || !newUrl.trim()) return;
    setAddAuthError(null);
    const built = buildCustomConnectorPayload(
      {
        name: newName, url: newUrl, authType: newAuthType,
        oauthClientId: newOauthId, oauthClientSecret: newOauthSecret,
        bearerToken: newBearerToken, headerName: newHeaderName, headerValue: newHeaderValue,
      },
      null,
    );
    if (!built.ok) { setAddAuthError(built.error); return; }
    try {
      const res = await authFetch(`${API_URL}/api/connectors/custom`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(built.payload),
      });
      if (res.ok) {
        const data = await res.json();
        setConnectors((prev) => [...prev, {
          id: data.id,
          name: newName.trim(),
          url: newUrl.trim(),
          connected: false,
          custom: true,
          authType: newAuthType,
          authHeaderName: newAuthType === "custom_header" ? newHeaderName.trim() : undefined,
        }]);
        // Probe right away so the row shows a real connection state
        // instead of a silent "Disconnected" the user has to chase.
        void handleTestConnection(data.id);
      } else {
        setAddAuthError("saveFailed");
        return;
      }
    } catch {
      setAddAuthError("saveFailed");
      return;
    }
    resetAddForm();
  }

  async function handleTestConnection(id: string) {
    setProbeState((prev) => ({ ...prev, [id]: { status: "testing" } }));
    try {
      const res = await authFetch(`${API_URL}/api/connectors/custom/${id}/test`, { method: "POST" });
      if (!res.ok) throw new Error();
      const data = await res.json() as { ok: boolean; toolCount?: number; error?: string; connected: boolean };
      setConnectors((prev) => prev.map((c) => (c.id === id ? { ...c, connected: data.connected } : c)));
      setProbeState((prev) => ({
        ...prev,
        [id]: data.ok ? { status: "ok", toolCount: data.toolCount } : { status: "fail", error: data.error },
      }));
    } catch {
      setProbeState((prev) => ({ ...prev, [id]: { status: "fail" } }));
    }
  }

  async function handleRemoveCustom(c: Connector) {
    setConnectors((prev) => prev.filter((x) => !isSameRow(x, c)));
    setSelected(null);
    // Custom rows are keyed by their provider UUID (== `c.id`), unique per row.
    try { await authFetch(`${API_URL}/api/connectors/custom/${c.id}`, { method: "DELETE" }); } catch {}
  }

  async function handleRemove(c: Connector) {
    // GCS uses the workspace-scoped disconnect (wipes the stored key; new
    // writes revert to the default bucket).
    if (c.id === "gcs") {
      setConnectors((prev) => prev.map((x) => (isSameRow(x, c) ? { ...x, connected: false } : x)));
      setSelected(null);
      try {
        await authFetch(`${API_URL}/api/connectors/gcs/disconnect`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ workspaceId }),
        });
      } catch {}
      fetchConnectors();
      return;
    }
    setConnectors((prev) => prev.filter((x) => !isSameRow(x, c)));
    setSelected(null);
    const url = c.connectorInstanceId
      ? `${API_URL}/api/connectors/instances/${c.connectorInstanceId}`
      : `${API_URL}/api/connectors/${c.id}`;
    try { await authFetch(url, { method: "DELETE" }); } catch {}
    // Reconcile with the server: a built-in whose last instance was just
    // removed comes back as a connect placeholder, and removing the primary
    // promotes the next-oldest instance to canonical — both only surface on a
    // refetch (the optimistic filter above just removed the row locally).
    fetchConnectors();
  }

  // Returns true on success so callers (e.g. the post-connect nudge) can
  // clear their own UI only when the grant actually landed.
  async function handleExpose(connectorInstanceId: string): Promise<boolean> {
    if (!active) return false;
    setExposeError(null);
    try {
      const res = await authFetch(
        `${API_URL}/api/connector-instances/${connectorInstanceId}/grants`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            targetType: "workspace",
            targetId: active.id,
          }),
        },
      );
      if (!res.ok) throw new Error();
      fetchGrants();
      return true;
    } catch {
      setExposeError(connectorInstanceId);
      return false;
    }
  }

  async function handleRevokeExpose(connectorInstanceId: string) {
    const grantId = exposedGrants[connectorInstanceId];
    if (!grantId) return;
    setExposeError(null);
    try {
      const res = await authFetch(
        `${API_URL}/api/connector-instances/${connectorInstanceId}/grants/${grantId}`,
        { method: "DELETE" },
      );
      if (!res.ok) throw new Error();
      fetchGrants();
    } catch {
      setExposeError(connectorInstanceId);
    }
  }

  // ── Master-detail selection resolution ───────────────────────
  //
  // The rail groups rows by sharing state (docs/architecture/integrations/
  // mcp.md → "Unified connectors — the master-detail Studio surface"). The
  // stored `selected` key resolves against the rail order: rowId first, then
  // bare provider slug (the OAuth `?connected=` return arms selection by slug
  // before the refetched row carries its instance UUID); null / stale keys
  // fall back to the first rail row.
  const sharedWorkspace = active ? isSharedWorkspace(active.memberCount) : false;
  const grouped = groupConnectors(connectors, {
    sharedWorkspace,
    exposedGrants,
    builtinIds: BUILTIN_PRIMITIVE_CONNECTOR_IDS,
  });
  const railGroups = (
    sharedWorkspace
      ? [
          { id: "shared", label: tc.groupShared, rows: grouped.shared },
          { id: "personal", label: tc.groupPersonal, rows: grouped.personal },
          { id: "workspace", label: tc.groupWorkspaceShared, rows: grouped.workspace },
          { id: "available", label: tc.groupAvailable, rows: grouped.available },
          { id: "builtin", label: tc.groupBuiltin, rows: grouped.builtin },
        ]
      : [
          { id: "personal", label: tc.groupConnected, rows: grouped.personal },
          { id: "workspace", label: tc.groupWorkspaceShared, rows: grouped.workspace },
          { id: "available", label: tc.groupAvailable, rows: grouped.available },
          { id: "builtin", label: tc.groupBuiltin, rows: grouped.builtin },
        ]
  ).filter((g) => g.rows.length > 0);
  const railOrder = railGroups.flatMap((g) => g.rows);
  const sel =
    railOrder.find((c) => rowId(c) === selected) ??
    railOrder.find((c) => c.id === selected) ??
    railOrder[0] ??
    null;
  const selKey = sel ? rowId(sel) : null;

  // Per-selection side effects (once per resolved row): reset the tab, load
  // the tool list, seed the custom-connector edit form — what the accordion's
  // expand handler used to do, now also covering the auto-selected first row.
  const seededSelRef = useRef<string | null>(null);
  useEffect(() => {
    if (!sel || seededSelRef.current === selKey) return;
    seededSelRef.current = selKey;
    setExpandTab("tools");
    setRenamingId(null);
    if ((sel.connected || isBuiltinPrimitive(sel)) && !toolsMap[sel.id]) loadTools(sel.id);
    if (sel.custom) {
      setEditName(sel.name); setEditUrl(sel.url ?? "");
      setEditAuthType(sel.authType ?? "none");
      setEditOauthId(""); setEditOauthSecret("");
      setEditBearerToken("");
      setEditHeaderName(sel.authHeaderName ?? ""); setEditHeaderValue("");
      setEditAuthError(null);
    }
    // `sel`/`toolsMap` identities churn with fetches; the ref guards one-shot
    // seeding per selection key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selKey]);

  function resetAddForm() {
    setShowAddForm(false); setNewName(""); setNewUrl("");
    setNewAuthType("none"); setNewOauthId(""); setNewOauthSecret("");
    setNewBearerToken(""); setNewHeaderName(""); setNewHeaderValue("");
    setAddAuthError(null); setShowAdvanced(false);
  }

  if (loading) {
    return <div className="text-sm text-muted-foreground py-10 text-center">{tc.loading}</div>;
  }

  return (
    <div className="space-y-5">
      {/* Intro row — the section description (the topbar breadcrumb names the
          section) + the page's one primary action, the Add menu. */}
      <div className="flex items-start justify-between gap-4">
        <p className="text-[13px] text-muted-foreground max-w-prose">
          {tc.pageDesc}
        </p>
        <AddConnectorMenu
          label={tc.addConnector}
          browseLabel={tc.browseDirectory}
          customLabel={tc.addCustomConnector}
          onBrowseDirectory={() => setShowBrowse(true)}
          onAddCustom={() => setShowAddForm(true)}
        />
      </div>

      {/* Custom MCP server form — opened from the Add menu. */}
      {showAddForm && (
        <div className="border border-primary/30 rounded-xl px-5 py-4 space-y-4">
          <div className="text-sm font-medium">{tc.addCustomConnector}</div>
          <p className="text-xs text-muted-foreground">{tc.remoteMcpDesc}</p>
          <input
            type="text" placeholder={tc.namePlaceholder} value={newName}
            onChange={(e) => setNewName(e.target.value)}
            className="w-full text-sm bg-muted/50 border border-border rounded-lg px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-primary/30"
          />
          <input
            type="url" placeholder={tc.remoteUrlPlaceholder} value={newUrl}
            onChange={(e) => setNewUrl(e.target.value)}
            className="w-full text-sm bg-muted/50 border border-border rounded-lg px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-primary/30"
          />
          <button
            type="button" onClick={() => setShowAdvanced(!showAdvanced)}
            className="flex items-center gap-2 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
          >
            <ChevronIcon open={showAdvanced} />
            {tc.advancedSettings}
          </button>
          <div className={`grid transition-[grid-template-rows] duration-200 ease-out ${showAdvanced ? "grid-rows-[1fr]" : "grid-rows-[0fr]"}`}>
            <div className="overflow-hidden">
              <ConnectorAuthSection
                fieldClass="w-full text-sm bg-muted/50 border border-border rounded-lg px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-primary/30"
                authType={newAuthType} onAuthType={setNewAuthType}
                oauthId={newOauthId} onOauthId={setNewOauthId}
                oauthSecret={newOauthSecret} onOauthSecret={setNewOauthSecret}
                bearerToken={newBearerToken} onBearerToken={setNewBearerToken}
                headerName={newHeaderName} onHeaderName={setNewHeaderName}
                headerValue={newHeaderValue} onHeaderValue={setNewHeaderValue}
                editing={false}
                error={addAuthError}
              />
            </div>
          </div>
          <p className="text-[11px] text-muted-foreground leading-relaxed">
            {tc.trustWarning}
          </p>
          <div className="flex items-center gap-2 justify-end">
            <button onClick={resetAddForm} className="text-xs font-medium border border-border px-4 py-1.5 rounded-lg text-muted-foreground hover:bg-muted transition-colors">
              {tc.cancel}
            </button>
            <button onClick={handleAddCustom} disabled={!newName.trim() || !newUrl.trim()}
              className="text-xs font-medium bg-primary text-primary-foreground px-4 py-1.5 rounded-lg hover:bg-primary/90 disabled:opacity-50 transition-colors">
              {tc.add}
            </button>
          </div>
        </div>
      )}

      <BrowseDirectory
        open={showBrowse}
        onClose={() => setShowBrowse(false)}
        onConnectorAdded={() => fetchConnectors()}
      />

      {gdriveError && (
        <div className="flex items-start justify-between gap-3 text-[12px] bg-destructive/10 border border-destructive/30 rounded-lg px-3 py-2 text-destructive">
          <div className="min-w-0">{gdriveError}</div>
          <button
            onClick={() => setGdriveError(null)}
            className="text-[11px] opacity-60 hover:opacity-100 shrink-0"
          >
            {tc.dismiss}
          </button>
        </div>
      )}

      {/* ── Master-detail: grouped rail + selected connector panel ── */}
      <div className="flex flex-col gap-6 md:flex-row">
        {/* Rail — every connector, grouped by sharing state. */}
        <aside className="w-full md:w-64 shrink-0 self-start">
          <nav aria-label={tc.railAriaLabel} className="flex flex-col gap-3">
            {railGroups.map((g) => (
              <div key={g.id}>
                <div className="flex items-center gap-1.5 px-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {g.label}
                  <span className="font-normal text-muted-foreground/50">
                    {g.rows.length}
                  </span>
                </div>
                <ul className="flex flex-col gap-0.5">
                  {g.rows.map((c) => {
                    const rid = rowId(c);
                    const isSel = selKey === rid;
                    return (
                      <li key={rid}>
                        <button
                          type="button"
                          onClick={() => setSelected(rid)}
                          aria-current={isSel ? "true" : undefined}
                          className={cn(
                            "flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
                            isSel
                              ? "bg-muted font-medium text-foreground"
                              : "text-muted-foreground hover:bg-muted/60 hover:text-foreground",
                          )}
                        >
                          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-muted">
                            <ConnectorIcon connectorId={c.id} iconUrl={c.icon_url} />
                          </span>
                          <span className="min-w-0 flex-1">
                            <span className="block truncate">{c.label ?? c.name}</span>
                            {c.connected && c.connectedEmail && (
                              <span className="block truncate text-[11px] font-normal text-muted-foreground">
                                {c.connectedEmail}
                              </span>
                            )}
                          </span>
                          {/* Built-ins skip the connected dot — always-on,
                              so the connected/available signal is noise. */}
                          {c.connected && !isBuiltinPrimitive(c) && (
                            <span
                              aria-hidden
                              className="h-1.5 w-1.5 shrink-0 rounded-full bg-primary"
                            />
                          )}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </nav>
        </aside>

        {/* Detail — the selected connector's management panel. */}
        <div className="min-w-0 flex-1">
          {!sel ? (
            <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
              {tc.selectPrompt}
            </div>
          ) : (() => {
            const rid = rowId(sel);
            // Read-only workspace-shared connector — a teammate's or a legacy
            // team-native instance the member can use but not manage. A
            // self-contained panel: identity + attribution + status, no
            // connect / rename / remove / share affordances and no credentials.
            if (sel.readonly) {
              return (
                <div key={rid} className="space-y-4">
                  <div className="flex items-start gap-3">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted">
                      <ConnectorIcon connectorId={sel.id} iconUrl={sel.icon_url} />
                    </div>
                    <div className="min-w-0 flex-1">
                      <h2 className="truncate text-[15px] font-semibold tracking-tight">
                        {sel.label ?? sel.name}
                      </h2>
                      <p className="text-[12px] text-muted-foreground">
                        {sel.source === "granted"
                          ? sel.sharedBy
                            ? tc.workspaceSharedByMember.replace("{name}", sel.sharedBy)
                            : tc.workspaceSharedByTeammate
                          : tc.workspaceSharedTeamNative}
                      </p>
                    </div>
                    {sel.connected && (
                      <span className="shrink-0 rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                        {tc.connected}
                      </span>
                    )}
                  </div>
                  <div className="rounded-lg border border-border bg-muted/30 px-4 py-3 text-[12px] leading-relaxed text-muted-foreground">
                    {tc.workspaceSharedReadonlyNote}
                  </div>
                </div>
              );
            }
            const transport = getTransportLabel(sel.url);
            const instanceId = sel.connectorInstanceId;
            // Built-in primitive — always-on pill, no connect/disconnect/
            // remove/share affordances, tool list always visible.
            const builtin = isBuiltinPrimitive(sel);
            // The header title is the instance nickname (defaults to the
            // provider name); when nicknamed, the provider name drops to a
            // muted badge so the account's identity stays readable.
            const hasNickname = !!sel.label && sel.label !== sel.name;
            // Built-in/directory instances rename in place via the pencil
            // next to the title; custom connectors edit their name in the
            // Settings tab instead. Built-in primitives have no accounts to
            // tell apart, so no nickname either.
            const canRename = !!sel.connectorInstanceId && !sel.custom && !builtin;
            const isRenaming = canRename && renamingId === sel.connectorInstanceId;
            const renameIconBtnCls =
              "inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-40";
            const subtitle =
              sel.connected && sel.connectedEmail
                ? sel.connectedEmail
                : sel.custom && sel.url
                  ? sel.url
                  : undefined;
            return (
              <div key={rid} className="space-y-4">
                {/* Header — icon, name + badges, account line, status pill. */}
                <div className="flex items-start gap-3">
                  <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted">
                    <ConnectorIcon connectorId={sel.id} iconUrl={sel.icon_url} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      {isRenaming ? (
                        /* In-place rename — the input sits where the title
                           was. Enter saves, Escape cancels; the check / x
                           icons mirror those keys. */
                        <>
                          <input
                            type="text"
                            value={renameLabel}
                            onChange={(e) => setRenameLabel(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") handleRename(sel);
                              if (e.key === "Escape") setRenamingId(null);
                            }}
                            placeholder={tc.nicknamePlaceholder}
                            /* In-place title field: the slide-in underline is
                               the focus affordance, so opt out of the global
                               :focus-visible ring (`focus-visible:shadow-none`
                               — `outline-none` alone never silences it; see
                               globals.css → ":focus-visible"). */
                            className="w-56 max-w-full bg-transparent text-[15px] font-semibold tracking-tight border-b border-border focus:border-primary focus:outline-none focus-visible:shadow-none"
                            autoFocus
                          />
                          <button
                            type="button"
                            onClick={() => handleRename(sel)}
                            disabled={!renameLabel.trim()}
                            aria-label={tc.saveBtn}
                            title={tc.saveBtn}
                            className={renameIconBtnCls}
                          >
                            <Check className="size-3.5" aria-hidden />
                          </button>
                          <button
                            type="button"
                            onClick={() => setRenamingId(null)}
                            aria-label={tc.cancel}
                            title={tc.cancel}
                            className={renameIconBtnCls}
                          >
                            <X className="size-3.5" aria-hidden />
                          </button>
                        </>
                      ) : (
                        <>
                          <h2 className="truncate text-[15px] font-semibold tracking-tight">
                            {sel.label ?? sel.name}
                          </h2>
                          {canRename && (
                            <button
                              type="button"
                              onClick={() => {
                                setRenamingId(sel.connectorInstanceId!);
                                setRenameLabel(sel.label ?? sel.name);
                              }}
                              aria-label={tc.renameAccount}
                              title={tc.renameAccount}
                              className={renameIconBtnCls}
                            >
                              <Pencil className="size-3.5" aria-hidden />
                            </button>
                          )}
                        </>
                      )}
                      {hasNickname && (
                        <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-foreground/80">
                          {sel.name}
                        </span>
                      )}
                      {sel.custom && transport && (
                        <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-primary">
                          {transport}
                        </span>
                      )}
                    </div>
                    {subtitle ? (
                      <div className="mt-0.5 truncate text-[12px] text-muted-foreground">
                        {subtitle}
                      </div>
                    ) : (() => {
                      const localized = (tc.cardDesc as Record<string, string>)[sel.id];
                      const desc = localized ?? sel.description;
                      return desc ? (
                        <div className="mt-0.5 text-[12px] text-muted-foreground">
                          {desc}
                        </div>
                      ) : null;
                    })()}
                  </div>
                  <span
                    className={cn(
                      "shrink-0 rounded-full px-2 py-0.5 text-xs font-medium",
                      sel.connected && sel.healthStatus === "auth_failed"
                        ? "bg-amber-500/10 text-amber-600 dark:text-amber-400"
                        : builtin || sel.connected
                          ? "bg-primary/10 text-primary"
                          : "bg-muted text-muted-foreground",
                    )}
                  >
                    {builtin
                      ? tc.alwaysOn
                      : sel.connected && sel.healthStatus === "auth_failed"
                        ? tc.reconnectNeeded
                        : sel.connected
                          ? tc.connected
                          : tc.disconnected}
                  </span>
                </div>

                {/* Connected rows already show the description as the header
                    subtitle fallback; when an email/url took that slot, keep
                    the description as its own line. */}
                {subtitle && (() => {
                  const localized = (tc.cardDesc as Record<string, string>)[sel.id];
                  const desc = localized ?? sel.description;
                  return desc ? (
                    <p className="text-xs text-muted-foreground">{desc}</p>
                  ) : null;
                })()}

                {/* Connector-health reconnect banner (migration 294): the
                    credentials stopped working (a 401/403 at call time) even
                    though the connector still reads as connected. */}
                {sel.connected && sel.healthStatus === "auth_failed" && (
                  <div className="flex items-start gap-2 text-[11px] bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2 text-amber-600 dark:text-amber-400">
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="shrink-0 mt-0.5">
                      <path d="M8 5v3m0 2.5v.5" strokeLinecap="round" />
                      <circle cx="8" cy="8" r="6.5" />
                    </svg>
                    <div className="min-w-0">
                      <div className="font-medium">{tc.healthReconnectTitle}</div>
                      <div className="mt-0.5 opacity-80">{tc.healthReconnectDesc}</div>
                      <button
                        onClick={() => handleConnect(sel)}
                        disabled={connecting === rid}
                        className="mt-1 text-[11px] font-medium underline underline-offset-2 hover:opacity-80 disabled:opacity-50"
                      >
                        {connecting === rid ? tc.connectingBtn : tc.reconnectBtn}
                      </button>
                    </div>
                  </div>
                )}

                {/* Scope-migration reconnect banner. */}
                {sel.connected &&
                  CURRENT_SCOPE_VERSION[sel.id] !== undefined &&
                  (sel.scopeVersion ?? 0) < CURRENT_SCOPE_VERSION[sel.id] && (
                    <div className="flex items-start gap-2 text-[11px] bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2 text-amber-600 dark:text-amber-400">
                      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" className="shrink-0 mt-0.5">
                        <path d="M8 5v3m0 2.5v.5" strokeLinecap="round" />
                        <circle cx="8" cy="8" r="6.5" />
                      </svg>
                      <div className="min-w-0">
                        <div className="font-medium">{tc.reconnectScopeTitle}</div>
                        <div className="mt-0.5 opacity-80">
                          {tc.reconnectScopeDesc}
                        </div>
                      </div>
                    </div>
                  )}

                {/* Connect / Disconnect / Add another / Remove / Drive picker.
                    Hidden for built-in primitives — there is no connection
                    state to manage. */}
                {!builtin && (
                <div className="flex flex-wrap items-center gap-2">
                  {/* Connect — only when this instance isn't connected. There is
                      no Disconnect: turning a connector off is Remove (below),
                      which deletes the instance. Built-ins fall back to a connect
                      placeholder, so re-adding one is a single click. */}
                  {!sel.connected && (
                    <button
                      onClick={() => handleConnect(sel)}
                      disabled={connecting === rid}
                      className="text-xs font-medium bg-primary text-primary-foreground px-3 py-1 rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50"
                    >
                      {connecting === rid ? tc.connectingBtn : tc.connectBtn}
                    </button>
                  )}
                  {/* Connect another account — for multi-instance providers that
                      already have a connected primary. Shown once, on the primary row. */}
                  {sel.connected && sel.addable && sel.isPrimary && (
                    <button
                      onClick={() => handleAddAnother(sel)}
                      className="text-xs font-medium border border-border px-3 py-1 rounded-lg text-muted-foreground hover:text-foreground hover:border-primary/30 transition-colors"
                    >
                      {tc.addAnother}
                    </button>
                  )}
                  {/* Remove — the single removal action on every real instance:
                      custom MCPs, directory connectors, and any built-in instance
                      including the primary and the Google OAuth built-ins.
                      Deleting the primary promotes the next-oldest instance to the
                      canonical tools; removing the last built-in instance brings
                      its connect placeholder back. A placeholder (no instance) has
                      nothing to remove, so the guard is "has an instance, or is
                      custom". */}
                  {(sel.custom || sel.connectorInstanceId) && (
                    <button
                      onClick={() => sel.custom ? handleRemoveCustom(sel) : handleRemove(sel)}
                      className="text-xs font-medium text-destructive/60 hover:text-destructive transition-colors px-2 py-1"
                    >
                      {tc.removeBtn}
                    </button>
                  )}

                  {/* Quick "Add from Drive" picker — only for gdrive when connected. */}
                  {sel.id === "gdrive" && sel.connected && (sel.scopeVersion ?? 0) >= (CURRENT_SCOPE_VERSION.gdrive ?? 0) && (
                    <DrivePicker
                      onPicked={async (picked) => {
                        const res = await authFetch(`${API_URL}/api/connectors/gdrive/authorized-files`, {
                          method: "POST",
                          headers: { "Content-Type": "application/json" },
                          body: JSON.stringify({ files: picked }),
                        });
                        if (res.ok) setExpandTab("settings");
                      }}
                      onError={(msg) => setGdriveError(msg)}
                    >
                      {({ open, isOpening, disabled, disabledReason }) => (
                        <button
                          onClick={open}
                          disabled={isOpening || disabled}
                          title={disabledReason}
                          className="text-xs font-medium bg-primary/10 text-primary hover:bg-primary/20 px-3 py-1 rounded-lg transition-colors disabled:opacity-40"
                        >
                          {isOpening ? tc.gdrivePanel.opening : tc.addFilesFromDrive}
                        </button>
                      )}
                    </DrivePicker>
                  )}

                </div>
                )}

                {/* PAT input form (for GitHub and other API key connectors) */}
                {showPatInput === rid && (
                  <div className="space-y-2">
                    <p className="text-xs text-muted-foreground">
                      {tc.patHelpPrefix}{" "}
                      <code className="bg-muted px-1 py-0.5 rounded text-[11px]">repo</code>{" "}
                      {tc.patHelpScope}{" "}
                      <a
                        href="https://github.com/settings/tokens/new?scopes=repo,read:user&description=sidanclaw"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-primary hover:underline"
                      >
                        {tc.patHelpLink}
                      </a>
                    </p>
                    <input
                      type="password"
                      placeholder={tc.tokenPlaceholderGh}
                      value={patInput}
                      onChange={(e) => setPatInput(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") handleSavePat(sel); }}
                      className="w-full text-sm bg-muted/50 border border-border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary/30"
                      autoFocus
                    />
                    <div className="flex gap-2">
                      <button
                        onClick={() => { setShowPatInput(null); setPatInput(""); }}
                        className="text-xs font-medium border border-border px-3 py-1 rounded-lg text-muted-foreground hover:bg-muted transition-colors"
                      >
                        {tc.cancel}
                      </button>
                      <button
                        onClick={() => handleSavePat(sel)}
                        disabled={!patInput.trim() || connecting === rid}
                        className="text-xs font-medium bg-primary text-primary-foreground px-3 py-1 rounded-lg hover:bg-primary/90 disabled:opacity-50 transition-colors"
                      >
                        {connecting === rid ? tc.savingBtn : tc.saveBtn}
                      </button>
                    </div>
                  </div>
                )}

                {/* GCS bring-your-own storage form — SA key + bucket, validated
                    server-side before the binding is saved. */}
                {showGcsForm === rid && (
                  <div className="space-y-2">
                    <p className="text-xs text-muted-foreground">{tc.gcs.formHelp}</p>
                    <textarea
                      placeholder={tc.gcs.keyPlaceholder}
                      value={gcsKey}
                      onChange={(e) => setGcsKey(e.target.value)}
                      rows={4}
                      className="w-full text-sm font-mono bg-muted/50 border border-border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary/30"
                      autoFocus
                    />
                    <input
                      type="text"
                      placeholder={tc.gcs.bucketPlaceholder}
                      value={gcsBucket}
                      onChange={(e) => setGcsBucket(e.target.value)}
                      className="w-full text-sm bg-muted/50 border border-border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary/30"
                    />
                    <input
                      type="text"
                      placeholder={tc.gcs.projectIdPlaceholder}
                      value={gcsProjectId}
                      onChange={(e) => setGcsProjectId(e.target.value)}
                      className="w-full text-sm bg-muted/50 border border-border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary/30"
                    />
                    <p className="text-[11px] text-muted-foreground">{tc.gcs.leastPriv}</p>
                    <p className="text-[11px] text-muted-foreground">{tc.gcs.regionNote}</p>
                    {gcsError && <p className="text-xs text-destructive">{gcsError}</p>}
                    <div className="flex gap-2">
                      <button
                        onClick={() => { setShowGcsForm(null); setGcsKey(""); setGcsBucket(""); setGcsProjectId(""); setGcsError(null); }}
                        className="text-xs font-medium border border-border px-3 py-1 rounded-lg text-muted-foreground hover:bg-muted transition-colors"
                      >
                        {tc.cancel}
                      </button>
                      <button
                        onClick={() => handleSaveGcs(sel)}
                        disabled={!gcsKey.trim() || !gcsBucket.trim() || connecting === rid}
                        className="text-xs font-medium bg-primary text-primary-foreground px-3 py-1 rounded-lg hover:bg-primary/90 disabled:opacity-50 transition-colors"
                      >
                        {connecting === rid ? tc.gcs.validatingBtn : tc.gcs.connectBtn}
                      </button>
                    </div>
                  </div>
                )}

                {/* "Add another GitHub account" — nickname + PAT, creates a NEW
                    instance. Anchored to the primary row. */}
                {addAnotherFor === sel.id && sel.isPrimary && (
                  <div className="space-y-2 border border-primary/30 rounded-lg p-3">
                    <div className="text-[13px] font-medium">{tc.addAnotherAccount.replace("{name}", sel.name)}</div>
                    <input
                      type="text"
                      placeholder={tc.nicknamePlaceholder}
                      value={addLabel}
                      onChange={(e) => setAddLabel(e.target.value)}
                      className="w-full text-sm bg-muted/50 border border-border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary/30"
                      autoFocus
                    />
                    <input
                      type="password"
                      placeholder={tc.tokenPlaceholderGh}
                      value={addPat}
                      onChange={(e) => setAddPat(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") handleSaveAddAnother(sel.id); }}
                      className="w-full text-sm bg-muted/50 border border-border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary/30"
                    />
                    <div className="flex gap-2">
                      <button
                        onClick={() => { setAddAnotherFor(null); setAddPat(""); setAddLabel(""); }}
                        className="text-xs font-medium border border-border px-3 py-1 rounded-lg text-muted-foreground hover:bg-muted transition-colors"
                      >
                        {tc.cancel}
                      </button>
                      <button
                        onClick={() => handleSaveAddAnother(sel.id)}
                        disabled={!addPat.trim() || connecting === `add:${sel.id}`}
                        className="text-xs font-medium bg-primary text-primary-foreground px-3 py-1 rounded-lg hover:bg-primary/90 disabled:opacity-50 transition-colors"
                      >
                        {connecting === `add:${sel.id}` ? tc.savingBtn : tc.addAccountBtn}
                      </button>
                    </div>
                  </div>
                )}

                {/* Built-in explainer — replaces the workspace-access card.
                    Built-ins are workspace-native; the personal-connection
                    expose/revoke grant flow doesn't apply to them. */}
                {builtin && (
                  <div className="rounded-lg border border-border px-4 py-3">
                    <div className="text-[13px] font-medium">
                      {tc.builtinCardTitle}
                    </div>
                    <p className="mt-0.5 text-[12px] text-muted-foreground">
                      {tc.builtinCardDesc}
                    </p>
                  </div>
                )}

                {/* Workspace access — the ONE place sharing state is stated
                    instead of implied. Shared workspace: the expose / revoke
                    pair over the connector_grant. Solo workspace: an explainer
                    (connected tools auto-load for the member's assistants; no
                    audience to share with until teammates join). */}
                {sel.connected && !builtin && (
                  <div className="rounded-lg border border-border px-4 py-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0">
                        <div className="text-[13px] font-medium">
                          {tc.workspaceAccessTitle}
                        </div>
                        {!sharedWorkspace ? (
                          <p className="mt-0.5 text-[12px] text-muted-foreground">
                            {tc.soloShareNote}
                          </p>
                        ) : instanceId && exposedGrants[instanceId] ? (
                          <p className="mt-0.5 text-[12px] text-muted-foreground">
                            {tc.exposeRowExposed}
                          </p>
                        ) : (
                          <>
                            <p className="mt-0.5 text-[12px] text-muted-foreground">
                              {tc.workspacePersonalNote}
                            </p>
                            <p className="mt-0.5 text-[12px] text-muted-foreground">
                              {tc.exposeRowDesc}
                            </p>
                          </>
                        )}
                        {instanceId && exposeError === instanceId && (
                          <div className="mt-0.5 text-[11px] text-destructive">
                            {tc.exposeRowError}
                          </div>
                        )}
                      </div>
                      {sharedWorkspace && instanceId && (
                        exposedGrants[instanceId] ? (
                          <button
                            type="button"
                            onClick={() => handleRevokeExpose(instanceId)}
                            className="shrink-0 rounded-lg border border-border px-3 py-1 text-xs font-medium text-muted-foreground transition-colors hover:border-destructive/30 hover:text-destructive"
                          >
                            {tc.exposeRowRevoke}
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={() => handleExpose(instanceId)}
                            className="shrink-0 rounded-lg border border-border px-3 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                          >
                            {tc.exposeRowExpose}
                          </button>
                        )
                      )}
                    </div>
                  </div>
                )}

                {/* Tabs: Tools / Settings (settings only for custom + configurable
                    built-ins). Built-in primitives always show their tools —
                    the per-tool allow/ask/block governance is the point of
                    the page for them. */}
                {(sel.connected || builtin) && (
                  <>
                    <div className="flex gap-0 border-b border-border">
                      <button
                        onClick={() => { setExpandTab("tools"); if (!toolsMap[sel.id]) loadTools(sel.id); }}
                        className={`text-xs font-medium px-3 py-1.5 border-b-2 transition-colors ${expandTab === "tools" ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"}`}
                      >
                        {tc.tabTools}
                      </button>
                      {(sel.custom || CONFIGURABLE_CONNECTORS.has(sel.id)) && (
                        <button
                          onClick={() => { setExpandTab("settings"); if ((CONFIGURABLE_CONNECTORS.has(sel.id) || sel.custom) && !configMap[sel.id]) loadConfig(sel.id); }}
                          className={`text-xs font-medium px-3 py-1.5 border-b-2 transition-colors ${expandTab === "settings" ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground"}`}
                        >
                          {tc.tabSettings}
                        </button>
                      )}
                    </div>

                    {/* Tools tab */}
                    {expandTab === "tools" && (() => {
                      const entry = toolsMap[sel.id];
                      return (
                        <ConnectorToolList
                          connectorId={sel.id}
                          loading={entry?.loading}
                          tools={(entry?.tools ?? []).map((tool) => ({
                            name: tool.name,
                            description: tool.description,
                            classification: tool.classification,
                            currentPolicy: tool.policy as ToolPolicy,
                          }))}
                          onPolicyChange={(toolName, policy) =>
                            handlePolicyChange(sel.id, entry?.serverName ?? sel.id, toolName, policy)
                          }
                        />
                      );
                    })()}

                    {/* Settings tab — custom connector or built-in config */}
                    {expandTab === "settings" && sel.custom && (
                      <div className="space-y-3">
                        <input
                          type="text" placeholder={tc.namePlaceholder} value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                          className="w-full text-sm bg-background border border-border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary/30"
                        />
                        <input
                          type="url" placeholder={tc.remoteUrlPlaceholder} value={editUrl}
                          onChange={(e) => setEditUrl(e.target.value)}
                          className="w-full text-sm bg-background border border-border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary/30"
                        />
                        <ConnectorAuthSection
                          fieldClass="w-full text-sm bg-background border border-border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary/30"
                          authType={editAuthType} onAuthType={setEditAuthType}
                          oauthId={editOauthId} onOauthId={setEditOauthId}
                          oauthSecret={editOauthSecret} onOauthSecret={setEditOauthSecret}
                          bearerToken={editBearerToken} onBearerToken={setEditBearerToken}
                          headerName={editHeaderName} onHeaderName={setEditHeaderName}
                          headerValue={editHeaderValue} onHeaderValue={setEditHeaderValue}
                          editing={editAuthType === (sel.authType ?? "none")}
                          error={editAuthError}
                        />
                        {(() => {
                          const probe = probeState[sel.id];
                          if (!probe) return null;
                          if (probe.status === "testing") {
                            return <div className="text-[11px] text-muted-foreground">{tc.testingConnection}</div>;
                          }
                          if (probe.status === "ok") {
                            return (
                              <div className="text-[11px] text-emerald-600 dark:text-emerald-400">
                                {tc.testOk.replace("{count}", String(probe.toolCount ?? 0))}
                              </div>
                            );
                          }
                          return (
                            <div className="text-[11px] text-destructive bg-destructive/10 border border-destructive/30 rounded-lg px-3 py-2">
                              {tc.testFailed.replace("{error}", probe.error ?? "")}
                            </div>
                          );
                        })()}
                        <div className="flex items-center justify-end gap-2">
                          <button
                            onClick={() => handleTestConnection(sel.id)}
                            disabled={probeState[sel.id]?.status === "testing"}
                            className="text-xs font-medium border border-border px-4 py-1.5 rounded-lg text-muted-foreground hover:bg-muted disabled:opacity-50 transition-colors"
                          >
                            {tc.testConnection}
                          </button>
                          <button
                            onClick={() => handleSaveCustom(sel.id)}
                            disabled={!editName.trim() || !editUrl.trim()}
                            className="text-xs font-medium bg-primary text-primary-foreground px-4 py-1.5 rounded-lg hover:bg-primary/90 disabled:opacity-50 transition-colors"
                          >
                            {tc.saveBtn}
                          </button>
                        </div>
                        {configMap[sel.id] !== undefined && (
                          <PreflightHeadersSection
                            key={sel.id}
                            initial={readPreflightHeaders(configMap[sel.id])}
                            onSave={(rows) => saveConfig(sel.id, { preflightHeaders: rows })}
                          />
                        )}
                        {configMap[sel.id] !== undefined && (
                          <ActorIdentityToggle
                            key={`actor-${sel.id}`}
                            initial={configMap[sel.id]?.sendActorIdentity === true}
                            hasAuth={!!sel.authType && sel.authType !== "none"}
                            onSave={(enabled) => saveConfig(sel.id, { sendActorIdentity: enabled })}
                          />
                        )}
                      </div>
                    )}

                    {/* Google Calendar settings */}
                    {expandTab === "settings" && sel.id === "gcal" && !sel.custom && (
                      <div className="space-y-4 py-1">
                        <div className="flex items-center justify-between">
                          <div className="min-w-0 flex-1">
                            <div className="text-[13px] font-medium">{tc.gcalNotifyTitle}</div>
                            <div className="text-[11px] text-muted-foreground mt-0.5">
                              {tc.gcalNotifyDesc}
                            </div>
                          </div>
                          <div className="flex items-center bg-muted rounded-md p-0.5 shrink-0">
                            {([
                              { value: "all", label: tc.gcalNotifyAll },
                              { value: "externalOnly", label: tc.gcalNotifyExternal },
                              { value: "none", label: tc.gcalNotifyNone },
                            ] as const).map(({ value, label }) => (
                              <button
                                key={value}
                                onClick={() => saveConfig("gcal", { sendUpdates: value })}
                                className={`text-[11px] font-medium px-2.5 py-0.5 rounded transition-colors ${
                                  (configMap.gcal?.sendUpdates ?? "all") === value
                                    ? "bg-background text-foreground shadow-sm"
                                    : "text-muted-foreground hover:text-foreground"
                                }`}
                              >
                                {label}
                              </button>
                            ))}
                          </div>
                        </div>
                      </div>
                    )}

                    {/* Google Drive settings — authorized files (Picker-managed) */}
                    {expandTab === "settings" && sel.id === "gdrive" && !sel.custom && (
                      <GDriveAuthorizedFiles />
                    )}
                  </>
                )}
              </div>
            );
          })()}
        </div>
      </div>

      {/* Link to assistant-level permissions */}
      {activeAssistantId && (
        <div className="text-[13px] text-muted-foreground">
          {tc.perAssistantPermsPrefix}{" "}
          <Link
            href={`/w/${workspaceId}/studio/assistants?assistant=${activeAssistantId}&tab=connectors`}
            className="text-primary hover:underline font-medium"
          >
            {tc.assistantConnectorsTab}
          </Link>
          .
        </div>
      )}
    </div>
  );
}

// ── Studio -> Connectors page — master-detail ──
//
// No in-page <h1>: the StudioTopbar breadcrumb names the section
// (docs/architecture/features/studio.md → "Page headers"). The description +
// the Add menu render as the list's intro row.

export default function ConnectorsPage() {
  return <ConnectorsList />;
}
