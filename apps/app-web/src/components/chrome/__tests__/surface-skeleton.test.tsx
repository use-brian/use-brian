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
import {
  surfaceSkeletonKind,
  type SurfaceSkeletonKind,
} from "@/components/chrome/surface-skeleton";
import type { WorkspaceSurface } from "@/lib/doc-page-url";

// Mirrors the `WorkspaceSurface` union. Kept as a literal (not derived) on
// purpose: adding a surface to the union must force a decision here.
const ALL_SURFACES: WorkspaceSurface[] = [
  "p",
  "brain",
  "studio",
  "workflow",
  "feed",
  "tasks",
  "crm",
  "computer",
  "goals",
  "approvals",
  "recordings",
  "inbox",
];

const KINDS: SurfaceSkeletonKind[] = ["page", "list", "grid", "rail", "brain"];

describe("[COMP:app-web/surface-skeleton] Surface skeleton shapes", () => {
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

  it("falls back to the page shape at the workspace root", () => {
    // `/w/<id>` redirects to `/p`, so the doc frame is the correct guess while
    // that redirect is in flight.
    expect(surfaceSkeletonKind(null)).toBe("page");
  });
});
