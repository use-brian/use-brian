/**
 * Tool catalog for the workflow step editor's "Restrict tools" multi-select
 * (app-web). Pure logic — no React, no i18n — so it carries the surface's unit
 * tests the same way `workflow-cron.ts` / `workflow-match.ts` do.
 *
 * The picker offers a grouped, searchable set of tool names an `assistant_call`
 * step may be restricted to (`step.tools`, an exact-name allow-list applied by
 * `filterToolsByAllowList` in the callee executor — matching is by the exact
 * registered `tool.name`, never a display name).
 *
 * Two group sources:
 *   - **Built-in** — the curated first-party base tools below. app-web cannot
 *     import `@use-brian/core` (where these are registered), so the list is a
 *     small local catalog; the names are verified against
 *     `packages/core/src/tools/base/index.ts` (`createBaseTools`) and
 *     `packages/core/src/memory/tools.ts`. It is a convenience catalog, not a
 *     runtime contract: the allow-list matches by exact name regardless, and
 *     the field's custom-add escape hatch covers any tool not listed here
 *     (custom MCP tools, env-gated base tools like `xSearch`, brain tools).
 *   - **Connectors** — derived at runtime from the shared connector registry
 *     (`OFFICIAL_CONNECTORS` order × `OFFICIAL_CONNECTOR_TOOLS`), never
 *     hardcoded, so adding a connector surfaces it here for free. Imported via
 *     the `@use-brian/shared/builtin-connectors` subpath (not the barrel) to
 *     keep the server-only `env.js` module out of the client bundle — the same
 *     rule `connector-action-grants.tsx` follows.
 *
 * Spec: docs/architecture/features/workflow.md → "Web builder UI".
 * [COMP:app-web/workflow-tools]
 */

import {
  OFFICIAL_CONNECTOR_TOOLS,
  type BuiltinToolClassification,
} from "@use-brian/shared/builtin-connectors";
import { OFFICIAL_CONNECTORS } from "@use-brian/shared/connector-registry";

/** One selectable tool row. `name` is the exact allow-list match key. */
export type ToolCatalogItem = {
  name: string;
  description: string;
  classification: BuiltinToolClassification;
};

/** A collapsible group of tools — the Built-in group or one connector. */
export type ToolGroup = {
  /** Stable group id: `"builtin"` or a connector id (`"gmail"`). */
  id: string;
  /** Display label. Registry-sourced for connectors (English data); the
   *  Built-in group carries an English fallback the component overrides with
   *  the translated label. */
  label: string;
  items: ToolCatalogItem[];
};

/** Stable id of the always-present first-party group. */
export const BUILTIN_GROUP_ID = "builtin";

/** Schema caps mirrored from `packages/core/src/workflow/schemas.ts` (the
 *  `tools` field: `z.array(z.string().min(1).max(128)).max(64)`), enforced by
 *  the custom-add input so a manual entry can never persist an invalid step. */
export const MAX_TOOLS = 64;
export const MAX_TOOL_NAME_LEN = 128;

/**
 * Curated first-party base tools worth offering in the picker. NOT connector
 * tools. Names verified against `createBaseTools()` + the free-mode memory
 * surface (a workflow callee runs in free mode, which injects `getMemory` +
 * `saveMemory`). Interactive / always-stripped tools are intentionally absent:
 * `askQuestion` (a workflow runs unattended), `askAssistant` /
 * `listConnectedAssistants` (the callee executor always deletes these after the
 * allow-list), `useSkill` (governed by the step's own Skills picker). `xSearch`
 * is env-gated (`XAI_API_KEY`) so it is left to the custom-add escape hatch.
 */
export const BUILTIN_TOOL_CATALOG: ToolCatalogItem[] = [
  { name: "webSearch", description: "Search the web for current information", classification: "read" },
  { name: "urlReader", description: "Read the main content of a web page", classification: "read" },
  { name: "getMemory", description: "Look up saved facts in the brain", classification: "read" },
  { name: "saveMemory", description: "Save a fact to the brain", classification: "write" },
  { name: "getTime", description: "Get the current date and time", classification: "read" },
  { name: "createTask", description: "Create a task to track work", classification: "write" },
  { name: "updateTask", description: "Update or complete a task", classification: "write" },
];

/**
 * Build the full grouped catalog: the Built-in group first, then one group per
 * official connector that exposes at least one tool, in registry order. The
 * connector groups derive from `OFFICIAL_CONNECTORS` (labels) × the
 * `OFFICIAL_CONNECTOR_TOOLS` table — a connector with no tools (`gcs`) is
 * skipped, and a newly registered connector appears automatically.
 */
export function buildToolCatalog(): ToolGroup[] {
  const groups: ToolGroup[] = [
    { id: BUILTIN_GROUP_ID, label: "Built-in", items: BUILTIN_TOOL_CATALOG },
  ];
  for (const connector of OFFICIAL_CONNECTORS) {
    const tools = OFFICIAL_CONNECTOR_TOOLS[connector.id] ?? [];
    if (tools.length === 0) continue;
    groups.push({
      id: connector.id,
      label: connector.name,
      items: tools.map((t) => ({
        name: t.name,
        description: t.description,
        classification: t.classification,
      })),
    });
  }
  return groups;
}

/** Every tool name present in the catalog — used to split a step's selected
 *  tools into "known" (in the catalog) vs "custom" (typed by hand / custom MCP,
 *  which must still be shown so editing never silently drops them). */
export function catalogToolNames(groups: ToolGroup[]): Set<string> {
  const names = new Set<string>();
  for (const group of groups) {
    for (const item of group.items) names.add(item.name);
  }
  return names;
}

/**
 * Filter the grouped catalog by a search query. A query matching a group's
 * label keeps the whole group (type "gmail" → all Gmail tools); otherwise a
 * group keeps only the items whose name or description matches. Groups left
 * with no items drop out. An empty query returns the groups unchanged.
 */
export function filterToolGroups(groups: ToolGroup[], query: string): ToolGroup[] {
  const q = query.trim().toLowerCase();
  if (!q) return groups;
  const out: ToolGroup[] = [];
  for (const group of groups) {
    if (group.label.toLowerCase().includes(q)) {
      out.push(group);
      continue;
    }
    const items = group.items.filter(
      (i) => i.name.toLowerCase().includes(q) || i.description.toLowerCase().includes(q),
    );
    if (items.length > 0) out.push({ ...group, items });
  }
  return out;
}

/**
 * Normalize a hand-typed tool name for the custom-add escape hatch. Trims
 * surrounding whitespace; returns `null` when the result is empty or exceeds
 * the schema's per-name length cap (so the caller can reject it).
 */
export function normalizeToolName(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_TOOL_NAME_LEN) return null;
  return trimmed;
}
