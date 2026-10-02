/** Mount at /api/recordings/interaction after authentication. No workers start here. */
import {
  Router,
  type Request,
  type Response,
  type NextFunction,
} from "express";
import { z } from "zod";
import {
  createLiveInteractionService,
  InteractionError,
  type LiveInteractionService,
  type LiveInteractionDeps,
} from "../recordings/live-interaction-service.js";
const uuid = z.string().uuid();
const binding = z.object({
  workspaceId: uuid,
  pageId: uuid,
  chatSessionId: uuid,
  assistantId: uuid,
});
const utterance = z
  .object({
    id: z.string().min(1).max(256),
    source: z.enum(["microphone", "system"]),
    text: z.string().max(8000),
    startMs: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    endMs: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    discontinuity: z.boolean().optional(),
    previousId: z.string().min(1).max(256).nullable().optional(),
  })
  .refine((u) => u.endMs >= u.startMs && u.previousId !== u.id);
export type RecordingInteractionRouteDeps =
  | LiveInteractionDeps
  | { service: LiveInteractionService };
export function recordingInteractionRoutes(
  deps: RecordingInteractionRouteDeps,
): Router {
  const service =
    "service" in deps ? deps.service : createLiveInteractionService(deps);
  const router = Router();
  const route =
    (fn: (req: Request, userId: string) => Promise<unknown>) =>
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const userId = (req as Request & { userId?: string }).userId;
        if (!userId) {
          res.status(401).json({ error: "Authentication required" });
          return;
        }
        res.json(await fn(req, userId));
      } catch (e) {
        if (e instanceof z.ZodError)
          res.status(400).json({ error: "Invalid interaction request" });
        else if (
          e instanceof InteractionError ||
          (e instanceof Error && "status" in e && e.status === 409)
        )
          res.status(Number(e.status)).json({ error: e.message });
        else next(e);
      }
    };
  router.get(
    "/settings",
    route(async (_, u) => ({
      rule: (await service.settings(u)).rule,
      available: service.available,
    })),
  );
  router.put(
    "/settings",
    route((r, u) => service.saveSettings(u, r.body?.rule)),
  );
  router.post(
    "/preview",
    route((r, u) => service.preview(r.body?.rule, r.body?.text, u)),
  );
  router.post(
    "/start",
    route((r, u) => service.create(u, binding.parse(r.body))),
  );
  router.post(
    "/:captureId/token",
    route((r, u) =>
      service.token(
        u,
        uuid.parse(r.params.captureId),
        z.enum(["microphone", "system"]).parse(r.body?.source),
      ),
    ),
  );
  router.post(
    "/:captureId/utterances",
    route(async (r, u) => {
      await service.ingest(
        u,
        uuid.parse(r.params.captureId),
        utterance.parse(r.body),
      );
      return { ok: true };
    }),
  );
  router.post(
    "/:captureId/question",
    route(async (r, u) => {
      const body = z.discriminatedUnion("action", [
        z.object({ id: uuid, action: z.literal("submit"), text: z.string().trim().min(1).max(8000) }),
        z.object({ id: uuid, action: z.literal("cancel"), text: z.string().max(8000).optional() }),
      ]).parse(r.body);
      await service.question(u, uuid.parse(r.params.captureId), body);
      return { ok: true };
    }),
  );
  router.post(
    "/:captureId/stop",
    route(async (r, u) => {
      await service.stopCapture(u, uuid.parse(r.params.captureId));
      return { ok: true };
    }),
  );
  router.get(
    "/jobs",
    route(async (r, u) => ({
      captureErrors: await service.captureErrors(
        u,
        uuid.parse(r.query.workspaceId),
        uuid.parse(r.query.chatSessionId),
      ),
      jobs: await service.jobs(
        u,
        uuid.parse(r.query.workspaceId),
        uuid.parse(r.query.chatSessionId),
      ),
    })),
  );
  router.post(
    "/jobs/:jobId/cancel",
    route(async (r, u) => {
      await service.cancel(u, uuid.parse(r.params.jobId));
      return { ok: true };
    }),
  );
  router.post(
    "/jobs/:jobId/retry",
    route(async (r, u) => {
      await service.retry(u, uuid.parse(r.params.jobId));
      return { ok: true };
    }),
  );
  return router;
}
