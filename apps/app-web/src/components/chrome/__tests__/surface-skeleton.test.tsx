/**
 * [COMP:app-web/surface-skeleton] — the surface-to-skeleton-shape mapping.
 *
 * The workspace-level `loading.tsx` dispatches on this, so an unclassified
 * surface silently falls through to the page shape and paints a doc reading
 * column where a table or a card grid is about to land. That is worse than the
 * blank it replaced: the frame moves when the real content arrives. This test
 * pins that EVERY `WorkspaceSurface` is classified deliberately, so adding a
 * surface without picking its shape fails here rather than in someone's eye.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { BrainGraphLoadingSkeleton } from "@/components/brain/graph-loading";
import {
  surfaceSkeletonKind,
  type SurfaceSkeletonKind,
  SurfaceSkeletonFor,
  AppShellSkeleton,
} from "@/components/chrome/surface-skeleton";
import { WORKSPACE_SURFACES } from "@/lib/doc-page-url";
import ChatLoading from "@/app/w/[workspaceId]/chat/loading";

// DERIVED from the union's source array, not copied.
//
// This was a literal, with a comment saying that was deliberate so "adding a
// surface must force a decision here". It did the opposite: nothing errors
// when the union grows, so the list just silently tested fewer surfaces — by
// 2026-08-10 it was four behind (`office`, `chat`, `apps`, `shopify`) while
// still claiming to cover every one.
//
// The forcing function is the exhaustive `switch` in `surfaceSkeletonKind`,
// which fails to compile on an unhandled surface. This list's job is only to
// assert the mapping at runtime, so it should track the real vocabulary.
const ALL_SURFACES = WORKSPACE_SURFACES;

const KINDS: SurfaceSkeletonKind[] = ["page", "list", "grid", "rail", "brain", "none"];

describe("[COMP:app-web/surface-skeleton] Surface skeleton shapes", () => {
  it("server-renders decorative chrome that the persistent app body can suppress", () => {
    const html = renderToStaticMarkup(<SurfaceSkeletonFor surface="projects" />);
    expect(html).toContain("data-surface-chrome-skeleton");
    expect(html.replace(/<[^>]+>/g, "").trim()).toBe("");
    const shell = renderToStaticMarkup(<AppShellSkeleton />);
    expect(shell).toContain("md:mt-3");
    expect(shell).toContain("h-[calc(100%-1.25rem)]");
    expect(shell).toContain("md:pt-2");
    expect(shell).toContain("md:mb-2");
    expect(shell).toContain("md:rounded-r-2xl");
    expect(shell.match(/data-surface-chrome-skeleton/g)).toHaveLength(1);
    expect(shell.indexOf("data-workspace-window-header")).toBeLessThan(shell.indexOf("<aside"));
  });

  it("classifies every workspace surface", () => {
    for (const surface of ALL_SURFACES) {
      expect(KINDS).toContain(surfaceSkeletonKind(surface));
    }
  });

  it("gives each surface family the shape its content actually has", () => {
    expect(surfaceSkeletonKind("brain")).toBe("brain");
    expect(surfaceSkeletonKind("studio")).toBe("rail");
    // Card grids.
    expect(surfaceSkeletonKind("workflow")).toBe("grid");
    expect(surfaceSkeletonKind("feed")).toBe("grid");
    expect(surfaceSkeletonKind("computer")).toBe("grid");
    // Dense tables.
    expect(surfaceSkeletonKind("tasks")).toBe("list");
    expect(surfaceSkeletonKind("crm")).toBe("list");
    expect(surfaceSkeletonKind("approvals")).toBe("list");
    // The doc surface.
    expect(surfaceSkeletonKind("p")).toBe("page");
  });

  it("keeps Home and Chat route entry free of placeholder content", () => {
    for (const surface of [null, "chat"] as const) {
      expect(surfaceSkeletonKind(surface)).toBe("none");
      expect(renderToStaticMarkup(<SurfaceSkeletonFor surface={surface} />)).toBe("");
    }
    expect(renderToStaticMarkup(<ChatLoading />)).toBe("");
  });

  it("mirrors the rendered brain graph using only the skeleton treatment", () => {
    const html = renderToStaticMarkup(<BrainGraphLoadingSkeleton />);

    expect(html).toContain('data-brain-graph-skeleton="true"');
    expect(html).toContain('data-brain-graph-edges="true"');
    expect(html.match(/data-brain-graph-node=/g)).toHaveLength(19);
    expect(html.match(/data-brain-graph-label=/g)).toHaveLength(19);
    // 19 discs + 19 label bars + the four overlay-chip stand-ins (stats
    // strip, colour-mode toggle, legend, zoom controls) the live canvas draws.
    expect(html.match(/class="skeleton/g)).toHaveLength(42);
    // One path for every edge, not one element per edge, and no
    // foreignObject islands inside the SVG.
    expect(html).not.toContain("<foreignObject");
    expect(html.match(/<line/g)).toBeNull();
    expect(html).not.toContain("--graph-entity-");
    expect(html).not.toContain("brain-outline");
    expect(html).not.toContain("brain-graph-loading-scan");
    expect(html.replace(/<[^>]+>/g, "").trim()).toBe("");
  });

  it("lets graph positioning and circular corners override the shared skeleton defaults", () => {
    const css = readFileSync(new URL("../../../app/globals.css", import.meta.url), "utf8");
    // Utilities must win the cascade: otherwise the overlay chips become
    // relatively positioned and graph discs turn into rounded rectangles.
    const components = css.slice(css.indexOf("@layer components {"), css.indexOf("@layer utilities {"));
    expect(components).toMatch(/\.skeleton\s*\{[^}]*position:\s*relative/);
    expect(components).toMatch(/\.skeleton\s*\{[^}]*border-radius:/);
    expect(css.slice(css.indexOf("@layer utilities {"))).not.toMatch(/\.skeleton\s*\{/);
  });
});
