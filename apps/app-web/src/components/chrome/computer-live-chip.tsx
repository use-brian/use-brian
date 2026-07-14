"use client";

/**
 * Persistent live-browser affordance for the chat composer.
 *
 * When the chat session has an active cloud computer task, a pulsing chip
 * renders above the composer linking into the Take-Over live view
 * (`/w/[workspaceId]/computer/[sessionId]`) so the user can watch the
 * assistant browse or take over (e.g. to sign in) at any moment - the
 * Manus-style always-there window into what the browser is doing.
 *
 * Presence is PROBED, never model-relayed: once a browser tool shows up in
 * the turn's tool timeline (or a restored message's receipt), the chip polls
 * `GET /api/computer/tasks/:sessionId` and shows while a task is running or
 * paused. The tool-result link (`tools.ts` navigate) still exists for
 * channel surfaces (Telegram/Slack) that have no chrome to hang a chip on;
 * this component is the web chat's guaranteed path - no regex or model
 * phrasing in the loop.
 *
 * [COMP:app-web/computer-live-chip] - spec: docs/architecture/engine/computer-use.md §5.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { Eye } from "lucide-react";
import { useT } from "@/lib/i18n/client";
import { getComputerTask } from "@/lib/api/computer";

/** Browser-driving tool names that imply a cloud task may exist. */
export function isBrowserToolName(name: string): boolean {
  return /^browser[A-Z]/.test(name) || name === "runBrowserSkill";
}

const POLL_MS = 15_000;

/** Pure chip render - exported for SSR tests; presence logic lives in the wrapper. */
export function ComputerLiveChipView({
  workspaceId,
  sessionId,
}: {
  workspaceId: string;
  sessionId: string;
}) {
  const t = useT();
  return (
    <div className="mb-2 flex items-center gap-2 rounded-md border border-primary/30 bg-primary/5 px-2.5 py-1.5 text-[11px]">
      <span aria-hidden className="claw-blink size-1.5 shrink-0 rounded-full bg-primary" />
      <span className="min-w-0 flex-1 truncate text-foreground">
        {t.computer.liveChip.active}
      </span>
      <Link
        href={`/w/${workspaceId}/computer/${encodeURIComponent(sessionId)}`}
        className="inline-flex shrink-0 items-center gap-1 rounded-md bg-primary/10 px-2 py-0.5 font-medium text-primary hover:bg-primary/20"
      >
        <Eye className="size-3" aria-hidden />
        {t.computer.liveChip.watch}
      </Link>
    </div>
  );
}

/**
 * Probing wrapper: renders the chip while the session's cloud task is alive.
 * `browserToolSeen` keeps the poll off pure-text chats - it only ever flips
 * true after a browser tool appeared in this session's activity.
 */
export function ComputerLiveChip({
  workspaceId,
  sessionId,
  browserToolSeen,
}: {
  workspaceId: string;
  sessionId: string | null;
  browserToolSeen: boolean;
}) {
  const [active, setActive] = useState(false);

  useEffect(() => {
    if (!sessionId || !browserToolSeen) {
      setActive(false);
      return;
    }
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const probe = async () => {
      const task = await getComputerTask(sessionId).catch(() => null);
      if (cancelled) return;
      setActive(!!task && (task.status === "running" || task.status === "paused"));
      timer = setTimeout(() => void probe(), POLL_MS);
    };
    void probe();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [sessionId, browserToolSeen]);

  if (!active || !sessionId) return null;
  return <ComputerLiveChipView workspaceId={workspaceId} sessionId={sessionId} />;
}
