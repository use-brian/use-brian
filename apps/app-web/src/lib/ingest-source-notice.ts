/**
 * Studio → Events: which workspace-attribution notices an ingest-source row
 * should show.
 *
 * A `Personal` (`scope='user'`) connector is account-level — it has no
 * `workspace_id` and `listByUser` is not workspace-filtered, so it renders
 * identically on *every* workspace's events page. The bare scope badge hides
 * two facts the user needs:
 *
 *   - **Routing.** A personal source's events always land in the owner's
 *     **Personal** workspace (`resolveWorkspaceId` falls back to
 *     `is_personal = true`), never the workspace being viewed. This mismatch
 *     only exists on a *non-personal* active workspace, so the routing notice
 *     gates on `activeIsPersonal === false`.
 *   - **Global toggle.** `ingestion_enabled` is one field on the single
 *     account-level row, so enable/disable applies across all the owner's
 *     workspaces — always true for a personal source.
 *
 * Fail-safe: an undefined `activeIsPersonal` (workspace list still loading)
 * suppresses the routing notice rather than asserting a wrong "feeds Personal,
 * not here" before the active workspace resolves. Workspace-scoped rows carry
 * the owning workspace's name and need no framing.
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
  activeIsPersonal: boolean | undefined,
): IngestSourceNotice {
  if (scope !== "user") {
    return { globalToggle: false, routesToPersonal: false };
  }
  return { globalToggle: true, routesToPersonal: activeIsPersonal === false };
}
