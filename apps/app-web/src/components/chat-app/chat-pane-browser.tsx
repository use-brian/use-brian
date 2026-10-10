"use client";

/**
 * The Chat side pane's `browser` tab body (chat-parity T7, D10).
 *
 * - **Desktop** (a shell speaking the pane protocol): an empty slot whose
 *   bounds are reported to the shell, which lays its native browser view
 *   into the rect. The slot reports `null` whenever it is hidden: unmounted
 *   (another tab active, the pane closed, a different chat) or covered by a
 *   modal, because a native view always paints above web content.
 * - **Web** (`computer:<sessionId>`): the cloud browser of that chat's task,
 *   as its latest Take-Over frame, refreshed while the browse runs. When the
 *   browse ends the tab keeps the last frame (D10) and offers Resume (a
 *   paused task) and Open (the full Take-Over view, the explicit way out).
 *
 * [COMP:app-web/chat-side-pane]
 */

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ExternalLink, Loader2, Monitor, Play } from "lucide-react";
import { useT } from "@/lib/i18n/client";
import {
  getComputerFrame,
  getComputerTask,
  resumeComputerTask,
  type ComputerTask,
} from "@/lib/api/computer";
import { desktopBrowserPane, reportBrowserSlot } from "@/lib/desktop-browser-pane";

/** The last frame each chat's browser showed, kept across tab switches (D10). */
const lastFrames = new Map<string, string>();

const FRAME_POLL_MS = 2_000;

/** Is a modal covering the page? A native view would paint over it. */
function modalOpen(): boolean {
  return !!document.querySelector('[role="dialog"]:not([hidden]), [role="alertdialog"]:not([hidden])');
}

function DesktopBrowserSlot({ chatKey }: { chatKey: string | null }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    let frame = 0;
    const report = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const box = element.getBoundingClientRect();
        const hidden = modalOpen() || box.width === 0 || box.height === 0;
        reportBrowserSlot(chatKey, hidden ? null : { x: box.left, y: box.top, width: box.width, height: box.height });
      });
    };
    report();
    const resize = new ResizeObserver(report);
    resize.observe(element);
    const mutations = new MutationObserver(report);
    mutations.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["role", "hidden", "data-open"] });
    window.addEventListener("resize", report);
    window.addEventListener("scroll", report, true);
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      mutations.disconnect();
      window.removeEventListener("resize", report);
      window.removeEventListener("scroll", report, true);
      // Unmounted: another tab, the pane closed, or another chat. Hide it.
      reportBrowserSlot(chatKey, null);
    };
  }, [chatKey]);
  return <div ref={ref} data-browser-slot={chatKey ?? ""} className="min-h-0 flex-1 bg-muted/20" />;
}

function ComputerFrameBody({ workspaceId, sessionId }: { workspaceId: string; sessionId: string }) {
  const t = useT().chatApp.sidePane;
  const router = useRouter();
  const [task, setTask] = useState<ComputerTask | null | undefined>(undefined);
  const [frame, setFrame] = useState<string | null>(() => lastFrames.get(sessionId) ?? null);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      const current = await getComputerTask(sessionId, controller.signal).catch(() => null);
      if (controller.signal.aborted) return;
      setTask(current);
      if (current && (current.status === "running" || current.status === "paused")) {
        const next = await getComputerFrame(sessionId, controller.signal).catch(() => null);
        if (controller.signal.aborted) return;
        if (next) {
          const url = `data:${next.mimeType};base64,${next.data}`;
          lastFrames.set(sessionId, url);
          setFrame(url);
        }
        timer = setTimeout(() => void tick(), FRAME_POLL_MS);
      }
    };
    void tick();
    return () => {
      controller.abort();
      if (timer) clearTimeout(timer);
    };
  }, [sessionId]);

  const status =
    task === undefined ? t.browserConnecting
      : task?.status === "running" ? t.browserLive
        : task?.status === "paused" ? t.browserPaused
          : t.browserEnded;

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-computer-frame={sessionId}>
      <div className="flex shrink-0 items-center gap-2 border-b border-border/70 px-3 py-1.5 text-xs text-muted-foreground">
        <Monitor className="size-3.5 shrink-0" aria-hidden />
        <span className="min-w-0 flex-1 truncate" role="status">{status}</span>
        {task?.status === "paused" && (
          <button
            type="button"
            onClick={() => void resumeComputerTask(sessionId).then(() => setTask({ ...task, status: "running" }))}
            className="inline-flex min-h-11 items-center gap-1.5 rounded-md px-2 hover:bg-muted hover:text-foreground sm:min-h-7"
          >
            <Play className="size-3.5" aria-hidden />
            {t.browserResume}
          </button>
        )}
        <button
          type="button"
          onClick={() => router.push(`/w/${workspaceId}/computer/${encodeURIComponent(sessionId)}`)}
          className="inline-flex min-h-11 items-center gap-1.5 rounded-md px-2 hover:bg-muted hover:text-foreground sm:min-h-7"
        >
          <ExternalLink className="size-3.5" aria-hidden />
          {t.browserOpen}
        </button>
      </div>
      <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-muted/20">
        {frame ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={frame} alt={status} className="h-full w-full object-contain" />
        ) : (
          <p className="inline-flex items-center gap-2 px-6 text-center text-xs text-muted-foreground">
            {task === undefined && <Loader2 className="size-3.5 animate-spin" aria-hidden />}
            {t.browserNoFrame}
          </p>
        )}
      </div>
    </div>
  );
}

/** Pick the body for a `browser` tab on this host. */
export function PaneBrowserBody({
  workspaceId,
  chatKey,
  browserId,
  url,
}: {
  workspaceId: string;
  chatKey: string | null;
  browserId: string;
  url: string | null;
}) {
  const t = useT().chatApp.sidePane;
  if (browserId.startsWith("computer:")) {
    return <ComputerFrameBody workspaceId={workspaceId} sessionId={browserId.slice("computer:".length)} />;
  }
  if (desktopBrowserPane()) return <DesktopBrowserSlot chatKey={chatKey} />;
  // A desktop tab seen from somewhere the shell's browser is not: say so.
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 px-6 text-center text-xs text-muted-foreground">
      <Monitor className="size-5" aria-hidden />
      <p>{t.browserDesktopOnly}</p>
      {url && (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex min-h-11 items-center gap-1.5 rounded-md px-2 text-foreground hover:bg-muted sm:min-h-8"
        >
          <ExternalLink className="size-3.5" aria-hidden />
          {t.openInBrowser}
        </a>
      )}
    </div>
  );
}
