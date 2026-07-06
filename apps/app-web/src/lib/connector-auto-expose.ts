/**
 * Auto-expose gate — decides whether a just-connected personal connector
 * should be automatically shared with the active workspace (app-web).
 *
 * Under the unified-connectors model the Studio -> Connectors page is a single
 * list of personal connectors. Connecting one while a workspace is active
 * auto-creates a `connector_grant` (exposing it to the workspace at the
 * member's clearance, computed server-side). This pure function is the
 * "should we, and for which instance?" decision so it can be unit-tested
 * without a DOM.
 *
 * Multi-instance resolution: the arm names the just-connected connector by
 * `connector_instance` UUID whenever the connect path knows it — the
 * store-credentials response carries `connectorInstanceId`, and the OAuth
 * callbacks thread it back as `?instance=<uuid>` alongside `?connected=`. A
 * slug-only arm (legacy single-account connect) resolves ONLY while exactly
 * one of the member's connected instances carries that provider slug; with
 * two or more the gate refuses to guess and never exposes. Picking "the
 * first list match" here is how the 2026-07-06 GitHub misfire shipped a
 * client-workspace connector into the team workspace: the list is
 * oldest-first, so a slug lookup always found the OLDEST instance, not the
 * just-connected one. Exposing the wrong account is a data-boundary breach,
 * so ambiguity fails closed — the member can still share manually.
 *
 * Decisions carry a `pending` flag when they don't expose: `pending: true`
 * means the instance hasn't landed in the list yet (the post-connect refetch
 * is in flight) and the caller should keep the arm; `pending: false` is
 * terminal (no workspace, ambiguous slug, already exposed) and the caller
 * must clear the arm so the effect doesn't spin.
 *
 * Solo workspaces expose too (since the workspace-exposure gating of
 * `listUsableWorkspaceConnectors`): exposure — not ownership — is what puts a
 * connector on a workspace's config surfaces (the Knowledge GitHub picker), so
 * connect-in-context must mint the grant everywhere or a solo member's
 * just-connected connector would never reach the picker. The already-exposed
 * guard ensures a connector the member deliberately stopped sharing is never
 * silently re-exposed within the page's lifetime.
 *
 * Spec: docs/architecture/integrations/mcp.md → "Unified connectors — the
 * master-detail Studio surface".
 *
 * [COMP:app-web/connector-auto-expose]
 */

/** The connector rows the auto-expose decision resolves against. */
export type AutoExposeConnector = {
  /** Provider slug — shared by every instance of the provider. */
  id: string;
  connected: boolean;
  /** The `connector_instance` UUID — grants key on this, not the slug. */
  connectorInstanceId?: string;
  /** A teammate's workspace-shared row — never the member's to expose. */
  readonly?: boolean;
};

/** What the connect flow knows about the connector it just connected. */
export type AutoExposeArm = {
  /** Provider slug — always known. */
  slug: string;
  /**
   * The `connector_instance` UUID the connect path minted or reconnected.
   * Present whenever the flow could learn it (store-credentials response,
   * OAuth `?instance=` return); its absence forces the single-candidate rule.
   */
  instanceId?: string;
};

/** The active workspace, as carried by `useWorkspaces()`. */
export type AutoExposeWorkspace = {
  id: string;
  /**
   * Live member count. Not part of the expose decision (solo workspaces
   * expose too — the grant is what surfaces a connector on workspace config
   * pickers); kept on the shape because callers pass the `useWorkspaces()`
   * row through unchanged.
   */
  memberCount?: number;
};

export type AutoExposeInput = {
  /** The full connector list (rail rows) at decision time. */
  connectors: readonly AutoExposeConnector[];
  /** The just-connected arm, or null when nothing is armed. */
  arm: AutoExposeArm;
  /** The active workspace, or null when none is selected. */
  workspace: AutoExposeWorkspace | null;
  /** connectorInstanceId → grantId for the active workspace. */
  exposedGrants: Record<string, string>;
};

export type AutoExposeDecision =
  | { expose: true; connectorInstanceId: string }
  | { expose: false; pending: boolean };

/**
 * Decide whether a just-connected connector should be auto-exposed to the
 * active workspace, and for which instance. Never guesses between multiple
 * instances of one provider — a slug-only arm with two or more connected
 * instances is a terminal no.
 */
export function resolveAutoExpose(input: AutoExposeInput): AutoExposeDecision {
  const { connectors, arm, workspace, exposedGrants } = input;

  // No active workspace to expose to. Solo workspaces are NOT skipped: the
  // grant is what puts the connector on this workspace's config surfaces.
  if (!workspace) return { expose: false, pending: false };

  // Resolve the just-connected row — instance UUID beats slug.
  let target: AutoExposeConnector | undefined;
  if (arm.instanceId) {
    target = connectors.find((c) => c.connectorInstanceId === arm.instanceId);
    // Not in the list yet (post-connect refetch pending) — wait.
    if (!target) return { expose: false, pending: true };
  } else {
    // The member's own connected instances of this provider. Readonly rows
    // are a teammate's exposure into this workspace — never ours to grant.
    const candidates = connectors.filter(
      (c) => c.id === arm.slug && !c.readonly && c.connected && c.connectorInstanceId,
    );
    if (candidates.length === 0) {
      // Keep waiting only while the provider is present at all (its instance
      // UUID / connected flip lands on refetch); a vanished slug is terminal.
      return {
        expose: false,
        pending: connectors.some((c) => c.id === arm.slug && !c.readonly),
      };
    }
    if (candidates.length > 1) {
      // Ambiguous: several instances share the slug and the connect path
      // didn't say which one it touched. Fail closed.
      return { expose: false, pending: false };
    }
    target = candidates[0];
  }

  // UUID-armed row still flipping to connected / receiving its UUID — wait.
  if (!target.connected) return { expose: false, pending: true };
  const connectorInstanceId = target.connectorInstanceId;
  if (!connectorInstanceId) return { expose: false, pending: true };

  // Already shared with this workspace — nothing to do (and never re-expose
  // something the member deliberately revoked).
  if (exposedGrants[connectorInstanceId]) return { expose: false, pending: false };

  return { expose: true, connectorInstanceId };
}
