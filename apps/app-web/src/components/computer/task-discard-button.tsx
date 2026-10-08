"use client";

import { useRef, useState } from "react";
import { useT } from "@/lib/i18n/client";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { discardComputerTask } from "@/lib/api/computer";

export function TaskDiscardButton({ sessionId, workspaceId, onDiscarded }: {
  sessionId: string; workspaceId: string; onDiscarded: () => void;
}) {
  const t = useT();
  const busy = useRef(false);
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  async function discard() {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setFailed(false);
    try {
      if (!(await confirmDialog({ title: t.computer.discardConfirmTitle,
        description: t.computer.discardConfirmBody, confirmLabel: t.computer.discardTask }))) return;
      if (await discardComputerTask(sessionId, workspaceId)) onDiscarded();
      else setFailed(true);
    } catch { setFailed(true); }
    finally { busy.current = false; setPending(false); }
  }
  return <div className="flex max-w-sm flex-col gap-2">
    <button type="button" disabled={pending} onClick={() => void discard()}
      className="shrink-0 rounded-md border border-destructive/40 px-3 py-1.5 text-xs font-medium text-destructive hover:bg-destructive/10 disabled:opacity-50 max-sm:min-h-11">
      {pending ? t.computer.discardPending : t.computer.discardTask}
    </button>
    {failed && <p role="alert" className="text-xs text-destructive">{t.computer.discardFailed}</p>}
  </div>;
}
