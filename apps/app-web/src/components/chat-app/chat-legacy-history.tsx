"use client";

/** Owner-only historical display, separate from actionable chat state. [COMP:app-web/chat-legacy-history] */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChatDisplayHistoryRow } from "./chat-display-history";
import { Button } from "@/components/ui/button";
import { useT } from "@/lib/i18n/client";
import { getUserInfo, subscribeUserInfo } from "@/lib/user";
import { readPrivateChatHistory, type PrivateChatHistory } from "@/lib/api/sessions";

export function ChatLegacyHistory({ workspaceId, sessionId, fallback, children }: {
  workspaceId: string; sessionId: string; fallback: string; children: ReactNode;
}) {
  const t = useT().chatApp.legacyHistory;
  const [actor, setActor] = useState(() => getUserInfo()?.id ?? null);
  const key = `${actor}:${workspaceId}:${sessionId}`;
  const [state, setState] = useState<{ key: string; page: PrivateChatHistory | null; loading: boolean; failed: boolean }>(
    { key, page: null, loading: true, failed: false });
  const read = useRef<(more?: boolean) => void>(() => {});
  useEffect(() => subscribeUserInfo(user => setActor(user?.id ?? null)), []);
  useEffect(() => {
    let alive = true, controller: AbortController | null = null;
    let loaded: PrivateChatHistory | null = null, pageCount = 1;
    async function load(more = false) {
      controller?.abort();
      const request = new AbortController(); controller = request;
      const current = () => alive && controller === request && !request.signal.aborted && (getUserInfo()?.id ?? null) === actor;
      setState(previous => ({ key, page: previous.key === key ? previous.page : null, loading: true, failed: false }));
      try {
        const count = more ? 1 : pageCount;
        let after = more ? loaded?.nextSequence ?? 0 : 0;
        let result: PrivateChatHistory | null = null;
        let rows: PrivateChatHistory["rows"] = more ? loaded?.rows ?? [] : [];
        for (let index = 0; index < count; index++) {
          const next = await readPrivateChatHistory(sessionId, workspaceId, after, request.signal);
          if (!current()) return;
          rows = [...rows, ...next.rows];
          result = { ...next, rows };
          if (next.nextSequence === null) break;
          after = next.nextSequence;
        }
        if (!current() || !result) return;
        if (more) pageCount++;
        loaded = result;
        setState({ key, page: result, loading: false, failed: false });
      } catch {
        if (current()) {
          loaded = null; pageCount = 1;
          setState({ key, page: null, loading: false, failed: true });
        }
      }
    }
    read.current = more => void load(more);
    const refresh = () => { if (document.visibilityState === "visible") void load(); };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    const interval = window.setInterval(refresh, 60_000);
    void load();
    return () => {
      alive = false; controller?.abort(); read.current = () => {};
      window.clearInterval(interval); window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [actor, key, sessionId, workspaceId]);
  const visible = state.key === key ? state : null;
  return <section aria-label={t.title} className="space-y-4 text-sm text-foreground">
    {visible?.page ? <>
      {visible.page.rows.map(row => <ChatDisplayHistoryRow key={row.id} row={row} />)}
      {visible.page.nextSequence !== null && <Button variant="outline" className="max-sm:min-h-11" disabled={visible.loading}
        onClick={() => read.current(true)}>{t.more}</Button>}
    </> : visible?.failed ? <p role="alert" className="text-destructive">{fallback}</p>
      : <p role="status" className="text-muted-foreground">{t.loading}</p>}
    {visible?.failed && <Button variant="outline" className="max-sm:min-h-11" onClick={() => read.current()}>{t.retry}</Button>}
    {children}
  </section>;
}
