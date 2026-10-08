import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { fetch } = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@/lib/auth-fetch", () => ({ authFetch: fetch }));
import { fetchLiveRoster, liveRosterRemaining } from "../live";
import { listApprovals } from "../approvals";
import { SurfaceCacheEvictionError } from "@/lib/surface-cache";

beforeEach(() => fetch.mockReset());
afterEach(() => vi.restoreAllMocks());
describe("[COMP:app-web/live-app] protected activity response handling", () => {
  const readers = [
    () => fetchLiveRoster("fixture-workspace"),
    () => listApprovals("fixture-workspace", { throwOnError: true }),
  ];
  it.each([401, 403, 404])("evicts cached activity after HTTP %s", async status => {
    for (const read of readers) {
      fetch.mockResolvedValueOnce(new Response(null, { status }));
      await expect(read()).rejects.toBeInstanceOf(SurfaceCacheEvictionError);
    }
  });
  it("distinguishes a transient failure from revoked access and successful emptiness", async () => {
    for (const read of readers) {
      fetch.mockResolvedValueOnce(new Response(null, { status: 503 }));
      await expect(read()).rejects.not.toBeInstanceOf(SurfaceCacheEvictionError);
      fetch.mockResolvedValueOnce(Response.json({ items: [], approvals: [] }));
      await expect(read()).resolves.toEqual([]);
    }
  });
  it("bounds a successful roster from request start, not response arrival", async () => {
    let now = 1_000;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    fetch.mockImplementationOnce(async () => { now += 10_000; return Response.json({ items: [] }); });
    const roster = await fetchLiveRoster('fixture-workspace');
    expect(liveRosterRemaining(roster)).toBe(20_000);
    now += 20_001;
    expect(liveRosterRemaining(roster)).toBe(0);
  });
  it("refuses a response that arrives after its authority budget", async () => {
    let now = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    fetch.mockImplementationOnce(async () => { now = 30_001; return Response.json({ items: [] }); });
    await expect(fetchLiveRoster('fixture-workspace')).rejects.toBeInstanceOf(SurfaceCacheEvictionError);
  });

});
