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
 *  - the one route-driven hide (`activeSurface === "chat"` in the shared
 *    dock policy) must pair with the Chat surface's composer rehost.
 *
 * Adding a new dock-hiding surface fails this test until the surface either
 * rehosts the recorder or mounts `DockRecorderFallback` - then its file is
 * added to HOSTS below.
 *
 * Desktop stickiness (floating-recorder-slot.ts): the floating button must
 * stay bottom-right on every dock-hiding surface, not move into a composer.
 *
 *  - `WorkspaceChrome` mounts `FloatingRecorderHost` whenever the dock hides;
 *  - a surface that renders its OWN floating recorder claims the slot, so
 *    the host never doubles it;
 *  - an inline rehost on a dock-hiding surface registers its composer as a
 *    clearance (the floating button lifts above Send) and hides the inline
 *    control at `lg`+, so a desktop screen shows exactly one record button.
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

  it("WorkspaceChrome keeps the floating recorder up while the dock hides", () => {
    const chrome = read("components/doc/workspace-chrome.tsx");
    expect(chrome).toMatch(/dockSuppressed && !brianNearby \? <FloatingRecorderHost \/>/);
  });

  it("a surface rendering its own floating recorder claims the slot", () => {
    const ownFloating = sourceFiles
      .map((path) => relative(SRC_ROOT, path).split(sep).join("/"))
      .filter(
        (rel) =>
          rel !== "components/chrome/dock-recorder.tsx" &&
          // The global dock itself: the host only mounts while it is hidden.
          rel !== "components/chrome/floating-chat.tsx",
      )
      .filter((rel) => {
        const source = read(rel);
        return (
          source.includes("<DockRecorderFallback") ||
          (source.includes('variant="floating"') && source.includes("DockRecorderButton"))
        );
      });
    expect(ownFloating.length).toBeGreaterThan(0);
    for (const rel of ownFloating) {
      expect(read(rel), rel).toContain("claimFloatingRecorder(");
    }
  });

  it("inline rehosts on dock-hiding surfaces yield to the floating button at lg", () => {
    for (const rel of [
      "components/chat-app/chat-surface.tsx",
      "components/feed/tuning-chat-panel.tsx",
      "components/brain/skill-iteration-chat.tsx",
    ]) {
      const source = read(rel);
      expect(source, rel).toContain("useFloatingRecorderClearance(");
      expect(source, rel).toMatch(/lg:hidden|inlineRecorderClass/);
      // ...and its message list reserves room for the lifted button.
      expect(source, rel).toContain("var(--floating-recorder-reserve,0px)");
    }
  });

  it("keeps the floating chat launcher reachable during capture and finishing", () => {
    const dock = read("components/chrome/floating-chat.tsx");
    const launcher = dock.slice(dock.indexOf("{/* Launcher — floating mode only."), dock.indexOf("function coercePayload"));
    // The old latched/finishing guard removed the entire row, including the
    // only way to open chat. Only side-panel mode may omit this launcher.
    expect(launcher).toMatch(/\{!isSidePanel && \(\s*<div/);
    expect(launcher).not.toContain("recorder.phase");
    expect(launcher).toContain("onClick={() => setExpanded(true)}");
    expect(launcher).toContain("tabIndex={expanded ? -1 : 0}");
    expect(launcher).not.toMatch(/router\.|navigate\(|setSession\(/);
    expect(launcher).toContain("<DockRecorderButton");
  });

  it("shares one recorder across the launcher and expanded chat without blocking typing", () => {
    const dock = read("components/chrome/floating-chat.tsx");
    expect(dock.match(/const recorder = useDockRecorder\(/g)).toHaveLength(1);
    expect(dock).toContain('<DockRecorderStrip rec={recorder} className="mb-1.5" />');
    expect(dock).toContain("<DockRecorderStrip rec={recorder} />");
    const composer = dock.slice(dock.indexOf("<ChatComposer"), dock.indexOf("{/* Live-recording chrome (collapsed mode)"));
    expect(composer).toContain("disabled={!!pendingQuestion || offline}");
    expect(composer).not.toMatch(/disabled=\{[^}]*recorder\./);
    expect(dock).not.toContain("captureUpload.busy");
  });

  it("keeps interaction answers in their originating session without replacing typed streaming messages", () => {
    const dock = read("components/chrome/floating-chat.tsx");
    const answers = dock.slice(dock.indexOf("<LiveInteractionJobs"), dock.indexOf("{showEmpty ?"));
    expect(answers).toContain("sessionId={session.state.sessionId}");
    expect(answers).toContain("if (sessionIdRef.current !== sid) return;");
    expect(answers).toContain("canonicalInteractionAdditions(session.state.messages,");
    expect(answers).toContain('session.dispatch({ type: "message/append", message })');
    expect(answers).not.toMatch(/router\.|navigate\(|setSession\(|setMessages\(/);
    const binding = dock.slice(dock.indexOf("ensureInteractionSession:"), dock.indexOf("getSessionId: () =>", dock.indexOf("ensureInteractionSession:")));
    expect(binding).toContain("const existing = sessionIdRef.current;");
    expect(binding).toContain("if (existing) return existing;");
    expect(binding).toContain('if (threadEpochRef.current !== epoch) throw new Error("Chat changed");');
    expect(binding).toContain("if (sessionIdRef.current) return sessionIdRef.current;");
  });

  it("the Chat route hide pairs with the Chat surface composer rehost", () => {
    // WorkspaceChrome hides the dock on the full-page Chat surface without
    // a suppression hold - the pairing is with ChatSurface itself.
    expect(read("components/doc/workspace-chrome.tsx")).toContain(
      "workspaceChatDockSuppressed(",
    );
    expect(read("lib/chat-dock-suppress.ts")).toContain(
      'activeSurface === "chat"',
    );
    const chatSurface = read("components/chat-app/chat-surface.tsx");
    expect(hostsRecorder(chatSurface)).toBe(true);
    expect(chatSurface).toContain("registerDockRecorderChatTarget");
  });
});
