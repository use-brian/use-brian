import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  fileURLToPath(
    new URL(
      "../../app/w/[workspaceId]/studio/connectors/browse-directory.tsx",
      import.meta.url,
    ),
  ),
  "utf8",
);

function usesTruncationClass(snippet: string): boolean {
  return [...snippet.matchAll(/className="([^"]*)"/g)].some((match) =>
    /\b(?:truncate|line-clamp-\d+)\b/.test(match[1] ?? ""),
  );
}

describe("[COMP:app-web/browse-directory] readable directory cards", () => {
  it("uses two columns and never truncates connector card copy", () => {
    const start = source.indexOf("function DirectorySection");
    const end = source.indexOf("function DirectoryCard", start);
    const section = source.slice(start, end);
    expect(section).toContain('className="grid grid-cols-1 sm:grid-cols-2 gap-3"');

    const cardStart = source.indexOf("function DirectoryCard");
    const cardEnd = source.indexOf("const SKILL_CATEGORY_COLORS", cardStart);
    const card = source.slice(cardStart, cardEnd);
    expect(card).toContain("{entry.name}");
    expect(card).toContain("{entry.description}");
    expect(usesTruncationClass(card)).toBe(false);
  });

  it("keeps skill names and descriptions fully readable too", () => {
    const start = source.indexOf("function SkillSection");
    const section = source.slice(start);
    expect(section).toContain('className="grid grid-cols-1 sm:grid-cols-2 gap-3"');
    expect(usesTruncationClass(section)).toBe(false);
  });
});
