import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { resolveRedeemWorkspace } from "./resolve-workspace";
import { RedeemForm } from "./redeem-form";

// [COMP:app-web/redeem] — see docs/architecture/features/promo-codes.md
//
// In-app promo redemption. Moved here from `apps/web/src/app/redeem` so the
// "Redeem a code" link in billing settings is SAME-ORIGIN. The old
// cross-origin deep-link read `NEXT_PUBLIC_APP_URL`, which is unset on the
// app-web prod deployment, so it fell back to `http://localhost:3000` and sent
// prod redeem clicks to a dev URL. Marketing `/redeem` now 301s here (it's in
// `MOVED_TO_APP_PREFIXES`), so shareable `?code=` links keep working.
//
// Workspace-scoped: a grant lands on a workspace. We resolve the target
// server-side (the `?ws=` override the billing link passes, else the member's
// first workspace) and thread `?code=` through for shareable links so the form
// can auto-submit.

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

type Workspace = { id: string; name: string };

export default async function RedeemPage(props: {
  searchParams: Promise<{ code?: string; ws?: string }>;
}) {
  const { code, ws } = await props.searchParams;
  const jar = await cookies();
  const accessToken = jar.get("access_token")?.value;
  // The proxy already gates `/redeem` (refreshing or bouncing to login), so a
  // missing token here is the edge where refresh just failed — send to login.
  if (!accessToken) redirect("/login");

  let workspaces: Workspace[] = [];
  try {
    const res = await fetch(`${API_URL}/api/workspaces`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: "no-store",
    });
    if (res.ok) {
      const data = (await res.json()) as { workspaces?: Workspace[] };
      workspaces = data.workspaces ?? [];
    }
  } catch {
    // Network blip — fall through with an empty list; the form renders its
    // no-workspace guard rather than a submittable form.
  }

  const targetWorkspaceId = resolveRedeemWorkspace(workspaces, ws ?? null);

  return (
    <RedeemForm
      targetWorkspaceId={targetWorkspaceId}
      prefilledCode={code ?? ""}
    />
  );
}
