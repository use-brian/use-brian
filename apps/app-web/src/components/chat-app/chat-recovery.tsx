"use client";

/** Explicit private continuation, never historical permission repair. [COMP:app-web/chat-recovery] */
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { useT } from "@/lib/i18n/client";
import { getUserInfo, subscribeUserInfo } from "@/lib/user";
import { chatRecoveryFailure, inspectChatRecovery, recoverChat, type ChatRecoveryResult } from "@/lib/api/sessions";

export function ChatRecoveryAction({ workspaceId, sessionId, onRecovered }: {
  workspaceId: string; sessionId: string; onRecovered: (result: ChatRecoveryResult) => void;
}) {
  const t = useT().chatApp.recovery;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<{ controller: AbortController; actorId: string | null } | null>(null);
  useEffect(() => {
    setBusy(false); setError(null);
    const unsubscribe = subscribeUserInfo((user) => {
      if (pending.current && (user?.id ?? null) !== pending.current.actorId) {
        pending.current.controller.abort(); pending.current = null; setBusy(false); setError(null);
      }
    });
    return () => { unsubscribe(); pending.current?.controller.abort(); pending.current = null; };
  }, [workspaceId, sessionId]);

  async function recover() {
    if (pending.current) return;
    const owner = { controller: new AbortController(), actorId: getUserInfo()?.id ?? null };
    pending.current = owner;
    setBusy(true); setError(null);
    const current = () => !owner.controller.signal.aborted && pending.current === owner && (getUserInfo()?.id ?? null) === owner.actorId;
    try {
      const preview = await inspectChatRecovery(sessionId, workspaceId, owner.controller.signal);
      if (!current()) return;
      if (preview.status === "busy" && !preview.continuationSessionId) { setError(t.busy); return; }
      const confirmed = await confirmDialog({ signal: owner.controller.signal, title: t.title,
        description: preview.continuationSessionId ? t.existingDescription : t.description,
        confirmLabel: preview.continuationSessionId ? t.openExisting : t.confirm, cancelLabel: t.cancel });
      if (!confirmed || !current()) return;
      const result = await recoverChat(sessionId, workspaceId, preview.revision, owner.controller.signal);
      if (current()) onRecovered(result);
    } catch (failure) {
      if (current()) setError(t[chatRecoveryFailure(failure)]);
    } finally {
      if (pending.current === owner) { pending.current = null; if (!owner.controller.signal.aborted) setBusy(false); }
    }
  }
  return <div className="mt-2 flex flex-wrap items-center gap-2">
    <Button type="button" variant="outline" className="max-sm:min-h-11" disabled={busy} onClick={() => void recover()}>
      {busy ? t.working : t.action}
    </Button>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
  </div>;
}
