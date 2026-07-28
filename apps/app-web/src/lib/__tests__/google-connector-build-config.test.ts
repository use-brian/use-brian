import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function read(relativeUrl: string): string {
  return readFileSync(fileURLToPath(new URL(relativeUrl, import.meta.url)), "utf8");
}

describe("[COMP:app-web/connector-oauth-callbacks] Google connector deployment configuration", () => {
  it("keeps the OAuth secret runtime-only while exposing public browser metadata", () => {
    const nextConfig = read("../../../next.config.ts");
    const callback = read("../../app/api/auth/callback/google-connector/route.ts");
    const turbo = JSON.parse(read("../../../../../turbo.json")) as {
      tasks: { build: { env: string[] } };
    };

    expect(nextConfig).toContain("process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID");
    expect(nextConfig).toContain("process.env.NEXT_PUBLIC_GOOGLE_API_KEY");
    expect(nextConfig).toContain("process.env.NEXT_PUBLIC_GOOGLE_PROJECT_NUMBER");
    expect(nextConfig).not.toContain("GOOGLE_CLIENT_SECRET");
    expect(turbo.tasks.build.env).not.toContain("GOOGLE_CLIENT_SECRET");
    expect(callback).toContain('process.env.GOOGLE_CLIENT_ID ?? ""');
    expect(callback).toContain('process.env.GOOGLE_CLIENT_SECRET ?? ""');
  });

  it("uses the configured OSS public origin behind a loopback reverse proxy", () => {
    const callback = read("../../app/api/auth/callback/google-connector/route.ts");

    expect(callback).toContain(
      "isOssEdition() ? process.env.APP_URL ?? request.url : request.url",
    );
    expect(callback).toContain(
      "const redirectUri = `${appOrigin}/api/auth/callback/google-connector`",
    );
    expect(callback).not.toContain("const origin = new URL(request.url).origin");
    expect(callback).not.toContain(
      'new URL(connectorsPath(workspaceId, { error: "token_exchange_failed" }), request.url)',
    );
  });
});
