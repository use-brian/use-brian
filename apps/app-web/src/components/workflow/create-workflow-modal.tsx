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
import { requestWorkflowRefresh } from "@/lib/workflow-events";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { isPhoneViewport } from "@/lib/viewport";
import {ModeAwareCreationContext,useCreationContext} from '@/components/context/mode-aware-context';
import { cn } from "@/lib/utils";

type Props = {
  onClose: () => void;
};

export function CreateWorkflowModal({ onClose }: Props) {
  const t = useT();
  const router = useRouter();
  const { activeId } = useWorkspaces();
  const destination=useCreationContext("new-shared");

  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [assistantId, setAssistantId] = useState<string>("primary");
  const [prompt, setPrompt] = useState("");
  const assistants=destination.choices?.assistants??[];
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(()=>{if(destination.reviewNeeded)setAssistantId("primary");},[destination.reviewNeeded,activeId]);

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
    const admitted=destination.snapshot();
    if (!activeId||!admitted) return;

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
      ...(destination.legacy&&!destination.hasSelection?{expectedPolicyRevision:admitted.expectedPolicyRevision}:admitted),
    };

    setSubmitting(true);
    const result = await createWorkflow(input).catch(()=>({ok:false as const,error:t.modeContext.stale}));
    setSubmitting(false);
    if(!destination.isCurrent())return;
    if (!result.ok) {
      destination.fail();
      setError(t.modeContext.stale);
      return;
    }
    requestWorkflowRefresh(activeId);
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
      {/* Settings-modal shape (responsive contract M5): full-screen below
          `sm`, a floating card above it. */}
      <div className="min-h-full flex items-center justify-center p-0 sm:p-6">
        <div
          role="dialog"
          aria-label={t.workflowPage.builder.newPageTitle}
          aria-modal="true"
          className="relative w-full max-w-xl min-h-[100dvh] sm:min-h-0 bg-popover border-0 sm:border border-border rounded-none sm:rounded-xl shadow-2xl"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            aria-label={t.workflowPage.builder.cancel}
            className="absolute top-2 right-2 sm:top-3 sm:right-3 h-11 w-11 sm:h-7 sm:w-7 rounded hover:bg-muted inline-flex items-center justify-center text-muted-foreground disabled:opacity-40"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>

          <form
            onSubmit={onSubmit}
            className="flex flex-col gap-5 p-4 pt-12 sm:p-6 pb-[max(1rem,env(safe-area-inset-bottom))] sm:pb-6"
          >
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
                // Not on a phone: auto-focusing a field on open raises the
                // keyboard (and used to zoom Safari) before the user has
                // done anything (responsive contract M4).
                autoFocus={!isPhoneViewport()}
                // Plain label field — keep browser autofill and password
                // managers (1Password / LastPass / Dashlane) off it.
                autoComplete="off"
                data-1p-ignore="true"
                data-lpignore="true"
                data-form-type="other"
                className="px-3 py-2 bg-background border border-border rounded-md text-[16px] md:text-sm outline-none focus:ring-2 focus:ring-ring"
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
                className="px-3 py-2 bg-background border border-border rounded-md text-[16px] md:text-sm outline-none focus:ring-2 focus:ring-ring resize-y"
              />
            </div>

            <div className="border-t border-border pt-4">
              <div className="pb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {t.workflowPage.builder.firstStepHeading}
              </div>
              <div className="flex flex-col gap-3">
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
                    <SelectTrigger className="w-full min-h-11 sm:min-h-0 text-[16px] md:text-sm" id="cwm-assistant">
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
                    className="px-3 py-2 bg-background border border-border rounded-md text-[16px] md:text-sm outline-none focus:ring-2 focus:ring-ring resize-y"
                  />
                </div>
              </div>
            </div>

            <ModeAwareCreationContext context={destination}/>

            {error && (
              <div className="text-sm text-red-600 dark:text-red-400">{error}</div>
            )}

            <div className="flex items-center gap-2 justify-end">
              <button
                type="button"
                onClick={onClose}
                disabled={submitting}
                className="inline-flex h-11 sm:h-9 items-center px-4 rounded-md border border-border text-sm hover:bg-muted disabled:opacity-50"
              >
                {t.workflowPage.builder.cancel}
              </button>
              <button
                type="submit"
                disabled={submitting||!destination.ready}
                className={cn(
                  "inline-flex h-11 sm:h-9 items-center px-4 rounded-md text-sm font-medium",
                  "bg-action text-action-foreground hover:opacity-90 disabled:opacity-50",
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
