/**
 * The condition from
 * docs/architecture/integrations/connector-configuration.md, in two halves:
 *
 *  1. `configTarget` sends a workspace-owned row to the instance-scoped config
 *     pair, because the provider-keyed one resolves by `(userId, provider)` and
 *     finds nothing for a row whose `user_id` is NULL.
 *  2. Every connector-config renderer is called from BOTH detail panels. That
 *     one is a source assertion (the page is a 5k-line client component with no
 *     unit seam; the CLI form-state suite next door pins page shape the same
 *     way) — it is what stops a future edit from putting an editor back into
 *     the owner panel only, which is the regression Transfer silently caused.
 *
 * [COMP:web/connector-config-target]
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { configTarget } from "../connector-config-target";

const page = readFileSync(
  fileURLToPath(
    new URL("../../app/w/[workspaceId]/studio/connectors/page.tsx", import.meta.url),
  ),
  "utf8",
);

/** The workspace-owned detail panel: from its early return to the owner panel's. */
function workspaceOwnedPanel(): string {
  const marker = 'if (sel.readonly && sel.source === "team_native" && sel.connectorInstanceId) {';
  const start = page.lastIndexOf(marker);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = page.indexOf("const builtin = isBuiltinPrimitive(sel);", start);
  expect(end).toBeGreaterThan(start);
  return page.slice(start, end);
}

describe("[COMP:web/connector-config-target] connector config target", () => {
  it("routes a workspace-owned row to the instance-scoped config pair", () => {
    expect(
      configTarget({
        id: "msgraph",
        connectorInstanceId: "ci-1",
        readonly: true,
        source: "team_native",
      }),
    ).toEqual({ key: "ci-1", path: "instances/ci-1" });
  });

  it("keeps a personally-owned row on the provider-keyed pair", () => {
    expect(configTarget({ id: "gcal", connectorInstanceId: "ci-2" })).toEqual({
      key: "gcal",
      path: "gcal",
    });
  });

  it("leaves a granted row alone — reconfiguring it is the owner's job", () => {
    expect(
      configTarget({
        id: "notion",
        connectorInstanceId: "ci-3",
        readonly: true,
        source: "granted",
      }),
    ).toEqual({ key: "notion", path: "notion" });
  });

  it("keys a workspace-owned row apart from a personal one of the same provider", () => {
    const personal = configTarget({ id: "gdrive", connectorInstanceId: "ci-a" });
    const shared = configTarget({
      id: "gdrive",
      connectorInstanceId: "ci-b",
      readonly: true,
      source: "team_native",
    });
    expect(personal.key).not.toBe(shared.key);
  });
});

describe("[COMP:web/connector-config-target] config editors reach both panels", () => {
  it("renders every config surface through a shared renderer, not an inline copy", () => {
    // Two call sites each: the owner panel and the workspace-owned panel.
    for (const renderer of ["msGraphConfigButton(", "msGraphConfigForm(", "connectorSettingsBody("]) {
      const calls = page.split(renderer).length - 1;
      // definition + both call sites
      expect(calls, renderer).toBeGreaterThanOrEqual(3);
    }
  });

  it("the workspace-owned panel calls them", () => {
    const panel = workspaceOwnedPanel();
    expect(panel).toContain("msGraphConfigButton(sel, rid)");
    expect(panel).toContain("msGraphConfigForm(sel, rid)");
    expect(panel).toContain("connectorSettingsBody(sel, rid)");
  });

  it("the workspace-owned panel reads and writes config through configTarget", () => {
    // Not the provider-keyed path: that one silently no-ops for these rows.
    expect(workspaceOwnedPanel()).toContain("configTarget(sel)");
  });
});
