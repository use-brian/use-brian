/**
 * Studio → Events: which workspace-attribution notices an ingest-source row
 * should show.
 *
 * A `Personal` (`scope='user'`) connector is account-level — it has no
 * `workspace_id`, and its episodes route to the personal workspace its owner
 * OWNS (`resolveInstanceWorkspaceId`: `owner_user_id + is_personal`). Since
 * the placement redesign the API only returns personal sources when the
 * active workspace IS that destination, so this helper's inputs are:
 *
 *   - `scope` — the row's scope badge.
 *   - `activeIsOwnedPersonal` — the API response's `ownedPersonal` flag for
 *     the active workspace. NEVER derive this from the workspace's bare
 *     `isPersonal` label: a legacy personal-flagged multi-member workspace
 *     is not the viewer's personal workspace, and keying off the raw flag
 *     is what suppressed the routing warning in the 2026-07 incident.
 *
 * Notices:
 *
 *   - **Global toggle** (`globalToggle`): `ingestion_enabled` is one field on
 *     the single account-level row, so enable/disable applies across all the
 *     owner's workspaces — always true for a personal source.
 *   - **Routing warning** (`routesToPersonal`): "events feed your Personal
 *     workspace, not <active>". Impossible by construction against a current
 *     API (personal rows only render on the owned personal page) — kept as a
 *     defensive branch for a stale client against an older API that still
 *     unions personal sources into team pages.
 *
 * Fail-safe: an undefined `activeIsOwnedPersonal` (response still loading)
 * suppresses the routing warning rather than asserting a wrong "feeds
 * Personal, not here". Workspace-scoped rows carry the owning workspace's
 * name and need no framing.
 *
 * Spec: docs/architecture/brain/ingest-pipeline.md → "Ingestion control plane"
 * (Personal-source workspace attribution). `[COMP:app-web/studio-ingest]`.
 */
export type IngestSourceNotice = {
  /** Show "on / off applies across all your workspaces". */
  globalToggle: boolean;
  /** Show "events feed your Personal workspace, not <active>" + add-source CTA. */
  routesToPersonal: boolean;
};

export function ingestSourceNotice(
  scope: "user" | "workspace",
  activeIsOwnedPersonal: boolean | undefined,
): IngestSourceNotice {
  if (scope !== "user") {
    return { globalToggle: false, routesToPersonal: false };
  }
  return { globalToggle: true, routesToPersonal: activeIsOwnedPersonal === false };
}
