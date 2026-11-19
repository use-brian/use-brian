"use client";

/** [COMP:app-web/chat-sessions-cache] Display-only offline authority timestamp. */
import { useEffect } from "react";
import { useLocale, useT } from "@/lib/i18n/client";
import { useIsOffline } from "@/lib/offline/use-offline-sync";
import { CHAT_OFFLINE_AUTHORITY_MS, useRetainedChatHistoryStatus } from "@/lib/offline/chat-history-cache";

export function ChatRetainedHistoryNotice({ sessionId, listSyncedAt, onExpire }: {
  sessionId: string | null; listSyncedAt?: number; onExpire?: () => void;
}) {
  const status = useRetainedChatHistoryStatus(sessionId);
  const offline = useIsOffline(), locale = useLocale(), t = useT().chatApp;
  const syncedAt = status?.syncedAt ?? listSyncedAt;
  const retained = !!status?.retained || offline;
  useEffect(() => {
    if (!retained || syncedAt === undefined || !onExpire) return;
    const timer = setTimeout(onExpire, Math.max(0, syncedAt + CHAT_OFFLINE_AUTHORITY_MS - Date.now()));
    return () => clearTimeout(timer);
  }, [retained, syncedAt, onExpire]);
  if (!retained || syncedAt === undefined || Date.now() - syncedAt >= CHAT_OFFLINE_AUTHORITY_MS) return null;
  return <p role="status" className="px-4 py-1 text-xs text-muted-foreground">
    {t.offlineRetainedHistory.replace("{time}", new Date(syncedAt).toLocaleString(locale))}
  </p>;
}
