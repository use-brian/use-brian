vi.mock("../../db/client.js", () => ({
  getPool: () => {
    throw new Error("Inject test pool");
  },
}));
import { describe, it, expect, vi } from "vitest";
import express from "express";
import request from "supertest";
import { recordingInteractionRoutes } from "../recording-interaction.js";
import {
  createLiveInteractionService,
  defaultRuleDecision,
} from "../../recordings/live-interaction-service.js";
import type { LiveInteractionStore } from "../../db/live-interaction-store.js";
const id = "11111111-1111-4111-8111-111111111111";
describe("[COMP:recordings/live-interaction] routes and authorization", () => {
  it("rejects unauthenticated requests before invoking adapters", async () => {
    const authorize = vi.fn(async () => true);
    const app = express()
      .use(express.json())
      .use(
        recordingInteractionRoutes({
          authorize,
          answer: async () => "",
          publish: async () => {},
        }),
      );
    expect((await request(app).get("/settings")).status).toBe(401);
    expect(authorize).not.toHaveBeenCalled();
  });
  it("rejects unauthorized binding before capture creation or token issuance", async () => {
    const create = vi.fn(),
      token = vi.fn();
    const app = express()
      .use(express.json())
      .use((req, _res, next) => {
        Object.assign(req, { userId: id });
        next();
      })
      .use(
        recordingInteractionRoutes({
          store: { create } as unknown as LiveInteractionStore,
          authorize: async () => false,
          createTranscriptionToken: token,
          answer: async () => "",
          publish: async () => {},
        }),
      );
    expect(
      (
        await request(app)
          .post("/start")
          .send({
            workspaceId: id,
            pageId: id,
            chatSessionId: id,
            assistantId: id,
          })
      ).status,
    ).toBe(403);
    expect(create).not.toHaveBeenCalled();
    expect(token).not.toHaveBeenCalled();
  });
  it("rejects another owner even if workspace authorizer allows access", async () => {
    const service = createLiveInteractionService({
      store: {
        capture: async () => ({ ownerId: "other" }),
      } as unknown as LiveInteractionStore,
      authorize: async () => true,
      answer: async () => "",
      publish: async () => {},
    });
    await expect(service.getCapture(id, id)).rejects.toMatchObject({
      status: 403,
    });
  });
  it("validates manual controls and enforces authentication and capture owner scope", async () => {
    const question = vi.fn();
    let userId: string | undefined = id;
    const service = createLiveInteractionService({
      store: { capture: async () => ({ id, ownerId: id, state: "stopped" }), question } as unknown as LiveInteractionStore,
      authorize: async () => true, answer: async () => "", publish: async () => {},
    });
    const app = express().use(express.json()).use((req, _res, next) => {
      Object.assign(req, { userId }); next();
    }).use(recordingInteractionRoutes({ service }));
    const body = { id, action: "submit", text: "  corrected  " };
    expect((await request(app).post(`/${id}/question`).send(body)).status).toBe(200);
    expect(question).toHaveBeenCalledWith(id, { ...body, text: "corrected" });
    expect((await request(app).post(`/${id}/question`).send({ id, action: "cancel" })).status).toBe(200);
    for (const invalid of [{ ...body, id: "bad" }, { ...body, text: " " }, { ...body, text: "x".repeat(8001) }, { ...body, action: "speech" }])
      expect((await request(app).post(`/${id}/question`).send(invalid)).status).toBe(400);
    question.mockClear();
    userId = "22222222-2222-4222-8222-222222222222";
    expect((await request(app).post(`/${id}/question`).send(body)).status).toBe(403);
    userId = undefined;
    expect((await request(app).post(`/${id}/question`).send(body)).status).toBe(401);
    expect(question).not.toHaveBeenCalled();
  });
  it("returns capture errors without jobs and enforces the same capture authorization boundary", async () => {
    const listCaptureErrors = vi.fn(async () => [{ captureId: id, error: "Generic failure" }]);
    let ownerId = id;
    const authorize = vi.fn(async () => true);
    const service = createLiveInteractionService({
      store: { listCaptureErrors, listJobs: async () => [], capture: async () => ({ id, ownerId }) } as unknown as LiveInteractionStore,
      authorize, answer: async () => "", publish: async () => {},
    });
    const app = express().use((req, _res, next) => { Object.assign(req, { userId: id }); next(); })
      .use(recordingInteractionRoutes({ service }));
    const url = `/jobs?workspaceId=${id}&chatSessionId=${id}`;
    expect((await request(app).get(url)).body).toEqual({ jobs: [], captureErrors: [{ captureId: id, error: "Generic failure" }] });
    expect(listCaptureErrors).toHaveBeenCalledWith(id, id, id);
    expect(authorize).toHaveBeenCalledWith(id, { id, ownerId: id });
    authorize.mockResolvedValue(false);
    expect((await request(app).get(url)).status).toBe(403);
    authorize.mockResolvedValue(true);
    ownerId = "other";
    expect((await request(app).get(url)).status).toBe(403);
  });
  it("handles split wake phrases, empty questions, and cancellation", () => {
    expect(defaultRuleDecision("Hey")).toEqual({
      action: "begin",
      question: "Hey",
    });
    expect(defaultRuleDecision("Brian what happened?", "Hey")).toEqual({
      action: "submit",
      question: "what happened?",
    });
    expect(defaultRuleDecision("Hey Brian")).toEqual({
      action: "begin",
      question: "",
    });
    expect(defaultRuleDecision("What happened?", "")).toEqual({
      action: "submit",
      question: "What happened?",
    });
    expect(defaultRuleDecision("cancel", "question")).toEqual({
      action: "cancel",
    });
  });
  it("uses structured semantic callback for custom rules and fails closed on invalid output", async () => {
    const evaluateRule = vi.fn(async () => ({
      action: "submit" as const,
      question: "Summary?",
    }));
    const service = createLiveInteractionService({
      evaluateRule,
      authorize: async () => true,
      answer: async () => "",
      publish: async () => {},
    });
    expect(
      await service.preview("Summarize when requested", "Please recap"),
    ).toEqual({
      question: "Summary?",
    });
    evaluateRule.mockResolvedValueOnce({ action: "submit", question: "" });
    await expect(service.preview("custom", "speech")).rejects.toThrow(
      "Invalid rule decision",
    );
  });
  it("filters evidence-denied jobs and denies direct access", async () => {
    const allowed = { id: "allowed", captureId: id, answer: "safe" };
    const denied = { id: "denied", captureId: id, answer: "secret" };
    const service = createLiveInteractionService({
      store: {
        capture: async () => ({ id, ownerId: id }),
        listJobs: async () => [allowed, denied],
        job: async () => denied,
      } as unknown as LiveInteractionStore,
      authorize: async () => true,
      authorizeJob: async (_capture, job) => job.id === "allowed",
      answer: async () => "",
      publish: async () => {},
    });
    expect(await service.jobs(id, id, id)).toEqual([allowed]);
    await expect(service.getJob(id, "denied")).rejects.toMatchObject({
      status: 403,
    });
  });
  it("limits start, token and paid previews before invoking adapters", async () => {
    const create = vi.fn(async () => ({}));
    const token = vi.fn(async () => ({ value: "token", expiresAt: 0 }));
    const evaluateRule = vi.fn(async () => ({ action: "ignore" as const }));
    const service = createLiveInteractionService({
      store: {
        create,
        settings: async () => ({ rule: "custom", version: 1 }),
        capture: async () => ({ id, ownerId: id, state: "listening" }),
      } as unknown as LiveInteractionStore,
      authorize: async () => true,
      createTranscriptionToken: token,
      evaluateRule,
      answer: async () => "",
      publish: async () => {},
    });
    const app = express()
      .use(express.json())
      .use((req, _res, next) => {
        Object.assign(req, { userId: id });
        next();
      })
      .use(recordingInteractionRoutes({ service }));
    for (const [path, body, max, adapter] of [
      [
        "/start",
        { workspaceId: id, pageId: id, chatSessionId: id, assistantId: id },
        6,
        create,
      ],
      [`/${id}/token`, { source: "microphone" }, 12, token],
      ["/preview", { rule: "custom", text: "hello" }, 10, evaluateRule],
    ] as const) {
      for (let n = 0; n < max; n++)
        expect((await request(app).post(path).send(body)).status).toBe(200);
      expect((await request(app).post(path).send(body)).status).toBe(429);
      expect(adapter).toHaveBeenCalledTimes(max);
    }
  });
  it("validates and forwards explicit utterance discontinuities", async () => {
    const ingest = vi.fn(async () => {});
    const service = createLiveInteractionService({
      store: {
        capture: async () => ({ ownerId: id }),
        ingest,
      } as unknown as LiveInteractionStore,
      authorize: async () => true,
      answer: async () => "",
      publish: async () => {},
    });
    const app = express()
      .use(express.json())
      .use((req, _res, next) => {
        Object.assign(req, { userId: id });
        next();
      })
      .use(recordingInteractionRoutes({ service }));
    const body = {
      id: "q",
      source: "microphone",
      text: "q",
      startMs: 0,
      endMs: 1,
      discontinuity: true,
    };
    expect(
      (await request(app).post(`/${id}/utterances`).send(body)).status,
    ).toBe(200);
    expect(ingest).toHaveBeenCalledWith(id, body);
    expect(
      (
        await request(app)
          .post(`/${id}/utterances`)
          .send({ ...body, discontinuity: "true" })
      ).status,
    ).toBe(400);
  });
});
