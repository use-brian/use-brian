import { readdirSync, readFileSync } from "node:fs";
import { relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buttonVariants } from "../button";

const SRC_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return tsxFiles(path);
    return entry.name.endsWith(".tsx") ? [path] : [];
  });
}

describe("[COMP:app-web/button] Button", () => {
  it("uses neutral action tokens for the filled variant", () => {
    const classes = buttonVariants({ variant: "default" });

    expect(classes).toContain("bg-action");
    expect(classes).toContain("text-action-foreground");
    expect(classes).not.toContain("bg-primary");
    expect(classes).not.toContain("text-primary-foreground");
  });

  it("keeps the accent token for link semantics", () => {
    expect(buttonVariants({ variant: "link" })).toContain("text-primary");
  });

  it("reserves primary-colour fills for compact semantic indicators", () => {
    const legacyPairs = tsxFiles(SRC_ROOT)
      .flatMap((file) =>
        readFileSync(file, "utf8")
          .split("\n")
          .filter((line) => line.includes("bg-primary") && line.includes("text-primary-foreground"))
          .map((line) => `${relative(SRC_ROOT, file)}:${line.trim().replace(/\s+/g, " ")}`),
      )
      .sort();

    expect(legacyPairs).toEqual([
      'components/brain/filter-strip.tsx:<span className="ml-0.5 min-w-[1.1rem] h-[1.1rem] px-1 inline-flex items-center justify-center rounded-full bg-primary text-primary-foreground text-[10px] font-semibold">',
      'components/chrome/floating-chat.tsx:<span className="inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">',
      'components/doc/doc-sidebar.tsx:className="absolute -right-0.5 -top-0.5 inline-flex min-w-[15px] items-center justify-center rounded-full bg-primary px-1 text-[9px] font-semibold leading-[15px] text-primary-foreground ring-2 ring-sidebar"',
      'components/feed/draft-session-detail.tsx:? "bg-primary text-primary-foreground border-background"',
      'components/ui/user-avatar.tsx:"rounded-full bg-primary text-primary-foreground flex items-center justify-center font-bold shrink-0",',
      'components/workflow/step-editor.tsx:checked ? "border-primary bg-primary text-primary-foreground" : "border-input",',
      'components/workflow/workflow-board.tsx:state === "running" && "bg-primary text-primary-foreground",',
    ]);
  });
});
