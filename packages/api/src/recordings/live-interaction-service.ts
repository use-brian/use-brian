/** Integration: createLiveInteractionService({store?,authorize,evaluateRule?,answer,publish,createTranscriptionToken?}).
 * authorize(userId,binding) checks workspace/page/chat/assistant access AND relationships.
 * publish({capture,job,signal}) must upsert canonical messages using stable message IDs.
 * onText receives cumulative text. Parent calls start()/runWorkers(); no boot side effects.
 */
import { randomUUID } from "node:crypto";
import {
  DEFAULT_INTERACTION_RULE,
  type InteractionSource,
  type InteractionUtterance,
  type InteractionJob,
} from "@use-brian/shared";
import {
  createLiveInteractionStore,
  type Capture,
  type Pending,
  type LiveInteractionStore,
  type ClaimedJob,
} from "../db/live-interaction-store.js";
export type Binding = Pick<
  Capture,
  "workspaceId" | "pageId" | "chatSessionId" | "assistantId"
>;
export type RuleDecision = {
  action: "ignore" | "begin" | "continue" | "submit" | "cancel";
  question?: string;
};
export type LiveInteractionDeps = {
  store?: LiveInteractionStore;
  authorize: (
    userId: string,
    binding: Binding & { id?: string },
  ) => Promise<boolean>;
  authorizeJob?: (capture: Capture, job: InteractionJob) => Promise<boolean>;
  createTranscriptionToken?: (
    source: InteractionSource,
  ) => Promise<{ value: string; expiresAt: number }>;
  evaluateRule?: (
    input: { rule: string; text: string; pending?: string },
    signal: AbortSignal,
  ) => Promise<RuleDecision>;
  answer: (input: {
    capture: Capture;
    job: InteractionJob;
    signal: AbortSignal;
    onText: (text: string) => Promise<void>;
  }) => Promise<string>;
  publish: (input: {
    capture: Capture;
    job: InteractionJob;
    signal: AbortSignal;
  }) => Promise<void>;
  onError?: (error: unknown) => void;
  workspaceConcurrency?: number;
};
export class InteractionError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function validateRule(rule: unknown): string {
  if (typeof rule !== "string" || !rule.trim() || rule.length > 2000)
    throw new InteractionError(400, "Rule must contain 1–2000 characters");
  return rule.trim();
}
/** ASR final utterances are completion boundaries; bare/split wake phrases remain pending. */
export function defaultRuleDecision(
  text: string,
  pending?: string,
): RuleDecision {
  const combined = [pending, text].filter(Boolean).join(" ").trim();
  const question = (value: string): RuleDecision => ({
    action:
      /\b(?:what|which|who|why|how|the|a|an|is|are|was|were|did|does|do|and|or|to|of|for|about)\s*$/i.test(
        value,
      )
        ? "continue"
        : "submit",
    question: value,
  });
  if (/^(?:cancel|never mind|nevermind)[.!]?$/i.test(text.trim()))
    return { action: "cancel" };
  const match = /\bhey[\s,]+brian\b[\s,:.!?]*(.*)$/is.exec(combined);
  if (match)
    return match[1]?.trim()
      ? question(match[1].trim())
      : { action: "begin", question: "" };
  if (pending !== undefined && !/^hey[\s,.!?]*$/i.test(pending))
    return combined ? question(combined) : { action: "begin", question: "" };
  if (/\bhey[\s,.!?]*$/i.test(combined))
    return { action: "begin", question: "Hey" };
  return { action: "ignore" };
}
export function createLiveInteractionService(deps: LiveInteractionDeps) {
  const store = deps.store ?? createLiveInteractionStore();
  // Per-process fixed windows: bounded memory, charged before paid adapter calls.
  const limits = new Map<string, { until: number; count: number }>();
  function rateLimit(userId: string, action: string, max: number) {
    const now = Date.now();
    for (const [key, value] of limits)
      if (value.until <= now) limits.delete(key);
    const key = `${action}:${userId}`;
    let window = limits.get(key);
    if (!window) {
      if (limits.size >= 10000)
        throw new InteractionError(429, "Interaction rate limit exceeded");
      window = { until: now + 60000, count: 0 };
      limits.set(key, window);
    }
    if (++window.count > max)
      throw new InteractionError(429, "Interaction rate limit exceeded");
  }
  const active = new Map<string, AbortController>();
  const tasks = new Set<Promise<void>>();
  let stopping = false,
    detectorBusy = false,
    answersBusy = false,
    timers: ReturnType<typeof setInterval>[] = [];
  const denied = () => new InteractionError(403, "Interaction access denied");
  async function authorize(userId: string, binding: Binding & { id?: string }) {
    if (!(await deps.authorize(userId, binding))) throw denied();
  }
  async function getCapture(userId: string, id: string) {
    const c = await store.capture(id);
    if (!c || c.ownerId !== userId) throw denied();
    await authorize(userId, c);
    return c;
  }
  async function getJob(userId: string, id: string) {
    const j = await store.job(id);
    if (!j) throw denied();
    const c = await getCapture(userId, j.captureId);
    if (deps.authorizeJob && !(await deps.authorizeJob(c, j))) throw denied();
    return j;
  }
  async function evaluate(
    rule: string,
    text: string,
    pending?: string,
  ): Promise<RuleDecision> {
    if (rule === DEFAULT_INTERACTION_RULE)
      return defaultRuleDecision(text, pending);
    if (!deps.evaluateRule)
      throw new InteractionError(503, "Semantic rule evaluator unavailable");
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const d = await Promise.race([
        deps.evaluateRule({ rule, text, pending }, controller.signal),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            controller.abort();
            reject(new Error("Rule evaluation timed out"));
          }, 8000);
        }),
      ]);
      if (
        !d ||
        !["ignore", "begin", "continue", "submit", "cancel"].includes(
          d.action,
        ) ||
        (d.question !== undefined &&
          (typeof d.question !== "string" || d.question.length > 8000)) ||
        (d.action === "submit" && !d.question?.trim())
      )
        throw new Error("Invalid rule decision");
      return d;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  async function tickDetector() {
    if (stopping || detectorBusy) return;
    detectorBusy = true;
    try {
      for (let n = 0; n < 20 && !stopping; n++) {
        const i = await store.claimInbox();
        if (!i) break;
        try {
          await authorize(i.capture.ownerId, i.capture);
          if (i.utterance.source !== "microphone") {
            await store.finishInbox(i, i.pending);
            continue;
          }
          const p =
            i.pending &&
            i.pending.rule === i.rule &&
            i.utterance.startMs - i.pending.endMs < 15000
              ? i.pending
              : null;
          // A single ASR final may contain several independent wake occurrences.
          const parts =
            i.rule === DEFAULT_INTERACTION_RULE
              ? i.utterance.text
                  .split(/(?=\bhey[\s,]+brian\b)/i)
                  .filter(Boolean)
              : [i.utterance.text];
          let next: Pending | null = p;
          const questions: string[] = [];
          for (const text of parts) {
            const d = await evaluate(i.rule, text, next?.text);
            if (d.action === "begin" || d.action === "continue")
              next = {
                text: (
                  d.question ?? [next?.text, text].filter(Boolean).join(" ")
                ).slice(0, 8000),
                endMs: i.utterance.endMs,
                rule: i.rule,
              };
            if (d.action === "submit") {
              if (d.question?.trim()) questions.push(d.question.trim());
              next = null;
            }
            if (d.action === "cancel") next = null;
          }
          await store.finishInbox(i, next, questions);
        } catch (e) {
          if (e instanceof InteractionError && e.status === 403)
            await store.finishInbox(i, null, undefined, false);
          else {
            await store.releaseInbox(i);
            deps.onError?.(e);
            break;
          }
        }
      }
    } finally {
      detectorBusy = false;
    }
  }
  async function runJob(j: ClaimedJob) {
    const controller = new AbortController();
    if (stopping) controller.abort();
    active.set(j.id, controller);
    const assertLive = async () => {
      if (controller.signal.aborted) throw new Error("Interaction cancelled");
      const c = await store.capture(j.captureId);
      if (!c || !(await deps.authorize(c.ownerId, c))) {
        await store.cancel(j.id);
        controller.abort();
        throw new Error("Interaction access lost");
      }
      if (!(await store.heartbeat(j.id, j.token))) {
        controller.abort();
        throw new Error("Interaction lease lost");
      }
      return c;
    };
    const heartbeat = setInterval(() => {
      void assertLive().catch(() => controller.abort());
    }, 5000);
    const timeout = setTimeout(
      () => controller.abort(new Error("Answer timed out")),
      120000,
    );
    try {
      const c = await assertLive();
      if (j.status !== "completed") {
        const aborted = new Promise<never>((_, reject) =>
          controller.signal.addEventListener(
            "abort",
            () => reject(new Error("Answer cancelled or timed out")),
            { once: true },
          ),
        );
        const answer = await Promise.race([
          deps.answer({
            capture: c,
            job: j,
            signal: controller.signal,
            onText: async (text) => {
              await assertLive();
              if (!(await store.text(j.id, j.token, text.slice(0, 200000))))
                throw new Error("Stale answer");
            },
          }),
          aborted,
        ]);
        await assertLive();
        if (!(await store.complete(j.id, j.token, answer.slice(0, 200000))))
          return;
        j = {
          ...j,
          status: "completed",
          answer: answer.slice(0, 200000),
          error: null,
        };
      }
      await assertLive();
      await Promise.race([
        deps.publish({ capture: c, job: j, signal: controller.signal }),
        new Promise<never>((_, reject) => {
          if (controller.signal.aborted)
            reject(new Error("Publication cancelled"));
          else
            controller.signal.addEventListener(
              "abort",
              () => reject(new Error("Publication cancelled")),
              { once: true },
            );
        }),
      ]);
      await store.published(j.id, j.token);
    } catch (e) {
      await store.fail(
        j.id,
        j.token,
        e instanceof Error ? e.message : "Answer failed",
      );
      deps.onError?.(e);
    } finally {
      clearInterval(heartbeat);
      clearTimeout(timeout);
      if (active.get(j.id) === controller) active.delete(j.id);
    }
  }
  async function tickAnswers() {
    if (stopping || answersBusy) return;
    answersBusy = true;
    try {
      while (tasks.size < 12 && !stopping) {
        const j = await store.claimJob(
          Math.max(1, Math.min(48, deps.workspaceConcurrency ?? 12)),
        );
        if (!j) break;
        const task = runJob(j).catch((e) => deps.onError?.(e));
        tasks.add(task);
        void task.finally(() => tasks.delete(task));
      }
    } finally {
      answersBusy = false;
    }
  }
  const report = (p: Promise<void>) => {
    void p.catch((e) => deps.onError?.(e));
  };
  function start() {
    if (timers.length) return;
    stopping = false;
    timers = [
      setInterval(() => report(tickDetector()), 200),
      setInterval(() => report(tickAnswers()), 200),
    ];
    report(tickDetector());
    report(tickAnswers());
  }
  return {
    store,
    available: !!deps.createTranscriptionToken,
    getCapture,
    getJob,
    tickDetector,
    tickAnswers,
    start,
    runWorkers: start,
    async stop() {
      stopping = true;
      timers.forEach(clearInterval);
      timers = [];
      active.forEach((c) => c.abort());
      while (detectorBusy || answersBusy)
        await new Promise((resolve) => setTimeout(resolve, 20));
      active.forEach((c) => c.abort());
      await Promise.allSettled([...tasks]);
    },
    settings: (userId: string) => store.settings(userId),
    saveSettings: (userId: string, rule: unknown) =>
      store.saveSettings(userId, validateRule(rule)),
    async preview(rule: unknown, text: unknown, userId = "internal") {
      if (typeof text !== "string" || text.length > 8000)
        throw new InteractionError(400, "Invalid preview text");
      rateLimit(userId, "preview", 10);
      const d = await evaluate(validateRule(rule), text);
      return { question: d.action === "submit" ? d.question : null };
    },
    async create(userId: string, binding: Binding) {
      await authorize(userId, binding);
      if (!deps.createTranscriptionToken)
        throw new InteractionError(503, "Streaming transcription unavailable");
      rateLimit(userId, "start", 6);
      const s = await store.settings(userId);
      return store.create({
        ...binding,
        id: randomUUID(),
        ownerId: userId,
        rule: s.rule,
        ruleVersion: s.version,
        state: "listening",
      });
    },
    async token(userId: string, id: string, source: InteractionSource) {
      const c = await getCapture(userId, id);
      if (c.state !== "listening")
        throw new InteractionError(409, "Capture stopped");
      if (!deps.createTranscriptionToken)
        throw new InteractionError(503, "Streaming transcription unavailable");
      rateLimit(userId, "token", 12);
      return deps.createTranscriptionToken(source);
    },
    async ingest(userId: string, id: string, u: InteractionUtterance) {
      await getCapture(userId, id);
      await store.ingest(id, u);
    },
    async question(userId: string, id: string, request: { id: string; action: "submit" | "cancel"; text?: string }) {
      await getCapture(userId, id);
      if (request.action === "submit" && (!request.text?.trim() || request.text.length > 8000))
        throw new InteractionError(400, "Question must contain 1–8000 characters");
      rateLimit(userId, "question", 30);
      // Deliberate typed override, including corrections after capture stop.
      await store.question(id, { ...request, text: request.text?.trim() });
    },
    async stopCapture(userId: string, id: string) {
      await getCapture(userId, id);
      await store.stop(id);
    },
    async captureErrors(userId: string, workspace: string, chat: string) {
      const errors = await store.listCaptureErrors(userId, workspace, chat);
      for (const error of errors) await getCapture(userId, error.captureId);
      return errors;
    },
    async jobs(userId: string, workspace: string, chat: string) {
      const jobs = await store.listJobs(userId, workspace, chat);
      const captures = new Map<string, Capture>();
      for (const id of new Set(jobs.map((j) => j.captureId)))
        captures.set(id, await getCapture(userId, id));
      const visible: InteractionJob[] = [];
      for (const job of jobs)
        if (
          !deps.authorizeJob ||
          (await deps.authorizeJob(captures.get(job.captureId)!, job))
        )
          visible.push(job);
      return visible;
    },
    async cancel(userId: string, id: string) {
      await getJob(userId, id);
      await store.cancel(id);
      active.get(id)?.abort();
    },
    async retry(userId: string, id: string) {
      await getJob(userId, id);
      await store.retry(id);
    },
  };
}
export type LiveInteractionService = ReturnType<
  typeof createLiveInteractionService
>;
