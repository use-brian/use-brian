/**
 * Connector removal/disconnect confirmation model.
 *
 * The Studio page owns localized copy and the actual `confirmDialog`; this
 * helper owns the lifecycle facts that choose the verb and warning strength.
 * Keep the provider sets narrow: they describe materially different teardown
 * semantics, not "all official connectors".
 *
 * Spec: docs/architecture/integrations/mcp.md → "Unified connectors — the
 * master-detail Studio surface".
 *
 * [COMP:app-web/connector-removal-confirmation]
 */

type ConnectorRemovalAction = "remove" | "disconnect";

type ConnectorRemovalRisk =
  | "standard"
  | "ingest"
  | "mailArchive"
  | "remoteStorage"
  | "localStorage";

export type ConnectorRemovalConfirmationModel = {
  action: ConnectorRemovalAction;
  risk: ConnectorRemovalRisk;
};

export type ConnectorRemovalCandidate = {
  id: string;
  ingestionEnabled?: boolean;
};

/** Remote BYO storage participates in the 30-day stale-file retraction sweep. */
const REMOTE_BYO_STORAGE = new Set(["gcs", "s3"]);

/** Local storage disconnects but is deliberately absent from that sweep. */
const LOCAL_STORAGE = "local";

export function connectorRemovalConfirmationModel(
  connector: ConnectorRemovalCandidate,
): ConnectorRemovalConfirmationModel {
  if (REMOTE_BYO_STORAGE.has(connector.id)) {
    return { action: "disconnect", risk: "remoteStorage" };
  }
  if (connector.id === LOCAL_STORAGE) {
    return { action: "disconnect", risk: "localStorage" };
  }
  if (connector.id === "imap") {
    return { action: "remove", risk: "mailArchive" };
  }
  if (connector.ingestionEnabled) {
    return { action: "remove", risk: "ingest" };
  }
  return { action: "remove", risk: "standard" };
}
