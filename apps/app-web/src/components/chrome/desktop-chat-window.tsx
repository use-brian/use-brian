"use client";

import { useEffect } from "react";
import { FloatingChat } from "@/components/chrome/floating-chat";
import type { ChatActivity } from "@/components/chrome/floating-chat";
import {
  PrimaryAssistantProvider,
  usePrimaryAssistant,
} from "@/contexts/primary-assistant";
import { desktopBridge } from "@/lib/desktop-auth-source";
import { useT } from "@/lib/i18n/client";

/** Chat-only renderer hosted by the companion's dedicated Electron window. */
export function DesktopChatWindow({ workspaceId }: { workspaceId: string }) {
  return (
    <PrimaryAssistantProvider workspaceId={workspaceId}>
      <DesktopChatContent workspaceId={workspaceId} />
    </PrimaryAssistantProvider>
  );
}

function DesktopChatContent({ workspaceId }: { workspaceId: string }) {
  const { assistantId } = usePrimaryAssistant();
  const t = useT().chat;

  useEffect(() => {
    if (!assistantId) desktopBridge()?.setCompanionState?.({ phase: "loading" });
    return () => desktopBridge()?.setCompanionState?.({ phase: "idle" });
  }, [assistantId]);

  const mirrorActivity = (activity: ChatActivity) => {
    const label =
      activity.phase === "action-required"
        ? t.pendingQuestion.heading
        : activity.phase === "thinking"
          ? (activity.activeTool?.description ?? t.thinking)
          : activity.phase === "loading"
            ? t.pendingQuestion.resuming
            : undefined;
    desktopBridge()?.setCompanionState?.({ phase: activity.phase, ...(label ? { label } : {}) });
  };

  return (
    <main className="relative h-dvh w-full overflow-hidden bg-transparent py-2 pr-4">
      <section className="h-full overflow-hidden rounded-2xl border border-border bg-background shadow-2xl">
        {assistantId ? (
          <FloatingChat
            workspaceId={workspaceId}
            assistantId={assistantId}
            mode="side-panel"
            origin="doc"
            messageBrianRequest={1}
            onActivityChange={mirrorActivity}
          />
        ) : null}
      </section>
      <span
        aria-hidden
        className="absolute bottom-16 right-1 size-6 rotate-45 border-r border-t border-border bg-background"
      />
    </main>
  );
}
