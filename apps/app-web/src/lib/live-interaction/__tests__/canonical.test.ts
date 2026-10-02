import { expect, it } from "vitest";
import { canonicalInteractionAdditions } from "../canonical";
import { chatReducer, initialChatState } from "../../../../../../packages/chat-ui/src/chat-reducer";
const message = (id: string, role: "user" | "assistant", text = id) => ({ id, role, text, timestamp: new Date() });
it("refreshes two out-of-order answers as pairs while preserving an active typed turn", () => {
  const typed = message("typed", "user", "keep my typed question");
  let state = { ...initialChatState, messages: [typed], isStreaming: true, streamingText: "typed partial" };
  const rows = [typed, message("q1", "user"), message("q2", "user"), message("a2", "assistant"), message("a1", "assistant"), message("unrelated", "assistant")];
  const ids = new Set(["q1", "a1", "q2", "a2"]);
  for (const row of canonicalInteractionAdditions(state.messages, rows, ids)) state = chatReducer(state, { type: "message/append", message: row });
  expect(state.messages.map((m) => m.id)).toEqual(["typed", "q1", "a1", "q2", "a2"]);
  expect(state.messages[0]).toBe(typed);
  expect(state.isStreaming).toBe(true); expect(state.streamingText).toBe("typed partial");
  expect(canonicalInteractionAdditions(state.messages, rows, ids)).toEqual([]);
});
it("retains already loaded canonical rows and ignores unknown message ids", () => {
  const q = message("q", "user"); const a = message("a", "assistant");
  expect(canonicalInteractionAdditions([q], [q, a], new Set(["q", "a", "not-persisted"])) ).toEqual([a]);
});
