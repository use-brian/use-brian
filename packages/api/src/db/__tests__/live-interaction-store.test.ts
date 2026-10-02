vi.mock("../client.js", () => ({
  getPool: () => {
    throw new Error("Inject test pool");
  },
}));
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import {
  createLiveInteractionStore,
  type Capture,
} from "../live-interaction-store.js";
import { DEFAULT_INTERACTION_RULE } from "@use-brian/shared";
import { createLiveInteractionService } from "../../recordings/live-interaction-service.js";

// Real PostgreSQL SQL engine. Advisory locks are no-ops here because the adapter
// serializes transactions; production uses pg's transaction-scoped advisory locks.
describe("[COMP:recordings/live-interaction] durable interaction store", () => {
  const db = new PGlite();
  let unlock: () => void;
  let tail = Promise.resolve();
  const pool = {
    query: async (sql: string, args?: unknown[]) => {
      await tail;
      const r = await db.query(sql, args);
      return { ...r, rowCount: r.affectedRows || r.rows.length };
    },
    connect: async () => {
      const previous = tail;
      tail = new Promise<void>((resolve) => {
        unlock = resolve;
      });
      const release = unlock!;
      await previous;
      return {
        query: async (sql: string, args?: unknown[]) => {
          const r = await db.query(sql, args);
          return { ...r, rowCount: r.affectedRows || r.rows.length };
        },
        release,
      };
    },
  };
  const store = createLiveInteractionStore(pool as unknown as Pool);
  const owner = randomUUID(),
    other = randomUUID(),
    workspace = randomUUID(),
    page = randomUUID(),
    chat = randomUUID(),
    assistant = randomUUID();
  const makeCapture = (): Capture => ({
    id: randomUUID(),
    ownerId: owner,
    workspaceId: workspace,
    pageId: page,
    chatSessionId: chat,
    assistantId: assistant,
    rule: DEFAULT_INTERACTION_RULE,
    ruleVersion: 1,
    state: "listening",
  });
  beforeAll(async () => {
    await db.exec(
      "CREATE TABLE users(id uuid PRIMARY KEY); CREATE TABLE workspaces(id uuid PRIMARY KEY); CREATE TABLE saved_views(id uuid PRIMARY KEY); CREATE TABLE sessions(id uuid PRIMARY KEY); CREATE TABLE assistants(id uuid PRIMARY KEY);",
    );
    await db.exec(
      `CREATE FUNCTION pg_advisory_xact_lock(integer) RETURNS void LANGUAGE SQL AS 'SELECT'; CREATE FUNCTION pg_advisory_xact_lock(integer,integer) RETURNS void LANGUAGE SQL AS 'SELECT';`,
    );
    for (const [table, id] of [
      ["users", owner],
      ["users", other],
      ["workspaces", workspace],
      ["saved_views", page],
      ["sessions", chat],
      ["assistants", assistant],
    ])
      await db.query(`INSERT INTO ${table} VALUES($1)`, [id]);
    await db.exec(
      readFileSync(
        new URL(
          "../../../migrations/650_live_interaction.sql",
          import.meta.url,
        ),
        "utf8",
      ),
    );
  }, 30000);
  afterAll(() => db.close());
  it("keeps personal settings separate and snapshots edits at ingestion", async () => {
    await store.saveSettings(owner, "Answer direct questions");
    expect((await store.settings(other)).rule).toBe(DEFAULT_INTERACTION_RULE);
    const c = await store.create(makeCapture());
    await store.ingest(c.id, {
      id: "s",
      source: "microphone",
      text: "hello",
      startMs: 0,
      endMs: 1,
    });
    await store.saveSettings(owner, DEFAULT_INTERACTION_RULE);
    const i = await store.claimInbox();
    expect(i?.rule).toBe("Answer direct questions");
    await store.finishInbox(i!, null);
  });
  it("orders the durable inbox, recovers claims, and deduplicates upload/enqueue retries", async () => {
    const c = await store.create(makeCapture());
    await store.ingest(c.id, {
      id: "second",
      previousId: "first",
      source: "microphone",
      text: "question?",
      startMs: 10,
      endMs: 20,
    });
    expect(await store.claimInbox()).toBeNull();
    await store.ingest(c.id, {
      id: "first",
      source: "microphone",
      text: "Hey Brian",
      startMs: 0,
      endMs: 10,
    });
    await db.query(
      "UPDATE live_interaction_captures SET detector_retry=now() WHERE id=$1",
      [c.id],
    );
    const first = await store.claimInbox();
    expect(first?.utterance.id).toBe("first");
    await db.query(
      "UPDATE live_interaction_captures SET detector_until=now()-interval '1 second' WHERE id=$1",
      [c.id],
    );
    const recovered = await store.claimInbox();
    expect(recovered?.token).not.toBe(first?.token);
    expect(await store.finishInbox(first!, null, "stale")).toBe(false);
    await store.finishInbox(recovered!, {
      text: "",
      endMs: 10,
      rule: DEFAULT_INTERACTION_RULE,
    });
    const second = await store.claimInbox();
    expect(second?.utterance.id).toBe("second");
    await store.finishInbox(second!, null, "question?");
    await store.finishInbox(second!, null, "duplicate");
    await store.ingest(c.id, second!.utterance);
    const jobs = await store.listJobs(owner, workspace, chat);
    expect(jobs.filter((j) => j.captureId === c.id)).toHaveLength(1);
    const range = await store.readLiveTranscriptRange(c.id);
    expect(range.segments).toHaveLength(2);
    expect(
      (await store.searchLiveTranscript(c.id, "question")).segments,
    ).toHaveLength(1);
  });
  it("caps at three per capture, fences cancellation and expired leases, retains completed text", async () => {
    await db.exec("DELETE FROM live_interaction_captures");
    const c = await store.create(makeCapture());
    for (let n = 0; n < 4; n++) {
      await store.ingest(c.id, {
        id: String(n),
        source: "microphone",
        text: "hey brian question?",
        startMs: n,
        endMs: n + 1,
      });
      const i = await store.claimInbox();
      await store.finishInbox(i!, null, `q${n}`);
    }
    const claims = await Promise.all([
      store.claimJob(),
      store.claimJob(),
      store.claimJob(),
      store.claimJob(),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(3);
    const j = claims[0]!;
    await store.cancel(j.id);
    expect(await store.complete(j.id, j.token, "late")).toBe(false);
    expect((await store.job(j.id))?.status).toBe("cancelled");
    await store.retry(j.id);
    const retried = await store.claimJob();
    expect(retried?.id).toBe(j.id);
    await db.query(
      "UPDATE live_interaction_jobs SET lease_until=now()-interval '1 second' WHERE id=$1",
      [j.id],
    );
    const recovered = await store.claimJob();
    expect(recovered?.id).toBe(j.id);
    expect(recovered?.token).not.toBe(retried?.token);
    expect(await store.complete(j.id, retried!.token, "stale")).toBe(false);
    expect(await store.complete(j.id, recovered!.token, "answer")).toBe(true);
    await store.published(j.id, recovered!.token);
    expect(await store.job(j.id)).toMatchObject({
      status: "completed",
      answer: "answer",
    });
  });
  it("never evaluates system speech; recovers accepted microphone speech across service recreation", async () => {
    await db.exec("DELETE FROM live_interaction_captures");
    const c = await store.create(makeCapture());
    const deps = {
      store,
      authorize: async () => true,
      answer: async () => "",
      publish: async () => {},
    };
    await store.ingest(c.id, {
      id: "system",
      source: "system",
      text: "Hey Brian system question?",
      startMs: 0,
      endMs: 1,
    });
    await store.ingest(c.id, {
      id: "mic",
      source: "microphone",
      text: "Hey Brian microphone question?",
      startMs: 2,
      endMs: 3,
    });
    await createLiveInteractionService(deps).tickDetector();
    const jobs = await store.listJobs(owner, workspace, chat);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.question).toBe("microphone question?");
    await createLiveInteractionService(deps).tickDetector();
    expect(await store.listJobs(owner, workspace, chat)).toHaveLength(1);
  });
  it("assembles split phrase/question and atomically enqueues multiple wake occurrences", async () => {
    await db.exec("DELETE FROM live_interaction_captures");
    const c = await store.create(makeCapture());
    const service = createLiveInteractionService({
      store,
      authorize: async () => true,
      answer: async () => "",
      publish: async () => {},
    });
    for (const [n, text] of [
      "Hey",
      "Brian what did",
      "we decide?",
      "Hey Brian first question? Hey Brian second question?",
    ].entries()) {
      await store.ingest(c.id, {
        id: String(n),
        source: "microphone",
        text,
        startMs: n * 1000,
        endMs: n * 1000 + 500,
      });
      await service.tickDetector();
    }
    const jobs = await store.listJobs(owner, workspace, chat);
    expect(jobs.map((j) => j.question).sort()).toEqual([
      "first question?",
      "second question?",
      "what did we decide?",
    ]);
    expect(new Set(jobs.map((j) => j.assistantMessageId)).size).toBe(3);
    expect(await store.listJobs(other, workspace, chat)).toEqual([]);
    expect(await store.listJobs(owner, randomUUID(), chat)).toEqual([]);
  });
  it("recovers missing predecessor as a discontinuity rather than combining unrelated speech", async () => {
    await db.exec("DELETE FROM live_interaction_captures");
    const c = await store.create(makeCapture());
    await store.ingest(c.id, {
      id: "wake",
      source: "microphone",
      text: "Hey Brian",
      startMs: 0,
      endMs: 1,
    });
    const wake = await store.claimInbox();
    await store.finishInbox(wake!, {
      text: "",
      endMs: 1,
      rule: DEFAULT_INTERACTION_RULE,
    });
    await store.ingest(c.id, {
      id: "gap",
      previousId: "lost",
      source: "microphone",
      text: "unrelated",
      startMs: 2,
      endMs: 3,
    });
    expect(await store.claimInbox()).toBeNull();
    await db.exec(
      "UPDATE live_interaction_utterances SET created_at=now()-interval '10 seconds';UPDATE live_interaction_captures SET detector_retry=now()",
    );
    const gap = await store.claimInbox();
    expect(gap?.pending).toBeNull();
    await store.finishInbox(gap!, null);
  });
  it("enforces workspace capacity across captures and runs answers independently of detection", async () => {
    await db.exec("DELETE FROM live_interaction_captures");
    const first = await store.create(makeCapture()),
      second = await store.create(makeCapture());
    for (const c of [first, second]) {
      await store.ingest(c.id, {
        id: "q",
        source: "microphone",
        text: "Hey Brian question?",
        startMs: 0,
        endMs: 1,
      });
    }
    const started: string[] = [];
    const finish = new Map<string, () => void>();
    const publish = vi.fn(async () => {});
    const service = createLiveInteractionService({
      store,
      workspaceConcurrency: 2,
      authorize: async () => true,
      publish,
      answer: async ({ job, onText, signal }) => {
        started.push(job.id);
        await onText(`partial ${job.id}`);
        await new Promise<void>((resolve, reject) => {
          finish.set(job.id, resolve);
          signal.addEventListener(
            "abort",
            () => reject(new Error("cancelled")),
            { once: true },
          );
        });
        return `final ${job.id}`;
      },
    });
    await service.tickDetector();
    await service.tickAnswers();
    await expect.poll(() => started.length).toBe(2);
    await expect.poll(() => finish.size).toBe(2);
    const jobs = await store.listJobs(owner, workspace, chat);
    expect(
      jobs.every(
        (j) => j.status === "running" && j.answer.startsWith("partial"),
      ),
    ).toBe(true);
    // ASR ingress/detection continues while both answer adapters are waiting.
    await store.ingest(first.id, {
      id: "later",
      source: "microphone",
      text: "Hey Brian later question?",
      startMs: 2,
      endMs: 3,
    });
    await service.tickDetector();
    expect(await store.claimJob(2)).toBeNull();
    expect(
      (await store.readLiveTranscriptRange(first.id)).segments,
    ).toHaveLength(2);
    await service.cancel(owner, started[0]!);
    finish.get(started[1]!)!();
    await expect
      .poll(async () => (await store.job(started[1]!))?.status)
      .toBe("completed");
    await expect.poll(() => publish.mock.calls.length).toBe(1);
    await service.stop();
    expect((await store.job(started[0]!))?.status).toBe("cancelled");
  });
  it("recovers completed-but-unpublished jobs without rerunning answers or changing message IDs", async () => {
    await db.exec("DELETE FROM live_interaction_captures");
    const c = await store.create(makeCapture());
    await store.ingest(c.id, {
      id: "q",
      source: "microphone",
      text: "question?",
      startMs: 0,
      endMs: 1,
    });
    const i = await store.claimInbox();
    await store.finishInbox(i!, null, "question?");
    const j = await store.claimJob();
    await store.complete(j!.id, j!.token, "saved result");
    await db.exec(
      "UPDATE live_interaction_jobs SET lease_until=now()-interval '1 second'",
    );
    const answer = vi.fn(async () => "must not run"),
      publish = vi.fn(async () => {});
    const recovered = createLiveInteractionService({
      store,
      authorize: async () => true,
      answer,
      publish,
    });
    await recovered.tickAnswers();
    await expect.poll(() => publish.mock.calls.length).toBe(1);
    await recovered.stop();
    expect(answer).not.toHaveBeenCalled();
    expect(await store.job(j!.id)).toMatchObject({
      answer: "saved result",
      assistantMessageId: j!.assistantMessageId,
    });
  });
  it("fails closed on detector errors and retries accepted speech without another upload", async () => {
    await db.exec("DELETE FROM live_interaction_captures");
    const c = await store.create(makeCapture());
    await store.saveSettings(owner, "custom rule");
    await store.ingest(c.id, {
      id: "q",
      source: "microphone",
      text: "recap",
      startMs: 0,
      endMs: 1,
    });
    const evaluateRule = vi
      .fn()
      .mockRejectedValueOnce(new Error("provider outage"))
      .mockResolvedValue({ action: "submit", question: "Recap?" });
    const deps = {
      store,
      authorize: async () => true,
      answer: async () => "",
      publish: async () => {},
      evaluateRule,
    };
    await createLiveInteractionService(deps).tickDetector();
    expect(await store.listJobs(owner, workspace, chat)).toHaveLength(0);
    await db.exec("UPDATE live_interaction_captures SET detector_retry=now()");
    await createLiveInteractionService(deps).tickDetector();
    expect(await store.listJobs(owner, workspace, chat)).toHaveLength(1);
    await store.saveSettings(owner, DEFAULT_INTERACTION_RULE);
  });
  it("terminates revoked work before answering and bounds lease-expiry retries", async () => {
    await db.exec("DELETE FROM live_interaction_captures");
    const c = await store.create(makeCapture());
    await store.ingest(c.id, {
      id: "q",
      source: "microphone",
      text: "question?",
      startMs: 0,
      endMs: 1,
    });
    const i = await store.claimInbox();
    await store.finishInbox(i!, null, "question?");
    const answer = vi.fn(async () => ""),
      publish = vi.fn(async () => {});
    const service = createLiveInteractionService({
      store,
      authorize: async () => false,
      answer,
      publish,
    });
    await service.tickAnswers();
    await expect
      .poll(
        async () => (await store.listJobs(owner, workspace, chat))[0]?.status,
      )
      .toBe("cancelled");
    await service.stop();
    expect(answer).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    const j = (await store.listJobs(owner, workspace, chat))[0]!;
    await store.retry(j.id);
    for (let n = 0; n < 3; n++) {
      expect(await store.claimJob()).not.toBeNull();
      await db.exec(
        "UPDATE live_interaction_jobs SET lease_until=now()-interval '1 second'",
      );
    }
    expect(await store.claimJob()).toBeNull();
    expect((await store.job(j.id))?.status).toBe("failed");
  });
  it("selects eligible jobs beyond a saturated capture backlog", async () => {
    await db.exec("DELETE FROM live_interaction_captures");
    const blocked = await store.create(makeCapture());
    const eligible = await store.create(makeCapture());
    for (const c of [blocked, eligible]) {
      await store.ingest(c.id, {
        id: "q",
        source: "microphone",
        text: "q",
        startMs: 0,
        endMs: 1,
      });
      await store.finishInbox((await store.claimInbox())!, null, "q");
    }
    // Construct an old backlog directly, independently of the queue admission cap.
    await db.query(
      `INSERT INTO live_interaction_jobs (id,capture_id,occurrence,data,status,occurrence_index)
      SELECT gen_random_uuid(),capture_id,occurrence,data,'queued',n
      FROM live_interaction_jobs CROSS JOIN generate_series(1,105) n WHERE capture_id=$1`,
      [blocked.id],
    );
    await db.query(
      "UPDATE live_interaction_jobs SET created_at=now()-interval '1 hour' WHERE capture_id=$1",
      [blocked.id],
    );
    for (let n = 0; n < 3; n++)
      expect((await store.claimJob())?.captureId).toBe(blocked.id);
    expect((await store.claimJob())?.captureId).toBe(eligible.id);
  });
  it("bounds publication failures and preserves completed answers through retry and cancellation", async () => {
    await db.exec("DELETE FROM live_interaction_captures");
    const c = await store.create(makeCapture());
    await store.ingest(c.id, {
      id: "q",
      source: "microphone",
      text: "q",
      startMs: 0,
      endMs: 1,
    });
    await store.finishInbox((await store.claimInbox())!, null, "q");
    let j = (await store.claimJob())!;
    await store.complete(j.id, j.token, "saved");
    for (let n = 0; n < 3; n++) {
      await store.fail(j.id, j.token, "publication unavailable");
      await db.exec("UPDATE live_interaction_jobs SET available_at=now()");
      if (n < 2) {
        j = (await store.claimJob())!;
        expect(j).toMatchObject({ status: "completed", answer: "saved" });
      }
    }
    expect(await store.claimJob()).toBeNull();
    expect(await store.job(j.id)).toMatchObject({
      status: "failed",
      answer: "saved",
    });
    await store.retry(j.id);
    j = (await store.claimJob())!;
    expect(j).toMatchObject({ status: "completed", answer: "saved" });
    await store.cancel(j.id);
    expect(await store.heartbeat(j.id, j.token)).toBe(false);
    await store.retry(j.id);
    for (let n = 0; n < 3; n++) {
      expect(await store.claimJob()).toMatchObject({
        status: "completed",
        answer: "saved",
      });
      await db.exec(
        "UPDATE live_interaction_jobs SET lease_until=now()-interval '1 second'",
      );
    }
    expect(await store.claimJob()).toBeNull();
    expect(await store.job(j.id)).toMatchObject({
      status: "failed",
      answer: "saved",
    });
  });
  it("resets pending speech on an explicit discontinuity even without a missing predecessor", async () => {
    await db.exec("DELETE FROM live_interaction_captures");
    const c = await store.create(makeCapture());
    await store.ingest(c.id, {
      id: "wake",
      source: "microphone",
      text: "Hey Brian",
      startMs: 0,
      endMs: 1,
    });
    await store.finishInbox((await store.claimInbox())!, {
      text: "",
      endMs: 1,
      rule: DEFAULT_INTERACTION_RULE,
    });
    await store.ingest(c.id, {
      id: "next",
      previousId: "wake",
      source: "microphone",
      text: "unrelated",
      startMs: 2,
      endMs: 3,
      discontinuity: true,
    });
    const next = (await store.claimInbox())!;
    expect(next.pending).toBeNull();
    await store.finishInbox(next, null);
  });
  it("durably deduplicates manual overrides after stop and excludes them from speech evidence", async () => {
    await db.exec("DELETE FROM live_interaction_captures");
    const c = await store.create(makeCapture());
    await store.stop(c.id);
    const evaluateRule = vi.fn();
    const service = createLiveInteractionService({ store, authorize: async () => true,
      evaluateRule, answer: async () => "", publish: async () => {} });
    const request = { id: randomUUID(), action: "submit" as const, text: "Corrected typed question" };
    await service.question(owner, c.id, request);
    await service.question(owner, c.id, request);
    await service.tickDetector();
    const jobs = await store.listJobs(owner, workspace, chat);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ question: request.text, status: "queued" });
    expect(evaluateRule).not.toHaveBeenCalled();
    expect(await store.claimInbox()).toBeNull();
    expect(await store.listUtterances(c.id)).toEqual([]);
    expect((await store.readLiveTranscriptRange(c.id)).segments).toEqual([]);
    expect((await store.searchLiveTranscript(c.id, "Corrected")).segments).toEqual([]);
    await expect(service.question(other, c.id, { ...request, id: randomUUID() })).rejects.toMatchObject({ status: 403 });
  });
  it("manual cancellation fences a claimed detector without deleting accepted jobs; retries do not cancel new work", async () => {
    await db.exec("DELETE FROM live_interaction_captures");
    const c = await store.create(makeCapture());
    await store.question(c.id, { id: randomUUID(), action: "submit", text: "accepted" });
    await store.ingest(c.id, { id: "pending", source: "microphone", text: "Hey Brian", startMs: 1, endMs: 2 });
    await store.finishInbox((await store.claimInbox())!, { text: "", endMs: 2, rule: c.rule });
    await store.ingest(c.id, { id: "in-flight", source: "microphone", text: "stale question?", startMs: 3, endMs: 4 });
    const stale = (await store.claimInbox())!;
    const cancel = { id: randomUUID(), action: "cancel" as const };
    await store.question(c.id, cancel);
    expect(await store.finishInbox(stale, null, "must not enqueue")).toBe(false);
    await store.releaseInbox(stale);
    expect(await store.claimInbox()).toBeNull();
    expect(await store.listJobs(owner, workspace, chat)).toHaveLength(1);
    await store.ingest(c.id, { id: "new", source: "microphone", text: "Hey Brian new question?", startMs: 5, endMs: 6 });
    const fresh = (await store.claimInbox())!;
    expect(fresh.pending).toBeNull();
    await store.question(c.id, cancel);
    expect(await store.finishInbox(fresh, null, "new question?")).toBe(true);
    expect(await store.listJobs(owner, workspace, chat)).toHaveLength(2);
    expect(await store.listUtterances(c.id)).toHaveLength(3);
  });
  it("bounds malformed detector attempts, exposes only generic failures, and continues with later microphone speech", async () => {
    await db.exec("DELETE FROM live_interaction_captures");
    await store.saveSettings(owner, "custom rule");
    const c = await store.create(makeCapture());
    const evaluateRule = vi.fn().mockResolvedValue({ action: "submit" });
    const service = createLiveInteractionService({ store, authorize: async () => true,
      evaluateRule, answer: async () => "", publish: async () => {} });
    await db.query("UPDATE live_interaction_captures SET pending=$2 WHERE id=$1", [c.id,
      { text: "private pending", endMs: 0, rule: "custom rule" }]);
    await store.ingest(c.id, { id: "bad", source: "microphone", text: "private speech", startMs: 1, endMs: 2 });
    for (let attempt = 1; attempt <= 3; attempt++) {
      await db.exec("UPDATE live_interaction_captures SET detector_retry=now()");
      await service.tickDetector();
      expect(evaluateRule).toHaveBeenCalledTimes(attempt);
      expect((await store.capture(c.id))?.error).toBe(attempt === 3
        ? "Could not process spoken input. Please try again or type your question." : undefined);
    }
    await service.tickDetector();
    expect(evaluateRule).toHaveBeenCalledTimes(3);
    expect((await db.query("SELECT processed,detector_attempts FROM live_interaction_utterances WHERE capture_id=$1", [c.id])).rows)
      .toEqual([{ processed: true, detector_attempts: 3 }]);
    expect((await db.query("SELECT pending FROM live_interaction_captures WHERE id=$1", [c.id])).rows).toEqual([{ pending: null }]);
    const errors = await service.captureErrors(owner, workspace, chat);
    expect(errors).toEqual([{ captureId: c.id, error: (await store.capture(c.id))!.error }]);
    expect(await store.listCaptureErrors(other, workspace, chat)).toEqual([]);
    expect(await store.listCaptureErrors(owner, randomUUID(), chat)).toEqual([]);
    expect(await store.listCaptureErrors(owner, workspace, randomUUID())).toEqual([]);
    expect(await store.listJobs(owner, workspace, chat)).toEqual([]);
    await store.ingest(c.id, { id: "system", source: "system", text: "Hey Brian answer this", startMs: 3, endMs: 4 });
    await service.tickDetector();
    expect(evaluateRule).toHaveBeenCalledTimes(3);
    expect(await service.captureErrors(owner, workspace, chat)).toEqual(errors);
    evaluateRule.mockResolvedValue({ action: "submit", question: "later question" });
    await store.ingest(c.id, { id: "later", previousId: "bad", source: "microphone", text: "later speech", startMs: 5, endMs: 6 });
    await service.tickDetector();
    expect(evaluateRule).toHaveBeenLastCalledWith(expect.objectContaining({ pending: undefined, text: "later speech" }), expect.any(AbortSignal));
    expect(await service.captureErrors(owner, workspace, chat)).toEqual([]);
    expect(await store.listJobs(owner, workspace, chat)).toMatchObject([{ question: "later question" }]);
    await store.saveSettings(owner, DEFAULT_INTERACTION_RULE);
  });
  it("never persists raw provider diagnostics in capture errors", async () => {
    await db.exec("DELETE FROM live_interaction_captures");
    const c = await store.create({ ...makeCapture(), rule: "custom rule" });
    await store.saveSettings(owner, "custom rule");
    const evaluateRule = vi.fn(async () => { throw new Error("provider secret: private speech"); });
    const service = createLiveInteractionService({ store, authorize: async () => true,
      evaluateRule, answer: async () => "", publish: async () => {} });
    await store.ingest(c.id, { id: "provider-failure", source: "microphone", text: "private speech", startMs: 0, endMs: 1 });
    for (let n = 0; n < 4; n++) {
      await db.exec("UPDATE live_interaction_captures SET detector_retry=now()");
      await service.tickDetector();
    }
    expect(evaluateRule).toHaveBeenCalledTimes(3);
    expect(await service.captureErrors(owner, workspace, chat)).toEqual([
      { captureId: c.id, error: "Could not process spoken input. Please try again or type your question." },
    ]);
    expect(JSON.stringify(await store.capture(c.id))).not.toMatch(/provider secret|private speech/);
    expect(await store.listJobs(owner, workspace, chat)).toEqual([]);
    await store.saveSettings(owner, DEFAULT_INTERACTION_RULE);
  });
  it("fences expired detector failures, bounds crash retries, and clears errors on manual actions", async () => {
    await db.exec("DELETE FROM live_interaction_captures");
    const c = await store.create(makeCapture());
    await store.ingest(c.id, { id: "crash", source: "microphone", text: "private", startMs: 0, endMs: 1 });
    const stale = (await store.claimInbox())!;
    await db.exec("UPDATE live_interaction_captures SET detector_until=now()-interval '1 second'");
    expect(await store.releaseInbox(stale)).toBe(false);
    for (let attempt = 2; attempt <= 3; attempt++) {
      expect(await store.claimInbox()).not.toBeNull();
      await db.exec("UPDATE live_interaction_captures SET detector_until=now()-interval '1 second'");
    }
    expect(await store.claimInbox()).toBeNull();
    expect((await store.capture(c.id))?.error).toBeTruthy();
    for (const action of ["submit", "cancel"] as const) {
      await db.query(`UPDATE live_interaction_captures SET data=data || '{"error":"generic failure"}'::jsonb WHERE id=$1`, [c.id]);
      await store.question(c.id, { id: randomUUID(), action, text: "manual" });
      expect((await store.capture(c.id))?.error).toBeUndefined();
      expect(await store.releaseInbox(stale)).toBe(false);
      expect(await store.finishInbox(stale, null, "stale")).toBe(false);
      expect((await store.capture(c.id))?.error).toBeUndefined();
    }
  });
  it("stopping rejects new speech but drains accepted speech; deleting destination cascades", async () => {
    await db.exec("DELETE FROM live_interaction_captures");
    const c = await store.create(makeCapture());
    await store.ingest(c.id, {
      id: "q",
      source: "microphone",
      text: "Hey Brian question?",
      startMs: 0,
      endMs: 1,
    });
    await store.stop(c.id);
    await expect(
      store.ingest(c.id, {
        id: "new",
        source: "microphone",
        text: "no",
        startMs: 2,
        endMs: 3,
      }),
    ).rejects.toMatchObject({ status: 409 });
    await createLiveInteractionService({
      store,
      authorize: async () => true,
      answer: async () => "",
      publish: async () => {},
    }).tickDetector();
    expect(await store.listJobs(owner, workspace, chat)).toHaveLength(1);
    await db.query("DELETE FROM sessions WHERE id=$1", [chat]);
    expect(await store.capture(c.id)).toBeNull();
    expect(await store.listJobs(owner, workspace, chat)).toHaveLength(0);
  });
});
