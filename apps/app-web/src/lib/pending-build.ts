/**
 * Pending doc build — survive the sub-app auth-refresh redirect.
 *
 * Building a page from the default-viewer landing is a multi-step client
 * action: `handleBuildPage` (doc-shell) calls `createDraft` (an `authFetch`
 * POST), then seeds the build turn. In production a sub-app can't refresh its
 * access token in place — on a 401, `authFetch` navigates the WHOLE browser to
 * `usebrian.ai/api/auth/refresh-and-return?next=<page>` and back. That full-page
 * round-trip reloads app-web and discards the prompt (it lived only in React
 * state), so the user sees "the page just refreshed and gave me no draft" — no
 * session, no draft row, nothing logged server-side, because the turn never ran.
 *
 * Fix: stash the build intent in `sessionStorage` BEFORE the call, and replay it
 * once when the shell remounts after the redirect. `sessionStorage` is per-tab
 * and survives the same-tab navigation round-trip (including a full re-login
 * bounce, as long as the tab stays open). Single-consume + a short TTL keep a
 * failed replay from looping or surprising a later visit.
 *
 * The logic core (`parsePendingBuild`, `isPendingBuildFresh`) is pure and
 * exported for tests — the app-web vitest env has no `sessionStorage`.
 *
 * Spec: docs/architecture/platform/auth.md → "A sub-app refresh discards
 * in-flight work" and docs/architecture/features/doc.md → "Default-viewer
 * landing".
 *
 * [COMP:app-web/pending-build]
 */

import type { ModelTier } from "@/lib/chat-model";

/** A build intent captured at submit time, replayed after an auth redirect. */
export type PendingBuild = {
  /** Workspace the build belongs to — a stash only replays on its own ws. */
  workspaceId: string;
  /** Composer prompt text (already trimmed). */
  text: string;
  /** Model tier chosen on the landing. Optional — mirrors the build turn's
   *  own `ChatSeed["model"]`, which falls back to the chat surface's tier. */
  model?: ModelTier;
  /** Whether the landing armed deep-research mode. */
  researchMode: boolean;
  /** Ready attachment ids — session-agnostic server rows, so they outlive the
   *  reload and the replayed turn can still reference them. */
  fileIds?: string[];
  /** Recording ids staged without processing before the auth redirect. */
  attachedRecordingIds?: string[];
  /** Build into this existing draft (empty-draft landing) vs minting a new one. */
  targetViewId?: string;
  /** Epoch ms when stashed — drives the freshness TTL. */
  ts: number;
};

const STORAGE_KEY = "doc:pending-build";

/**
 * How long a stash stays replayable. Long enough to cover the auth round-trip
 * (even a full re-login on usebrian.ai), short enough that a later, unrelated visit
 * never resurrects a stale prompt.
 */
export const PENDING_BUILD_TTL_MS = 3 * 60 * 1000;

function store(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.sessionStorage : null;
  } catch {
    // Storage access can throw in privacy modes / sandboxed iframes — absent.
    return null;
  }
}

/** Parse + shape-guard a raw stash value. Returns null on anything malformed. */
export function parsePendingBuild(raw: string | null): PendingBuild | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const p = parsed as Record<string, unknown>;
  if (
    typeof p.workspaceId !== "string" ||
    typeof p.text !== "string" ||
    typeof p.researchMode !== "boolean" ||
    typeof p.ts !== "number"
  ) {
    return null;
  }
  // `model` is optional but, when present, must be a string tier.
  if (p.model !== undefined && typeof p.model !== "string") return null;
  if (
    p.attachedRecordingIds !== undefined &&
    (!Array.isArray(p.attachedRecordingIds) ||
      !p.attachedRecordingIds.every((id) => typeof id === "string"))
  ) return null;
  return parsed as PendingBuild;
}

/** Is this stash still valid to replay for `workspaceId` at `nowMs`? */
export function isPendingBuildFresh(
  p: PendingBuild | null,
  workspaceId: string,
  nowMs: number,
): boolean {
  if (!p) return false;
  if (p.workspaceId !== workspaceId) return false;
  const age = nowMs - p.ts;
  // age >= 0 rejects a future-dated stash (clock skew / tampering); < TTL
  // rejects anything older than the resume window.
  return age >= 0 && age < PENDING_BUILD_TTL_MS;
}

/** Persist a build intent before an action that may trigger an auth redirect. */
export function stashPendingBuild(p: PendingBuild): void {
  const s = store();
  if (!s) return;
  try {
    s.setItem(STORAGE_KEY, JSON.stringify(p));
  } catch {
    // Quota / disabled storage — non-critical; the build just won't resume.
  }
}

/** Drop any stashed build (turn started, or a terminal non-redirect failure). */
export function clearPendingBuild(): void {
  const s = store();
  if (!s) return;
  try {
    s.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

/**
 * Read-and-remove the pending build, returning it only when it's fresh for
 * `workspaceId`. ALWAYS removes (single-consume), so a replay that fails again
 * can't loop on the next mount.
 */
export function takePendingBuild(
  workspaceId: string,
  nowMs: number,
): PendingBuild | null {
  const s = store();
  if (!s) return null;
  let raw: string | null = null;
  try {
    raw = s.getItem(STORAGE_KEY);
  } catch {
    raw = null;
  }
  try {
    s.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
  const parsed = parsePendingBuild(raw);
  return isPendingBuildFresh(parsed, workspaceId, nowMs) ? parsed : null;
}
