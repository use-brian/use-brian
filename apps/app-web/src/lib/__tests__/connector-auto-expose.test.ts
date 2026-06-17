/**
 * Auto-expose gating (app-web).
 * Component tag: [COMP:app-web/connector-auto-expose].
 *
 * Pure unit tests — `connector-auto-expose.ts` has no runtime imports, so this
 * needs no DOM and no mocks. Ported verbatim from `apps/web`'s
 * `[COMP:web/connector-auto-expose]` test (the unit under test is byte-identical
 * across the two apps). Covers every precondition gate: connector presence +
 * connected state, instance UUID, shared-vs-solo workspace (keyed on member
 * count, never on is_personal), and the already-exposed short-circuit (the
 * "never silently re-expose" guard).
 *
 * Spec: docs/architecture/integrations/mcp.md → "Unified connectors — the
 * master-detail Studio surface".
 */

import { describe, expect, it } from "vitest";
import {
  resolveAutoExpose,
  type AutoExposeInput,
} from "../connector-auto-expose";

const sharedWorkspace = { id: "ws-1", memberCount: 3 };
const soloWorkspace = { id: "ws-solo", memberCount: 1 };

/** A connected connector with a resolved instance UUID. */
function base(overrides: Partial<AutoExposeInput> = {}): AutoExposeInput {
  return {
    connector: { connected: true, connectorInstanceId: "inst-1" },
    workspace: sharedWorkspace,
    exposedGrants: {},
    ...overrides,
  };
}

describe("[COMP:app-web/connector-auto-expose] resolveAutoExpose", () => {
  it("exposes a freshly-connected connector in a shared workspace", () => {
    expect(resolveAutoExpose(base())).toEqual({
      expose: true,
      connectorInstanceId: "inst-1",
    });
  });

  it("holds when the connector vanished from the list", () => {
    expect(resolveAutoExpose(base({ connector: undefined }))).toEqual({
      expose: false,
    });
  });

  it("holds until the connection is actually live", () => {
    expect(
      resolveAutoExpose(
        base({ connector: { connected: false, connectorInstanceId: "inst-1" } }),
      ),
    ).toEqual({ expose: false });
  });

  it("holds until the instance UUID is resolved (post-refetch)", () => {
    expect(
      resolveAutoExpose(base({ connector: { connected: true } })),
    ).toEqual({ expose: false });
  });

  it("holds in a solo workspace (member count <= 1) — no audience to share with", () => {
    expect(resolveAutoExpose(base({ workspace: soloWorkspace }))).toEqual({
      expose: false,
    });
  });

  it("holds when the member count is absent (reads as solo)", () => {
    expect(resolveAutoExpose(base({ workspace: { id: "ws-x" } }))).toEqual({
      expose: false,
    });
  });

  it("exposes once a teammate joins (member count > 1), regardless of how the workspace was created", () => {
    // The default ("Personal") workspace that has accreted members is shared
    // like any other — this is the gap the member-count keying fixes.
    expect(
      resolveAutoExpose(base({ workspace: { id: "ws-default", memberCount: 2 } })),
    ).toEqual({ expose: true, connectorInstanceId: "inst-1" });
  });

  it("holds when no workspace is active", () => {
    expect(resolveAutoExpose(base({ workspace: null }))).toEqual({
      expose: false,
    });
  });

  it("holds when already exposed — never silently re-exposes a revoked connector", () => {
    expect(
      resolveAutoExpose(base({ exposedGrants: { "inst-1": "grant-9" } })),
    ).toEqual({ expose: false });
  });

  it("still exposes when a *different* instance is exposed", () => {
    expect(
      resolveAutoExpose(base({ exposedGrants: { "inst-other": "grant-2" } })),
    ).toEqual({ expose: true, connectorInstanceId: "inst-1" });
  });
});
