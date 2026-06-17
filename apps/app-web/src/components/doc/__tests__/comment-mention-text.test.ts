/**
 * [COMP:app-web/comment-composer] Comment composer — mention text helpers.
 *
 * app-web's Vitest runner is node-only (no jsdom — see
 * `apps/app-web/vitest.config.ts`), so this suite covers the pure
 * mention-tracking contract the composer relies on: detecting the active
 * `@query` at the caret, and recovering which tracked mentions are still
 * present in the draft (the ids posted to the Inbox). The live
 * textarea/popup/insert flow needs a future jsdom suite.
 */

import { describe, expect, it } from "vitest";
import {
  activeMentionQuery,
  presentMentionIds,
  type InsertedMention,
} from "../comment-mention-text";

describe("[COMP:app-web/comment-composer] activeMentionQuery", () => {
  it("matches a trailing @query at the start of input", () => {
    expect(activeMentionQuery("@ja")).toEqual({ query: "ja", at: 0 });
  });

  it("matches a trailing @query after whitespace and reports the @ offset", () => {
    expect(activeMentionQuery("hey @jan")).toEqual({ query: "jan", at: 4 });
  });

  it("matches the bare @ trigger (empty query → recents)", () => {
    expect(activeMentionQuery("hello @")).toEqual({ query: "", at: 6 });
  });

  it("does not match once the mention is closed by a space", () => {
    expect(activeMentionQuery("hey @jane ")).toBeNull();
  });

  it("does not match an @ that's glued to a previous word (email-ish)", () => {
    expect(activeMentionQuery("ping me@")).toBeNull();
  });

  it("returns null with no @ before the caret", () => {
    expect(activeMentionQuery("just text")).toBeNull();
  });
});

describe("[COMP:app-web/comment-composer] presentMentionIds", () => {
  const jane: InsertedMention = { id: "u-jane", name: "Jane" };
  const janet: InsertedMention = { id: "u-janet", name: "Janet" };
  const janeDoe: InsertedMention = { id: "u-jd", name: "Jane Doe" };

  it("returns the id of a mention still present in the text", () => {
    expect(presentMentionIds("hi @Jane, look", [jane])).toEqual(["u-jane"]);
  });

  it("drops a mention whose token was deleted from the text", () => {
    expect(presentMentionIds("hi there", [jane])).toEqual([]);
  });

  it("does not match @Jane inside @Janet (word boundary)", () => {
    expect(presentMentionIds("ping @Janet", [jane, janet])).toEqual(["u-janet"]);
  });

  it("matches a multi-word display name up to its boundary", () => {
    expect(presentMentionIds("cc @Jane Doe please", [janeDoe])).toEqual(["u-jd"]);
  });

  it("dedups the same id even if tracked twice", () => {
    expect(presentMentionIds("@Jane and @Jane", [jane, jane])).toEqual(["u-jane"]);
  });

  it("returns every distinct mention present", () => {
    const ids = presentMentionIds("@Jane and @Janet", [jane, janet]);
    expect(new Set(ids)).toEqual(new Set(["u-jane", "u-janet"]));
  });
});
