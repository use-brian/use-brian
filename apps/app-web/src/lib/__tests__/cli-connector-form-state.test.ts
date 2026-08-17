import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const page = readFileSync(
  fileURLToPath(
    new URL(
      "../../app/w/[workspaceId]/studio/connectors/page.tsx",
      import.meta.url,
    ),
  ),
  "utf8",
);

function section(start: string, end: string): string {
  const startIndex = page.indexOf(start);
  const endIndex = page.indexOf(end, startIndex);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  expect(endIndex).toBeGreaterThan(startIndex);
  return page.slice(startIndex, endIndex);
}

describe("[COMP:web/settings-connectors] CLI connector form state", () => {
  it("keeps the create draft independent from the selected connector settings", () => {
    const createForm = section(
      "{showCliForm === rid && (",
      "{/* Company mailbox (imap) connected card",
    );
    // The settings body moved into `connectorSettingsBody`, the renderer BOTH
    // detail panels call, so the per-block `expandTab === "settings"` gate now
    // lives at the two call sites instead of on the block itself. The draft
    // separation this test pins is unchanged.
    const settingsForm = section(
      '{sel.id === "cli" && !wsOwned && sel.connectorInstanceId && (',
      "{/* Google Calendar settings */}",
    );

    expect(createForm).toContain("value={newCliLabel}");
    expect(createForm).toContain("value={newCliBinaryPath}");
    expect(createForm).toContain("value={newCliArgs}");
    expect(createForm).toContain("value={newCliCwd}");
    expect(createForm).not.toContain("value={cliLabel}");
    expect(settingsForm).toContain("value={cliLabel}");
    expect(settingsForm).toContain("value={cliBinaryPath}");
    expect(settingsForm).toContain("value={cliArgs}");
    expect(settingsForm).toContain("value={cliCwd}");
    expect(settingsForm).not.toContain("value={newCliLabel}");
  });

  it("submits each form from its own draft", () => {
    const createHandler = section(
      "async function handleSaveCli",
      "async function handleUpdateCli",
    );
    const updateHandler = section(
      "async function handleUpdateCli",
      "async function handlePolicyChange",
    );

    expect(createHandler).toContain("label: newCliLabel.trim()");
    expect(createHandler).toContain("binaryPath: newCliBinaryPath.trim()");
    expect(createHandler).not.toContain("label: cliLabel.trim()");
    expect(updateHandler).toContain("label: cliLabel.trim()");
    expect(updateHandler).toContain("binaryPath: cliBinaryPath.trim()");
    expect(updateHandler).not.toContain("newCliLabel");
  });
});
