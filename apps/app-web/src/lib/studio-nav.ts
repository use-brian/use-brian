/**
 * Studio section navigation — the single source of truth for the grouped
 * sub-menu, shared by the desktop rail (now the `StudioSidebarPanel` in the
 * left sidebar) and the `<md` mobile tab strip still rendered by
 * `studio/layout.tsx`. Keeping one definition is what stops the two nav
 * surfaces from drifting (the root CLAUDE.md "derive, don't duplicate" rule).
 *
 * The keys index into the i18n `studioPage.sections` / `studioPage.groups`
 * dictionaries; the `segment` is the child route under `/w/[id]/studio/`.
 *
 * [COMP:app-web/studio-nav]
 */

import type { useT } from "@/lib/i18n/client";
import { isOssEdition } from "@/lib/edition";

export type StudioSectionKey =
  keyof ReturnType<typeof useT>["studioPage"]["sections"];
export type StudioGroupKey =
  keyof ReturnType<typeof useT>["studioPage"]["groups"];

/** `hostedOnly` sections are dropped from the nav in the OSS edition (see
 *  `visibleStudioGroups`). Mini-apps is the only one today: its sole installable
 *  mini-apps are Feed (hosted-only) and Doc (hidden), so OSS has nothing here. */
export type StudioSection = {
  key: StudioSectionKey;
  segment: string;
  hostedOnly?: boolean;
};
export type StudioGroup = { key: StudioGroupKey; sections: readonly StudioSection[] };

/**
 * Grouped by the verb each section serves (docs/architecture/features/studio.md → IA):
 *   Ingest  — sources connected and tuned (Connectors, Events, Knowledge)
 *   Consume — surfaces that use the brain (Assistants, Channels, Mini-apps)
 *   Develop — credentials for external MCP clients (Programmatic access)
 */
export const STUDIO_GROUPS: readonly StudioGroup[] = [
  {
    key: "ingest",
    sections: [
      { key: "connectors", segment: "connectors" },
      { key: "ingestRules", segment: "ingest-rules" },
      { key: "knowledge", segment: "knowledge" },
    ],
  },
  {
    key: "consume",
    sections: [
      { key: "assistants", segment: "assistants" },
      { key: "channels", segment: "channels" },
      { key: "miniApps", segment: "mini-apps", hostedOnly: true },
    ],
  },
  {
    key: "develop",
    sections: [
      { key: "programmaticAccess", segment: "programmatic-access" },
    ],
  },
] as const;

/**
 * The Studio groups visible in the current edition. Hosted gets the full
 * `STUDIO_GROUPS` unchanged; the OSS edition drops every `hostedOnly` section
 * (and any group thereby left empty). `STUDIO_GROUPS` itself stays the static
 * source of truth — callers iterate this instead so the nav reflects the
 * edition. The two nav surfaces (sidebar panel + mobile strip) both call it.
 */
export function visibleStudioGroups(): readonly StudioGroup[] {
  if (!isOssEdition()) return STUDIO_GROUPS;
  return STUDIO_GROUPS.map((g) => ({
    ...g,
    sections: g.sections.filter((s) => !s.hostedOnly),
  })).filter((g) => g.sections.length > 0);
}

/**
 * Resolve the active Studio section from a pathname
 * (`/w/<id>/studio/<segment>[/...]`). Null when the path isn't inside a known
 * section (the bare studio root, or an unknown sub-route). Drives the
 * `StudioTopbar` breadcrumb.
 */
export function studioSectionFromPathname(
  pathname: string,
): StudioSectionKey | null {
  const m = pathname.match(/\/studio\/([^/?#]+)/);
  if (!m) return null;
  for (const group of STUDIO_GROUPS) {
    for (const section of group.sections) {
      if (section.segment === m[1]) return section.key;
    }
  }
  return null;
}
