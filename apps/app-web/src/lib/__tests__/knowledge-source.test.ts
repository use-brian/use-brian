/**
 * [COMP:app-web/entry-reader] Source provenance URL regression.
 */

import { describe, expect, it } from "vitest";
import {
  canOpenLocalKnowledgeSource,
  getKnowledgeEntryNavigationUrl,
  getKnowledgeSourceUrl,
  type KnowledgeEntrySource,
} from "@/lib/api/brain";

function source(
  sourceType: KnowledgeEntrySource["sourceType"],
  repo: string,
): KnowledgeEntrySource {
  return {
    id: "source-1",
    sourceType,
    repo,
    branch: sourceType === "github" ? "main" : "local",
    rootPath: "",
    lastSyncedAt: null,
  };
}

describe("[COMP:app-web/entry-reader] knowledge source URL", () => {
  it("links GitHub repositories", () => {
    expect(getKnowledgeSourceUrl(source("github", "acme/knowledge"))).toBe(
      "https://github.com/acme/knowledge",
    );
  });

  it("does not turn a local directory into a GitHub URL", () => {
    expect(getKnowledgeSourceUrl(source("local", "/srv/knowledge"))).toBeNull();
  });

  it("uses the entry Markdown navigation URL", () => {
    expect(getKnowledgeEntryNavigationUrl("https://docs.example.com/knowledge"))
      .toBe("https://docs.example.com/knowledge");
    expect(getKnowledgeEntryNavigationUrl("joplin://x-callback-url/openNote?id=note-1"))
      .toBe("joplin://x-callback-url/openNote?id=note-1");
    expect(getKnowledgeEntryNavigationUrl("obsidian://open?vault=kb&file=note-1"))
      .toBe("obsidian://open?vault=kb&file=note-1");
    expect(getKnowledgeEntryNavigationUrl("notes-app://open/note-1"))
      .toBe("notes-app://open/note-1");
  });

  it("rejects an unsafe entry Markdown navigation URL", () => {
    expect(getKnowledgeEntryNavigationUrl("file:///etc/passwd")).toBeNull();
    expect(getKnowledgeEntryNavigationUrl("javascript:alert(1)")).toBeNull();
    expect(getKnowledgeEntryNavigationUrl("chrome://settings")).toBeNull();
  });

  it("offers native folder opening only for loopback APIs", () => {
    expect(canOpenLocalKnowledgeSource("http://localhost:4000")).toBe(true);
    expect(canOpenLocalKnowledgeSource("http://127.0.0.1:4000")).toBe(true);
    expect(canOpenLocalKnowledgeSource("https://brain.example.com")).toBe(false);
  });
});
