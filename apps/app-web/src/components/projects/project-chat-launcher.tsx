"use client";

/**
 * New Project chat audience (D24, project-shared-spaces.md -> "Chats"):
 * shared with the Project's participants by default, with a visible private
 * option before the first message. A shared chat is a Project room (a
 * workspace session bound to the Project; the server labels it with the
 * Project audience). The private option is the existing personal draft.
 * The workspace owner's read oversight cannot start a shared chat.
 * [COMP:app-web/project-shared-journey]
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n/client";
import { createWorkspaceSession } from "@/lib/api/sessions";
import { patchSharedChatSessions } from "@/lib/chat-surface-data";
import { dispatchChatSessionsRefresh } from "@/lib/chat-session-events";

export type ProjectChatAudience = "shared" | "private";

export function ProjectChatLauncher({ workspaceId, projectId, assistantId, audience, onAudience, canShare, disabled }: {
  workspaceId: string;
  projectId: string;
  assistantId: string;
  audience: ProjectChatAudience;
  onAudience: (audience: ProjectChatAudience) => void;
  /** Participants only; oversight and nonparticipants start private chats. */
  canShare: boolean;
  disabled: boolean;
}) {
  const t = useT().contextScope.sharedProjects;
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const effective = canShare ? audience : "private";

  async function startShared() {
    if (busy || disabled) return;
    setBusy(true);
    setError(null);
    try {
      const created = await createWorkspaceSession(workspaceId, assistantId || undefined, { contextGroupId: null, contextProjectId: projectId });
      patchSharedChatSessions(workspaceId, rows => [created, ...rows.filter(r => r.id !== created.id)], { seed: true });
      dispatchChatSessionsRefresh(workspaceId);
      router.push(`/w/${workspaceId}/chat?v=workspace&s=${encodeURIComponent(created.id)}`);
    } catch {
      setError(t.chatFailed);
    } finally { setBusy(false); }
  }

  return <div className="space-y-2">
    <div role="radiogroup" aria-label={t.chatAudience} className="flex flex-wrap gap-1">
      {canShare ? <Button role="radio" aria-checked={effective === "shared"} variant={effective === "shared" ? "secondary" : "ghost"}
        className="max-sm:min-h-11" onClick={() => onAudience("shared")} disabled={disabled}>{t.chatShared}</Button> : null}
      <Button role="radio" aria-checked={effective === "private"} variant={effective === "private" ? "secondary" : "ghost"}
        className="max-sm:min-h-11" onClick={() => onAudience("private")} disabled={disabled}>{t.chatPrivate}</Button>
    </div>
    <p className="text-sm text-muted-foreground">{effective === "shared" ? t.chatSharedHint : t.chatPrivateHint}</p>
    {effective === "shared" ? <Button className="max-sm:min-h-11" disabled={busy || disabled} onClick={() => void startShared()}>{t.chatShared}</Button> : null}
    {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
  </div>;
}
