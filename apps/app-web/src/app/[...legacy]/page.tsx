import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { resolveLegacyPath } from "@/lib/legacy-paths";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

type Team = { id: string; name: string };

/**
 * Legacy bare-path catch-all — `[COMP:app-web/legacy-redirect]`.
 *
 * Serves the pre-consolidation root paths the marketing proxy forwards
 * here path-preserved (`app.sidan.ai/brain`, `/studio/skills`, …; see
 * `MOVED_TO_APP_PREFIXES` in apps/web). Static routes (`/teams`, `/login`,
 * `/w/...`, `/share/...`) take precedence over this catch-all, and unknown
 * paths still `notFound()` — only the allowlisted legacy surfaces redirect.
 *
 * The incoming query string is forwarded onto every redirect target —
 * the OAuth/auth flows thread `?error=` / `?connected=` / `?accountError=`
 * feedback through these paths, and dropping it would lose the message.
 *
 * Workspace resolution mirrors the root landing (`app/page.tsx`):
 *   - id in path   → /w/:id            (`/workspaces/<id>` bookmarks)
 *   - 1 workspace  → /w/:id<suffix>    (straight into the surface)
 *   - 0/n          → /teams            (picker; the sub-path is dropped)
 */
export default async function LegacyPathPage(props: {
  params: Promise<{ legacy: string[] }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [{ legacy }, searchParams] = await Promise.all([
    props.params,
    props.searchParams,
  ]);
  const target = resolveLegacyPath(legacy);
  if (!target) notFound();

  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(searchParams)) {
    if (Array.isArray(value)) {
      for (const v of value) qs.append(key, v);
    } else if (value !== undefined) {
      qs.append(key, value);
    }
  }
  const query = qs.toString() ? `?${qs.toString()}` : "";

  if (target.kind === "teams") redirect(`/teams${query}`);
  if (target.kind === "workspace-id") redirect(`/w/${target.id}${query}`);

  const jar = await cookies();
  const accessToken = jar.get("access_token")?.value;
  if (!accessToken) {
    redirect(`/login${query}`);
  }

  let teams: Team[] = [];
  try {
    const res = await fetch(`${API_URL}/api/workspaces`, {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: "no-store",
    });
    if (res.ok) {
      const data = (await res.json()) as { teams?: Team[] };
      teams = data.teams ?? [];
    }
  } catch (err) {
    // Network blip — fall through to the picker, which renders its own
    // error UI (same posture as the root landing).
    console.warn("[legacy-redirect] teams fetch failed:", err);
  }

  if (teams.length === 1) {
    redirect(`/w/${teams[0].id}${target.suffix}${query}`);
  }
  redirect(`/teams${query}`);
}
