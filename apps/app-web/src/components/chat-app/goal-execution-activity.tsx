"use client";

/**
 * Follow one acting goal's authenticated SSE feed and fold its background
 * callee events through the normal chat reasoning/tool activity UI.
 *
 * [COMP:app-web/goal-live-activity]
 */
import { useEffect, useState } from "react";
import type { ToolUsed } from "@use-brian/chat-ui";
import { createSSEBuffer, parseSSEStream } from "@use-brian/chat-ui";
import { ChatActivityFeed } from "@/components/chrome/chat-activity";
import { authFetch } from "@/lib/auth-fetch";
import {
  appendReasoning,
  appendStep,
  EMPTY_LOG,
  removeToolSteps,
  updateStepText,
  type EventLog,
} from "@/lib/build-events";
import { describeToolFromInput, type NarrationDict } from "@/lib/tool-narration";
import { useT } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export type GoalExecutionActivityState = {
  status: string | null;
  phase: string | null;
  log: EventLog;
  tools: ToolUsed[];
  reasoning: string;
  startedAt: number;
  toolStartedAt: Record<string, number>;
  nextId: number;
};

export function emptyGoalExecutionActivity(
  status: string | null = null,
  now = Date.now(),
): GoalExecutionActivityState {
  return {
    status,
    phase: null,
    log: EMPTY_LOG,
    tools: [],
    reasoning: "",
    startedAt: now,
    toolStartedAt: {},
    nextId: 1,
  };
}

export function reduceGoalExecutionActivity(
  state: GoalExecutionActivityState,
  event: string,
  payload: Record<string, unknown>,
  narration: NarrationDict,
  now = Date.now(),
): GoalExecutionActivityState {
  let nextId = state.nextId;
  const mintId = () => `goal-activity-${nextId++}`;

  if (event === "status") {
    return {
      ...state,
      status: typeof payload.status === "string" ? payload.status : state.status,
      phase: typeof payload.phase === "string" ? payload.phase : state.phase,
    };
  }
  if (event === "done") {
    return {
      ...state,
      status: typeof payload.status === "string" ? payload.status : state.status,
      tools: state.tools.map((tool) =>
        tool.status === "running" ? { ...tool, status: "done" as const } : tool,
      ),
    };
  }
  if (event === "reasoning") {
    const delta = typeof payload.text === "string" ? payload.text : "";
    if (!delta) return state;
    const reasoning = state.reasoning + delta;
    return {
      ...state,
      reasoning,
      log: appendReasoning(state.log, reasoning, mintId),
      nextId,
    };
  }
  if (event === "tool_start") {
    const id = typeof payload.id === "string" ? payload.id : "";
    const name = typeof payload.name === "string" ? payload.name : "";
    if (!id || !name || state.tools.some((tool) => tool.id === id)) return state;
    const described = describeToolFromInput(name, {}, narration);
    return {
      ...state,
      tools: [...state.tools, { id, name, status: "running", description: described.description }],
      toolStartedAt: { ...state.toolStartedAt, [id]: now },
      log: appendStep(state.log, described.description, mintId, { toolId: id }),
      nextId,
    };
  }
  if (event === "tool_input") {
    const id = typeof payload.id === "string" ? payload.id : "";
    const name = typeof payload.name === "string" ? payload.name : "";
    if (!id || !name) return state;
    const input = payload.input && typeof payload.input === "object" && !Array.isArray(payload.input)
      ? payload.input as Record<string, unknown>
      : {};
    const described = describeToolFromInput(name, input, narration);
    return {
      ...state,
      tools: state.tools.map((tool) =>
        tool.id === id
          ? { ...tool, description: described.description, ...(described.url ? { url: described.url } : {}) }
          : tool,
      ),
      log: updateStepText(state.log, id, described.description, described.url),
    };
  }
  if (event === "tool_result") {
    const id = typeof payload.id === "string" ? payload.id : "";
    if (!id) return state;
    const isError = payload.isError === true;
    const startedAt = state.toolStartedAt[id];
    return {
      ...state,
      tools: state.tools.map((tool) =>
        tool.id === id
          ? {
              ...tool,
              status: isError ? "retried" as const : "done" as const,
              ...(startedAt != null ? { durationMs: Math.max(0, now - startedAt) } : {}),
              ...(isError && typeof payload.errorMessage === "string"
                ? { errorMessage: payload.errorMessage }
                : {}),
            }
          : tool,
      ),
    };
  }
  if (event === "tool_dropped") {
    const id = typeof payload.id === "string" ? payload.id : "";
    if (!id) return state;
    return {
      ...state,
      tools: state.tools.filter((tool) => tool.id !== id),
      log: removeToolSteps(state.log, id),
    };
  }
  return state;
}

function payloadOf(data: unknown): Record<string, unknown> {
  return data && typeof data === "object" && !Array.isArray(data)
    ? data as Record<string, unknown>
    : {};
}

function isTerminal(status: string | null): boolean {
  return status === "done" || status === "blocked" || status === "abandoned";
}

function waitForRetry(signal: AbortSignal, ms: number): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = window.setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      window.clearTimeout(timer);
      resolve();
    }, { once: true });
  });
}

export function GoalExecutionActivity({
  goalId,
  initialStatus = null,
  enabled = true,
  onStatusChange,
  className,
}: {
  goalId: string;
  initialStatus?: string | null;
  enabled?: boolean;
  onStatusChange?: (status: string) => void;
  className?: string;
}) {
  const t = useT();
  const [state, setState] = useState(() =>
    emptyGoalExecutionActivity(initialStatus),
  );

  useEffect(() => {
    if (state.status) onStatusChange?.(state.status);
  }, [onStatusChange, state.status]);

  useEffect(() => {
    setState(emptyGoalExecutionActivity(initialStatus));
    if (!enabled || !goalId) return;
    const controller = new AbortController();

    void (async () => {
      let terminal = isTerminal(initialStatus);
      let retryMs = 1_000;
      while (!controller.signal.aborted && !terminal) {
        try {
          const response = await authFetch(
            `${API_URL}/api/goals/${encodeURIComponent(goalId)}/stream`,
            { signal: controller.signal },
          );
          if (!response.ok || !response.body) throw new Error("goal_activity_unavailable");
          retryMs = 1_000;
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          const buffer = createSSEBuffer();
          while (!controller.signal.aborted) {
            const { value, done } = await reader.read();
            if (done) break;
            for (const frame of parseSSEStream(decoder.decode(value, { stream: true }), buffer)) {
              const payload = payloadOf(frame.data);
              if (frame.event === "done") terminal = true;
              if (frame.event === "status" && isTerminal(
                typeof payload.status === "string" ? payload.status : null,
              )) terminal = true;
              setState((current) => reduceGoalExecutionActivity(
                current,
                frame.event,
                payload,
                t.chat.toolNarration,
              ));
            }
          }
        } catch {
          if (controller.signal.aborted) break;
        }
        if (!terminal && !controller.signal.aborted) {
          await waitForRetry(controller.signal, retryMs);
          retryMs = Math.min(10_000, retryMs * 2);
        }
      }
    })();

    return () => controller.abort();
  }, [enabled, goalId, initialStatus, t.chat.toolNarration]);

  if (!enabled) return null;
  if (isTerminal(state.status)) {
    const status = state.status as "done" | "blocked" | "abandoned";
    return (
      <p className={cn("text-[11px] font-medium text-muted-foreground", className)}>
        {t.goalsPage.status[status]}
      </p>
    );
  }

  return (
    <div data-testid="goal-execution-activity" className={cn("min-w-0", className)}>
      <ChatActivityFeed
        events={state.log.events}
        tools={state.tools}
        replyStreaming={false}
        startedAt={state.startedAt}
      />
    </div>
  );
}
