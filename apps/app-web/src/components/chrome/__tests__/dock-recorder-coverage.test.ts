/**
 * [COMP:app-web/dock-recorder] Recorder stickiness coverage.
 *
 * The record affordance lives in the ONE global chat dock, so any surface
 * that hides that dock takes the recorder down with it unless it rehosts
 * the controller (`useGlobalDockRecorder`) in its own chrome or mounts the
 * sticky `DockRecorderFallback` cluster. That regressed silently twice (the
 * full-page Chat surface and the Office editor shipped with no record
 * button), so the pairing is a source contract here:
 *
 *  - every `chatDockSuppression.suppress()` caller must map to a recorder
 *    host file, and that host must actually reference the recorder chrome;
 *  - the one route-driven hide (`activeSurface === "chat"` in
 *    WorkspaceChrome) must pair with the Chat surface's composer rehost.
 *
 * Adding a new dock-hiding surface fails this test until the surface either
 * rehosts the recorder or mounts `DockRecorderFallback` - then its file is
 * added to HOSTS below.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

const SRC_ROOT = join(
  dirname(fileURLToPath(import.meta.url)), // __tests__
  "..", // chrome
  "..", // components
  "..", // src
);

/** Dock-suppressing file → the file that keeps the recorder on screen. */
const HOSTS: Record<string, string> = {
  // Feed swaps in its own tuning dock, which rehosts the recorder cluster.
  "components/feed/feed-surface-shell.tsx":
    "components/feed/feed-floating-chat.tsx",
  // The skill creator's embedded iteration chat rehosts it in its composer.
  "components/brain/skill-creator.tsx":
    "components/brain/skill-iteration-chat.tsx",
  // The Office editor has no replacement chat: it mounts the sticky fallback.
  "components/office/office-editor-shell.tsx":
    "components/office/office-editor-shell.tsx",
};

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "__tests__") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\./.test(name)) out.push(path);
  }
  return out;
}

const sourceFiles = walk(SRC_ROOT);
const read = (rel: string) =>
  readFileSync(join(SRC_ROOT, rel.split("/").join(sep)), "utf8");

const hostsRecorder = (source: string) =>
  source.includes("<DockRecorderFallback") ||
  (source.includes("useGlobalDockRecorder") &&
    source.includes("DockRecorderButton"));

describe("[COMP:app-web/dock-recorder] recorder stickiness coverage", () => {
  const suppressors = sourceFiles
    .filter((path) =>
      readFileSync(path, "utf8").includes("chatDockSuppression.suppress("),
    )
    .map((path) => relative(SRC_ROOT, path).split(sep).join("/"))
    .sort();

  it("maps every dock-suppressing surface to a recorder host", () => {
    // A new suppressor must pick a recorder story (inline rehost or the
    // DockRecorderFallback cluster) and register it in HOSTS above.
    expect(suppressors).toEqual(Object.keys(HOSTS).sort());
  });

  it("each mapped host actually renders the recorder chrome", () => {
    for (const [suppressor, host] of Object.entries(HOSTS)) {
      expect(hostsRecorder(read(host)), `${suppressor} → ${host}`).toBe(true);
    }
  });

  it("the Chat route hide pairs with the Chat surface composer rehost", () => {
    // WorkspaceChrome hides the dock on the full-page Chat surface without
    // a suppression hold - the pairing is with ChatSurface itself.
    expect(read("components/doc/workspace-chrome.tsx")).toContain(
      'activeSurface === "chat"',
    );
    const chatSurface = read("components/chat-app/chat-surface.tsx");
    expect(hostsRecorder(chatSurface)).toBe(true);
    expect(chatSurface).toContain("registerDockRecorderChatTarget");
  });
});
