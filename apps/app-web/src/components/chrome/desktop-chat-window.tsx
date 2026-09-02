"use client";

import { useEffect, useLayoutEffect } from "react";
import { FloatingChat } from "@/components/chrome/floating-chat";
import type { ChatActivity } from "@/components/chrome/floating-chat";
import {
  PrimaryAssistantProvider,
  usePrimaryAssistant,
} from "@/contexts/primary-assistant";
import { desktopBridge } from "@/lib/desktop-auth-source";
import { useT } from "@/lib/i18n/client";

/** Chat-only renderer hosted by the companion's dedicated Electron window. */
export function DesktopChatWindow({
  workspaceId,
  initialPrompt,
}: {
  workspaceId: string;
  initialPrompt?: string;
}) {
  return (
    <PrimaryAssistantProvider workspaceId={workspaceId}>
      <DesktopChatContent workspaceId={workspaceId} initialPrompt={initialPrompt} />
    </PrimaryAssistantProvider>
  );
}

function DesktopChatContent({
  workspaceId,
  initialPrompt,
}: {
  workspaceId: string;
  initialPrompt?: string;
}) {
  const { assistantId } = usePrimaryAssistant();
  const t = useT().chat;

  useLayoutEffect(() => {
    const elements = [document.documentElement, document.body];
    const previous = elements.map((element) => ({
      value: element.style.getPropertyValue("background-color"),
      priority: element.style.getPropertyPriority("background-color"),
    }));
    for (const element of elements) {
      element.style.setProperty("background-color", "transparent", "important");
    }
    return () => {
      elements.forEach((element, index) => {
        const prior = previous[index];
        if (prior?.value) {
          element.style.setProperty("background-color", prior.value, prior.priority);
        } else {
          element.style.removeProperty("background-color");
        }
      });
    };
  }, []);

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
      <section className="h-full overflow-hidden rounded-2xl border border-border bg-background">
        {assistantId ? (
          <FloatingChat
            workspaceId={workspaceId}
            assistantId={assistantId}
            mode="side-panel"
            origin="doc"
            messageBrianRequest={1}
            seedRequest={
              initialPrompt
                ? { prefill: initialPrompt, autoSend: true, nonce: 1 }
                : undefined
            }
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
