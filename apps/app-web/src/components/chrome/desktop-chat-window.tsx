"use client";

import { FloatingChat } from "@/components/chrome/floating-chat";
import {
  PrimaryAssistantProvider,
  usePrimaryAssistant,
} from "@/contexts/primary-assistant";

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

  return (
    <main className="h-dvh w-full overflow-hidden bg-background">
      {assistantId ? (
        <FloatingChat
          workspaceId={workspaceId}
          assistantId={assistantId}
          mode="side-panel"
          origin="doc"
          messageBrianRequest={1}
        />
      ) : null}
    </main>
  );
}
