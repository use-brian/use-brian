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
});
