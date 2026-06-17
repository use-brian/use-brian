import { describe, it, expect } from "vitest";
import {
  parsePendingBuild,
  isPendingBuildFresh,
  PENDING_BUILD_TTL_MS,
  type PendingBuild,
} from "@/lib/pending-build";

const base: PendingBuild = {
  workspaceId: "ws-1",
  text: "show me the Q3 pipeline by stage",
  model: "pro",
  researchMode: false,
  ts: 1_000_000,
};

describe("[COMP:app-web/pending-build] pending build resume", () => {
  describe("parsePendingBuild", () => {
    it("round-trips a valid stash", () => {
      expect(parsePendingBuild(JSON.stringify(base))).toEqual(base);
    });

    it("accepts a stash without an explicit model (optional tier)", () => {
      const noModel: Record<string, unknown> = { ...base };
      delete noModel.model;
      expect(parsePendingBuild(JSON.stringify(noModel))).toEqual(noModel);
    });

    it("returns null for malformed / empty input", () => {
      expect(parsePendingBuild(null)).toBeNull();
      expect(parsePendingBuild("not json")).toBeNull();
      expect(parsePendingBuild("123")).toBeNull();
    });

    it("rejects a stash missing required fields or with a bad type", () => {
      const noText: Record<string, unknown> = { ...base };
      delete noText.text;
      expect(parsePendingBuild(JSON.stringify(noText))).toBeNull();
      expect(parsePendingBuild(JSON.stringify({ ...base, ts: "soon" }))).toBeNull();
      expect(parsePendingBuild(JSON.stringify({ ...base, model: 7 }))).toBeNull();
    });
  });

  describe("isPendingBuildFresh", () => {
    it("is fresh within the TTL for the same workspace", () => {
      expect(isPendingBuildFresh(base, "ws-1", base.ts)).toBe(true);
      expect(
        isPendingBuildFresh(base, "ws-1", base.ts + PENDING_BUILD_TTL_MS - 1),
      ).toBe(true);
    });

    it("is stale at or after the TTL", () => {
      expect(
        isPendingBuildFresh(base, "ws-1", base.ts + PENDING_BUILD_TTL_MS),
      ).toBe(false);
    });

    it("never replays on a different workspace", () => {
      expect(isPendingBuildFresh(base, "ws-2", base.ts)).toBe(false);
    });

    it("rejects a future-dated stash (clock skew / tamper) and null", () => {
      expect(isPendingBuildFresh(base, "ws-1", base.ts - 1)).toBe(false);
      expect(isPendingBuildFresh(null, "ws-1", base.ts)).toBe(false);
    });
  });
});
