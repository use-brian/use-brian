/**
 * Unit tests for the collab-socket signal store in `use-offline-sync` — the
 * seam doc-shell publishes through so the WorkspaceChrome-mounted driver can
 * fold the sync socket's health into the global connectivity classification.
 *
 * [COMP:app-web/use-offline-sync]
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api/views", () => ({
  renameView: vi.fn(),
  setViewIcon: vi.fn(),
  setViewFullWidth: vi.fn(),
  setViewClearance: vi.fn(),
}));

import {
  publishCollabConnected,
  getCollabConnected,
} from "../use-offline-sync";

describe("[COMP:app-web/use-offline-sync] collab-socket signal store", () => {
  it("defaults to connected (no open doc must not read as degraded)", () => {
    expect(getCollabConnected()).toBe(true);
  });

  it("publishes down and back up", () => {
    publishCollabConnected(false);
    expect(getCollabConnected()).toBe(false);
    publishCollabConnected(true);
    expect(getCollabConnected()).toBe(true);
  });

  it("is idempotent on repeated publishes of the same value", () => {
    publishCollabConnected(true);
    publishCollabConnected(true);
    expect(getCollabConnected()).toBe(true);
  });
});
