import { describe, expect, it } from "vitest";
import {
  addPageLinks,
  collectPageWrites,
  pageIdsFromToolResult,
  pageLinksForRow,
} from "@/lib/chat-page-links";

describe("[COMP:app-web/chat-page-links] Pages written by a Chat turn", () => {
  it("reads page ids from a doc-edit receipt and a direct page render", () => {
    expect(
      pageIdsFromToolResult(
        JSON.stringify({ status: "completed", summary: "Built it", pageIds: ["p1", "p1", "p2"] }),
      ),
    ).toEqual(["p1", "p2"]);
    expect(pageIdsFromToolResult(JSON.stringify({ pageId: "p3", version: 1 }))).toEqual(["p3"]);
  });

  it("links nothing for a failed receipt or an error result", () => {
    expect(
      pageIdsFromToolResult(JSON.stringify({ status: "failed", pageIds: ["p1"] })),
    ).toEqual([]);
    expect(pageIdsFromToolResult(JSON.stringify({ pageIds: ["p1"] }), true)).toEqual([]);
  });

  it("recovers ids from a truncated result string", () => {
    expect(
      pageIdsFromToolResult('{"status":"partial","pageIds":["p1","p2"],"summary":"long…'),
    ).toEqual(["p1", "p2"]);
  });

  it("maps a thread's persisted rows to each assistant row's pages", () => {
    const assistantRow = {
      content: [
        { type: "text", text: "Creating the board." },
        { type: "tool_use", id: "tu-1", name: "delegateDocEdit", input: { intent: "create" } },
        { type: "tool_use", id: "tu-2", name: "searchBrain", input: {} },
      ],
    };
    const resultRow = {
      content: [
        {
          type: "tool_result",
          toolUseId: "tu-1",
          content: JSON.stringify({ status: "completed", pageIds: ["page-a"] }),
        },
        { type: "tool_result", toolUseId: "tu-2", content: '{"pageId":"not-a-write"}' },
      ],
    };
    const writes = collectPageWrites([assistantRow, resultRow]);
    expect([...writes.entries()]).toEqual([["tu-1", ["page-a"]]]);
    expect(pageLinksForRow(assistantRow.content, writes)).toEqual(["page-a"]);
    expect(pageLinksForRow("plain text", writes)).toEqual([]);
  });

  it("appends live ids in order without repeats", () => {
    expect(addPageLinks(["a"], ["b", "a", "c"])).toEqual(["a", "b", "c"]);
  });
});
