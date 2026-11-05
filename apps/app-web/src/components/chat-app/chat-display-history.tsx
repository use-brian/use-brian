"use client";

/** Human display only; never an input to the chat reducer or transcript cache. [COMP:app-web/chat-display-history] */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ChatMarkdown } from "@use-brian/chat-ui";
import remarkGfm from "remark-gfm";
import { ChatPaneLink } from "./chat-link-routing";
import { formatTranscriptTime, type TranscriptRowMeta } from "./chat-transcript";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/skeleton";
import { useLocale, useT } from "@/lib/i18n/client";
import { getUserInfo, subscribeUserInfo } from "@/lib/user";
import { CHAT_SESSIONS_REFRESH_EVENT } from "@/lib/chat-session-events";
import { BRAIN_REFRESH_EVENT } from "@/lib/brain-events";
import { ASSISTANT_REFRESH_EVENT } from "@/lib/assistant-events";
import { WORKSPACE_IDENTITY_REFRESH_EVENT } from "@/lib/workspace-identity-events";
import { readPersonalDisplayHistory, type PersonalDisplayHistory } from "@/lib/api/sessions";

type DisplayRow = PersonalDisplayHistory["rows"][number];
type CanonicalRow = { id: string; timestamp: Date };
export type DisplayTimelineEntry<T> = { historicalDisplayOnly: false; message: T; canonicalIndex: number }
  | { historicalDisplayOnly: true; row: DisplayRow };

/** Canonical objects and their action indexes stay intact. Only the render timeline gains inert rows. */
export function mergeDisplayTimeline<T extends CanonicalRow>(canonical: readonly T[], history: readonly DisplayRow[], admittedIds: ReadonlySet<string> = new Set()): DisplayTimelineEntry<T>[] {
  const canonicalIds = new Set([...admittedIds, ...canonical.map(row => row.id)]);
  const sequences = new Map(history.map(row => [row.id, row.sequence]));
  const missing = history.filter(row => !canonicalIds.has(row.id)).toSorted((a, b) => a.sequence - b.sequence);
  const result: DisplayTimelineEntry<T>[] = [];
  let cursor = 0;
  canonical.forEach((message, canonicalIndex) => {
    const sequence = sequences.get(message.id);
    while (cursor < missing.length && (sequence !== undefined ? missing[cursor].sequence < sequence
      : new Date(missing[cursor].timestamp).getTime() <= message.timestamp.getTime())) {
      result.push({ historicalDisplayOnly: true, row: missing[cursor++] });
    }
    result.push({ historicalDisplayOnly: false, message, canonicalIndex });
  });
  for (; cursor < missing.length; cursor++) result.push({ historicalDisplayOnly: true, row: missing[cursor] });
  return result;
}

export function usePersonalDisplayHistory(workspaceId: string, sessionId: string | null, enabled: boolean) {
  const [actor, setActor] = useState(() => getUserInfo()?.id ?? null);
  const key = JSON.stringify([actor, workspaceId, sessionId, enabled]);
  const [state, setState] = useState<{ key: string; page: PersonalDisplayHistory | null; loading: boolean; failed: boolean } | null>(null);
  const commands = useRef({ refresh: () => {}, more: () => {}, invalidate: () => {} });
  useEffect(() => subscribeUserInfo(user => setActor(user?.id ?? null)), []);
  useEffect(() => {
    if (!enabled || !actor || !sessionId) { commands.current = { refresh: () => {}, more: () => {}, invalidate: () => {} }; return; }
    let alive = true, controller: AbortController | null = null;
    let loaded: PersonalDisplayHistory | null = null, pageCount = 1;
    async function load(more = false) {
      controller?.abort();
      const request = new AbortController(); controller = request;
      const current = () => alive && controller === request && !request.signal.aborted && (getUserInfo()?.id ?? null) === actor;
      setState({ key, page: loaded, loading: true, failed: false });
      try {
        let rows = more ? loaded?.rows ?? [] : [];
        let after = more ? loaded?.nextSequence ?? 0 : 0;
        let result: PersonalDisplayHistory | null = null;
        for (let count = 0; count < (more ? 1 : pageCount); count++) {
          const page = await readPersonalDisplayHistory(sessionId!, workspaceId, after, request.signal);
          if (!current()) return;
          const priorIds = new Set(rows.map(row => row.id));
          if (page.rows.some(row => priorIds.has(row.id))) throw new Error("personal_display_history_duplicate");
          rows = [...rows, ...page.rows]; result = { ...page, rows };
          if (page.nextSequence === null) break;
          after = page.nextSequence;
        }
        if (!current() || !result) return;
        if (more) pageCount++;
        loaded = result; setState({ key, page: result, loading: false, failed: false });
      } catch {
        if (!current()) return;
        loaded = null; pageCount = 1;
        setState({ key, page: null, loading: false, failed: true });
      }
    }
    commands.current = {
      refresh: () => void load(), more: () => void load(true),
      invalidate: () => { controller?.abort(); loaded = null; pageCount = 1; setState({ key, page: null, loading: false, failed: true }); },
    };
    const refresh = () => { if (document.visibilityState === "visible") void load(); };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    const refreshEvents = [CHAT_SESSIONS_REFRESH_EVENT, BRAIN_REFRESH_EVENT, ASSISTANT_REFRESH_EVENT, WORKSPACE_IDENTITY_REFRESH_EVENT];
    const invalidated = (event: Event) => {
      const detail = (event as CustomEvent<{ workspaceId?: string | null }>).detail;
      if (detail?.workspaceId && detail.workspaceId !== workspaceId) return;
      loaded = null;
      void load();
    };
    for (const event of refreshEvents) window.addEventListener(event, invalidated);
    void load();
    return () => {
      alive = false; controller?.abort(); commands.current = { refresh: () => {}, more: () => {}, invalidate: () => {} };
      window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh);
      for (const event of refreshEvents) window.removeEventListener(event, invalidated);
    };
  }, [actor, key, enabled, sessionId, workspaceId]);
  const current = enabled && actor && state?.key === key ? state : null;
  const refresh = useCallback(() => commands.current.refresh(), []);
  const more = useCallback(() => commands.current.more(), []);
  const invalidate = useCallback(() => commands.current.invalidate(), []);
  return { rows: current?.page?.rows ?? [], hasPage: !!current?.page, loading: !!enabled && !!actor && (!current || current.loading),
    failed: !!current?.failed, hasMore: current?.page?.nextSequence != null, refresh, more, invalidate };
}

/** Ordinary transcript presentation without a message-id selector or semantic
 * actions: displaying a published utterance does not admit it as new evidence. */
const HISTORY_MARKDOWN_COMPONENTS = {
  a: ChatPaneLink,
  // Historical Markdown must not automatically fetch remote image URLs.
  img: ({ alt }: { alt?: string }) => <span>{alt}</span>,
};
const HISTORY_REMARK_PLUGINS = [remarkGfm];
export function ChatDisplayHistoryRow({ row, avatar, authorName, meta }: {
  row: DisplayRow; avatar?: ReactNode; authorName?: string; meta?: TranscriptRowMeta;
}) {
  const t = useT().chatApp;
  const locale = useLocale();
  const date = new Date(row.timestamp);
  const human = row.role === "user";
  const header = (meta?.startsGroup ?? true) && <span className="mb-0.5 flex flex-wrap items-baseline gap-1.5 text-xs text-muted-foreground">
    <span className="font-medium">{authorName ?? (human ? t.legacyHistory.you : t.legacyHistory.assistant)}</span>
    {Number.isFinite(date.getTime()) && <time dateTime={row.timestamp} title={date.toLocaleString(locale)}>{formatTranscriptTime(date, locale)}</time>}
  </span>;
  const text = row.available ? row.text : t.displayHistory.unavailableMessage;
  return <article data-historical-display-only="true"
    className={`${human ? "flex flex-col items-end" : "flex gap-2.5"}${meta && !meta.startsGroup ? " -mt-3.5" : ""}`}>
    {human ? <>{header}<div data-brian-chat-user className="max-w-[85%] rounded-2xl rounded-br-md bg-secondary px-3.5 py-2 text-[16px] @[560px]/chat-reading:text-[15px] leading-[1.5] [overflow-wrap:anywhere] whitespace-pre-wrap text-secondary-foreground shadow-sm">{text}</div></>
      : <>{avatar}<div className="min-w-0 flex-1 space-y-2.5 pt-0.5">{header}
        <div data-brian-chat-answer className="chat-markdown prose prose-sm dark:prose-invert max-w-none text-[16px] @[560px]/chat-reading:text-[15px] leading-[1.65] text-foreground [overflow-wrap:anywhere]">
          <ChatMarkdown text={text ?? ""} components={HISTORY_MARKDOWN_COMPONENTS} remarkPlugins={HISTORY_REMARK_PLUGINS} />
        </div>
      </div></>}
  </article>;
}

export function ChatDisplayHistoryStatus({ history }: {
  history: ReturnType<typeof usePersonalDisplayHistory>;
}) {
  const t = useT().chatApp.displayHistory;
  return <>
    {history.loading && !history.hasPage && <div aria-hidden data-testid="chat-display-history-skeleton" className="space-y-2"><Skeleton className="h-4 w-3/4" /><Skeleton className="h-4 w-1/2" /></div>}
    {history.failed && <div className="space-y-2"><p role="alert" className="text-sm text-muted-foreground">{t.failed}</p>
      <Button variant="outline" className="max-sm:min-h-11" onClick={history.refresh}>{t.retry}</Button></div>}
    {history.hasMore && <Button variant="outline" className="max-sm:min-h-11" disabled={history.loading} onClick={history.more}>{t.more}</Button>}
  </>;
}
