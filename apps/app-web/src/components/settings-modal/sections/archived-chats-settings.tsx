"use client";

/** [COMP:app-web/settings-chat-archive] Settings → Privacy archive manager. */
import { useState } from "react";
import Link from "next/link";
import { Dialog } from "@base-ui/react/dialog";
import { ArchiveRestore, LoaderCircle, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tooltip } from "@/components/ui/tooltip";
import { Skeleton } from "@/components/skeleton";
import { useT, useLocale } from "@/lib/i18n/client";
import { useWorkspaceContext } from "@/lib/workspace-context";
import { requestSidebarClose } from "@/lib/sidebar-close";
import { setChatSessionArchived, useArchivedChatSessionsData } from "@/lib/chat-surface-data";
import type { DocSession } from "@/lib/api/sessions";

export function ArchivedChatsSettings({ onOpenChat }: { onOpenChat?: () => void }) {
  const t = useT().chatApp;
  const { workspaceId } = useWorkspaceContext();
  const [openWorkspace, setOpenWorkspace] = useState<string | null>(null);
  const [audience, setAudience] = useState<"personal" | "workspace">("personal");
  const open = openWorkspace === workspaceId;
  const close = () => setOpenWorkspace(null);

  return <>
    <div className="flex items-center justify-between gap-4 border-t border-border pt-6">
      <div className="min-w-0">
        <h3 className="text-sm font-medium">{t.archivedChats}</h3>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{t.archiveSettingsDescription}</p>
      </div>
      <Button variant="outline" className="min-h-11 shrink-0 sm:min-h-9" onClick={() => {
        setAudience("personal");
        setOpenWorkspace(workspaceId);
      }}>{t.archiveManage}</Button>
    </div>
    <Dialog.Root open={open} onOpenChange={next => { if (!next) close(); }}>
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-[60] bg-background/70 backdrop-blur-sm" />
        <Dialog.Popup
          className="fixed inset-0 z-[60] flex h-[100dvh] w-full flex-col overflow-hidden border border-border bg-background shadow-2xl sm:inset-auto sm:left-1/2 sm:top-1/2 sm:h-[min(36rem,calc(100dvh-3rem))] sm:w-[calc(100%-3rem)] sm:max-w-2xl sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-2xl"
          onKeyDown={event => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              close();
            }
          }}>
          <div className="relative shrink-0 border-b border-border px-5 pb-4 pt-5 pr-16">
            <Dialog.Title className="text-lg font-semibold">{t.archivedChats}</Dialog.Title>
            <Dialog.Description className="mt-1 text-sm text-muted-foreground">{t.archiveManagerDescription}</Dialog.Description>
            <Dialog.Close aria-label={t.archiveClose} className="absolute right-3 top-3 flex size-11 items-center justify-center rounded-md text-muted-foreground hover:bg-accent">
              <X className="size-4" aria-hidden />
            </Dialog.Close>
          </div>
          <div role="group" aria-label={t.archivedChats} className="flex shrink-0 gap-1 border-b border-border px-5 py-3">
            {(["personal", "workspace"] as const).map(value => <Button key={value}
              variant={value === audience ? "secondary" : "ghost"} aria-pressed={value === audience}
              className="min-h-11 sm:min-h-9" onClick={() => setAudience(value)}>
              {value === "personal" ? t.viewPersonal : t.viewWorkspace}
            </Button>)}
          </div>
          {open && <ArchivedChatList key={`${workspaceId}:${audience}`} workspaceId={workspaceId} audience={audience} onOpenChat={() => {
            close();
            requestSidebarClose();
            onOpenChat?.();
          }} />}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  </>;
}

function ArchivedChatList({ workspaceId, audience, onOpenChat }: {
  workspaceId: string; audience: "personal" | "workspace"; onOpenChat: () => void;
}) {
  const t = useT().chatApp;
  const locale = useLocale();
  const rows = useArchivedChatSessionsData(workspaceId, audience, true);
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const unarchive = async (row: DocSession) => {
    if (working) return;
    setWorking(row.id);
    setError(null);
    try {
      await setChatSessionArchived(workspaceId, audience, row, false);
    } catch {
      setError(t.restoreFailed);
    } finally {
      setWorking(null);
    }
  };

  return <div className="min-h-0 flex-1 overflow-y-auto px-5 py-2" aria-busy={rows.loading}>
    {rows.loading && <div aria-hidden className="space-y-6 py-5">{[0, 1, 2].map(i => <Skeleton key={i} className="h-4 w-2/3" />)}</div>}
    {Boolean(rows.error) && <div role="alert" className="py-4 text-sm text-destructive">
      <p>{t.archiveLoadFailed}</p>
      <Button variant="ghost" className="mt-2 max-sm:min-h-11" onClick={() => void rows.refresh()}>{t.archiveRetry}</Button>
    </div>}
    {error && <p role="alert" className="py-3 text-sm text-destructive">{error}</p>}
    {!rows.error && rows.data?.length === 0 && <p className="py-10 text-center text-sm text-muted-foreground">{t.archiveEmpty}</p>}
    <ul className="divide-y divide-border">
      {rows.data?.map(row => {
        const date = new Date(row.lastActive);
        const dateLabel = Number.isFinite(date.getTime()) ? date.toLocaleDateString(locale, { month: "short", day: "numeric", year: "numeric" }) : null;
        return <li key={row.id} className="flex min-h-16 items-center gap-3 py-2">
          <div className="min-w-0 flex-1">
            <Link href={`/w/${workspaceId}/chat?${audience === "workspace" ? "v=workspace&" : ""}s=${encodeURIComponent(row.id)}`}
              onClick={onOpenChat} className="flex min-h-11 min-w-0 items-center rounded text-sm font-medium hover:underline sm:min-h-8">
              <span className="truncate">{row.title}</span>
            </Link>
            {dateLabel && <time dateTime={row.lastActive} className="block text-xs text-muted-foreground" aria-label={`${t.archiveLastActive}: ${dateLabel}`}>{dateLabel}</time>}
          </div>
          <Tooltip label={t.unarchiveChat}>
            <button type="button" aria-label={t.unarchiveChat} disabled={working !== null}
              onClick={() => void unarchive(row)} className="flex size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50">
              {working === row.id ? <LoaderCircle aria-hidden className="size-4 animate-spin motion-reduce:animate-none" /> : <ArchiveRestore aria-hidden className="size-4" />}
            </button>
          </Tooltip>
        </li>;
      })}
    </ul>
    {rows.hasMore && <Button variant="ghost" disabled={rows.paging} className="my-3 max-sm:min-h-11 w-full" onClick={() => void rows.more()}>{t.moreChats}</Button>}
  </div>;
}
