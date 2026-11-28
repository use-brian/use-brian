/**
 * [COMP:app-web/tool-narration] Shared tool → narration describer.
 *
 * The resolution-order contract: input-aware template → static per-tool
 * label → generic "Running {name}". Before extraction the chat surface
 * skipped tier 2, so tools with a friendly dictionary label still rendered
 * as raw "Running <toolName>".
 */

import { describe, expect, it } from "vitest";
import { en } from "@/lib/i18n/dictionaries/en";
import {
  describeToolFromInput,
  staticToolLabel,
  summarizeToolArgs,
} from "@/lib/tool-narration";

const dict = en.chat.toolNarration;

describe("[COMP:app-web/tool-narration] describeToolFromInput", () => {
  it.each(["readChatHistory", "requestConversationContext"])(
    "uses the chat history narration for %s",
    (name) => {
      expect(describeToolFromInput(name, {}, dict).description).toBe("Checking chat history");
    },
  );

  it("builds input-aware lines for searches", () => {
    expect(describeToolFromInput("webSearch", { query: "middle mile" }, dict).description).toBe(
      'Searching "middle mile"',
    );
    expect(
      describeToolFromInput("mcp_search", { query: "drep tools" }, dict).description,
    ).toBe('Searching tools: "drep tools"');
  });

  it("narrates urlReader with the host and carries the link", () => {
    const n = describeToolFromInput(
      "urlReader",
      { url: "https://www.example.com/a/b" },
      dict,
    );
    expect(n.description).toBe("Reading example.com");
    expect(n.url).toBe("https://www.example.com/a/b");
  });

  it("names the remote tool + server for mcp_call", () => {
    expect(
      describeToolFromInput("mcp_call", { tool: "searchDreps", server: "cgov" }, dict)
        .description,
    ).toBe("Using searchDreps (cgov)");
  });

  it("falls back to the static per-tool label when no input template fits", () => {
    expect(describeToolFromInput("gmailSendMessage", {}, dict).description).toBe(
      "Sending email",
    );
    expect(describeToolFromInput("googleCalendarListEvents", {}, dict).description).toBe(
      "Checking your calendar",
    );
  });

  it("derives a Using {tool} ({server}) line for server-prefixed MCP names", () => {
    expect(describeToolFromInput("mcp_notion_createPage", {}, dict).description).toBe(
      "Using createPage (notion)",
    );
  });

  it("degrades to the generic label for unknown tools", () => {
    expect(describeToolFromInput("getWorkflow", {}, dict).description).toBe(
      "Running getWorkflow",
    );
  });

  it("expands patchPage into per-op narration lines", () => {
    const n = describeToolFromInput(
      "patchPage",
      {
        ops: [
          { op: "add", block: { kind: "heading", content: [{ text: "Overview" }] } },
          { op: "delete" },
        ],
      },
      dict,
    );
    expect(n.opLines).toEqual(['Adding heading "Overview"', "Removing a block"]);
  });
});

describe("[COMP:app-web/tool-narration] staticToolLabel", () => {
  it("returns plain labels and refuses template entries", () => {
    expect(staticToolLabel(dict, "webSearch")).toBe("Searching the web");
    // `generic` is a {name} template — a tool named "generic" must not
    // leak the raw placeholder string.
    expect(staticToolLabel(dict, "generic")).toBeUndefined();
    expect(staticToolLabel(dict, "definitelyUnknownTool")).toBeUndefined();
  });
});

describe("[COMP:app-web/tool-narration] argument detail", () => {
  it("summarises the first scalar args and skips nested values", () => {
    expect(
      summarizeToolArgs({ filter: { a: 1 }, query: "name:#1042", first: 50, verbose: true }),
    ).toBe("query: name:#1042 · first: 50");
    // The identifying argument leads even when the model emitted it last.
    expect(summarizeToolArgs({ limit: 5, query: "pricing" })).toBe("query: pricing · limit: 5");
    expect(summarizeToolArgs({ query: "" })).toBeUndefined();
    expect(summarizeToolArgs("not an object")).toBeUndefined();
    expect(summarizeToolArgs({ query: "x".repeat(60) })).toBe(`query: ${"x".repeat(37)}…`);
  });

  it("carries mcp_call args as detail so repeated calls read as different rows", () => {
    const n = describeToolFromInput(
      "mcp_call",
      { server: "shopify", tool: "shopifyListOrders", args: { query: "name:#1042" } },
      dict,
    );
    expect(n.description).toBe("Using shopifyListOrders (shopify)");
    expect(n.detail).toBe("query: name:#1042");
  });

  it("gives prefixed-MCP and unlabelled tools an input detail, and input-aware lines none", () => {
    expect(describeToolFromInput("mcp_cgov_searchDreps", { name: "x" }, dict).detail).toBe(
      "name: x",
    );
    expect(describeToolFromInput("definitelyUnknownTool", { limit: 20 }, dict).detail).toBe(
      "limit: 20",
    );
    expect(describeToolFromInput("webSearch", { query: "middle mile" }, dict).detail).toBeUndefined();
    expect(describeToolFromInput("mcp_search", { query: "orders" }, dict).detail).toBeUndefined();
  });
});
