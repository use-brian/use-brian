/**
 * Auto-expose gating (app-web).
 * Component tag: [COMP:app-web/connector-auto-expose].
 *
 * Pure unit tests — `connector-auto-expose.ts` has no runtime imports, so this
 * needs no DOM and no mocks. Covers every precondition gate: instance-UUID vs
 * slug-only arm resolution (the 2026-07-06 "GitHub - fls" misfire: a slug
 * lookup that took the first list match exposed the OLDEST instance of a
 * provider to the active workspace), the fail-closed ambiguity rule, connected
 * state, an active workspace (solo included — exposure is what surfaces a
 * connector on workspace config pickers), and the already-exposed
 * short-circuit (the "never silently re-expose" guard).
 *
 * Spec: docs/architecture/integrations/mcp.md → "Unified connectors — the
 * master-detail Studio surface".
 */

import { describe, expect, it } from "vitest";
import {
  resolveAutoExpose,
  type AutoExposeConnector,
  type AutoExposeInput,
} from "../connector-auto-expose";

const sharedWorkspace = { id: "ws-1", memberCount: 3 };
const soloWorkspace = { id: "ws-solo", memberCount: 1 };

/** A connected github instance row. */
function row(overrides: Partial<AutoExposeConnector> = {}): AutoExposeConnector {
  return { id: "github", connected: true, connectorInstanceId: "inst-1", ...overrides };
}

/** One connected instance, slug-only arm — the legacy single-account shape. */
function base(overrides: Partial<AutoExposeInput> = {}): AutoExposeInput {
  return {
    connectors: [row()],
    arm: { slug: "github" },
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

  it("resolves a UUID arm to THAT instance among several of the same provider", () => {
    // The regression case: two github accounts, the SECOND one just connected.
    // The oldest sorts first — a slug lookup would find it and expose the
    // wrong account to the workspace.
    expect(
      resolveAutoExpose(
        base({
          connectors: [
            row({ connectorInstanceId: "inst-old" }),
            row({ connectorInstanceId: "inst-new" }),
          ],
          arm: { slug: "github", instanceId: "inst-new" },
        }),
      ),
    ).toEqual({ expose: true, connectorInstanceId: "inst-new" });
  });

  it("fails closed on a slug-only arm when the provider has several connected instances", () => {
    expect(
      resolveAutoExpose(
        base({
          connectors: [
            row({ connectorInstanceId: "inst-old" }),
            row({ connectorInstanceId: "inst-new" }),
          ],
          arm: { slug: "github" },
        }),
      ),
    ).toEqual({ expose: false, pending: false });
  });

  it("waits while a UUID arm's instance hasn't landed in the list yet", () => {
    expect(
      resolveAutoExpose(
        base({
          connectors: [row({ connectorInstanceId: "inst-old" })],
          arm: { slug: "github", instanceId: "inst-new" },
        }),
      ),
    ).toEqual({ expose: false, pending: true });
  });

  it("waits until the connection is actually live", () => {
    expect(
      resolveAutoExpose(base({ connectors: [row({ connected: false })] })),
    ).toEqual({ expose: false, pending: true });
  });

  it("waits until the instance UUID is resolved (post-refetch)", () => {
    expect(
      resolveAutoExpose(
        base({ connectors: [row({ connectorInstanceId: undefined })] }),
      ),
    ).toEqual({ expose: false, pending: true });
  });

  it("terminates when the provider vanished from the list entirely", () => {
    expect(resolveAutoExpose(base({ connectors: [] }))).toEqual({
      expose: false,
      pending: false,
    });
  });

  it("never resolves a slug arm to a teammate's readonly row", () => {
    // A teammate's exposed github is in the list — it must neither be picked
    // nor make the member's own single instance ambiguous.
    expect(
      resolveAutoExpose(
        base({
          connectors: [
            row({ connectorInstanceId: "inst-teammate", readonly: true }),
            row({ connectorInstanceId: "inst-own" }),
          ],
          arm: { slug: "github" },
        }),
      ),
    ).toEqual({ expose: true, connectorInstanceId: "inst-own" });
  });

  it("exposes in a solo workspace too — the grant is what reaches workspace config pickers", () => {
    expect(resolveAutoExpose(base({ workspace: soloWorkspace }))).toEqual({
      expose: true,
      connectorInstanceId: "inst-1",
    });
  });

  it("exposes when the member count is absent", () => {
    expect(resolveAutoExpose(base({ workspace: { id: "ws-x" } }))).toEqual({
      expose: true,
      connectorInstanceId: "inst-1",
    });
  });

  it("terminates when no workspace is active", () => {
    expect(resolveAutoExpose(base({ workspace: null }))).toEqual({
      expose: false,
      pending: false,
    });
  });

  it("terminates when already exposed — never silently re-exposes a revoked connector", () => {
    expect(
      resolveAutoExpose(base({ exposedGrants: { "inst-1": "grant-9" } })),
    ).toEqual({ expose: false, pending: false });
  });

  it("still exposes when a *different* instance is exposed", () => {
    expect(
      resolveAutoExpose(base({ exposedGrants: { "inst-other": "grant-2" } })),
    ).toEqual({ expose: true, connectorInstanceId: "inst-1" });
  });
});
