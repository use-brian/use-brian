import { cookies } from "next/headers";

import { INTERNAL_API_URL as API_URL } from "@/lib/internal-api-url";

/**
 * Server-side fetch helper that forwards the access_token cookie as a
 * Bearer header. Used by server components in the operator app to talk to
 * apps/api on behalf of the signed-in operator. Returns the parsed JSON
 * body or null on any non-2xx — callers decide what to do with null
 * (typically redirect or render an empty state).
 */
export async function serverApiFetch<T>(path: string): Promise<T | null> {
  const jar = await cookies();
  const accessToken = jar.get("access_token")?.value;
  if (!accessToken) return null;

  try {
    const res = await fetch(`${API_URL}${path}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: "no-store",
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch (err) {
    console.warn("[serverApiFetch] failed:", path, err);
    return null;
  }
}
