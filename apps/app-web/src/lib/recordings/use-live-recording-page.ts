"use client";

/** Pre-flight destination selection plus sequential live-window streaming. */

import { createElement, useCallback, useRef } from "react";
import { useRouter } from "next/navigation";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import {
  LIVE_NEW_ROOT,
  LiveRecordingPicker,
  liveNewUnder,
  liveUseExisting,
} from "@/components/recordings/live-recording-picker";
import { useT } from "@/lib/i18n/client";
import { listViews } from "@/lib/api/views";
import {
  startLiveRecordingPage,
  streamLiveRecordingWindow,
  type LiveRecordingPage,
} from "@/lib/api/recordings";
import { dispatchLiveTranscriptWindow } from "@/lib/recordings/live-transcript-events";
import { docPagePath } from "@/lib/doc-page-url";
import type { SearchableSelectItem } from "@/components/ui/searchable-select";

export type LiveWindow = {
  blob: Blob;
  mime: string;
  startMs: number;
  endMs: number;
};

export function decodeLiveDestination(value: string): {
  destination: "new" | "existing";
  pageId?: string;
  parentPageId?: string | null;
} {
  if (value.startsWith("existing:")) {
    return { destination: "existing", pageId: value.slice("existing:".length) };
  }
  if (value.startsWith("new:") && value !== LIVE_NEW_ROOT) {
    return { destination: "new", parentPageId: value.slice("new:".length) };
  }
  return { destination: "new", parentPageId: null };
}

export function useLiveRecordingPage(workspaceId: string, assistantId: string) {
  const t = useT().recorder;
  const router = useRouter();
  const currentRef = useRef<LiveRecordingPage | null>(null);
  const failedWindowsRef = useRef(0);

  const prepare = useCallback(async (): Promise<LiveRecordingPage | null> => {
    const pages = await listViews({ workspaceId, state: "saved" }).catch(() => []);
    const items: SearchableSelectItem[] = [
      { value: LIVE_NEW_ROOT, label: t.liveNewRoot },
      ...pages.map((page) => ({
        value: liveNewUnder(page.id),
        label: t.liveNewUnder.replace("{page}", page.name),
      })),
      ...pages.map((page) => ({
        value: liveUseExisting(page.id),
        label: t.liveUseExisting.replace("{page}", page.name),
      })),
    ];
    let choice = LIVE_NEW_ROOT;
    const confirmed = await confirmDialog({
      title: t.liveConfirmTitle,
      description: t.liveConfirmBody,
      confirmLabel: t.liveConfirmAction,
      content: createElement(LiveRecordingPicker, {
        items,
        initial: choice,
        onChange: (value: string) => {
          choice = value;
        },
      }),
    });
    if (!confirmed) return null;
    const page = await startLiveRecordingPage({
      workspaceId,
      ...decodeLiveDestination(choice),
    });
    currentRef.current = page;
    failedWindowsRef.current = 0;
    // The sidebar lists only refetch on their own mutation handlers plus this
    // bus — a page created server-side by /live/start is otherwise invisible
    // until the user navigates away and back (the mount-only-fetch trap,
    // realtime-sync.md). Same event the chat-created-draft path fires.
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent("doc:draft-created"));
    }
    router.push(docPagePath(workspaceId, page.pageId));
    return page;
  }, [router, t, workspaceId]);

  const streamWindow = useCallback(async (win: LiveWindow): Promise<void> => {
    const page = currentRef.current;
    if (!page) return;
    const missedBefore = failedWindowsRef.current;
    try {
      if (win.blob.size === 0) throw new Error("empty live window")
      const chunkId = crypto.randomUUID();
      const result = await streamLiveRecordingWindow({
        workspaceId,
        assistantId,
        page,
        chunkId,
        missedWindows: missedBefore,
        ...win,
      });
      failedWindowsRef.current = 0;
      // Same-tab pane append (other tabs converge via the pane's poll).
      if (!result.duplicate) {
        dispatchLiveTranscriptWindow({
          pageId: page.pageId,
          chunkId,
          offsetMs: win.startMs,
          durationMs: win.endMs - win.startMs,
          missedBefore,
          lines: result.lines ?? (result.transcript ? [{ speaker: null, text: result.transcript }] : []),
        });
      }
    } catch {
      // Window failures are isolated. The durable local recording continues,
      // and the next independently-decodable window still gets a chance.
      failedWindowsRef.current += 1;
    }
  }, [assistantId, workspaceId]);

  return { prepare, streamWindow };
}
