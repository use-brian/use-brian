"use client";

/**
 * Browsers surface index (`/w/[id]/computer`) — the full-width prompt shown
 * when no session is selected and no task is live. If a task is available,
 * opening the Browsers app routes directly to the most recently active live
 * session; the sidebar still lets the user switch between multiple sessions.
 *
 * [COMP:app-web/browsers-surface]
 */

import { use as usePromise, useEffect } from "react";
import { useRouter } from "next/navigation";
import { MonitorPlay } from "lucide-react";
import { useT } from "@/lib/i18n/client";
import {
  listActiveComputerTasks,
  mostRecentComputerTask,
} from "@/lib/api/computer";

const POLL_MS = 2_000;

export default function BrowsersIndexPage(props: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = usePromise(props.params);
  const router = useRouter();
  const t = useT().computer.sessions;

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const probe = async () => {
      const tasks = await listActiveComputerTasks(workspaceId);
      const task = mostRecentComputerTask(tasks);
      if (!cancelled && task) {
        router.replace(
          `/w/${workspaceId}/computer/${encodeURIComponent(task.sessionId)}`,
        );
        return;
      }
      if (!cancelled) timer = setTimeout(() => void probe(), POLL_MS);
    };
    void probe();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [router, workspaceId]);

  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
      <MonitorPlay className="size-8 text-muted-foreground/50" aria-hidden />
      <div className="max-w-sm space-y-1">
        <p className="text-sm font-medium text-foreground">{t.selectTitle}</p>
        <p className="text-xs text-muted-foreground">{t.selectHint}</p>
      </div>
    </div>
  );
}
