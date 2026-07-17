/**
 * Desktop target model — which brain the shell fronts.
 *
 * Phase 2 of docs/plans/consumer-local-experience.md (§2.1): the downloaded
 * shell fronts ONE target at a time — Use Brian Cloud or a local / self-hosted
 * brain. A target is a triple `{ appUrl (uiSource), apiUrl, auth }`, resolved
 * with the precedence env override (dev) > persisted userData record > cloud
 * default. Switching targets persists the record and relaunches the shell, so
 * a resolved config stays a process-lifetime constant.
 *
 * The persisted record keeps the last local `appUrl` even while `kind` is
 * `cloud`, so "switch back to Local Brain" reuses the remembered address.
 *
 * Pure: serde + URL derivation only. The userData file I/O, the `/health`
 * probe, and the relaunch live in `main.ts`; `resolveConfig` (config.ts)
 * consumes `resolveTargetFromPersisted`'s output.
 *
 * Spec: docs/architecture/features/app-desktop.md → "Dual target"
 * [COMP:app-desktop/target-store]
 */

export type TargetKind = "cloud" | "local";

/**
 * How the shell authenticates the target: the system-browser PKCE flow
 * (cloud), or the oss local-owner session minted by navigating in-window to
 * the app-web `local-session` trigger route (local — no login exists there).
 */
export type TargetAuth = "pkce" | "local-session";

/** The cloud target endpoints — the single source `config.ts` defaults to. */
export const CLOUD_APP_URL = "https://app.usebrian.ai";
export const CLOUD_API_URL = "https://api.usebrian.ai";

/** Where a launcher-run local brain serves the app (its API pairs at :4000). */
export const DEFAULT_LOCAL_APP_URL = "http://localhost:3003";

/** The persisted target record's filename under Electron's `userData` dir. */
export const TARGET_FILE_NAME = "target.json";

/**
 * Host prefixes that identify an authenticated-app origin; each maps to the
 * sibling `api.<domain>` backend. `canvas.` is the pre-consolidation origin,
 * `app.` the post-flip one. Shared by the cloud/dev derivation and the
 * self-hosted derivation below.
 */
const APP_HOST_PREFIXES = ["app.", "canvas."] as const;

/**
 * Pair the API base URL to the app base URL (cloud/dev semantics — the
 * historical `resolveConfig` derivation, moved here so both derivations live
 * together): `localhost` → the local API, `app.`/`canvas.` host → the `api.`
 * sibling, anything else → the production API default.
 */
export function deriveApiUrl(appUrl: string): string {
  try {
    const u = new URL(appUrl);
    if (u.hostname === "localhost" || u.hostname === "127.0.0.1") {
      return "http://localhost:4000";
    }
    for (const prefix of APP_HOST_PREFIXES) {
      if (u.hostname.startsWith(prefix)) {
        return `${u.protocol}//api.${u.hostname.slice(prefix.length)}`;
      }
    }
  } catch {
    /* fall through to the default */
  }
  return CLOUD_API_URL;
}

/**
 * Pair the API base URL to a LOCAL/self-hosted app URL. Unlike `deriveApiUrl`
 * this NEVER falls back to the cloud API — a self-hosted target's traffic must
 * only ever reach its own paired backend (§2.3 "paired API only"): `localhost`
 * → `localhost:4000`, an `app.`/`canvas.`-prefixed host → its `api.` sibling
 * (a reverse-proxied self-host), anything else → the same host on `:4000`
 * (the launcher convention).
 */
export function deriveLocalApiUrl(appUrl: string): string {
  try {
    const u = new URL(appUrl);
    if (u.hostname === "localhost" || u.hostname === "127.0.0.1") {
      return "http://localhost:4000";
    }
    for (const prefix of APP_HOST_PREFIXES) {
      if (u.hostname.startsWith(prefix)) {
        return `${u.protocol}//api.${u.hostname.slice(prefix.length)}`;
      }
    }
    return `${u.protocol}//${u.hostname}:4000`;
  } catch {
    return "http://localhost:4000";
  }
}

/** A fully resolved target — what `resolveConfig` folds into the config. */
export interface ResolvedTarget {
  readonly kind: TargetKind;
  /** Base URL the shell loads (no trailing slash). */
  readonly appUrl: string;
  /** The paired backend (no trailing slash). */
  readonly apiUrl: string;
  readonly auth: TargetAuth;
  /** Human indicator for the menu/tray/title, e.g. `Local Brain (localhost:3003)`. */
  readonly label: string;
}

/** The persisted userData record (`target.json`). */
export interface PersistedTarget {
  readonly v: 1;
  readonly kind: TargetKind;
  /** The last local brain address; kept across a switch to cloud. */
  readonly appUrl?: string;
}

/**
 * Normalize a user-entered target URL: require a parseable `http(s)` URL,
 * drop query/hash, and strip trailing slashes so path concatenation stays
 * unambiguous. Returns `null` for anything else (the caller surfaces
 * `invalid-url` instead of guessing).
 */
export function normalizeTargetUrl(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  const path = u.pathname.replace(/\/+$/, "");
  return `${u.origin}${path}`;
}

/** The cloud target (the shipped default). */
export function cloudTarget(): ResolvedTarget {
  return Object.freeze({
    kind: "cloud" as const,
    appUrl: CLOUD_APP_URL,
    apiUrl: CLOUD_API_URL,
    auth: "pkce" as const,
    label: "Use Brian Cloud",
  });
}

/**
 * Resolve a local/self-hosted target from a (possibly user-entered) URL.
 * Returns `null` when the URL doesn't normalize — never a half-built target.
 */
export function localTarget(rawUrl: string = DEFAULT_LOCAL_APP_URL): ResolvedTarget | null {
  const appUrl = normalizeTargetUrl(rawUrl);
  if (!appUrl) return null;
  return Object.freeze({
    kind: "local" as const,
    appUrl,
    apiUrl: deriveLocalApiUrl(appUrl),
    auth: "local-session" as const,
    label: `Local Brain (${new URL(appUrl).host})`,
  });
}

/**
 * Tolerantly parse the persisted record. Anything malformed — unreadable JSON,
 * a non-object, an unknown `kind` — is `null` (the caller falls back to
 * cloud). An `appUrl` that doesn't normalize is dropped rather than poisoning
 * the record, so a hand-edited file degrades to the default local address.
 */
export function parsePersistedTarget(raw: string | null | undefined): PersistedTarget | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const rec = parsed as Record<string, unknown>;
  if (rec.kind !== "cloud" && rec.kind !== "local") return null;
  const appUrl = typeof rec.appUrl === "string" ? normalizeTargetUrl(rec.appUrl) : null;
  return Object.freeze({ v: 1 as const, kind: rec.kind, ...(appUrl ? { appUrl } : {}) });
}

/** Serialize the record `main.ts` writes to `target.json`. */
export function serializePersistedTarget(kind: TargetKind, appUrl?: string): string {
  const normalized = appUrl ? normalizeTargetUrl(appUrl) : null;
  return JSON.stringify({ v: 1, kind, ...(normalized ? { appUrl: normalized } : {}) });
}

/**
 * The resolution `resolveConfig` consumes: no/invalid record → cloud; a local
 * record → its remembered address (or the launcher default). A local record
 * whose address can't resolve falls back to cloud rather than a broken target.
 */
export function resolveTargetFromPersisted(raw: string | null | undefined): ResolvedTarget {
  const rec = parsePersistedTarget(raw);
  if (!rec || rec.kind === "cloud") return cloudTarget();
  return localTarget(rec.appUrl ?? DEFAULT_LOCAL_APP_URL) ?? cloudTarget();
}

/**
 * Window-title decoration (§2.3 "visible active-target indicator"): a local
 * target suffixes every page title with the target label so the two brains are
 * never mistaken for each other; the cloud target keeps titles untouched.
 */
export function targetWindowTitle(
  pageTitle: string,
  target: Pick<ResolvedTarget, "kind" | "label">,
): string {
  if (target.kind !== "local") return pageTitle;
  const title = pageTitle.trim();
  return title ? `${title} · ${target.label}` : target.label;
}

/** The app-web trigger route that mints the oss local-owner session in-window. */
export function localMintUrl(appUrl: string): string {
  return `${appUrl}/api/auth/local-session`;
}

/** The paired API's health endpoint (the cheap pre-switch probe). */
export function healthUrl(apiUrl: string): string {
  return `${apiUrl}/health`;
}
