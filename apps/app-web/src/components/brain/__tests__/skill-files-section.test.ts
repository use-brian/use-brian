import { describe, expect, it } from "vitest";

import { skillFileDraftPath } from "../skill-files-section";

describe("[COMP:app-web/brain-skill-files] native bundle path preservation", () => {
  it("creates a canonical resource-root path for a new file", () => {
    expect(skillFileDraftPath("reference", "policy.md", null)).toBe("references/policy.md");
  });

  it("preserves imported nested folders when the basename changes", () => {
    expect(
      skillFileDraftPath("reference", "renewals.md", "references/sales/playbook.md"),
    ).toBe("references/sales/renewals.md");
  });

  it("moves the resource root without flattening nested folders when kind changes", () => {
    expect(
      skillFileDraftPath("asset", "scorecard.md", "references/finance/checklist.md"),
    ).toBe("assets/finance/scorecard.md");
  });
});
