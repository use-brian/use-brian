import { publicRuntimeConfig } from "@/lib/runtime-public-config";
/**
 * Shopify built-in app API client (app-web).
 *
 * Everything the Shopify surface does goes through `/api/apps/shopify`, which
 * executes tools but never decides them — the callable set comes from the same
 * resolver the sandboxed Home-app bridge uses. So there is no tool list in this
 * file to drift from the server's: `listTools()` asks.
 *
 * [COMP:app-web/shopify-app]
 */

import { authFetch } from "@/lib/auth-fetch";

const API_URL = publicRuntimeConfig().apiUrl ?? "http://localhost:4000";

/**
 * A store read answers in seconds; an assistant turn chains tool calls and can
 * legitimately take a minute. Neither may hang forever — without a deadline a
 * stalled call leaves the page spinning with no error and no way out but a
 * reload, and the call most likely to stall is the one whose spinner looks
 * most normal.
 */
const TIMEOUT_MS = { tool: 45_000, assistant: 180_000 };

export class ShopifyCallError extends Error {
  constructor(message: string, readonly kind: "timeout" | "network" | "http" | "tool") {
    super(message);
    this.name = "ShopifyCallError";
  }
}

async function post<T>(path: string, body: unknown, limit: number): Promise<T> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), limit);
  let res: Response;
  try {
    res = await authFetch(`${API_URL}/api/apps/shopify${path}`, {
      method: "POST",
      signal: ctl.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    // Say which of the two it was: "timed out" sends someone to look at the
    // store, "could not reach" sends them to look at the connection.
    if (err instanceof Error && err.name === "AbortError") {
      throw new ShopifyCallError(
        `Timed out after ${Math.round(limit / 1000)}s.`,
        "timeout",
      );
    }
    throw new ShopifyCallError("Could not reach Use Brian.", "network");
  } finally {
    clearTimeout(timer);
  }

  const payload = (await res.json().catch(() => null)) as
    | { isError?: boolean; data?: unknown; answer?: string; error?: string; detail?: string }
    | null;

  if (!res.ok) {
    throw new ShopifyCallError(payload?.detail || payload?.error || `Request failed (${res.status}).`, "http");
  }
  return payload as T;
}

/**
 * Which Shopify tools this workspace can actually reach.
 *
 * `connected: false` is a real answer, not a failure: it means no store
 * connector is exposed to the workspace, which is something the owner fixes in
 * Studio. The page says that rather than looking broken.
 */
export async function listTools(workspaceId: string): Promise<{ tools: string[]; connected: boolean }> {
  const res = await authFetch(
    `${API_URL}/api/apps/shopify/tools?workspaceId=${encodeURIComponent(workspaceId)}`,
  );
  if (!res.ok) throw new ShopifyCallError(`Could not read the store's tools (${res.status}).`, "http");
  return (await res.json()) as { tools: string[]; connected: boolean };
}

/**
 * Call one Shopify tool.
 *
 * A tool refusing (missing scope, throttled, unknown filter) comes back as
 * `isError` with the tool's own words, and those words are the best
 * explanation available — they name the scope to grant or the field that was
 * wrong. Replacing them with a generic message throws that away.
 */
export async function callTool<T = unknown>(
  workspaceId: string,
  tool: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const out = await post<{ isError: boolean; data: unknown }>(
    "/call",
    { workspaceId, tool, args },
    TIMEOUT_MS.tool,
  );
  if (out.isError) {
    throw new ShopifyCallError(
      typeof out.data === "string" ? out.data : JSON.stringify(out.data),
      "tool",
    );
  }
  return out.data as T;
}

/** Hand a task to the workspace assistant, capped at this surface's own tools. */
export async function askAssistant(workspaceId: string, task: string): Promise<string> {
  const out = await post<{ answer: string }>("/ask", { workspaceId, task }, TIMEOUT_MS.assistant);
  return out.answer;
}

/** Pull the first JSON object out of an assistant reply. Null when there isn't one. */
export function extractJson<T = Record<string, unknown>>(text: string): T | null {
  const m = String(text ?? "").match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    return JSON.parse(m[0]) as T;
  } catch {
    return null;
  }
}
