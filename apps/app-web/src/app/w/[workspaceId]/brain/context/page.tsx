"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useAppSession } from "@/components/app-session";
import { BrainTopbar } from "@/components/brain/brain-topbar";
import { MemoryContextPicker } from "@/components/brain/memory-context-picker";
import { isHostedEdition } from "@/lib/edition";
import { useT } from "@/lib/i18n/client";
import { webAppUrl } from "@/lib/primary-auth";
import { useWorkspaceContext } from "@/lib/workspace-context";

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;

export default function MemoryContextPage() {
  const { workspaceId, name, me } = useWorkspaceContext();
  const { state } = useAppSession();
  const requestedMemory = useSearchParams().get("memory");
  const initialId = requestedMemory && UUID.test(requestedMemory) ? requestedMemory : undefined;
  const t = useT().brainPage.memoryContext;

  return <div className="flex h-full min-w-0 flex-col">
    <BrainTopbar workspaceId={workspaceId} tailSection="entries" tail={t.action} />
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-5xl space-y-6 px-4 py-6 pb-24 sm:px-6 sm:py-8">
        <header className="space-y-2">
          <div className="flex flex-wrap items-baseline justify-between gap-x-4">
            <h1 className="text-2xl font-semibold tracking-tight">{t.action}</h1>
            {state.workspaces.length > 1 && <Link href="/memory-context" className="inline-flex min-h-8 items-center text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground max-md:min-h-11">{t.changeWorkspace}</Link>}
          </div>
          <p className="break-words text-sm font-medium">{name}</p>
          <p className="text-sm text-muted-foreground">{t.intro}</p>
        </header>
        <MemoryContextPicker key={`${workspaceId}:${me.id}:${initialId ?? ""}`} workspaceId={workspaceId} initialId={initialId} />
        {isHostedEdition() && <details className="border-t border-border pt-1 text-sm text-muted-foreground">
          <summary className="min-h-8 cursor-pointer py-2 font-medium text-foreground max-md:min-h-11">{t.handoff}</summary>
          <ul className="list-disc space-y-2 ps-5">
            <li>{t.handoffExisting}</li>
            <li>{t.handoffGuest}</li>
            <li>{t.handoffTemporary}</li>
            <li>{t.handoffCopy}</li>
          </ul>
          <a href={`${webAppUrl()}/remember`} className="inline-flex min-h-8 items-center underline underline-offset-4 hover:text-foreground max-md:min-h-11">{t.guide}</a>
        </details>}
      </div>
    </div>
  </div>;
}
