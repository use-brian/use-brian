import { publicRuntimeConfig } from "@/lib/runtime-public-config";
import { authFetch } from "@/lib/auth-fetch";

const API_URL = publicRuntimeConfig().apiUrl ?? "http://localhost:4000";

/**
 * A web link's preview for the Chat side pane's `url` tab (chat-parity T9):
 * the bookmark block's OG probe (`POST /api/doc/og-preview`, SSRF-guarded
 * server side), which also reports whether the page may be framed.
 */
export type LinkPreview = {
  url: string;
  title?: string;
  description?: string;
  siteName?: string;
  favicon?: string;
  /** Absent from an older server: treat as not embeddable. */
  embeddable?: boolean;
};

/** Fetch a link preview; `null` when the probe refused or failed. */
export async function fetchLinkPreview(url: string, signal?: AbortSignal): Promise<LinkPreview | null> {
  try {
    const res = await authFetch(`${API_URL}/api/doc/og-preview`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url }),
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as LinkPreview;
    return body && typeof body.url === "string" ? body : null;
  } catch {
    return null;
  }
}
