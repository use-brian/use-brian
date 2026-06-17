"use client";

/**
 * Full-screen Doc surface at `/w/[workspaceId]/doc?viewId=<id>`.
 *
 * Renders `<DocShell>` directly. The default interlocutor is the
 * workspace PRIMARY assistant (`kind='primary'`) — the doc assistant
 * has been demoted to a context-injected skill, so the backend injects the
 * doc-editing tools off `appOrigin: "doc"` regardless of which
 * assistant runs. There's no setup-wizard gate any more; a primary always
 * exists, so the shell renders for every workspace and the chat offers a
 * switcher to any other accessible assistant.
 *
 * Spec: docs/plans/a2ui-notion-feel.md § Phase 1 → Full-screen UI +
 * Doc app.
 */

import { use, useEffect, useState } from "react";
import { DocShell } from "@/components/doc/doc-shell";
import { FloatingChat } from "@/components/chrome/floating-chat";
import { listWorkspaceAssistants } from "@/lib/api/views";
import { useT } from "@/lib/i18n/client";

export default function WorkspaceDocPage(props: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = use(props.params);
  const t = useT().docPage;
  // The default assistant FloatingChat POSTs to /api/chat with is the
  // workspace primary; the chat header lets the user switch to any other
  // accessible workspace assistant.
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "ready"; defaultAssistantId: string | null }
    | { kind: "error"; message: string }
  >({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    listWorkspaceAssistants(workspaceId)
      .then((assistants) => {
        if (cancelled) return;
        // Prefer the primary; fall back to the first accessible assistant on
        // data drift so the shell still renders rather than crashing.
        const primary = assistants.find((a) => a.kind === "primary");
        setState({
          kind: "ready",
          defaultAssistantId: primary?.id ?? assistants[0]?.id ?? null,
        });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        setState({ kind: "error", message });
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  if (state.kind === "loading") {
    return (
      <div className="flex h-full items-center justify-center p-8 text-sm text-muted-foreground">
        {t.dataBlockLoading}
      </div>
    );
  }

  if (state.kind === "error") {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {state.message}
        </div>
      </div>
    );
  }

  return (
    <div className="relative h-full w-full">
      <DocShell workspaceId={workspaceId} />
      {state.defaultAssistantId ? (
        <FloatingChat
          workspaceId={workspaceId}
          assistantId={state.defaultAssistantId}
        />
      ) : null}
    </div>
  );
}
