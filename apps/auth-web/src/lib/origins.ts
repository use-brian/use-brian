import type { PortalConfig } from "./config";

export function safeReturnUrl(raw: string | null | undefined, config: PortalConfig): URL | null {
  if (!raw || raw.startsWith("//")) return null;
  try {
    if (raw.startsWith("/")) {
      const url = new URL(raw, config.portalOrigin);
      return url.origin === config.portalOrigin && url.pathname === "/invite" ? url : null;
    }
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin === config.appOrigin || url.origin === config.portalOrigin ? url : null;
  } catch {
    return null;
  }
}

export function loginUrl(config: PortalConfig, next?: URL | null, error?: string): URL {
  const url = new URL("/login", config.portalOrigin);
  if (next) url.searchParams.set("next", next.toString());
  if (error) url.searchParams.set("error", error);
  return url;
}
