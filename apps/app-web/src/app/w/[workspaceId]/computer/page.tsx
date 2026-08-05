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
import { openWorkspaceSettings } from "@/components/settings-modal/settings-modal";
import { BROWSER_EXTENSION_INSTALL_URL } from "@/lib/browser-extension-bridge";
import { useT } from "@/lib/i18n/client";
import {
  listActiveComputerTasks,
  mostRecentComputerTask,
} from "@/lib/api/computer";

const POLL_MS = 2_000;

/** Persistent getting-started copy for the no-live-session state. */
export function BrowsersEmptyState() {
  const t = useT().computer.sessions;

  return (
    <div className="flex h-full flex-col items-center justify-center gap-5 p-8 text-center">
      <MonitorPlay className="size-8 text-muted-foreground/50" aria-hidden />
      <div className="max-w-sm space-y-1">
        <p className="text-sm font-medium text-foreground">{t.selectTitle}</p>
        <p className="text-xs text-muted-foreground">{t.selectHint}</p>
      </div>
      <div className="w-full max-w-sm rounded-lg border border-border bg-muted/30 px-4 py-3">
        <p className="text-xs font-medium text-foreground">{t.connectTitle}</p>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          {t.connectHint}
        </p>
        <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
          <a
            href={BROWSER_EXTENSION_INSTALL_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex h-8 items-center justify-center rounded-md bg-action px-3 text-xs font-medium text-action-foreground transition-colors hover:bg-action/90"
          >
            {t.installAction}
          </a>
          <button
            type="button"
            onClick={() => openWorkspaceSettings("ws-browser-profiles")}
            className="inline-flex h-8 items-center justify-center rounded-md border border-border bg-background px-3 text-xs font-medium text-foreground transition-colors hover:bg-accent"
          >
            {t.connectAction}
          </button>
        </div>
      </div>
    </div>
  );
}

export default function BrowsersIndexPage(props: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = usePromise(props.params);
  const router = useRouter();

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

  return <BrowsersEmptyState />;
}
