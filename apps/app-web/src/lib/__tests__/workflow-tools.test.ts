/**
 * Unit tests for the restrict-tools catalog helper.
 * Component tag: [COMP:app-web/workflow-tools].
 */

import { describe, it, expect } from "vitest";
import {
  OFFICIAL_CONNECTOR_TOOLS,
} from "@use-brian/shared/builtin-connectors";
import { OFFICIAL_CONNECTORS } from "@use-brian/shared/connector-registry";
import {
  buildToolCatalog,
  catalogToolNames,
  filterToolGroups,
  normalizeToolName,
  BUILTIN_GROUP_ID,
  BUILTIN_TOOL_CATALOG,
  MAX_TOOL_NAME_LEN,
} from "../workflow-tools";

describe("[COMP:app-web/workflow-tools] tool catalog", () => {
  it("puts the Built-in group first with the curated base tools", () => {
    const groups = buildToolCatalog();
    expect(groups[0].id).toBe(BUILTIN_GROUP_ID);
    const names = groups[0].items.map((i) => i.name);
    // Verified against createBaseTools + the free-mode memory surface.
    expect(names).toContain("webSearch");
    expect(names).toContain("urlReader");
    expect(names).toContain("saveMemory");
    // Interactive / always-stripped tools must never be offered.
    expect(names).not.toContain("askQuestion");
    expect(names).not.toContain("askAssistant");
    expect(names).not.toContain("useSkill");
  });

  it("derives one group per official connector that exposes tools, in registry order", () => {
    const groups = buildToolCatalog();
    const connectorGroups = groups.filter((g) => g.id !== BUILTIN_GROUP_ID);
    const expected = OFFICIAL_CONNECTORS.filter(
      (c) => (OFFICIAL_CONNECTOR_TOOLS[c.id] ?? []).length > 0,
    ).map((c) => c.id);
    expect(connectorGroups.map((g) => g.id)).toEqual(expected);
    // gcs has no tools — it must be skipped.
    expect(groups.some((g) => g.id === "gcs")).toBe(false);
  });

  it("labels connector groups from the registry and mirrors their tool lists", () => {
    const groups = buildToolCatalog();
    const gmail = groups.find((g) => g.id === "gmail");
    expect(gmail?.label).toBe("Gmail");
    expect(gmail?.items.map((i) => i.name)).toEqual(
      OFFICIAL_CONNECTOR_TOOLS.gmail.map((t) => t.name),
    );
  });

  it("collects every catalog tool name across all groups", () => {
    const groups = buildToolCatalog();
    const names = catalogToolNames(groups);
    expect(names.has("webSearch")).toBe(true);
    expect(names.has("gmailSendMessage")).toBe(true);
    expect(names.has("googleCalendarCreateEvent")).toBe(true);
    // Size = built-in + every non-empty connector's tools.
    const connectorTotal = OFFICIAL_CONNECTORS.reduce(
      (n, c) => n + (OFFICIAL_CONNECTOR_TOOLS[c.id] ?? []).length,
      0,
    );
    expect(names.size).toBe(BUILTIN_TOOL_CATALOG.length + connectorTotal);
  });
});

describe("[COMP:app-web/workflow-tools] filterToolGroups", () => {
  const groups = buildToolCatalog();

  it("returns every group unchanged for an empty query", () => {
    expect(filterToolGroups(groups, "")).toBe(groups);
    expect(filterToolGroups(groups, "   ")).toBe(groups);
  });

  it("keeps a whole group when the query matches its label", () => {
    const out = filterToolGroups(groups, "gmail");
    const gmail = out.find((g) => g.id === "gmail");
    expect(gmail?.items).toEqual(OFFICIAL_CONNECTOR_TOOLS.gmail.map((t) => ({
      name: t.name,
      description: t.description,
      classification: t.classification,
    })));
  });

  it("filters to matching items by name or description, case-insensitively", () => {
    const out = filterToolGroups(groups, "SEND");
    const gmail = out.find((g) => g.id === "gmail");
    expect(gmail?.items.map((i) => i.name)).toContain("gmailSendMessage");
    // A group with no match drops out entirely.
    expect(out.every((g) => g.items.length > 0)).toBe(true);
  });

  it("returns no groups when nothing matches", () => {
    expect(filterToolGroups(groups, "zzz-no-such-tool")).toEqual([]);
  });
});

describe("[COMP:app-web/workflow-tools] normalizeToolName", () => {
  it("trims surrounding whitespace", () => {
    expect(normalizeToolName("  webSearch  ")).toBe("webSearch");
  });

  it("rejects empty / whitespace-only input", () => {
    expect(normalizeToolName("")).toBeNull();
    expect(normalizeToolName("   ")).toBeNull();
  });

  it("rejects a name past the schema length cap", () => {
    expect(normalizeToolName("a".repeat(MAX_TOOL_NAME_LEN))).not.toBeNull();
    expect(normalizeToolName("a".repeat(MAX_TOOL_NAME_LEN + 1))).toBeNull();
  });
});
