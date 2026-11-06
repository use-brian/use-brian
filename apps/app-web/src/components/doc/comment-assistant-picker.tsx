"use client";

import { useEffect, useState } from "react";
import { listWorkspaceAssistants, type WorkspaceAssistantSummary } from "@/lib/api/views";
import { ASSISTANT_REFRESH_EVENT, type AssistantRefreshDetail } from "@/lib/assistant-events";
import { readActiveAssistantId, resolveDraftAssistantId, writeActiveAssistantId } from "@/lib/active-assistant";
import { useT } from "@/lib/i18n/client";
import { AssistantAvatar } from "@/components/assistant-avatar";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";

/** [COMP:app-web/comment-assistant-picker] Shared Page comment voice choice. */
export function useCommentAssistant(workspaceId: string, primary?: string) {
  const [snapshot, setSnapshot] = useState<{ workspaceId: string; rows: WorkspaceAssistantSummary[] }>({ workspaceId, rows: [] });
  const roster = snapshot.workspaceId === workspaceId ? snapshot.rows : [];
  const [pick, setPick] = useState(() => ({ workspaceId, id: readActiveAssistantId(workspaceId) }));
  useEffect(() => {
    if (!primary) return;
    let disposed = false;
    let revision = 0;
    const reload = async () => {
      const request = ++revision;
      try {
        const rows = await listWorkspaceAssistants(workspaceId);
        if (!disposed && request === revision) setSnapshot({ workspaceId, rows });
      } catch { /* A roster failure cannot broaden authority; sends still require admission. */ }
    };
    const refresh = (event: Event) => {
      const detail = (event as CustomEvent<AssistantRefreshDetail>).detail;
      if (!detail?.workspaceId || detail.workspaceId === workspaceId) void reload();
    };
    void reload();
    window.addEventListener(ASSISTANT_REFRESH_EVENT, refresh);
    return () => { disposed = true; window.removeEventListener(ASSISTANT_REFRESH_EVENT, refresh); };
  }, [workspaceId, primary]);
  const selectedId = resolveDraftAssistantId({
    persisted: pick.workspaceId === workspaceId ? pick.id : readActiveAssistantId(workspaceId),
    primary: primary ?? null,
    roster,
  });
  const choose = (id: string) => {
    if (!roster.some(row => row.id === id)) return;
    setPick({ workspaceId, id });
    writeActiveAssistantId(workspaceId, id);
  };
  return { roster, selectedId, selected: roster.find(row => row.id === selectedId), choose };
}

export function CommentAssistantPicker({ roster, selectedId, onSelect, disabled }: {
  roster: WorkspaceAssistantSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  disabled?: boolean;
}) {
  const t = useT().docPage.landing;
  const selected = roster.find(row => row.id === selectedId);
  if (roster.length < 2 || !selected) return null;
  return (
    <Select value={selected.id} onValueChange={value => { if (value) onSelect(value); }} disabled={disabled}>
      <SelectTrigger aria-label={t.assistantLabel} className="min-h-11 min-w-0 max-w-40 gap-1.5 border-0 bg-transparent px-1.5 py-1 text-xs text-muted-foreground shadow-none md:min-h-7">
        <span aria-hidden><AssistantAvatar id={selected.id} name={selected.name} iconSeed={selected.iconSeed ?? undefined} size="sm" /></span>
        <span className="truncate">{selected.name}</span>
      </SelectTrigger>
      <SelectContent side="bottom" align="start" alignItemWithTrigger={false} className="w-60 max-w-[calc(100vw-2rem)]">
        {roster.map(row => <SelectItem key={row.id} value={row.id} className="min-h-11 md:min-h-8">{row.name}</SelectItem>)}
      </SelectContent>
    </Select>
  );
}
