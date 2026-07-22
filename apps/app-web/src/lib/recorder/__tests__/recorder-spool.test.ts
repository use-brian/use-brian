import { describe, expect, it } from "vitest";
import {
  LIVE_SESSION_GRACE_MS,
  assembleSpooledBlob,
  memorySpoolStore,
  recoverableSessions,
  rescueSessionMeta,
  type SpoolSessionMeta,
} from "../recorder-spool";

const meta = (over: Partial<SpoolSessionMeta> = {}): SpoolSessionMeta => ({
  id: "s1",
  workspaceId: "ws",
  assistantId: "as",
  startedAt: 1000,
  mime: "audio/webm",
  elapsedMs: 0,
  chunkCount: 0,
  updatedAt: 1000,
  ...over,
});

describe("[COMP:app-web/recorder-engine] Capture spool", () => {
  it("append refreshes elapsedMs + chunkCount; chunks read back in order", async () => {
    const spool = memorySpoolStore();
    await spool.createSession(meta());
    await spool.appendChunk("s1", 0, new Blob(["a"]), 5_000);
    await spool.appendChunk("s1", 1, new Blob(["b"]), 10_000);
    const [session] = await spool.listSessions();
    expect(session.elapsedMs).toBe(10_000);
    expect(session.chunkCount).toBe(2);
    const chunks = await spool.readChunks("s1");
    expect(chunks).toHaveLength(2);
    expect(await new Response(chunks[0]).text()).toBe("a");
    expect(await new Response(chunks[1]).text()).toBe("b");
  });

  it("deleteSession drops the session and its chunks", async () => {
    const spool = memorySpoolStore();
    await spool.createSession(meta());
    await spool.appendChunk("s1", 0, new Blob(["a"]), 1_000);
    await spool.deleteSession("s1");
    expect(await spool.listSessions()).toHaveLength(0);
    expect(await spool.readChunks("s1")).toHaveLength(0);
  });

  it("assembleSpooledBlob concatenates under the session mime", async () => {
    const blob = assembleSpooledBlob(meta({ mime: "audio/webm;codecs=opus" }), [
      new Blob(["hel"]),
      new Blob(["lo"]),
    ]);
    expect(blob.type).toBe("audio/webm;codecs=opus");
    expect(await new Response(blob).text()).toBe("hello");
  });

  it("recoverableSessions excludes the live session and sorts oldest first", () => {
    const now = 1_000_000;
    const sessions = [
      meta({ id: "new", startedAt: 3000 }),
      meta({ id: "live", startedAt: 2000 }),
      meta({ id: "old", startedAt: 1000 }),
    ];
    expect(recoverableSessions(sessions, "live", now).map((s) => s.id)).toEqual(["old", "new"]);
    expect(recoverableSessions(sessions, null, now)).toHaveLength(3);
  });

  it("recoverableSessions hides sessions written to inside the grace window (live in another tab)", () => {
    const now = 1_000_000;
    const sessions = [
      // Written 5s ago — a live capture elsewhere; discarding it would delete
      // the chunks under a running meeting.
      meta({ id: "other-tab", updatedAt: now - 5_000 }),
      // Crashed well past the window — genuinely recoverable.
      meta({ id: "crashed", updatedAt: now - LIVE_SESSION_GRACE_MS - 1 }),
      // Exactly at the boundary — recoverable (>= grace).
      meta({ id: "boundary", updatedAt: now - LIVE_SESSION_GRACE_MS }),
    ];
    expect(recoverableSessions(sessions, null, now).map((s) => s.id)).toEqual([
      "crashed",
      "boundary",
    ]);
  });

  it("rescueSessionMeta back-dates startedAt and carries the capture's clock", () => {
    const now = 500_000;
    const rescued = rescueSessionMeta("r1", "ws", "as", { mime: "audio/mp4", durationMs: 30_000 }, now);
    expect(rescued.startedAt).toBe(now - 30_000);
    expect(rescued.elapsedMs).toBe(30_000);
    expect(rescued.mime).toBe("audio/mp4");
    expect(rescued.updatedAt).toBe(now);
    // Fresh by construction — the grace window hides it until the delayed
    // re-list, same as a retained live session.
    expect(recoverableSessions([rescued], null, now)).toHaveLength(0);
    expect(recoverableSessions([rescued], null, now + LIVE_SESSION_GRACE_MS)).toHaveLength(1);
  });

  it("append refreshes updatedAt so a live session stays inside the grace window", async () => {
    const spool = memorySpoolStore();
    await spool.createSession(meta({ updatedAt: 0 }));
    await spool.appendChunk("s1", 0, new Blob(["a"]), 5_000);
    const [session] = await spool.listSessions();
    expect(session.updatedAt).toBeGreaterThan(0);
  });
});
