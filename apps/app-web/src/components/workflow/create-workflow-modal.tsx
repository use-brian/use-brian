"use client";

/**
 * Create-workflow modal (app-web) — overlay form for the minimum viable
 * workflow: name, optional description, and a seed first step (assistant_call
 * against the workspace primary by default, with an editable instruction).
 *
 * Ported from `apps/web/src/components/workflow/create-workflow-modal.tsx`
 * (app consolidation §5a). Rendered conditionally by the parent
 * (`{open && <CreateWorkflowModal/>}`) so each open is a fresh mount — no
 * reset-on-reopen bookkeeping needed.
 *
 * On success → close + navigate to `/w/[workspaceId]/workflow/:id`, where the
 * full builder (steps, trigger, runs) lives. app-web is workspace-scoped,
 * so the new workflow inherits the route workspace (`activeId` from the
 * `useWorkspaces()` adapter).
 *
 * Spec: docs/architecture/features/workflow.md.
 * [COMP:app-web/workflow]
 */

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useT } from "@/lib/i18n/client";
import { useWorkspaces } from "@/contexts/workspace-context";
import {
  createWorkflow,
  type CreateWorkflowInput,
  type WorkflowDefinition,
} from "@/lib/api/workflow";
import { listAssistants, type StudioAssistantSummary } from "@/lib/api/studio";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

type Props = {
  onClose: () => void;
};

export function CreateWorkflowModal({ onClose }: Props) {
  const t = useT();
  const router = useRouter();
  const { activeId } = useWorkspaces();

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [assistantId, setAssistantId] = useState<string>("primary");
  const [prompt, setPrompt] = useState("");
  const [assistants, setAssistants] = useState<StudioAssistantSummary[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!activeId) return;
    let cancelled = false;
    void (async () => {
      const list = await listAssistants(activeId);
      if (!cancelled) {
        setAssistants(list.filter((a) => a.workspaceId === activeId));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeId]);

  // Escape-to-close + body scroll lock — mirrors SettingsModal.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !submitting) onClose();
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose, submitting]);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (!name.trim()) {
      setError(t.workflowPage.builder.nameRequired);
      return;
    }
    if (!prompt.trim()) {
      setError(t.workflowPage.builder.promptRequired);
      return;
    }
    if (!activeId) return;

    const definition: WorkflowDefinition = {
      startStepId: "step_1",
      steps: [
        {
          id: "step_1",
          type: "assistant_call",
          target: { assistantId },
          prompt: prompt.trim(),
          modelAlias: "pro",
        },
      ],
    };

    const input: CreateWorkflowInput = {
      workspaceId: activeId,
      name: name.trim(),
      description: description.trim() || undefined,
      definition,
      trigger: { kind: "manual" },
    };

    setSubmitting(true);
    const result = await createWorkflow(input);
    setSubmitting(false);
    if (!result.ok) {
      setError(result.error || t.workflowPage.builder.createError);
      return;
    }
    router.push(
      `/w/${activeId}/workflow/${encodeURIComponent(result.workflow.id)}`,
    );
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-background/40 backdrop-blur-sm overflow-y-auto"
      onClick={() => {
        if (!submitting) onClose();
      }}
    >
      <div className="min-h-full flex items-center justify-center p-6">
        <div
          role="dialog"
          aria-label={t.workflowPage.builder.newPageTitle}
          aria-modal="true"
          className="relative w-full max-w-xl bg-popover border border-border rounded-xl shadow-2xl"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            aria-label={t.workflowPage.builder.cancel}
            className="absolute top-3 right-3 h-7 w-7 rounded hover:bg-muted inline-flex items-center justify-center text-muted-foreground disabled:opacity-40"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>

          <form onSubmit={onSubmit} className="flex flex-col gap-5 p-6">
            <header>
              <h2 className="text-lg font-semibold">{t.workflowPage.builder.newPageTitle}</h2>
              <p className="text-sm text-muted-foreground">
                {t.workflowPage.builder.newPageSubtitle}
              </p>
            </header>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="cwm-name" className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {t.workflowPage.builder.nameLabel}
              </label>
              <input
                id="cwm-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t.workflowPage.builder.namePlaceholder}
                disabled={submitting}
                maxLength={120}
                autoFocus
                // Plain label field — keep browser autofill and password
                // managers (1Password / LastPass / Dashlane) off it.
                autoComplete="off"
                data-1p-ignore="true"
                data-lpignore="true"
                data-form-type="other"
                className="px-3 py-2 bg-background border border-border rounded-md text-sm outline-none focus:ring-2 focus:ring-ring"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <label htmlFor="cwm-desc" className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {t.workflowPage.builder.descriptionLabel}
              </label>
              <textarea
                id="cwm-desc"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={t.workflowPage.builder.descriptionPlaceholder}
                disabled={submitting}
                rows={2}
                maxLength={2000}
                className="px-3 py-2 bg-background border border-border rounded-md text-sm outline-none focus:ring-2 focus:ring-ring resize-y"
              />
            </div>

            <div className="border border-border rounded-md bg-card overflow-hidden">
              <div className="px-4 py-2 border-b border-border text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {t.workflowPage.builder.firstStepHeading}
              </div>
              <div className="p-4 flex flex-col gap-3">
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-medium text-muted-foreground">
                    {t.workflowPage.builder.assistantPickerLabel}
                  </label>
                  <Select
                    value={assistantId}
                    onValueChange={(v) => {
                      if (v) setAssistantId(v);
                    }}
                    disabled={submitting}
                  >
                    <SelectTrigger className="w-full text-sm" id="cwm-assistant">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="primary">
                        {t.workflowPage.builder.assistantPickerPrimary}
                      </SelectItem>
                      {assistants.map((a) => (
                        <SelectItem key={a.id} value={a.id}>
                          {a.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="flex flex-col gap-1.5">
                  <label htmlFor="cwm-prompt" className="text-xs font-medium text-muted-foreground">
                    {t.workflowPage.builder.promptLabel}
                  </label>
                  <textarea
                    id="cwm-prompt"
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    placeholder={t.workflowPage.builder.promptPlaceholder}
                    disabled={submitting}
                    rows={5}
                    maxLength={8000}
                    className="px-3 py-2 bg-background border border-border rounded-md text-sm outline-none focus:ring-2 focus:ring-ring resize-y"
                  />
                </div>
              </div>
            </div>

            {error && (
              <div className="text-sm text-red-600 dark:text-red-400">{error}</div>
            )}

            <div className="flex items-center gap-2 justify-end">
              <button
                type="button"
                onClick={onClose}
                disabled={submitting}
                className="px-4 py-2 rounded-md border border-border text-sm hover:bg-muted disabled:opacity-50"
              >
                {t.workflowPage.builder.cancel}
              </button>
              <button
                type="submit"
                disabled={submitting}
                className={cn(
                  "px-4 py-2 rounded-md text-sm font-medium",
                  "bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50",
                )}
              >
                {submitting ? t.workflowPage.builder.saving : t.workflowPage.builder.saveCreateBtn}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
