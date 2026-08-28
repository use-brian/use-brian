import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "@/proxy";

vi.mock("@/lib/edition", () => ({
  isOssEdition: vi.fn(() => true),
  usebrianEdition: vi.fn(() => "oss"),
}));

afterEach(() => vi.unstubAllEnvs());

describe("[COMP:app-web/local-session-route] OSS proxy redirects", () => {
  it("sends a signed-out proxied deep link to the public local-session origin", async () => {
    vi.stubEnv("APP_URL", "https://hinson.usebrian.ai");
    const request = new NextRequest(
      "http://localhost:3003/w/workspace-id/p/page-id?view=table",
    );

    const response = await proxy(request);

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "https://hinson.usebrian.ai/api/auth/local-session?next=%2Fw%2Fworkspace-id%2Fp%2Fpage-id%3Fview%3Dtable",
    );
  });

  it("keeps zero-config local development on the incoming origin", async () => {
    vi.stubEnv("APP_URL", "");
    const request = new NextRequest("http://localhost:3003/teams");

    const response = await proxy(request);

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe(
      "http://localhost:3003/api/auth/local-session?next=%2Fteams",
    );
  });
});
