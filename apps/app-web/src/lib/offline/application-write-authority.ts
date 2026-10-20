/** Native outbox isolation and live replay admission. [COMP:app-web/application-authority-cache] */
import { getValidAccessToken } from "@/lib/auth-fetch";
import { workspaceIdFromPath } from "@/lib/connector-auto-expose";
import { usesGatewayCredentials } from "@/lib/desktop-auth-source";
import { getDictionary } from "@/lib/i18n/dictionaries";
import { isLocale } from "@/lib/i18n/config";
import { publicRuntimeConfig } from "@/lib/runtime-public-config";
import { getUserInfo } from "@/lib/user";
import type { QueuedWrite } from "./write-queue";

export type OfflineWriteAuthority = {
  viewerId: string;
  workspaceId: string;
  applicationId: "native";
  apiOrigin: string;
};

export function offlineWriteUnavailable(): Error {
  const locale = typeof document === "undefined" ? undefined
    : document.cookie.match(/(?:^|;\s*)locale=([^;]+)/)?.[1];
  return new Error(getDictionary(isLocale(locale) ? locale : "en").docPage.offlinePageSessionMissing);
}

/** Routing metadata only. The server authenticates every later read and mutation. */
export function currentOfflineWriteAuthority(workspaceId?: string): OfflineWriteAuthority | null {
  const viewerId = getUserInfo()?.id;
  const activeWorkspace = typeof window === "undefined" ? null : workspaceIdFromPath(window.location.pathname);
  const workspace = workspaceId ?? activeWorkspace;
  if (!viewerId || !workspace || activeWorkspace && activeWorkspace !== workspace) return null;
  return { viewerId, workspaceId: workspace, applicationId: "native",
    apiOrigin: (publicRuntimeConfig().apiUrl ?? "http://localhost:4000").replace(/\/$/, "") };
}

export function sameOfflineWriteAuthority(a: OfflineWriteAuthority | undefined | null,
  b: OfflineWriteAuthority | undefined | null): boolean {
  return !!a && !!b && a.viewerId === b.viewerId && a.workspaceId === b.workspaceId
    && a.applicationId === b.applicationId && a.apiOrigin === b.apiOrigin;
}

export function offlineWriteQueueKey(authority: OfflineWriteAuthority): string {
  return `offline:write-queue:v2:${[authority.apiOrigin, authority.viewerId, authority.workspaceId,
    authority.applicationId].map(encodeURIComponent).join(":")}`;
}

function tokenSubject(token: string): string | null {
  try {
    const claims = JSON.parse(atob(token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/")));
    return typeof claims.sub === "string" ? claims.sub : null;
  } catch { return null; }
}

/** This fixed native route catalog is the same metadata mutation path as online editing. */
function mutation(op: QueuedWrite): { id: string; body: Record<string, unknown> } {
  const payload = op.payload;
  if (!payload || typeof payload !== "object" || !("id" in payload) || typeof payload.id !== "string") {
    throw offlineWriteUnavailable();
  }
  const value = payload as Record<string, unknown>;
  switch (op.kind) {
    case "view.rename": if (typeof value.name === "string") return { id: payload.id, body: { name: value.name } }; break;
    case "view.icon": if (value.icon === null || typeof value.icon === "string") return { id: payload.id, body: { icon: value.icon } }; break;
    case "view.fullWidth": if (typeof value.fullWidth === "boolean") return { id: payload.id, body: { fullWidth: value.fullWidth } }; break;
    case "view.clearance": if (["public", "internal", "confidential"].includes(String(value.clearance)))
      return { id: payload.id, body: { clearance: value.clearance } }; break;
  }
  throw offlineWriteUnavailable();
}

/**
 * Fresh server admission, then a single pinned-session dispatch. No cached page,
 * client receipt or transparent account-refresh retry can authorize the write.
 */
export async function prepareQueuedMetadataWrite(op: QueuedWrite): Promise<() => Promise<void>> {
  const authority = op.authority;
  if (!authority || !sameOfflineWriteAuthority(authority, currentOfflineWriteAuthority())) throw offlineWriteUnavailable();
  const request = mutation(op);
  const token = await getValidAccessToken();
  const assertIdentity = () => {
    if (!token || tokenSubject(token) !== authority.viewerId
      || !sameOfflineWriteAuthority(authority, currentOfflineWriteAuthority())) throw offlineWriteUnavailable();
  };
  assertIdentity();
  const headers = { Authorization: `Bearer ${token}` };
  const credentials = usesGatewayCredentials() ? "include" : "omit";
  const response = await fetch(`${authority.apiOrigin}/api/views/${encodeURIComponent(request.id)}`, {
    headers, credentials, cache: "no-store",
  });
  if (!response.ok) throw offlineWriteUnavailable();
  const page: unknown = await response.json();
  if (!page || typeof page !== "object" || !("id" in page) || page.id !== request.id
    || !("workspaceId" in page) || page.workspaceId !== authority.workspaceId) throw offlineWriteUnavailable();
  assertIdentity();
  return async () => {
    assertIdentity();
    const written = await fetch(`${authority.apiOrigin}/api/saved-views/${encodeURIComponent(request.id)}`, {
      method: "PATCH", headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(request.body), credentials,
    });
    if (written.status !== 200) throw offlineWriteUnavailable();
    // A transport success without the canonical result is still uncertain.
    const result: unknown = await written.json();
    if (!result || typeof result !== "object" || !("id" in result) || result.id !== request.id
      || !("workspaceId" in result) || result.workspaceId !== authority.workspaceId) throw offlineWriteUnavailable();
  };
}

/** One native invocation's bearer, never a reusable authorization receipt. */
export type PinnedOfflineSession = {
  readonly authority: Readonly<OfflineWriteAuthority>;
  assertCurrent: () => void;
  bearer: () => string;
  request: (path: string, init?: RequestInit) => Promise<Response>;
};

/** Bind refresh, fetch and reconnect callbacks to the intent's original actor. */
export async function pinOfflineWriteSession(raw: OfflineWriteAuthority): Promise<PinnedOfflineSession> {
  const authority = Object.freeze(structuredClone(raw));
  if (!sameOfflineWriteAuthority(authority, currentOfflineWriteAuthority(authority.workspaceId))) throw offlineWriteUnavailable();
  const token = await getValidAccessToken();
  const assertCurrent = () => {
    if (!token || tokenSubject(token) !== authority.viewerId
      || !sameOfflineWriteAuthority(authority, currentOfflineWriteAuthority(authority.workspaceId))) throw offlineWriteUnavailable();
  };
  assertCurrent();
  const credentials = usesGatewayCredentials() ? "include" : "omit";
  return Object.freeze({ authority, assertCurrent,
    bearer: () => { assertCurrent(); return token!; },
    request: async (path: string, init?: RequestInit) => {
      assertCurrent();
      const url = new URL(`${authority.apiOrigin}${path}`);
      if (!path.startsWith("/api/") || url.origin !== new URL(authority.apiOrigin).origin) throw offlineWriteUnavailable();
      const headers = new Headers(init?.headers);
      headers.set("Authorization", `Bearer ${token}`);
      const response = await fetch(url.href, { ...init, headers, credentials, redirect: "error", cache: "no-store" });
      assertCurrent();
      return response;
    },
  });
}

/** Local routing/isolation metadata only; computing a key grants no read access. */
export function offlinePageDocumentKey(pageId: string, authority: OfflineWriteAuthority | null = currentOfflineWriteAuthority()): string | null {
  return authority ? `doc-page-v2:${[authority.apiOrigin, authority.viewerId, authority.workspaceId,
    authority.applicationId, pageId].map(encodeURIComponent).join(":")}` : null;
}
