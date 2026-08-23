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

describe("[COMP:app-web/studio-connectors] Local Directory connect form", () => {
  it("reveals the selected row when Connect starts from the directory", () => {
    const start = page.indexOf('if (id === "local")');
    const end = page.indexOf('if (id === "cli")', start);

    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);

    const localConnectBranch = page.slice(start, end);
    expect(localConnectBranch).toContain("setShowLocalForm(rid)");
    expect(localConnectBranch).toContain("revealConnectForm(rid)");
  });

  it("preflights, connects, and imports for the server-validated active workspace", () => {
    expect(page).toContain("const { activeId, active } = useWorkspaces();");
    expect(page).toContain('const workspaceId = activeId ?? "";');
    expect(page).not.toContain("useParams");

    const start = page.indexOf("async function handleSaveLocal");
    const end = page.indexOf("async function handleSaveCli", start);
    const localSubmit = page.slice(start, end);

    expect(localSubmit).toContain("if (!workspaceId)");
    expect(localSubmit).toContain("await preflightLocal(path)");
    expect(localSubmit).toContain("await confirmLocalImport(preflight)");
    expect(localSubmit).toContain("JSON.stringify({ workspaceId, path })");
    expect(localSubmit).toContain("await importLocalDirectory()");
  });
});
