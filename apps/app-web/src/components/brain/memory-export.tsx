"use client";

/** Workspace-wide, paid Memory download and OAuth deep link. [COMP:app-web/memory-bulk-export] */
import { useEffect, useRef, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { Download } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { fetchMemoryExport } from "@/lib/api/brain";
import { format, useT } from "@/lib/i18n/client";
import { webAppUrl } from "@/lib/primary-auth";
import { requestSidebarClose } from "@/lib/sidebar-close";

type ExportFormat = "markdown" | "csv";
type ExportStatus = "preparing" | "denied" | "failed" | "upgrade" | "askOwner";

export function MemoryExport({
  workspaceId, workspaceName, requestedFormat, clearRequest, showTrigger, offline,
}: {
  workspaceId: string;
  workspaceName?: string;
  requestedFormat: ExportFormat | null;
  clearRequest: () => void;
  showTrigger: boolean;
  offline: boolean;
}) {
  const t = useT().brainPage.memoryExport;
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState<ExportFormat | null>(null);
  const [status, setStatus] = useState<ExportStatus | null>(null);
  const request = useRef<AbortController | null>(null);
  const fileFormat = choice ?? requestedFormat ?? "markdown";
  const dialogOpen = open || requestedFormat !== null;

  useEffect(() => () => request.current?.abort(), []);

  function close() {
    request.current?.abort();
    request.current = null;
    setStatus(null);
    setChoice(null);
    setOpen(false);
    if (requestedFormat) clearRequest();
  }

  async function download() {
    if (request.current || offline) return;
    const controller = new AbortController();
    request.current = controller;
    setStatus("preparing");
    try {
      const result = await fetchMemoryExport(workspaceId, fileFormat, controller.signal);
      if (controller.signal.aborted) return;
      if (result.kind === "denied") { setStatus("denied"); return; }
      if (result.kind === "upgrade") {
        setStatus(result.canManageBilling ? "upgrade" : "askOwner");
        return;
      }
      const url = URL.createObjectURL(result.file);
      const link = document.createElement("a");
      link.href = url;
      link.download = fileFormat === "csv" ? "brian-memories.csv" : "brian-memories.md";
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      close();
    } catch {
      if (!controller.signal.aborted) setStatus("failed");
    } finally {
      if (request.current === controller) request.current = null;
    }
  }

  return (
    <Dialog.Root open={dialogOpen} onOpenChange={next => {
      if (next) { requestSidebarClose(); setOpen(true); }
      else close();
    }}>
      {showTrigger && (
        <Dialog.Trigger render={<Button type="button" variant="ghost" size="sm" className="max-md:size-11 focus-visible:ring-2 focus-visible:ring-ring" />}
          aria-label={t.title} title={t.title}>
          <Download aria-hidden />
          <span className="hidden lg:inline">{t.title}</span>
        </Dialog.Trigger>
      )}
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-foreground/40" />
        <Dialog.Popup className="fixed left-1/2 top-1/2 z-50 max-h-[85dvh] w-[min(26rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 space-y-4 overflow-y-auto rounded-xl border border-border bg-background p-5 shadow-xl">
          <div className="space-y-1">
            <Dialog.Title className="text-base font-semibold">{t.title}</Dialog.Title>
            <Dialog.Description className="text-sm text-muted-foreground">
              {workspaceName ? format(t.workspaceDescription, { workspace: workspaceName }) : t.description}
            </Dialog.Description>
          </div>
          <div role="group" aria-label={t.format} className="flex gap-2">
            {(["markdown", "csv"] as const).map(value => (
              <Button key={value} type="button" variant={fileFormat === value ? "secondary" : "outline"}
                aria-pressed={fileFormat === value} onClick={() => setChoice(value)} disabled={status === "preparing"}>
                {t[value]}
              </Button>
            ))}
          </div>
          {status && <p role={status === "preparing" ? "status" : "alert"} className="text-sm text-muted-foreground">{t[status]}</p>}
          {offline && !status && <p role="status" className="text-sm text-muted-foreground">{t.offline}</p>}
          <div className="flex flex-wrap justify-end gap-2">
            <Dialog.Close render={<Button type="button" variant="ghost" />}>{t.cancel}</Dialog.Close>
            {status === "upgrade" ? (
              <a className={buttonVariants()} href={`${webAppUrl()}/plans?workspaceId=${encodeURIComponent(workspaceId)}`}>{t.plans}</a>
            ) : (
              <Button type="button" onClick={() => void download()} disabled={offline || status === "preparing" || status === "askOwner"}>
                {t.download}
              </Button>
            )}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
