import { describe, it, expect } from "vitest";
import {
  buildTelegramDeepLink,
  linkCodeSecondsLeft,
  formatCountdown,
} from "../telegram-link";

describe("[COMP:app-web/telegram-link] Telegram link helpers", () => {
  describe("buildTelegramDeepLink", () => {
    it("builds the t.me start deep link", () => {
      expect(buildTelegramDeepLink("use_brian_bot", "ABC123")).toBe(
        "https://t.me/use_brian_bot?start=ABC123",
      );
    });

    it("returns null without a bot username (manual-paste fallback)", () => {
      expect(buildTelegramDeepLink(null, "ABC123")).toBeNull();
      expect(buildTelegramDeepLink(undefined, "ABC123")).toBeNull();
      expect(buildTelegramDeepLink("", "ABC123")).toBeNull();
    });

    it("rejects out-of-shape usernames and codes", () => {
      expect(buildTelegramDeepLink("bad name", "ABC123")).toBeNull();
      expect(buildTelegramDeepLink("ok_bot", "has space")).toBeNull();
      expect(buildTelegramDeepLink("ok_bot", "")).toBeNull();
    });
  });

  describe("linkCodeSecondsLeft", () => {
    const now = new Date("2026-06-10T00:00:00Z");

    it("returns whole seconds until expiry", () => {
      expect(linkCodeSecondsLeft("2026-06-10T00:05:00Z", now)).toBe(300);
      expect(linkCodeSecondsLeft(new Date("2026-06-10T00:00:30.900Z"), now)).toBe(30);
    });

    it("clamps to 0 once expired", () => {
      expect(linkCodeSecondsLeft("2026-06-09T23:59:59Z", now)).toBe(0);
      expect(linkCodeSecondsLeft("2026-06-10T00:00:00Z", now)).toBe(0);
    });

    it("treats an unparseable date as expired", () => {
      expect(linkCodeSecondsLeft("not-a-date", now)).toBe(0);
    });
  });

  describe("formatCountdown", () => {
    it("formats M:SS", () => {
      expect(formatCountdown(300)).toBe("5:00");
      expect(formatCountdown(61)).toBe("1:01");
      expect(formatCountdown(9)).toBe("0:09");
      expect(formatCountdown(0)).toBe("0:00");
    });

    it("clamps negatives", () => {
      expect(formatCountdown(-5)).toBe("0:00");
    });
  });
});
