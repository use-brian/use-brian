/**
 * [COMP:app-web/activity-receipt] Post-turn receipt logic: history restore
 * (steps + notes + outcomes from the paired tool_result rows), the by-kind
 * summary line, and the expanded feed layout (notes / ×N groups / steps).
 */

import { describe, expect, it } from "vitest";
import type { ToolUsed } from "@use-brian/chat-ui";
import { en } from "@/lib/i18n/dictionaries/en";
import {
  buildReceiptItems,
  collectToolResults,
  finalizeActivityNotes,
  outputExcerptOf,
  restoreAssistantActivity,
  summarizeActivity,
  terminalFailureIds,
} from "@/lib/activity-receipt";

const narration = en.chat.toolNarration;
const activity = en.chat.activity;

const shopifyUse = (id: string, query: string) => ({
  type: "tool_use",
  id,
  name: "mcp_call",
  input: { server: "shopify", tool: "shopifyListOrders", args: { query } },
});

describe("[COMP:app-web/activity-receipt] restoreAssistantActivity", () => {
  it("restores actual host read input and result without a fabricated provider call", () => {
    const observation = { type: "host_observation", version: 1, id: "host-read-1", name: "googleCalendarListEvents",
      input: { calendarId: "fictional-calendar" }, content: "Fictional meeting at noon", isError: false };
    const outcomes = collectToolResults([{ content: [observation] }]);
    const restored = restoreAssistantActivity([observation], outcomes, narration, "host-row");
    expect(restored.toolsUsed).toHaveLength(1);
    expect(restored.toolsUsed[0]).toMatchObject({ id: observation.id, name: observation.name, status: "done",
      input: observation.input, output: observation.content });
    expect(restored.activityNotes).toEqual([]);
    expect(restoreAssistantActivity([{ ...observation, providerSignature: "forged" }], outcomes, narration, "host-row").toolsUsed).toEqual([]);
  });
  it("restores steps with input and detail, and notes attached to the call they precede", () => {
    const outcomes = collectToolResults([]);
    const { toolsUsed, activityNotes } = restoreAssistantActivity(
      [
        { type: "text", text: "Let me find the right tool." },
        { type: "tool_use", id: "toolu_01", name: "mcp_search", input: { query: "orders" } },
        { type: "text", text: "Now the lookup." },
        shopifyUse("toolu_02", "name:#1042"),
        { type: "text", text: "trailing" },
      ],
      outcomes,
      narration,
      "row1",
    );
    expect(toolsUsed).toEqual([
      {
        id: "toolu_01",
        name: "mcp_search",
        status: "done",
        description: 'Searching tools: "orders"',
        input: { query: "orders" },
      },
      {
        id: "toolu_02",
        name: "mcp_call",
        status: "done",
        description: "Using shopifyListOrders (shopify)",
        detail: "query: name:#1042",
        input: { server: "shopify", tool: "shopifyListOrders", args: { query: "name:#1042" } },
      },
    ]);
    expect(activityNotes).toEqual([
      { id: "row1_note_0", text: "Let me find the right tool.", beforeToolId: "toolu_01" },
      { id: "row1_note_1", text: "Now the lookup.", beforeToolId: "toolu_02" },
      // Trailing text is left unattached for the coalescer to resolve.
      { id: "row1_note_2", text: "trailing" },
    ]);
  });

  it("reads a call's outcome from the paired tool_result row so a failure restores as retried", () => {
    const outcomes = collectToolResults([
      { content: [{ type: "text", text: "unrelated user row" }] },
      {
        content: [
          {
            type: "tool_result",
            toolUseId: "toolu_02",
            name: "mcp_call",
            content: "Error:   Column Not Found:\n order_number",
            isError: true,
          },
          { type: "tool_result", toolUseId: "toolu_03", name: "mcp_call", content: "{}" },
        ],
      },
    ]);
    const { toolsUsed } = restoreAssistantActivity(
      [shopifyUse("toolu_02", "order_number:1042"), shopifyUse("toolu_03", "name:#1042")],
      outcomes,
      narration,
      "row2",
    );
    expect(toolsUsed[0]).toMatchObject({
      status: "retried",
      errorMessage: "Error: Column Not Found: order_number",
    });
    expect(toolsUsed[1]).toMatchObject({ status: "done", output: "{}" });
    expect(toolsUsed[1]?.errorMessage).toBeUndefined();
    // The failed call keeps its raw output too, newlines intact.
    expect(toolsUsed[0]?.output).toBe("Error:   Column Not Found:\n order_number");
  });

  it("caps the restored output at the stream's ~2 KB excerpt", () => {
    expect(outputExcerptOf("a\r\nb\n\n\n\nc")).toBe("a\nb\n\nc");
    const big = outputExcerptOf("z".repeat(9000));
    expect(big).toHaveLength(2002);
    expect(big.endsWith("\n…")).toBe(true);
    expect(outputExcerptOf("  ")).toBe("");
  });

  it("clips a long error excerpt and ignores rows that are not arrays", () => {
    const outcomes = collectToolResults([
      { content: "not blocks" },
      {
        content: [
          { type: "tool_result", toolUseId: "x", name: "t", content: "e".repeat(400), isError: true },
        ],
      },
    ]);
    expect(outcomes.get("x")?.excerpt).toHaveLength(198);
    expect(outcomes.get("x")?.excerpt.endsWith("…")).toBe(true);
    expect(restoreAssistantActivity("plain string", outcomes, narration, "r")).toEqual({
      toolsUsed: [],
      activityNotes: [],
    });
  });
});

describe("[COMP:app-web/activity-receipt] finalizeActivityNotes", () => {
  it("keeps only notes that precede a tool and are not the answer", () => {
    expect(
      finalizeActivityNotes(
        [
          { id: "1", text: "Let me check.", beforeToolId: "t1" },
          { id: "2", text: "Done." , beforeToolId: "t2" },
          { id: "3", text: "stray" },
          { id: "4", text: "   ", beforeToolId: "t3" },
        ],
        "Done.",
      ),
    ).toEqual([{ id: "1", text: "Let me check.", beforeToolId: "t1" }]);
    expect(finalizeActivityNotes([{ id: "3", text: "stray" }], "x")).toBeUndefined();
    expect(finalizeActivityNotes(undefined, "x")).toBeUndefined();
  });
});

describe("[COMP:app-web/activity-receipt] summarizeActivity", () => {
  const mcp = (server: string): Pick<ToolUsed, "name" | "input"> => ({
    name: "mcp_call",
    input: { server, tool: "x" },
  });

  it("names the two largest buckets and folds the rest into N more", () => {
    const tools = [
      { name: "mcp_search" },
      ...Array.from({ length: 9 }, () => mcp("shopify")),
      { name: "urlReader" },
      { name: "saveMemory" },
    ];
    expect(summarizeActivity(tools, activity)).toBe(
      "Ran 9 Shopify calls, searched once, and 2 more",
    );
  });

  it("uses singular forms, a lone bucket, and the read heuristic", () => {
    expect(summarizeActivity([{ name: "webSearch" }], activity)).toBe("Searched once");
    expect(summarizeActivity([{ name: "listWorkflows" }, { name: "getWorkflow" }], activity)).toBe(
      "Read 2 sources",
    );
    expect(summarizeActivity([{ name: "mcp_cgov_searchDreps" }, { name: "patchPage" }], activity)).toBe(
      "Ran 1 Cgov call and ran 1 tool",
    );
    expect(summarizeActivity([], activity)).toBe("");
  });
});

describe("[COMP:app-web/activity-receipt] buildReceiptItems", () => {
  const call = (id: string, query: string, over?: Partial<ToolUsed>): ToolUsed => ({
    id,
    name: "mcp_call",
    status: "done",
    description: "Using shopifyListOrders (shopify)",
    detail: `query: ${query}`,
    input: { server: "shopify", tool: "shopifyListOrders", args: { query } },
    ...over,
  });

  it("groups consecutive same-tool calls, breaks on notes and on a different tool", () => {
    const items = buildReceiptItems(
      [
        { id: "s1", name: "mcp_search", status: "done", description: "Searching tools" },
        call("c1", "a"),
        call("c2", "b"),
        call("c3", "c"),
        call("c4", "d", { input: { server: "shopify", tool: "shopifyGetOrder" } }),
        call("c5", "e"),
      ],
      [
        { id: "n1", text: "Let me look.", beforeToolId: "c1" },
        { id: "n2", text: "Different tool now.", beforeToolId: "c3" },
        { id: "n3", text: "orphan (dropped call)", beforeToolId: "gone" },
      ],
    );
    expect(items.map((item) => item.kind)).toEqual([
      "step", // s1
      "note", // n1
      "group", // c1 + c2
      "note", // n2
      "step", // c3 alone (note split the run)
      "step", // c4 — a different mcp tool never joins
      "step", // c5
    ]);
    const group = items[2];
    expect(group?.kind === "group" && group.tools.map((tool) => tool.id)).toEqual(["c1", "c2"]);
    expect(group?.kind === "group" && group.label).toBe("Using shopifyListOrders (shopify)");
  });

  it("groups by name for non-MCP tools", () => {
    const items = buildReceiptItems(
      [
        { id: "w1", name: "webSearch", status: "done", description: 'Searching "a"' },
        { id: "w2", name: "webSearch", status: "done", description: 'Searching "b"' },
      ],
      undefined,
    );
    expect(items).toHaveLength(1);
    expect(items[0]?.kind).toBe("group");
  });
});

describe("[COMP:app-web/activity-receipt] terminalFailureIds", () => {
  const call = (id: string, tool: string, status: ToolUsed["status"]): ToolUsed => ({
    id,
    name: "mcp_call",
    status,
    input: { server: "shopify", tool },
  });

  it("marks an errored call Failed only when no later call of the same tool followed", () => {
    const failed = terminalFailureIds([
      call("c1", "shopifyListOrders", "retried"), // followed by c2 → Retried
      call("c2", "shopifyListOrders", "done"),
      call("c3", "shopifyGetOrder", "retried"), // nothing followed → Failed
      { id: "w1", name: "webSearch", status: "retried" }, // different tool, last → Failed
    ]);
    expect([...failed].sort()).toEqual(["c3", "w1"]);
  });
});
