import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { ossSignedOutRedirect } from "@/lib/oss-entry";

// `||` not `??`: an empty-string NEXT_PUBLIC_API_URL (e.g. inlined as "" by the
// bundler when unset at build) must also fall back, else this server-side fetch
// gets the relative "/api/workspaces" and throws ERR_INVALID_URL.
const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";

type Team = { id: string; name: string };

/**
 * Landing route. Resolves the user's destination based on workspace
 * membership:
 *
 *   - 1 workspace        → /w/:workspaceId    (skip the picker → doc)
 *   - 0 or n workspaces  → /teams             (picker)
 *
 * The membership fetch carries the user's access_token so the backend
 * applies RLS. A fetch error leaves the list empty and falls through to
 * /teams, which re-fetches and renders real workspaces (or bounces to
 * /login). A genuinely empty list is effectively unreachable — every
 * user has a Personal workspace auto-created at signup.
 *
 * Signed out, the destination depends on the edition — see
 * `lib/oss-entry.ts`. The hosted edition goes to /login for Google OAuth;
 * the open edition has no login, so its root IS the local-owner session.
 * This path is not proxy-guarded (`/` is absent from GUARDED_PREFIXES), so
 * this redirect is the only thing standing between a self-hosted visitor
 * and a Google button that can never complete.
 */
export default async function HomePage(props: {
  searchParams: Promise<{ capture?: string }>;
}) {
  const jar = await cookies();
  const accessToken = jar.get("access_token")?.value;
  if (!accessToken) {
    redirect(ossSignedOutRedirect() ?? "/login");
  }

  // Desktop quick-capture (`?capture=1`): preserve it through the single-
  // workspace redirect so `doc-shell` can open a fresh draft. Multi-
  // workspace users land on the picker (which drops it) — see
  // docs/architecture/features/app-desktop.md → "quick-capture.ts".
  const { capture } = await props.searchParams;
  const captureSuffix = capture === "1" ? "?capture=1" : "";

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
    // Network blip — show the picker which renders its own error UI.
    console.warn("[home] teams fetch failed:", err);
  }

  if (teams.length === 1) {
    redirect(`/w/${teams[0].id}${captureSuffix}`);
  }
  redirect("/teams");
}
