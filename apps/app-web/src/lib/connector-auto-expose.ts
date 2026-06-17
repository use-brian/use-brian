/**
 * Auto-expose gate — decides whether a just-connected personal connector
 * should be automatically shared with the active workspace (app-web).
 *
 * Ported verbatim from `apps/web/src/lib/connector-auto-expose.ts`
 * (app consolidation §9 #5). Pure function, no app-local imports, so it copies
 * cleanly. The `AutoExposeWorkspace` shape matches the app-web
 * `useWorkspaces()` adapter's `Workspace` (`{ id, memberCount? }`).
 *
 * Under the unified-connectors model the Studio -> Connectors page is a single
 * list of personal connectors. Connecting one while a *shared* workspace is
 * active auto-creates a `connector_grant` (exposing it to the workspace at the
 * member's clearance, computed server-side). This pure function is the
 * "should we, and for which instance?" decision so it can be unit-tested
 * without a DOM. It returns `expose: true` only when the connector is
 * connected, its `connector_instance` UUID is known, the active workspace is
 * shared (more than one member — a solo workspace already auto-loads the
 * owner's personal connectors, so there is nobody to share with), and it is not
 * already exposed — the last guard ensures a connector the member deliberately
 * stopped sharing is never silently re-exposed. Shared-ness is keyed on member
 * count, never on `is_personal` (which is only a label).
 *
 * Spec: docs/architecture/integrations/mcp.md → "Unified connectors — the
 * master-detail Studio surface".
 *
 * [COMP:app-web/connector-auto-expose]
 */

/** The connector row the auto-expose decision points at. */
export type AutoExposeConnector = {
  connected: boolean;
  /** The `connector_instance` UUID — grants key on this, not the slug. */
  connectorInstanceId?: string;
};

/** The active workspace, as carried by `useWorkspaces()`. */
export type AutoExposeWorkspace = {
  id: string;
  /**
   * Live member count. Auto-expose only fires when the workspace is *shared*
   * (more than one member); a solo workspace already auto-loads the owner's
   * personal connectors, so exposing there is a no-op. Absent ⇒ treated as
   * solo (1).
   */
  memberCount?: number;
};

export type AutoExposeInput = {
  /** The connector row resolved from the current list, if still present. */
  connector: AutoExposeConnector | undefined;
  /** The active workspace, or null when none is selected. */
  workspace: AutoExposeWorkspace | null;
  /** connectorInstanceId → grantId for the active workspace. */
  exposedGrants: Record<string, string>;
};

export type AutoExposeDecision =
  | { expose: false }
  | { expose: true; connectorInstanceId: string };

/**
 * Decide whether a just-connected connector should be auto-exposed to the
 * active workspace, and for which instance. Returns `{ expose: false }`
 * whenever any precondition is unmet.
 */
export function resolveAutoExpose(input: AutoExposeInput): AutoExposeDecision {
  const { connector, workspace, exposedGrants } = input;

  // The connector vanished from the list, or isn't live yet.
  if (!connector || !connector.connected) return { expose: false };

  // We need the instance UUID to create the grant (lands post-refetch).
  const connectorInstanceId = connector.connectorInstanceId;
  if (!connectorInstanceId) return { expose: false };

  // No active workspace, or a solo one (member count <= 1) — a solo workspace
  // already auto-loads the owner's personal connectors, so nobody to share with.
  if (!workspace || (workspace.memberCount ?? 1) <= 1) return { expose: false };

  // Already shared with this workspace — nothing to do (and never re-expose
  // something the member deliberately revoked).
  if (exposedGrants[connectorInstanceId]) return { expose: false };

  return { expose: true, connectorInstanceId };
}
