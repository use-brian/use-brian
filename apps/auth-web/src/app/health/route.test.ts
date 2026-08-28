import { describe, expect, it } from "vitest";
import { GET } from "./route";

describe("[COMP:app/outpost-auth] health", () => {
  it("is public and uncached", async () => {
    const response = GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ status: "ok" });
  });
});
