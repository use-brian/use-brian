/**
 * [COMP:app-web/legacy-redirect] Legacy bare-path resolver.
 *
 * Pure-logic tests for `resolveLegacyPath()` — the mapping behind the
 * `app/[...legacy]/page.tsx` catch-all that serves pre-consolidation
 * marketing paths forwarded here by the marketing proxy
 * (`MOVED_TO_APP_PREFIXES` in apps/web). Covers the four target kinds
 * (workspace surface / workspace root alias / workspace-id / teams
 * picker), sub-path preservation, the bare-head defaults for surfaces
 * with no index route (knowledge-base → gaps, memories → review), and
 * the null fallthrough that keeps unknown paths 404ing.
 *
 * Spec: docs/architecture/features/web-ui.md → Phase C ("old links, bookmarks,
 * and deep-links keep working").
 */

import { describe, expect, it } from "vitest";
import { resolveLegacyPath } from "../legacy-paths";

describe("[COMP:app-web/legacy-redirect] resolveLegacyPath", () => {
  it("maps workspace-scoped surfaces to their /w suffix", () => {
    expect(resolveLegacyPath(["brain"])).toEqual({
      kind: "workspace",
      suffix: "/brain",
    });
    expect(resolveLegacyPath(["approvals"])).toEqual({
      kind: "workspace",
      suffix: "/approvals",
    });
  });

  it("maps bare heads with no index route to their default sub-surface", () => {
    // /w/<id>/knowledge-base and /w/<id>/memories have no page.tsx —
    // the bare heads must land on a route that exists.
    expect(resolveLegacyPath(["knowledge-base"])).toEqual({
      kind: "workspace",
      suffix: "/knowledge-base/gaps",
    });
    expect(resolveLegacyPath(["memories"])).toEqual({
      kind: "workspace",
      suffix: "/memories/review",
    });
  });

  it("preserves sub-paths for workspace-scoped surfaces", () => {
    expect(resolveLegacyPath(["studio", "skills"])).toEqual({
      kind: "workspace",
      suffix: "/studio/skills",
    });
    expect(resolveLegacyPath(["workflow", "abc-123"])).toEqual({
      kind: "workspace",
      suffix: "/workflow/abc-123",
    });
    // Deeper sub-paths under the bare-head-defaulted surfaces keep the
    // plain join — only the bare heads get rewritten.
    expect(resolveLegacyPath(["knowledge-base", "new"])).toEqual({
      kind: "workspace",
      suffix: "/knowledge-base/new",
    });
    expect(resolveLegacyPath(["memories", "review"])).toEqual({
      kind: "workspace",
      suffix: "/memories/review",
    });
  });

  it("maps home/chat/settings to the workspace root, dropping sub-paths", () => {
    expect(resolveLegacyPath(["home"])).toEqual({ kind: "workspace", suffix: "" });
    expect(resolveLegacyPath(["chat"])).toEqual({ kind: "workspace", suffix: "" });
    expect(resolveLegacyPath(["settings"])).toEqual({ kind: "workspace", suffix: "" });
    expect(resolveLegacyPath(["settings", "billing"])).toEqual({
      kind: "workspace",
      suffix: "",
    });
  });

  it("maps bare /workspaces to the teams picker", () => {
    expect(resolveLegacyPath(["workspaces"])).toEqual({ kind: "teams" });
  });

  it("maps /workspaces/<id> straight to that workspace", () => {
    // Old bookmarks (also produced by the apps/web /teams/:path* redirects)
    // carry the workspace id — go to /w/<id> directly, not the picker.
    expect(resolveLegacyPath(["workspaces", "ws-42"])).toEqual({
      kind: "workspace-id",
      id: "ws-42",
    });
    // Deeper sub-paths drop — only the id survives.
    expect(resolveLegacyPath(["workspaces", "ws-42", "members"])).toEqual({
      kind: "workspace-id",
      id: "ws-42",
    });
  });

  it("returns null for unknown paths so they still 404", () => {
    expect(resolveLegacyPath(["wp-admin"])).toBeNull();
    expect(resolveLegacyPath(["favicon.ico"])).toBeNull();
    expect(resolveLegacyPath([])).toBeNull();
    // Workspace-scoped names must match the first segment exactly.
    expect(resolveLegacyPath(["brains"])).toBeNull();
  });
});
