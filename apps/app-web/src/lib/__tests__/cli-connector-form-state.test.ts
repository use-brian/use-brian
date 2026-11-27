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

describe("[COMP:app-web/studio-connectors] CLI connector form state", () => {
  it("reveals a fresh CLI create draft from either add-another entry point", () => {
    const cliConnect = section('if (id === "cli") {', "// Company mailbox");
    expect(cliConnect).toContain("revealConnectForm(rid)");
    expect(cliConnect).toContain('setNewCliLabel(opts?.addAnother ? ""');
    expect(cliConnect).toContain('setNewCliBinaryPath("")');
    expect(cliConnect).toContain('setNewCliArgs("")');
    expect(cliConnect).toContain('setNewCliCwd("")');
    expect(cliConnect).toContain("setNewCliError(null)");

    const addAnother = section('if (flow === "cli-form") {', 'if (flow === "pat-form") {');
    expect(addAnother).toContain("handleConnect(c, { addAnother: true })");

    const directoryHandoff = section("onConnectorConnect={(entry, opts) => {", "onConfigureApp=");
    expect(directoryHandoff).toContain("revealConnectForm(rowId(connector))");
    expect(directoryHandoff).toContain("opts?.addAnother && isPatConnector(connector.id)");
    expect(directoryHandoff).toContain("handleAddAnother(connector)");
    expect(directoryHandoff).toContain("handleConnect(connector, {");
    expect(directoryHandoff).toContain("...opts,");
  });

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
