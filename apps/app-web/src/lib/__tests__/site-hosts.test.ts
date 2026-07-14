import { describe, expect, it } from "vitest";
import { isAppHost, isGuardedPath, normalizeHostHeader } from "../site-hosts";

describe("[COMP:app-web/site-route] Custom-domain host classification", () => {
  describe("isAppHost", () => {
    it("treats our origins and dev hosts as app hosts", () => {
      expect(isAppHost("app.sidan.ai")).toBe(true);
      expect(isAppHost("sidan.ai")).toBe(true);
      expect(isAppHost("ai-api.sidan.io")).toBe(true);
      expect(isAppHost("preview-abc.vercel.app")).toBe(true);
      expect(isAppHost("localhost")).toBe(true);
      expect(isAppHost("127.0.0.1")).toBe(true);
      expect(isAppHost("docs.acme.localhost")).toBe(true);
      expect(isAppHost("")).toBe(true); // no Host header — never a customer site
    });

    it("treats everything else as a customer domain", () => {
      expect(isAppHost("docs.acme.com")).toBe(false);
      expect(isAppHost("acme.com")).toBe(false);
      // suffix tricks don't qualify
      expect(isAppHost("evilsidan.ai.attacker.com")).toBe(false);
      expect(isAppHost("notsidan.ai.co")).toBe(false);
    });
  });

  describe("normalizeHostHeader", () => {
    it("lowercases, strips ports, and takes the first forwarded value", () => {
      expect(normalizeHostHeader("Docs.Acme.com:443")).toBe("docs.acme.com");
      expect(normalizeHostHeader("docs.acme.com, proxy.internal")).toBe("docs.acme.com");
      expect(normalizeHostHeader(" docs.acme.com ")).toBe("docs.acme.com");
    });
  });

  describe("isGuardedPath", () => {
    it("guards the operator prefixes exactly as the pre-custom-domain matcher", () => {
      expect(isGuardedPath("/teams")).toBe(true);
      expect(isGuardedPath("/redeem")).toBe(true);
      expect(isGuardedPath("/w")).toBe(true);
      expect(isGuardedPath("/w/ws-1/p/abc")).toBe(true);
      expect(isGuardedPath("/settings/profile")).toBe(true);
      expect(isGuardedPath("/knowledge-base/x")).toBe(true);
    });

    it("passes public and auth paths through unguarded", () => {
      expect(isGuardedPath("/")).toBe(false);
      expect(isGuardedPath("/share/tok123")).toBe(false);
      expect(isGuardedPath("/share/p/page-1")).toBe(false);
      expect(isGuardedPath("/login")).toBe(false);
      expect(isGuardedPath("/site/docs.acme.com")).toBe(false);
      // prefix must be a whole segment: /workflows is not /workflow
      expect(isGuardedPath("/workflowish")).toBe(false);
      expect(isGuardedPath("/teamspace")).toBe(false);
    });
  });
});
