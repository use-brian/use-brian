/**
 * Connector removal/disconnect confirmation model.
 * Component tag: [COMP:app-web/connector-removal-confirmation].
 */

import { describe, expect, it } from "vitest";
import { connectorRemovalConfirmationModel } from "../connector-removal-confirmation";

describe(
  "[COMP:app-web/connector-removal-confirmation] connectorRemovalConfirmationModel",
  () => {
    it("uses the ordinary Remove warning for a stateless connector", () => {
      expect(
        connectorRemovalConfirmationModel({ id: "gmail", ingestionEnabled: false }),
      ).toEqual({ action: "remove", risk: "standard" });
    });

    it("strengthens Remove when connector ingestion is enabled", () => {
      expect(
        connectorRemovalConfirmationModel({ id: "github", ingestionEnabled: true }),
      ).toEqual({ action: "remove", risk: "ingest" });
    });

    it("gives the mailbox archive cascade precedence over generic ingest state", () => {
      expect(
        connectorRemovalConfirmationModel({ id: "imap", ingestionEnabled: true }),
      ).toEqual({ action: "remove", risk: "mailArchive" });
    });

    it.each(["gcs", "s3"])(
      "uses Disconnect plus the 30-day prune warning for %s",
      (id) => {
        expect(connectorRemovalConfirmationModel({ id })).toEqual({
          action: "disconnect",
          risk: "remoteStorage",
        });
      },
    );

    it("uses Disconnect without a false 30-day-prune claim for local storage", () => {
      expect(connectorRemovalConfirmationModel({ id: "local" })).toEqual({
        action: "disconnect",
        risk: "localStorage",
      });
    });
  },
);
