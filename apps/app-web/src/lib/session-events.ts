/** Session lifecycle signals contain identity scope, never credentials. [COMP:app-web/app-session] */
type SessionEvent = { type: "required" | "logout"; identity?: string | null };
const listeners = new Set<(event: SessionEvent) => void>();
export function subscribeSessionEvents(listener: (event: SessionEvent) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function notifySessionRequired(identity?: string | null): boolean {
  for (const listener of listeners) listener({ type: "required", identity });
  return listeners.size > 0;
}
export function notifySessionLogout(): void {
  for (const listener of listeners) listener({ type: "logout" });
}

/** JWT subject is used solely to isolate caches/events; server probes establish authority. */
export function sessionIdentity(token: string | null, fallback?: string | null): string | null {
  let subject = fallback;
  try {
    const claims = JSON.parse(atob((token?.split(".")[1] ?? "").replace(/-/g, "+").replace(/_/g, "/")));
    if (typeof claims.sub === "string" && claims.sub) subject = claims.sub;
  } catch { /* A native display ID can scope older token bridges. */ }
  if (!subject || typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  return JSON.stringify([params.get("app") || window.location.origin, params.get("api") || window.location.origin, subject]);
}
