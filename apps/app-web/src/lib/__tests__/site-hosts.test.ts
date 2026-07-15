import { describe, expect, it, vi } from "vitest";
import { isAppHost, isGuardedPath, normalizeHostHeader } from "../site-hosts";

describe("[COMP:app-web/site-route] Custom-domain host classification", () => {
  describe("isAppHost", () => {
    async function withEnv(vars: Record<string, string>, fn: (m: typeof import("../site-hosts")) => void) {
      vi.resetModules();
      for (const [k, v] of Object.entries(vars)) vi.stubEnv(k, v);
      try {
        fn(await import("../site-hosts"));
      } finally {
        vi.unstubAllEnvs();
        vi.resetModules();
      }
    }

    it("always treats localhost and a missing Host header as the app", () => {
      expect(isAppHost("localhost")).toBe(true);
      expect(isAppHost("127.0.0.1")).toBe(true);
      expect(isAppHost("docs.acme.localhost")).toBe(true);
      expect(isAppHost("")).toBe(true); // no Host header — never a customer site
    });

    it("unconfigured: dev treats non-local hosts as customer sites", () => {
      // (test env is not production; NEXT_PUBLIC_APP_HOSTS is unset)
      expect(isAppHost("docs.acme.com")).toBe(false);
    });

    it("unconfigured: production stays DARK — every host is the app", async () => {
      await withEnv({ NODE_ENV: "production" }, (m) => {
        expect(m.isAppHost("app.example.com")).toBe(true);
        expect(m.isAppHost("docs.acme.com")).toBe(true); // feature off, fail-safe
      });
    });

    it("configured: exact entries and .suffix entries classify app origins", async () => {
      await withEnv(
        { NEXT_PUBLIC_APP_HOSTS: "app.example.com, Example.com, .vercel.app", NODE_ENV: "production" },
        (m) => {
          expect(m.isAppHost("app.example.com")).toBe(true);
          expect(m.isAppHost("example.com")).toBe(true);
          expect(m.isAppHost("preview-abc.vercel.app")).toBe(true);
          expect(m.isAppHost("vercel.app")).toBe(true);
          // everything else — including sibling subdomains of the apex — is a site
          expect(m.isAppHost("page.example.com")).toBe(false);
          expect(m.isAppHost("docs.acme.com")).toBe(false);
          // suffix tricks don't qualify
          expect(m.isAppHost("evilexample.com")).toBe(false);
          expect(m.isAppHost("app.example.com.attacker.net")).toBe(false);
        },
      );
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
