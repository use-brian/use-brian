import { describe, expect, it } from "vitest";
import {
  crumbsOf,
  folderHasSkillMd,
  toSkillImportPrefill,
} from "../skill-import";
import type {
  SkillImportGithubEntry,
  SkillImportResult,
} from "@/lib/api/skills";

const RESULT: SkillImportResult = {
  dialect: "agent-skills",
  draft: {
    name: "Release Notes",
    slug: "release-notes",
    description: "Drafts release notes from merged PRs.",
    whenToUse: "Use when the user asks for release notes.",
    category: "custom",
    requiresConnectors: [],
    content: "Collect merged PRs.\n\n## Imported support files\n\n- {{reference:style.md}}",
  },
  supportFiles: [{ kind: "reference", name: "style.md", content: "House style." }],
  warnings: [{ code: "no_frontmatter", detail: "derived" }],
  importSource: { kind: "github", owner: "acme", repo: "skills", path: "notes" },
};

describe("[COMP:app-web/brain-skill-import] skill-import helpers", () => {
  it("maps an import result onto the creator prefill (draft + files + provenance)", () => {
    const prefill = toSkillImportPrefill(RESULT);
    expect(prefill.draft).toEqual({
      name: "Release Notes",
      description: "Drafts release notes from merged PRs.",
      whenToUse: "Use when the user asks for release notes.",
      content: RESULT.draft.content,
    });
    expect(prefill.supportFiles).toEqual(RESULT.supportFiles);
    expect(prefill.importSource).toEqual(RESULT.importSource);
    // The prefill deliberately carries no slug/category/warnings: the create
    // route re-derives the slug from the (possibly edited) name.
    expect("slug" in prefill.draft).toBe(false);
  });

  it("offers folder import only when the directory holds a SKILL.md (case-insensitive)", () => {
    const dir = (name: string): SkillImportGithubEntry => ({
      type: "dir",
      name,
      path: name,
      size: 0,
    });
    const file = (name: string): SkillImportGithubEntry => ({
      type: "file",
      name,
      path: name,
      size: 1,
    });

    expect(folderHasSkillMd([file("SKILL.md"), dir("references")])).toBe(true);
    expect(folderHasSkillMd([file("skill.md")])).toBe(true);
    expect(folderHasSkillMd([dir("SKILL.md")])).toBe(false);
    expect(folderHasSkillMd([file("readme.md")])).toBe(false);
    expect(folderHasSkillMd([])).toBe(false);
    expect(folderHasSkillMd(null)).toBe(false);
  });

  it("segments repo paths into breadcrumbs, with the root as an empty list", () => {
    expect(crumbsOf("")).toEqual([]);
    expect(crumbsOf("skills")).toEqual(["skills"]);
    expect(crumbsOf("skills/notes/references")).toEqual(["skills", "notes", "references"]);
  });
});
