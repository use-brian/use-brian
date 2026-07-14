/**
 * Connector rail grouping (app-web).
 * Component tag: [COMP:app-web/connector-groups].
 *
 * Pure unit tests — `connector-groups.ts` has no runtime imports. Covers the
 * buckets (shared / personal / available / workspace / builtin) — identical in
 * every workspace, solo included (the solo collapse died with the solo
 * injection default, 2026-07-14) — grant-less connected instances, placeholder
 * rows without an instance UUID, and the builtin bucket's connected-state
 * independence + custom-slug guard.
 *
 * Spec: docs/architecture/integrations/mcp.md → "Unified connectors — the
 * master-detail Studio surface".
 */

import { describe, expect, it } from "vitest";
import { groupConnectors } from "../connector-groups";

const rows = {
  exposedGithub: { connectorInstanceId: "inst-gh", connected: true, name: "GitHub" },
  personalNotion: { connectorInstanceId: "inst-no", connected: true, name: "Notion" },
  disconnectedGcal: { connectorInstanceId: "inst-gc", connected: false, name: "Calendar" },
  placeholderGmail: { connected: false, name: "Gmail" },
} as const;

const all = [
  rows.exposedGithub,
  rows.personalNotion,
  rows.disconnectedGcal,
  rows.placeholderGmail,
];

describe("[COMP:app-web/connector-groups] groupConnectors", () => {
  it("buckets a granted instance as shared", () => {
    const grouped = groupConnectors(all, {
      exposedGrants: { "inst-gh": "grant-1" },
    });
    expect(grouped.shared).toEqual([rows.exposedGithub]);
    expect(grouped.personal).toEqual([rows.personalNotion]);
    expect(grouped.available).toEqual([
      rows.disconnectedGcal,
      rows.placeholderGmail,
    ]);
  });

  it("keeps every connected row personal when nothing is granted", () => {
    const grouped = groupConnectors(all, {
      exposedGrants: {},
    });
    expect(grouped.shared).toEqual([]);
    expect(grouped.personal).toEqual([
      rows.exposedGithub,
      rows.personalNotion,
    ]);
  });

  it("buckets disconnected instances and placeholders as available", () => {
    const grouped = groupConnectors(
      [rows.disconnectedGcal, rows.placeholderGmail],
      { exposedGrants: {} },
    );
    expect(grouped.shared).toEqual([]);
    expect(grouped.personal).toEqual([]);
    expect(grouped.available).toEqual([
      rows.disconnectedGcal,
      rows.placeholderGmail,
    ]);
  });

  it("never buckets a grant-less placeholder as shared (no instance UUID)", () => {
    const connectedPlaceholder = { connected: true, name: "Files" };
    const grouped = groupConnectors([connectedPlaceholder], {
      exposedGrants: {},
    });
    expect(grouped.personal).toEqual([connectedPlaceholder]);
  });

  it("buckets a built-in primitive as builtin regardless of connected state", () => {
    const filesPlaceholder = { id: "files", connected: false, name: "Workspace Files" };
    const filesInstance = {
      id: "files",
      connectorInstanceId: "inst-files",
      connected: true,
      name: "Workspace Files",
    };
    for (const row of [filesPlaceholder, filesInstance]) {
      const grouped = groupConnectors([row], {
        exposedGrants: { "inst-files": "grant-1" },
        builtinIds: new Set(["files"]),
      });
      expect(grouped.builtin).toEqual([row]);
      expect(grouped.shared).toEqual([]);
      expect(grouped.personal).toEqual([]);
      expect(grouped.available).toEqual([]);
    }
  });

  it("keeps a custom MCP row out of builtin even on a slug collision", () => {
    const customFiles = { id: "files", connected: true, custom: true, name: "files" };
    const grouped = groupConnectors([customFiles], {
      exposedGrants: {},
      builtinIds: new Set(["files"]),
    });
    expect(grouped.builtin).toEqual([]);
    expect(grouped.personal).toEqual([customFiles]);
  });

  it("buckets read-only workspace-shared rows into `workspace`, never the owned groups", () => {
    const teammateGithub = {
      id: "github",
      connectorInstanceId: "inst-mate",
      connected: true,
      name: "GitHub",
      readonly: true,
    };
    const grouped = groupConnectors([rows.exposedGithub, teammateGithub], {
      // Even if a stale grant entry exists for the read-only row, it stays in
      // `workspace` — readonly is checked first.
      exposedGrants: { "inst-gh": "grant-1", "inst-mate": "grant-2" },
    });
    expect(grouped.workspace).toEqual([teammateGithub]);
    expect(grouped.shared).toEqual([rows.exposedGithub]);
    expect(grouped.personal).toEqual([]);
    expect(grouped.available).toEqual([]);
  });

  it("buckets nothing as builtin when no builtinIds are passed", () => {
    const filesPlaceholder = { id: "files", connected: false, name: "Workspace Files" };
    const grouped = groupConnectors([filesPlaceholder], {
      exposedGrants: {},
    });
    expect(grouped.builtin).toEqual([]);
    expect(grouped.available).toEqual([filesPlaceholder]);
  });
});
