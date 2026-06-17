// [COMP:app-web/redeem] — see docs/architecture/features/promo-codes.md
//
// Pure target-workspace resolution for the in-app redeem page. A promo
// grant lands on a workspace, so the page must pick one before POSTing
// to /api/promo/redeem. Precedence:
//   1. the `?ws=` override (the billing link passes the workspace the
//      member is currently viewing — the exact billing target),
//   2. otherwise the first workspace the member belongs to (the common
//      single-workspace case).
// Returns null when the member has no workspaces (the form then renders
// its no-workspace guard instead of a submittable form).

export function resolveRedeemWorkspace(
  workspaces: { id: string }[],
  override: string | null | undefined,
): string | null {
  if (override && workspaces.some((w) => w.id === override)) return override;
  return workspaces[0]?.id ?? null;
}
