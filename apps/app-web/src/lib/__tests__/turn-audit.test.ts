/**
 * Turn audit view-model (docs/architecture/features/chat-audit.md).
 *
 * The audit panel's rendering is FE/gstack-QA territory; the rules that
 * decide WHAT it renders - prompt pairing, trace flattening, the retrieval
 * de-dup, which ids light up the graph, the deep-link contract - are pure
 * and pinned here.
 */

import { describe, expect, it } from "vitest";
import type { DocSessionMessage } from "../api/sessions";
import {
  auditTurnUrl,
  buildAuditTurns,
  eagerToolInputRefs,
  filterAuditTurns,
  graphAccessSteps,
  formatPayloadPreview,
  formatPromptMessage,
  formatPromptResponse,
  formatTokens,
  graphHighlightIds,
  graphHighlightNames,
  humanizeToolName,
  isBrainRowTool,
  mergeTurnTraces,
  parseAuditDeepLink,
  providerPromptRefs,
  retrievedPrimitiveLabel,
  summarizeTrace,
  usageTokens,
  withToolInputs,
  type TurnTrace,
} from "../turn-audit";

function msg(
  id: string,
  role: DocSessionMessage["role"],
  content: unknown,
  extra: Partial<DocSessionMessage> = {},
): DocSessionMessage {
  return {
    id,
    role,
    content,
    timestamp: `2026-09-0${id.length % 9 || 1}T00:00:00.000Z`,
    senderUserId: null,
    senderName: null,
    ...extra,
  };
}

const M1 = "11111111-1111-4111-8111-111111111111";
const M2 = "22222222-2222-4222-8222-222222222222";
const E1 = "33333333-3333-4333-8333-333333333333";

describe("[COMP:app-web/turn-audit] browsing and access replay", () => {
  const turns = buildAuditTurns([
    msg("u1", "user", "Budget [draft]"),
    msg("a1", "assistant", "The estimate is ready", { timestamp: "2026-09-01T10:00:00Z" }),
    msg("u2", "user", "Find the launch plan"),
    msg("a2", "assistant", [{ type: "tool_use", id: "call", name: "getEntity", input: {} }]),
    msg("a3", "assistant", "Release on Friday", { timestamp: "2026-09-02T10:00:00Z" }),
  ]);
  it("shows newest first, preserving turn numbers and multi-round grouping", () => {
    expect(filterAuditTurns(turns, "").map((turn) => [turn.id, turn.index, turn.rounds]))
      .toEqual([["a3", 2, 2], ["a1", 1, 1]]);
    expect(turns.map((turn) => turn.id)).toEqual(["a1", "a3"]);
  });
  it("searches prompts, replies and tools literally, with empty/no-match handling", () => {
    for (const query of [" LAUNCH ", "friday", "getentity"]) {
      expect(filterAuditTurns(turns, query).map((turn) => turn.id)).toEqual(["a3"]);
    }
    expect(filterAuditTurns(turns, "[draft]").map((turn) => turn.id)).toEqual(["a1"]);
    expect(filterAuditTurns(turns, "missing")).toEqual([]);
    expect(filterAuditTurns(turns, "  ")).toHaveLength(2);
  });
  it("replays actual retrieval and brain-tool steps in ordinal order, preserving repeated access", () => {
    const summary = summarizeTrace({ fidelity: "legacy", preEpoch: true, sessionId: "fixture", steps: [
      { ordinal: 4, kind: "tool_call", at: null, payloadRefs: [], metadata: { name: "getEntity", input: { id_or_name: "Launch plan" } } },
      { ordinal: 3, kind: "tool_call", at: null, payloadRefs: [], metadata: { name: "sendMessage", input: { entityId: E1 } } },
      { ordinal: 2, kind: "tool_call", at: null, payloadRefs: [], metadata: { name: "getMemory", input: { memoryId: M1 } } },
      { ordinal: 1, kind: "retrieval", at: null, payloadRefs: [], metadata: { returnedRows: [{ primitive: "memory", rowId: M1 }] } },
    ] });
    expect(graphAccessSteps(summary).map((step) => [step.kind, step.ids, step.names]))
      .toEqual([["retrieval", [M1], []], ["tool_call", [M1], []], ["tool_call", [], ["launch plan"]]]);
    expect(graphAccessSteps({ steps: [] })).toEqual([]);
  });
  it("replays a retrieval one entry at a time in returned order, once per entry", () => {
    const summary = summarizeTrace({ fidelity: "full", preEpoch: false, sessionId: "fixture", steps: [
      { ordinal: 0, kind: "retrieval", at: null, payloadRefs: [], metadata: { source: "index_inject", returnedRows: [
        { primitive: "memory", rowId: M1 },
        { primitive: "entity", rowId: E1 },
        { primitive: "memory", rowId: M1 },
      ] } },
    ] });
    expect(summary.steps[0]!.rows!.map((row) => row.rowId)).toEqual([M1, E1]);
    const accesses = graphAccessSteps(summary);
    expect(accesses.map((step) => [step.stepKey, step.rowId, step.ids])).toEqual([
      ["0:retrieval", M1, [M1]],
      ["0:retrieval", E1, [E1]],
    ]);
    expect(new Set(accesses.map((step) => step.key)).size).toBe(2);
  });
});

describe("[COMP:app-web/turn-audit] buildAuditTurns", () => {
  it("pairs each turn with the nearest preceding prompt and counts tools", () => {
    const turns = buildAuditTurns([
      msg("u1", "user", "hello there"),
      msg("a1", "assistant", [
        { type: "tool_use", id: "t1", name: "searchBrain", input: {} },
        { type: "tool_use", id: "t2", name: "searchBrain", input: {} },
        { type: "tool_use", id: "t3", name: "getEntity", input: {} },
        { type: "text", text: "answer one" },
      ]),
      msg("s1", "system", "ignored"),
      msg("u2", "user", [{ type: "text", text: "second" }]),
      msg("a2", "assistant", [{ type: "text", text: "answer two" }], {
        senderAssistantId: "asst-2",
      }),
      msg("a3", "assistant", "answer three (same prompt, room)", {
        senderAssistantId: "asst-3",
      }),
    ]);
    expect(turns.map((t) => t.id)).toEqual(["a1", "a2", "a3"]);
    expect(turns.map((t) => t.index)).toEqual([1, 2, 3]);
    expect(turns[0].prompt).toBe("hello there");
    expect(turns[0].reply).toBe("answer one");
    expect(turns[0].toolNames).toEqual(["searchBrain", "getEntity"]);
    expect(turns[0].rounds).toBe(1);
    expect(turns[1].prompt).toBe("second");
    expect(turns[1].assistantId).toBe("asst-2");
    // A different answering assistant on the same prompt is its own turn.
    expect(turns[2].prompt).toBe("second");
    expect(turns[2].assistantId).toBe("asst-3");
    expect(turns[2].toolNames).toEqual([]);
  });

  it("folds a multi-round reply (tool-result user rows between rounds) into ONE turn keyed by its last row", () => {
    const turns = buildAuditTurns([
      msg("u1", "user", "look it up"),
      msg("a1", "assistant", [{ type: "tool_use", id: "c1", name: "search", input: { query: "x" } }]),
      msg("r1", "user", [{ type: "tool_result", toolUseId: "c1", name: "search", content: "…" }]),
      msg("a2", "assistant", [{ type: "tool_use", id: "c2", name: "getEntity", input: { entityId: E1 } }]),
      msg("r2", "user", [{ type: "tool_result", toolUseId: "c2", name: "getEntity", content: "…" }]),
      msg("a3", "assistant", [{ type: "text", text: "here is the answer" }]),
      msg("u2", "user", "thanks, and another?"),
      msg("a4", "assistant", "sure"),
    ]);
    expect(turns).toHaveLength(2);
    expect(turns[0].id).toBe("a3");
    expect(turns[0].roundIds).toEqual(["a1", "a2", "a3"]);
    expect(turns[0].rounds).toBe(3);
    expect(turns[0].prompt).toBe("look it up");
    expect(turns[0].toolNames).toEqual(["search", "getEntity"]);
    expect(turns[0].reply).toBe("here is the answer");
    expect(turns[1].id).toBe("a4");
    expect(turns[1].prompt).toBe("thanks, and another?");
    expect(turns[1].index).toBe(2);
  });

  it("gives a leading assistant row no prompt", () => {
    const turns = buildAuditTurns([msg("a0", "assistant", "hi, I am here")]);
    expect(turns[0].prompt).toBeNull();
    expect(turns[0].promptAt).toBeNull();
  });
});

describe("[COMP:app-web/turn-audit] mergeTurnTraces", () => {
  const legacy = (id: string, steps: TurnTrace["steps"]): TurnTrace => ({
    fidelity: "legacy",
    preEpoch: true,
    sessionId: `s-${id}`,
    steps,
  });
  it("returns a full last trace untouched (it already holds every round)", () => {
    const merged = mergeTurnTraces([legacy("a", []), fullTrace]);
    expect(merged).toBe(fullTrace);
  });
  it("concatenates legacy rounds in order, renumbers, and keeps one usage summary", () => {
    const merged = mergeTurnTraces([
      legacy("a", [
        { ordinal: 0, kind: "tool_call", metadata: { name: "search" }, payloadRefs: [], at: null },
        { ordinal: 1, kind: "usage_summary", metadata: { calls: 2 }, payloadRefs: [], at: null },
      ]),
      null,
      legacy("b", [
        { ordinal: 0, kind: "response_text", metadata: { text: "done" }, payloadRefs: [], at: null },
        { ordinal: 1, kind: "usage_summary", metadata: { calls: 3 }, payloadRefs: [], at: null },
      ]),
    ]);
    expect(merged?.fidelity).toBe("legacy");
    expect(merged?.steps.map((s) => [s.ordinal, s.kind])).toEqual([
      [0, "tool_call"],
      [1, "response_text"],
      [2, "usage_summary"],
    ]);
    expect(merged?.steps[2].metadata.calls).toBe(3);
  });
  it("returns null when no round produced a trace", () => {
    expect(mergeTurnTraces([null, null])).toBeNull();
  });
});

const fullTrace: TurnTrace = {
  fidelity: "full",
  preEpoch: false,
  sessionId: "sess-1",
  steps: [
    {
      ordinal: 0,
      kind: "retrieval",
      metadata: {
        returnedRows: [
          { primitive: "memory", rowId: M1 },
          { primitive: "memory", rowId: M2 },
        ],
        source: "index_inject",
      },
      payloadRefs: [],
      at: "2026-09-01T00:00:00.000Z",
    },
    {
      ordinal: 2,
      kind: "tool_call",
      metadata: { name: "getEntity", toolUseId: "t1", isError: false, hasResult: true, turn: 0 },
      payloadRefs: ["h-in", "h-out"],
      at: "2026-09-01T00:00:02.000Z",
    },
    {
      ordinal: 1,
      kind: "provider_call",
      metadata: {
        model: "gemini-3-flash",
        stopReason: "tool_use",
        turn: 0,
        usage: { inputTokens: 1200, outputTokens: 80 },
      },
      payloadRefs: ["sys", "m0", "resp"],
      at: "2026-09-01T00:00:01.000Z",
    },
    {
      ordinal: 3,
      kind: "provider_call",
      metadata: {
        model: "gemini-3-flash",
        stopReason: "end_turn",
        turn: 1,
        usage: { input_tokens: 1500, output_tokens: 300 },
      },
      payloadRefs: ["sys", "m0", "m1", "resp2"],
      at: "2026-09-01T00:00:03.000Z",
    },
    {
      ordinal: 4,
      kind: "retrieval",
      metadata: {
        returnedRows: [{ primitive: "memory", rowId: M1 }],
        nudgeVerdict: { [M1]: "USED" },
        source: "nudge",
      },
      payloadRefs: [],
      at: "2026-09-01T00:00:04.000Z",
    },
    {
      ordinal: 5,
      kind: "something_new",
      metadata: {},
      payloadRefs: [],
      at: null,
    },
  ],
};

describe("[COMP:app-web/turn-audit] summarizeTrace", () => {
  it("orders by ordinal, totals usage across provider calls, and de-dupes retrievals with USED winning", () => {
    const s = summarizeTrace(fullTrace);
    expect(s.fidelity).toBe("full");
    expect(s.steps.map((x) => x.kind)).toEqual([
      "retrieval",
      "provider_call",
      "tool_call",
      "provider_call",
      "retrieval",
      "other",
    ]);
    expect(s.providerCalls).toBe(2);
    expect(s.toolCalls).toBe(1);
    expect(s.toolErrors).toBe(0);
    expect(s.inputTokens).toBe(2700);
    expect(s.outputTokens).toBe(380);
    expect(s.costUsd).toBeNull();
    expect(s.models).toEqual(["gemini-3-flash"]);
    expect(s.retrievedRows).toHaveLength(2);
    const m1 = s.retrievedRows.find((r) => r.rowId === M1);
    expect(m1?.verdict).toBe("USED");
    expect(s.retrievedRows.find((r) => r.rowId === M2)?.verdict).toBeNull();
    const tool = s.steps[2];
    expect(tool.toolName).toBe("getEntity");
    expect(tool.hasResult).toBe(true);
    expect(tool.payloadRefs).toEqual(["h-in", "h-out"]);
    expect(tool.input).toBeUndefined();
  });

  it("carries legacy inline input/result, response text, and the approximate usage summary", () => {
    const s = summarizeTrace({
      fidelity: "legacy",
      preEpoch: true,
      sessionId: "s",
      steps: [
        {
          ordinal: 0,
          kind: "tool_call",
          metadata: {
            name: "searchBrain",
            toolUseId: "c1",
            input: { query: "acme", entityId: E1 },
            result: "found 3",
            isError: true,
          },
          payloadRefs: [],
          at: null,
        },
        { ordinal: 1, kind: "response_text", metadata: { text: "the answer" }, payloadRefs: [], at: null },
        {
          ordinal: 2,
          kind: "usage_summary",
          metadata: { calls: 3, inputTokens: 900, outputTokens: 120, costUsd: 0.01, approximate: true },
          payloadRefs: [],
          at: null,
        },
      ],
    });
    expect(s.toolCalls).toBe(1);
    expect(s.toolErrors).toBe(1);
    expect(s.steps[0].input).toEqual({ query: "acme", entityId: E1 });
    expect(s.steps[0].result).toBe("found 3");
    expect(s.steps[0].hasResult).toBe(true);
    expect(s.steps[1].text).toBe("the answer");
    expect(s.inputTokens).toBe(900);
    expect(s.outputTokens).toBe(120);
    expect(s.costUsd).toBeCloseTo(0.01);
    expect(s.usageApproximate).toBe(true);
    expect(s.providerCalls).toBe(0);
  });

  it("marks a legacy tool with a null result as unresolved", () => {
    const s = summarizeTrace({
      fidelity: "legacy",
      preEpoch: true,
      sessionId: "s",
      steps: [
        { ordinal: 0, kind: "tool_call", metadata: { name: "x", input: {}, result: null }, payloadRefs: [], at: null },
      ],
    });
    expect(s.steps[0].hasResult).toBe(false);
    expect(s.steps[0].result).toBeNull();
  });
});

describe("[COMP:app-web/turn-audit] graphHighlightIds", () => {
  it("lights up retrieved rows plus brain ids named in tool inputs, never free-form ids", () => {
    const s = summarizeTrace({
      fidelity: "legacy",
      preEpoch: true,
      sessionId: "s",
      steps: [
        {
          ordinal: 0,
          kind: "retrieval",
          metadata: { returnedRows: [{ primitive: "memory", rowId: M1 }] },
          payloadRefs: [],
          at: null,
        },
        {
          ordinal: 1,
          kind: "tool_call",
          metadata: {
            name: "getEntity",
            input: { entityId: E1, id: "44444444-4444-4444-8444-444444444444", channel: "C123" },
          },
          payloadRefs: [],
          at: null,
        },
        {
          ordinal: 2,
          kind: "tool_call",
          metadata: { name: "getMemory", input: { memoryId: M1, memoryIds: [M2, "not-a-uuid"] } },
          payloadRefs: [],
          at: null,
        },
        {
          ordinal: 3,
          kind: "tool_call",
          // The retrieval layer's canonical key.
          metadata: { name: "getEntity", input: { row_id: M2 } },
          payloadRefs: [],
          at: null,
        },
      ],
    });
    expect(graphHighlightIds(s)).toEqual([M1, E1, M2]);
  });
});

describe("[COMP:app-web/turn-audit] graphHighlightNames", () => {
  it("collects the names brain-row tools looked up, never uuids or search queries", () => {
    const s = summarizeTrace({
      fidelity: "legacy",
      preEpoch: true,
      sessionId: "s",
      steps: [
        { ordinal: 0, kind: "tool_call", metadata: { name: "search", input: { query: "Acme pricing" } }, payloadRefs: [], at: null },
        { ordinal: 1, kind: "tool_call", metadata: { name: "getEntity", input: { id_or_name: " Strategy ID 1 " } }, payloadRefs: [], at: null },
        { ordinal: 2, kind: "tool_call", metadata: { name: "getEntity", input: { id_or_name: E1 } }, payloadRefs: [], at: null },
        { ordinal: 3, kind: "tool_call", metadata: { name: "getEntity", input: { id_or_name: "strategy id 1" } }, payloadRefs: [], at: null },
        { ordinal: 4, kind: "tool_call", metadata: { name: "fileRead", input: { name: "notes.md" } }, payloadRefs: [], at: null },
      ],
    });
    expect(graphHighlightNames(s)).toEqual(["strategy id 1"]);
    // The uuid form still rides the id highlight.
    expect(graphHighlightIds(s)).toEqual([E1]);
  });
});

describe("[COMP:app-web/turn-audit] eager brain-row tool inputs", () => {
  it("recognises brain-row tools and leaves search/file tools lazy", () => {
    expect(isBrainRowTool("getEntity")).toBe(true);
    expect(isBrainRowTool("getMemory")).toBe(true);
    expect(isBrainRowTool("updateContact")).toBe(true);
    expect(isBrainRowTool("searchBrain")).toBe(false);
    expect(isBrainRowTool("fileRead")).toBe(false);
    expect(isBrainRowTool(undefined)).toBe(false);
  });

  it("lists the input hashes of brain-row calls that are not inline, in order, capped", () => {
    const s = summarizeTrace(fullTrace);
    // fullTrace's getEntity step carries refs ["h-in", "h-out"] and no inline input.
    expect(eagerToolInputRefs(s)).toEqual([{ key: "2:tool_call", hash: "h-in" }]);
    const legacy = summarizeTrace({
      fidelity: "legacy",
      preEpoch: true,
      sessionId: "s",
      steps: [
        { ordinal: 0, kind: "tool_call", metadata: { name: "getEntity", input: { entityId: E1 } }, payloadRefs: [], at: null },
      ],
    });
    expect(eagerToolInputRefs(legacy)).toEqual([]);
  });

  it("fills dereferenced inputs so the highlight derives from them", () => {
    const s = summarizeTrace(fullTrace);
    expect(graphHighlightIds(s)).toEqual([M1, M2]);
    const filled = withToolInputs(s, { "2:tool_call": { entityId: E1 } });
    expect(filled.steps[2].input).toEqual({ entityId: E1 });
    expect(graphHighlightIds(filled)).toEqual([M1, M2, E1]);
    // Same object back when there is nothing to fill.
    expect(withToolInputs(s, {})).toBe(s);
  });
});

describe("[COMP:app-web/turn-audit] presentation helpers", () => {
  it("humanizes tool names", () => {
    expect(humanizeToolName("searchBrain")).toBe("Search brain");
    expect(humanizeToolName("shopify_list_products")).toBe("Shopify list products");
    expect(humanizeToolName("mcp_search")).toBe("Mcp search");
    expect(humanizeToolName("")).toBe("");
  });

  it("reads provider usage in either casing", () => {
    expect(usageTokens({ inputTokens: 1, outputTokens: 2 })).toEqual({ input: 1, output: 2 });
    expect(usageTokens({ input_tokens: 3, output_tokens: 4 })).toEqual({ input: 3, output: 4 });
    expect(usageTokens(null)).toEqual({ input: 0, output: 0 });
  });

  it("folds primitives to the labelled buckets", () => {
    expect(retrievedPrimitiveLabel("memory")).toBe("memory");
    expect(retrievedPrimitiveLabel("person")).toBe("entity");
    expect(retrievedPrimitiveLabel("kb_chunk")).toBe("file");
    expect(retrievedPrimitiveLabel("episode")).toBe("episode");
    expect(retrievedPrimitiveLabel("wat")).toBe("other");
  });

  it("pretty-prints JSON payloads, leaves text alone, and bounds length", () => {
    expect(formatPayloadPreview('{"a":1}')).toBe('{\n  "a": 1\n}');
    expect(formatPayloadPreview("plain")).toBe("plain");
    expect(formatPayloadPreview("x".repeat(10), 4)).toBe("xxxx…");
  });

  it("formats token counts compactly", () => {
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1234)).toBe("1.2k");
    expect(formatTokens(45_600)).toBe("46k");
    expect(formatTokens(2_500_000)).toBe("2.5M");
  });
});

describe("[COMP:app-web/turn-audit] deep link", () => {
  it("parses session + optional turn and round-trips through the builder", () => {
    expect(parseAuditDeepLink(new URLSearchParams(""))).toBeNull();
    expect(parseAuditDeepLink(new URLSearchParams("audit=s1"))).toEqual({ sessionId: "s1", turnId: null });
    expect(parseAuditDeepLink(new URLSearchParams("audit=s1&turn=m9"))).toEqual({ sessionId: "s1", turnId: "m9" });
    const url = auditTurnUrl("", "ws", "s1", "m9");
    expect(url).toBe("/w/ws/brain?audit=s1&turn=m9");
    expect(parseAuditDeepLink(new URL(`https://x.example${url}`).searchParams)).toEqual({
      sessionId: "s1",
      turnId: "m9",
    });
    expect(auditTurnUrl("https://app.example", "ws", "s1")).toBe("https://app.example/w/ws/brain?audit=s1");
  });
});

describe("[COMP:app-web/turn-audit] raw prompt", () => {
  it("splits provider_call refs into system, messages and response by messageCount", () => {
    expect(providerPromptRefs(["sys", "m1", "m2", "resp"], 2)).toEqual({
      systemRef: "sys", messageRefs: ["m1", "m2"], responseRef: "resp",
    });
    // No system prompt recorded: every ref but the response is a message.
    expect(providerPromptRefs(["m1", "m2", "resp"], 2)).toEqual({
      systemRef: null, messageRefs: ["m1", "m2"], responseRef: "resp",
    });
    // Without the count a system ref cannot be told from a message.
    expect(providerPromptRefs(["a", "b", "resp"], undefined)).toEqual({
      systemRef: null, messageRefs: ["a", "b"], responseRef: "resp",
    });
    expect(providerPromptRefs([], 0)).toBeUndefined();
  });

  it("attaches prompt refs to full-fidelity model calls", () => {
    const summary = summarizeTrace({ fidelity: "full", preEpoch: false, sessionId: "fixture", steps: [
      { ordinal: 0, kind: "provider_call", at: null, payloadRefs: ["sys", "m1", "resp"],
        metadata: { model: "m", turn: 0, messageCount: 1 } },
    ] });
    expect(summary.steps[0]!.prompt).toEqual({ systemRef: "sys", messageRefs: ["m1"], responseRef: "resp" });
  });

  it("renders recorded messages readably and never drops an unparseable payload", () => {
    expect(formatPromptMessage(JSON.stringify({ role: "user", content: "hello" })))
      .toEqual({ role: "user", text: "hello" });
    const blocks = formatPromptMessage(JSON.stringify({ role: "assistant", content: [
      { type: "text", text: "Looking it up" },
      { type: "tool_use", id: "t1", name: "getEntity", input: { id_or_name: "Acme" } },
    ] }));
    expect(blocks.role).toBe("assistant");
    expect(blocks.text).toContain("Looking it up");
    expect(blocks.text).toContain("[tool call: getEntity]");
    expect(blocks.text).toContain('"id_or_name": "Acme"');
    const result = formatPromptMessage(JSON.stringify({ role: "user", content: [
      { type: "tool_result", toolUseId: "t1", content: "not found", isError: true },
      { type: "image", source: {} },
    ] }));
    expect(result.text).toBe("[tool result, error]\nnot found\n\n[image]");
    expect(formatPromptMessage("not json")).toEqual({ role: "other", text: "not json" });
    expect(formatPromptResponse(JSON.stringify([{ type: "text", text: "Done" }])))
      .toEqual({ role: "assistant", text: "Done" });
    expect(formatPromptResponse("{bad")).toEqual({ role: "assistant", text: "{bad" });
  });
});
