"use client";

/**
 * Workflow approval reviewer default (docs/architecture/features/approval-review.md;
 * workflow.md -> "Delegated approval review and route bindings"). The default
 * is an explicit assignment row the signed-in person makes, never a field in
 * the workflow definition an assistant could edit. Default: no reviewer.
 */
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { format, useT } from "@/lib/i18n/client";
import { markSurfaceCacheStale, useCachedResource } from "@/lib/surface-cache";
import { listWorkspaceAssistants } from "@/lib/api/views";
import { assignReviewer, changeReviewer, listAssignments, newIdempotencyKey, revokeReviewer } from "@/lib/api/approval-review";

const NONE = "__none__";

export function WorkflowReviewerSetting({ workspaceId, workflowId }: { workspaceId: string; workflowId: string }) {
  const t = useT().chatApp.workflowReviewer;
  const cacheKey = `approval-review:assignments:${workspaceId}`;
  const assignments = useCachedResource(cacheKey, () => listAssignments(workspaceId));
  const current = assignments.data?.assignments.find((a) => a.scopeKind === "workflow" && a.scopeId === workflowId && a.status === "active") ?? null;
  const [assistants, setAssistants] = useState<Array<{ value: string; label: string }>>([]);
  const [choice, setChoice] = useState<string>(NONE);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    void listWorkspaceAssistants(workspaceId).then((rows) => { if (live) setAssistants(rows.map((a) => ({ value: a.id, label: a.name }))) }).catch(() => {});
    return () => { live = false };
  }, [workspaceId]);
  useEffect(() => { setChoice(current?.reviewerAssistantId ?? NONE) }, [current?.reviewerAssistantId]);

  const save = async () => {
    setBusy(true);
    setStatus(null);
    try {
      if (choice === NONE && current) {
        await revokeReviewer(workspaceId, current.id, current.revision);
        setStatus(t.removedToast);
      } else if (choice !== NONE && current) {
        await changeReviewer(workspaceId, current.id, { expectedRevision: current.revision, reviewerAssistantId: choice });
        setStatus(t.saved);
      } else if (choice !== NONE) {
        await assignReviewer(workspaceId, { reviewerAssistantId: choice, scopeKind: "workflow", scopeId: workflowId, idempotencyKey: newIdempotencyKey("workflow-reviewer") });
        setStatus(t.saved);
      }
      markSurfaceCacheStale(cacheKey);
    } catch (error) {
      setStatus(format(t.error, { message: error instanceof Error ? error.message : String(error) }));
    } finally {
      setBusy(false);
    }
  };

  const items = [{ value: NONE, label: t.none }, ...assistants];
  const dirty = choice !== (current?.reviewerAssistantId ?? NONE);
  return (
    <section className="space-y-2 rounded-lg border p-3" data-testid="workflow-reviewer-setting">
      <h3 className="text-sm font-semibold">{t.title}</h3>
      <p className="text-xs text-muted-foreground">{t.help}</p>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <SearchableSelect value={choice} onValueChange={setChoice} items={items} aria-label={t.title} className="min-w-0 sm:w-72" />
        <Button size="sm" disabled={!dirty || busy} onClick={() => void save()}>{choice === NONE && current ? t.remove : t.save}</Button>
      </div>
      {status && <p role="status" className="text-xs text-muted-foreground">{status}</p>}
    </section>
  );
}
