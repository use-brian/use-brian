/**
 * Unit tests for the restrict-tools catalog helper.
 * Component tag: [COMP:app-web/workflow-tools].
 */

import { beforeEach, describe, it, expect, vi } from "vitest";

vi.mock("@/lib/auth-fetch", () => ({ authFetch: vi.fn() }));
import {
  OFFICIAL_CONNECTOR_TOOLS,
} from "@use-brian/shared/builtin-connectors";
import { BUILTIN_PRIMITIVE_CONNECTOR_IDS } from "@use-brian/shared/connector-registry";
import {
  buildToolCatalog,
  catalogToolNames,
  filterToolGroups,
  normalizeToolName,
  BUILTIN_GROUP_ID,
  MAX_TOOL_NAME_LEN,
  type ConnectedToolSource,
} from "../workflow-tools";
import { authFetch } from "@/lib/auth-fetch";
import {
  listConnectedWorkflowToolSources,
  listWorkspaceConnectorOptions,
} from "../api/workflow";

const mockAuthFetch = vi.mocked(authFetch);

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function source(
  connectorId: string,
  overrides: Partial<ConnectedToolSource> = {},
): ConnectedToolSource {
  return {
    id: `instance-${connectorId}`,
    connectorId,
    label: connectorId,
    ...overrides,
  };
}

describe("[COMP:app-web/workflow-tools] tool catalog", () => {
  it("puts the Built-in group first with the curated base tools", () => {
    const groups = buildToolCatalog([]);
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

  it("shows connected official connectors and omits disconnected ones", () => {
    const groups = buildToolCatalog([source("gmail")]);
    expect(groups.some((g) => g.id === "gmail")).toBe(true);
    expect(groups.some((g) => g.id === "gcal")).toBe(false);
    expect(groups.some((g) => g.id === "github")).toBe(false);
  });

  it("keeps always-on workspace primitives without connector instances", () => {
    const groups = buildToolCatalog([]);
    for (const id of BUILTIN_PRIMITIVE_CONNECTOR_IDS) {
      if ((OFFICIAL_CONNECTOR_TOOLS[id] ?? []).length > 0) {
        expect(groups.some((group) => group.id === id)).toBe(true);
      }
    }
  });

  it("labels connected official groups from the registry and mirrors their tool lists", () => {
    const groups = buildToolCatalog([source("gmail", { label: "Work inbox" })]);
    const gmail = groups.find((g) => g.id === "gmail");
    expect(gmail?.label).toBe("Gmail");
    expect(gmail?.items.map((i) => i.name)).toEqual(
      OFFICIAL_CONNECTOR_TOOLS.gmail.map((t) => t.name),
    );
  });

  it("adds live-discovered custom connector tools under the instance label", () => {
    const groups = buildToolCatalog([
      source("custom-provider", {
        id: "custom-instance",
        label: "Acme MCP",
        items: [
          {
            name: "acmeLookup",
            description: "Look up an Acme record",
            classification: "read",
          },
        ],
      }),
    ]);
    expect(groups.find((group) => group.id === "custom-instance")).toEqual({
      id: "custom-instance",
      label: "Acme MCP",
      items: [
        {
          name: "acmeLookup",
          description: "Look up an Acme record",
          classification: "read",
        },
      ],
    });
  });

  it("omits a dynamic connector when discovery returns no tools", () => {
    const groups = buildToolCatalog([source("custom-provider", { items: [] })]);
    expect(groups.some((group) => group.id === "instance-custom-provider")).toBe(false);
  });

  it("collects catalog tool names across built-in, connected, and custom groups", () => {
    const groups = buildToolCatalog([
      source("gmail"),
      source("custom-provider", {
        items: [{ name: "customRead", description: "Read custom data", classification: "read" }],
      }),
    ]);
    const names = catalogToolNames(groups);
    expect(names.has("webSearch")).toBe(true);
    expect(names.has("gmailSendMessage")).toBe(true);
    expect(names.has("customRead")).toBe(true);
    expect(names.has("googleCalendarCreateEvent")).toBe(false);
  });
});

describe("[COMP:app-web/workflow-tools] filterToolGroups", () => {
  const groups = buildToolCatalog([source("gmail")]);

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

describe("[COMP:app-web/workflow-tools] connected connector loading", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("loads custom tools and drops disconnected workspace connectors", async () => {
    mockAuthFetch
      .mockResolvedValueOnce(json({
        teamNative: [
          { id: "gmail-instance", provider: "gmail", label: "Inbox", connected: true },
          { id: "gcal-instance", provider: "gcal", label: "Calendar", connected: false },
          {
            id: "cli-instance",
            provider: "cli",
            label: "Local tools",
            connected: true,
          },
        ],
        granted: [{
          instance: {
            id: "custom-instance",
            provider: "11111111-1111-4111-8111-111111111111",
            label: "Acme MCP",
            connected: true,
          },
        }],
      }))
      .mockResolvedValueOnce(json({
        serverName: "Local tools",
        tools: [{
          name: "localStatus",
          description: "Read local status",
          classification: "read",
        }],
      }))
      .mockResolvedValueOnce(json({
        serverName: "Acme",
        tools: [{
          name: "acmeLookup",
          description: "Look up an Acme record",
          classification: "read",
        }],
      }));

    const sources = await listConnectedWorkflowToolSources("workspace-1", "assistant-1");

    expect(sources).toEqual([
      {
        id: "gmail-instance",
        connectorId: "gmail",
        label: "Inbox",
      },
      {
        id: "cli-instance",
        connectorId: "cli",
        label: "Local tools",
        items: [{
          name: "localStatus",
          description: "Read local status",
          classification: "read",
        }],
      },
      {
        id: "custom-instance",
        connectorId: "11111111-1111-4111-8111-111111111111",
        label: "Acme MCP",
        items: [{
          name: "acmeLookup",
          description: "Look up an Acme record",
          classification: "read",
        }],
      },
    ]);
    expect(mockAuthFetch).toHaveBeenCalledTimes(3);
    expect(mockAuthFetch).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining(
        "/api/assistants/assistant-1/connectors/cli%3Acli-instance/tools",
      ),
    );
    expect(mockAuthFetch).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining(
        "/api/assistants/assistant-1/connectors/11111111-1111-4111-8111-111111111111%3Acustom-instance/tools",
      ),
    );

    const groups = buildToolCatalog(sources);
    expect(groups.find((group) => group.id === "cli-instance")).toEqual({
      id: "cli-instance",
      label: "Local tools",
      items: [{
        name: "localStatus",
        description: "Read local status",
        classification: "read",
      }],
    });
  });

  it("offers both workspace-owned and exposed personal connectors as event sources", async () => {
    mockAuthFetch.mockResolvedValueOnce(json({
      teamNative: [
        { id: "team-mailbox", provider: "imap", label: "Team inbox", connected: true },
      ],
      granted: [
        {
          instance: {
            id: "shared-mailbox",
            provider: "imap",
            label: "Shared inbox",
            connected: true,
          },
        },
      ],
    }));

    await expect(listWorkspaceConnectorOptions("workspace-1")).resolves.toEqual([
      { id: "team-mailbox", provider: "imap", label: "Team inbox", connected: true },
      { id: "shared-mailbox", provider: "imap", label: "Shared inbox", connected: true },
    ]);
  });

  it("de-duplicates an instance returned through both connector inventory paths", async () => {
    const row = { id: "mailbox-1", provider: "imap", label: "Inbox", connected: true };
    mockAuthFetch.mockResolvedValueOnce(json({
      teamNative: [row],
      granted: [{ instance: row }],
    }));

    await expect(listWorkspaceConnectorOptions("workspace-1")).resolves.toEqual([row]);
  });
});
