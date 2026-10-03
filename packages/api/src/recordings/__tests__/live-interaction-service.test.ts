import { describe, expect, it } from "vitest";
import { defaultRuleDecision } from "../live-interaction-service.js";

describe("live interaction default wake question extraction", () => {
  it("does not include a subsequent ASR speaker turn in the question", () => {
    expect(defaultRuleDecision(
      "Speaker 1: Hey Brian，咱們，咱們來拍個照吧。\nBrian: 你要拿手機拍嗎？",
    )).toEqual({ action: "submit", question: "咱們，咱們來拍個照吧。" });
    expect(defaultRuleDecision(
      "Speaker 1: Hey Brian, 今日幾多號?\nSpeaker 2: 我唔知。",
    )).toEqual({ action: "submit", question: "今日幾多號?" });
  });

  it("keeps bare wakes pending and recognizes fullwidth speaker separators", () => {
    expect(defaultRuleDecision("Hey Brian\nBrian: 你要拿手機拍嗎？"))
      .toEqual({ action: "begin", question: "" });
    expect(defaultRuleDecision("Hey Brian：今日幾多號？\nSpeaker 2：我唔知。"))
      .toEqual({ action: "submit", question: "今日幾多號？" });
  });

  it("preserves unlabeled multiline speech and does not treat bare Brian as a wake", () => {
    expect(defaultRuleDecision("Brian\nHey Brian\n快啲答我，今日幾多號？"))
      .toEqual({ action: "submit", question: "快啲答我，今日幾多號？" });
    expect(defaultRuleDecision("Brian: 你要拿手機拍嗎？")).toEqual({ action: "ignore" });
    expect(defaultRuleDecision("Hey 喺度...今日幾多號...")).toEqual({ action: "ignore" });
    expect(defaultRuleDecision("Hey Brian, explain this:\nfirst line\nsecond line"))
      .toEqual({ action: "submit", question: "explain this:\nfirst line\nsecond line" });
  });
});
