"use client";

/**
 * Workflow detail page — `/w/[workspaceId]/workflow/[id]` (app-web).
 *
 * Ported from `apps/web/src/app/(app)/workflow/[id]/page.tsx` (app
 * consolidation §5a). Board-centric view: the centerpiece is the
 * WorkflowBoard, an n8n-style illustration of the trigger + step chain.
 * Clicking a board node opens that step's editor (entering edit mode and
 * scrolling to it); the "Edit" button reveals the full editor panel (trigger
 * config + step editors + add-step). "Run now" kicks off a manual run via
 * POST /api/workflows/:id/run, and recent runs are listed below.
 *
 * app-web is single-workspace-per-route — assistants + destinations scope
 * to the route workspace (`activeId` from the `useWorkspaces()` adapter,
 * `[COMP:app-web/workspaces-adapter]`); back / delete navigation is
 * prefixed with `/w/[workspaceId]`. The page renders full-width inside the
 * `/w/[workspaceId]` layout's `<main>` (its own chrome, not the doc page
 * shell).
 *
 * Spec: docs/architecture/features/workflow.md → "Board view".
 * [COMP:app-web/workflow]
 */

import { use, useCallback, useEffect, useState } from "react";
import { BackButton } from "@/components/ui/back-button";
import { useRouter } from "next/navigation";
import { useT } from "@/lib/i18n/client";
import { format as fmt } from "@/lib/i18n";
import { useWorkspaces } from "@/contexts/workspace-context";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import {
  deleteWorkflow,
  getWorkflowFull,
  listChannelDestinations,
  listWorkspaceSlackChannels,
  runWorkflowNow,
  updateWorkflow,
  type ChannelDestination,
  type SlackChannelOption,
  type WorkflowFull,
  type WorkflowIssue,
  type WorkflowStep,
  type WorkflowTrigger,
} from "@/lib/api/workflow";
import { useWorkflowLiveRun } from "@/lib/workflow-live-run";
import { listAssistants, type StudioAssistantSummary } from "@/lib/api/studio";
import {
  listCustomPageTemplates,
  listViews,
  type ViewListRow,
} from "@/lib/api/views";
import type { CustomPageTemplateSummary } from "@sidanclaw/doc-model";
import { listWorkspaceSkills, type WorkspaceSkillSummary } from "@/lib/api/skills";
import { WorkflowBoard } from "@/components/workflow/workflow-board";
import { StepEditor } from "@/components/workflow/step-editor";
import { TriggerEditor } from "@/components/workflow/trigger-editor";
import { TriggerJobsList } from "@/components/workflow/trigger-jobs-list";
import { RunHistory } from "@/components/workflow/run-history";
import { LiveRunBanner } from "@/components/workflow/live-run-banner";
import { cn } from "@/lib/utils";

export default function WorkflowDetailPage({
  params,
}: {
  params: Promise<{ workspaceId: string; id: string }>;
}) {
  const t = useT();
  const { workspaceId, id } = use(params);
  const router = useRouter();
  const { activeId } = useWorkspaces();
  const listHref = `/w/${workspaceId}/workflow`;

  const [workflow, setWorkflow] = useState<WorkflowFull | null | undefined>(undefined);
  const [draft, setDraft] = useState<WorkflowFull | null>(null);
  const [assistants, setAssistants] = useState<StudioAssistantSummary[]>([]);
  const [destinations, setDestinations] = useState<ChannelDestination[]>([]);
  const [slackChannels, setSlackChannels] = useState<SlackChannelOption[]>([]);
  const [pages, setPages] = useState<ViewListRow[]>([]);
  const [blueprints, setBlueprints] = useState<CustomPageTemplateSummary[]>([]);
  const [skills, setSkills] = useState<WorkspaceSkillSummary[]>([]);
  const [editing, setEditing] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<WorkflowIssue[]>([]);
  const [runMessage, setRunMessage] = useState<string | null>(null);
  const [refetchTick, setRefetchTick] = useState(0);

  // Recent runs + live-run overlay. The hook owns the runs list (poll-based:
  // 2.5 s while a run is executing, 15 s idle, so a schedule/webhook fire
  // lights the board up too). `running` (the Run-now POST in flight) keeps
  // the fast cadence through the gap before the new run row is visible.
  const { runs, liveView, pollNow } = useWorkflowLiveRun(id, {
    forceActive: running,
  });

  // Load the workflow.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const wf = await getWorkflowFull(id);
      if (cancelled) return;
      setWorkflow(wf);
      setDraft(wf);
    })();
    return () => {
      cancelled = true;
    };
  }, [id, refetchTick]);

  // Load assistants for the picker + board node labels.
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

  // Load recent chat destinations for the per-step `deliver.channelId` dropdown.
  useEffect(() => {
    if (!activeId) return;
    let cancelled = false;
    void (async () => {
      const list = await listChannelDestinations(activeId);
      if (!cancelled) setDestinations(list);
    })();
    return () => {
      cancelled = true;
    };
  }, [activeId]);

  // Load the workspace's Slack channels (by name) for the deliver picker's
  // Slack destination dropdown. Best-effort — empty when Slack isn't connected.
  useEffect(() => {
    if (!activeId) return;
    let cancelled = false;
    void (async () => {
      const list = await listWorkspaceSlackChannels(activeId);
      if (!cancelled) setSlackChannels(list);
    })();
    return () => {
      cancelled = true;
    };
  }, [activeId]);

  // Load the workspace page roster once — backs the per-step page-anchor
  // picker (PageAnchorField) and the board node's "Edits page: X" chip.
  useEffect(() => {
    if (!activeId) return;
    let cancelled = false;
    void (async () => {
      try {
        const list = await listViews({ workspaceId: activeId, state: "all" });
        if (!cancelled) setPages(list);
      } catch {
        // Roster is a UX nicety — the picker degrades to raw ids.
        if (!cancelled) setPages([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeId]);

  // Load the workspace blueprints once — backs the per-step blueprint picker
  // (a built-in slug or a workspace blueprint template id). The list API
  // returns every page template; the picker filters to those with a spec.
  useEffect(() => {
    if (!activeId) return;
    let cancelled = false;
    void (async () => {
      try {
        const list = await listCustomPageTemplates(activeId);
        if (!cancelled) setBlueprints(list);
      } catch {
        // The picker degrades to just the built-ins — non-fatal.
        if (!cancelled) setBlueprints([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeId]);

  // Load the workspace brain skills once — backs the per-step skills allow-list
  // picker (`SkillsField`). The picker hides itself when the list is empty.
  useEffect(() => {
    if (!activeId) return;
    let cancelled = false;
    void (async () => {
      try {
        const list = await listWorkspaceSkills(activeId);
        if (!cancelled) setSkills(list);
      } catch {
        // The picker just hides — non-fatal.
        if (!cancelled) setSkills([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeId]);

  // When a board node selects a target, scroll its editor into view once
  // the editor panel has mounted.
  useEffect(() => {
    if (!editing || !selectedKey) return;
    const domId =
      selectedKey === "trigger" ? "wf-trigger-editor" : `wf-step-${selectedKey}`;
    const tid = window.setTimeout(() => {
      document
        .getElementById(domId)
        ?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }, 60);
    return () => window.clearTimeout(tid);
  }, [editing, selectedKey]);

  const refresh = useCallback(() => setRefetchTick((n) => n + 1), []);

  if (workflow === undefined) {
    return (
      <div className="w-full px-6 py-10 text-sm text-muted-foreground">…</div>
    );
  }

  if (workflow === null || !draft) {
    return (
      <div className="w-full px-6 py-20 text-center flex flex-col gap-3">
        <div className="font-medium">{t.workflowPage.detail.notFound}</div>
        <BackButton
          href={listHref}
          label={t.workflowPage.detail.backToList}
          className="mx-auto"
        />
      </div>
    );
  }

  // ── Draft mutation helpers ───────────────────────────────────────────
  const updateDraft = (patch: Partial<WorkflowFull>) =>
    setDraft((d) => (d ? { ...d, ...patch } : d));

  const updateStep = (idx: number, next: WorkflowStep) => {
    setDraft((d) => {
      if (!d) return d;
      const steps = d.definition.steps.slice();
      steps[idx] = next;
      return { ...d, definition: { ...d.definition, steps } };
    });
  };

  const moveStep = (idx: number, dir: -1 | 1) => {
    setDraft((d) => {
      if (!d) return d;
      const steps = d.definition.steps.slice();
      const targetIdx = idx + dir;
      if (targetIdx < 0 || targetIdx >= steps.length) return d;
      const [removed] = steps.splice(idx, 1);
      steps.splice(targetIdx, 0, removed);
      return { ...d, definition: { ...d.definition, steps } };
    });
  };

  const removeStep = (idx: number) => {
    const steps = draft.definition.steps;
    if (steps.length <= 1) return;
    const newSteps = steps.filter((_, i) => i !== idx);
    const startStepId = newSteps.some((s) => s.id === draft.definition.startStepId)
      ? draft.definition.startStepId
      : newSteps[0].id;
    setDraft({ ...draft, definition: { startStepId, steps: newSteps } });
    // Keep a surviving step focused so the editor panel doesn't go blank.
    setSelectedKey(newSteps[Math.min(idx, newSteps.length - 1)].id);
  };

  const addStep = () => {
    // Step ids aren't renumbered on removal, so `step_<count+1>` can
    // collide — walk forward until the id is free.
    const taken = new Set(draft.definition.steps.map((s) => s.id));
    let n = draft.definition.steps.length + 1;
    let nextId = `step_${n}`;
    while (taken.has(nextId)) {
      n += 1;
      nextId = `step_${n}`;
    }
    const step: WorkflowStep = {
      id: nextId,
      type: "assistant_call",
      target: { assistantId: "primary" },
      prompt: "",
      modelAlias: "pro",
    };
    setDraft({
      ...draft,
      definition: {
        ...draft.definition,
        steps: [...draft.definition.steps, step],
      },
    });
    // Focus the new step so its editor opens immediately.
    setSelectedKey(nextId);
  };

  // ── Board node selection → enter edit mode + scroll to the editor ────
  const selectStep = (stepId: string) => {
    setEditing(true);
    setSelectedKey(stepId);
  };
  const selectTrigger = () => {
    setEditing(true);
    setSelectedKey("trigger");
  };

  // ── Persistence ──────────────────────────────────────────────────────
  const onSaveTrigger = (trigger: WorkflowTrigger) => updateDraft({ trigger });

  const onRotateWebhook = async () => {
    setSaving(true);
    setError(null);
    const result = await updateWorkflow(workflow.id, { rotateWebhookSecret: true });
    setSaving(false);
    if (!result.ok) {
      setError(result.error || t.workflowPage.builder.saveFail);
      return;
    }
    setWorkflow(result.workflow);
    setDraft(result.workflow);
  };

  const onSave = async () => {
    if (!draft) return;
    setError(null);
    setIssues([]);
    setRunMessage(null);
    setSaving(true);
    // An "Edit a page" anchor left unpicked is transient UI state, not
    // intent — scrub `page: { id: "" }` back to no anchor before save (a
    // half-filled anchor would otherwise 400 on the uuid check).
    const definition = {
      ...draft.definition,
      steps: draft.definition.steps.map((s) =>
        s.type === "assistant_call" && s.page && "id" in s.page && s.page.id === ""
          ? { ...s, page: undefined }
          : s,
      ),
    };
    const result = await updateWorkflow(workflow.id, {
      name: draft.name,
      description: draft.description,
      definition,
      enabled: draft.enabled,
      trigger: draft.trigger,
    });
    setSaving(false);
    if (!result.ok) {
      setError(result.error || t.workflowPage.builder.saveFail);
      const next = result.issues ?? [];
      setIssues(next);
      // Auto-route focus to the first problematic step / trigger so the
      // user lands on the input that needs fixing instead of hunting for it.
      const first = next[0];
      if (first) {
        const target = locateIssueTarget(first, draft.definition.steps);
        if (target === "trigger") {
          setEditing(true);
          setSelectedKey("trigger");
        } else if (typeof target === "string") {
          setEditing(true);
          setSelectedKey(target);
        }
        // Header errors (name/description) don't change focus — they're
        // already visible at the top.
      }
      return;
    }
    setWorkflow(result.workflow);
    setDraft(result.workflow);
    setEditing(false);
    setSelectedKey(null);
    refresh();
  };

  const onCancelEdit = () => {
    setDraft(workflow);
    setEditing(false);
    setSelectedKey(null);
    setError(null);
    setIssues([]);
  };

  const onDelete = async () => {
    const ok = await confirmDialog({
      title: t.workflowPage.builder.deleteConfirmTitle,
      description: t.workflowPage.builder.deleteConfirmBody,
      confirmLabel: t.workflowPage.builder.deleteConfirmAction,
      variant: "destructive",
    });
    if (!ok) return;
    const deleted = await deleteWorkflow(workflow.id);
    if (deleted) router.push(listHref);
  };

  const onRunNow = async () => {
    setRunMessage(null);
    setError(null);
    setRunning(true);
    // Light the live overlay up immediately — the POST holds until the run
    // terminates, but the run row (and its step statuses) are visible to the
    // poller right away.
    pollNow();
    const result = await runWorkflowNow(workflow.id, {});
    setRunning(false);
    pollNow();
    if (!result) {
      setError(t.workflowPage.builder.runFail);
      return;
    }
    setRunMessage(
      fmt(t.workflowPage.builder.runOk, {
        status: t.workflowPage.builder.runStatus[result.status],
      }),
    );
  };

  const onToggleEnabled = async () => {
    setError(null);
    setSaving(true);
    const result = await updateWorkflow(workflow.id, { enabled: !workflow.enabled });
    setSaving(false);
    if (!result.ok) {
      setError(result.error || t.workflowPage.builder.saveFail);
      return;
    }
    setWorkflow(result.workflow);
    setDraft(result.workflow);
  };

  // The "Edit" button has no node context — focus the start step so the
  // panel opens on something.
  const enterEditFromButton = () => {
    setEditing(true);
    setSelectedKey(draft.definition.startStepId);
  };

  // Resolve the single step the editor panel should render. `selectedKey`
  // is "trigger" | <stepId> | null; only one editor shows at a time.
  const selectedStepIdx =
    selectedKey && selectedKey !== "trigger"
      ? draft.definition.steps.findIndex((s) => s.id === selectedKey)
      : -1;
  const selectedStep =
    selectedStepIdx >= 0 ? draft.definition.steps[selectedStepIdx] : null;

  const nameIssues = issues.filter((i) => i.path[0] === "name");
  const descriptionIssues = issues.filter((i) => i.path[0] === "description");
  const triggerIssues = issues.filter((i) => i.path[0] === "trigger");
  const selectedStepIssues =
    selectedStep && selectedStepIdx >= 0
      ? [
          ...issuesForStepIndex(issues, selectedStepIdx),
          // startStepId / definition-level issues surface against the first
          // step so the user has a concrete place to act.
          ...(selectedStepIdx === 0 ? topLevelDefinitionIssues(issues) : []),
        ]
      : [];

  return (
    // `[&>*]:shrink-0` is load-bearing. This is a flex column AND a scroll
    // container: when its content (header + board + editor + runs + footer)
    // exceeds the viewport, the flex layout shrinks its children to fit instead
    // of letting the container scroll. The board is an `overflow-auto` child, so
    // its flex min-height is 0 - it gets squeezed to zero and the whole n8n
    // board vanishes. Pinning children to their natural height makes the page
    // scroll as one document, with everything reachable. pb-28 then keeps the
    // footer clear of the fixed "Ask anything" chat dock floated bottom-right.
    <div className="w-full h-full overflow-y-auto px-6 pt-6 pb-28 flex flex-col gap-6 [&>*]:shrink-0">
      <BackButton href={listHref} label={t.workflowPage.detail.backToList} />

      <header className="flex flex-col gap-3">
        <div className="flex items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            {editing ? (
              <>
                <input
                  type="text"
                  value={draft.name}
                  onChange={(e) => updateDraft({ name: e.target.value })}
                  maxLength={120}
                  // Plain label field — keep browser autofill and password
                  // managers (1Password / LastPass / Dashlane) off it.
                  autoComplete="off"
                  data-1p-ignore="true"
                  data-lpignore="true"
                  data-form-type="other"
                  className={cn(
                    "w-full text-xl font-semibold bg-background border rounded-md px-2 py-1 outline-none focus:ring-2 focus:ring-ring",
                    nameIssues.length > 0
                      ? "border-red-500 focus:ring-red-500/40"
                      : "border-border",
                  )}
                />
                {nameIssues.length > 0 && (
                  <p className="mt-1 text-xs text-red-600 dark:text-red-400">
                    {nameIssues.map((i) => i.message).join("; ")}
                  </p>
                )}
              </>
            ) : (
              <>
                <h1 className="text-xl font-semibold flex items-center gap-2">
                  {workflow.name}
                  <EnabledBadge enabled={workflow.enabled} t={t} />
                </h1>
                {!workflow.enabled && workflow.pausedReason ? (
                  <p className="mt-1 text-xs rounded-md border border-amber-300/60 bg-amber-500/10 text-amber-700 dark:text-amber-400 px-2 py-1.5">
                    <span className="font-medium">
                      {t.workflowPage.builder.stormPausedTitle}
                    </span>{" "}
                    {workflow.pausedReason}
                  </p>
                ) : null}
              </>
            )}
            {editing ? (
              <>
                <textarea
                  value={draft.description ?? ""}
                  onChange={(e) => updateDraft({ description: e.target.value || null })}
                  placeholder={t.workflowPage.builder.descriptionPlaceholder}
                  rows={2}
                  maxLength={2000}
                  className={cn(
                    "mt-2 w-full text-sm bg-background border rounded-md px-2 py-1 outline-none focus:ring-2 focus:ring-ring resize-y",
                    descriptionIssues.length > 0
                      ? "border-red-500 focus:ring-red-500/40"
                      : "border-border",
                  )}
                />
                {descriptionIssues.length > 0 && (
                  <p className="mt-1 text-xs text-red-600 dark:text-red-400">
                    {descriptionIssues.map((i) => i.message).join("; ")}
                  </p>
                )}
              </>
            ) : workflow.description ? (
              <p className="text-sm text-muted-foreground">{workflow.description}</p>
            ) : null}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={onRunNow}
              disabled={running || !workflow.enabled}
              className="px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 disabled:opacity-50"
            >
              {running ? t.workflowPage.builder.running : t.workflowPage.builder.runNowBtn}
            </button>
            {editing ? (
              <>
                <button
                  type="button"
                  onClick={onCancelEdit}
                  disabled={saving}
                  className="px-3 py-1.5 rounded-md border border-border text-sm hover:bg-muted disabled:opacity-50"
                >
                  {t.workflowPage.builder.cancel}
                </button>
                <button
                  type="button"
                  onClick={onSave}
                  disabled={saving}
                  className="px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 disabled:opacity-50"
                >
                  {saving ? t.workflowPage.builder.saving : t.workflowPage.builder.saveChanges}
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={enterEditFromButton}
                className="px-3 py-1.5 rounded-md border border-border text-sm hover:bg-muted"
              >
                {t.workflowPage.builder.editModeOn}
              </button>
            )}
          </div>
        </div>

        {runMessage && !liveView && (
          <div className="text-xs text-green-700 dark:text-green-400">{runMessage}</div>
        )}
        {error && <div className="text-xs text-red-600 dark:text-red-400">{error}</div>}
      </header>

      {/* Live activity — visible whenever a run is in flight (Run now,
          schedule, webhook or event), so the user sees which step the
          assistant is working on instead of a silent board. */}
      {liveView && (
        <LiveRunBanner
          workspaceId={workspaceId}
          workflowId={workflow.id}
          view={liveView}
          definition={workflow.definition}
          assistants={assistants}
        />
      )}

      {/* Board — the n8n-style illustration. Always visible; reflects the
          live draft. Clicking a node opens its editor. */}
      <WorkflowBoard
        definition={draft.definition}
        trigger={draft.trigger}
        assistants={assistants}
        pages={pages}
        selectedKey={editing ? selectedKey : null}
        live={liveView}
        onSelectStep={selectStep}
        onSelectTrigger={selectTrigger}
      />

      {/* Reality check — the ACTUAL scheduled-trigger rows firing this
          workflow (any member's), with a drift warning when they disagree
          with the configured trigger. Compares against the SAVED trigger,
          not the in-edit draft. */}
      {workflow.triggerJobs && workflow.triggerJobs.length > 0 && (
        <TriggerJobsList trigger={workflow.trigger} jobs={workflow.triggerJobs} />
      )}

      {/* Editor panel — revealed in edit mode. Shows only the editor for
          the node focused on the board (the trigger or a single step). */}
      {editing && (
        <div className="flex flex-col gap-3">
          <div className="flex justify-end">
            <button
              type="button"
              onClick={addStep}
              className="text-xs px-2 py-1 rounded border border-border hover:bg-muted"
            >
              {t.workflowPage.builder.addStepBtn}
            </button>
          </div>

          {selectedKey === "trigger" && (
            <div
              id="wf-trigger-editor"
              className={cn(
                triggerIssues.length > 0 &&
                  "rounded-md ring-1 ring-red-500/60 ring-offset-2 ring-offset-background",
              )}
            >
              {triggerIssues.length > 0 && (
                <ul className="mb-2 text-xs text-red-600 dark:text-red-400 list-disc pl-5 space-y-0.5">
                  {triggerIssues.map((i, idx) => (
                    <li key={idx}>{i.message}</li>
                  ))}
                </ul>
              )}
              <TriggerEditor
                workflowId={workflow.id}
                workspaceId={workflow.workspaceId}
                trigger={draft.trigger}
                webhookSlug={draft.webhookSlug}
                webhookSecret={draft.webhookSecret}
                onChange={onSaveTrigger}
                onRotateWebhook={onRotateWebhook}
                disabled={saving}
              />
            </div>
          )}

          {selectedStep && (
            <div
              key={selectedStep.id}
              id={`wf-step-${selectedStep.id}`}
              className={cn(
                selectedStepIssues.length > 0 &&
                  "rounded-md ring-1 ring-red-500/60 ring-offset-2 ring-offset-background",
              )}
            >
              {selectedStepIssues.length > 0 && (
                <ul className="mb-2 text-xs text-red-600 dark:text-red-400 list-disc pl-5 space-y-0.5">
                  {selectedStepIssues.map((i, idx) => (
                    <li key={idx}>
                      <span className="font-mono text-[10px] text-red-500/80 mr-1">
                        {i.path.slice(3).join(".") || "step"}
                      </span>
                      {i.message}
                    </li>
                  ))}
                </ul>
              )}
              <StepEditor
                index={selectedStepIdx}
                total={draft.definition.steps.length}
                step={selectedStep}
                assistants={assistants}
                destinations={destinations}
                slackChannels={slackChannels}
                pages={pages}
                blueprints={blueprints}
                skills={skills}
                steps={draft.definition.steps}
                onChange={(next) => updateStep(selectedStepIdx, next)}
                onMoveUp={() => moveStep(selectedStepIdx, -1)}
                onMoveDown={() => moveStep(selectedStepIdx, 1)}
                onRemove={() => removeStep(selectedStepIdx)}
                disabled={saving}
              />
            </div>
          )}
        </div>
      )}

      {/* Recent runs — read-only history, hidden while editing so the edit
          surface stays focused on the step being configured. */}
      {!editing && (
        <RunHistory
          workspaceId={workspaceId}
          workflowId={workflow.id}
          runs={runs}
        />
      )}

      {/* Footer actions */}
      <div className="flex items-center justify-between pt-2 border-t border-border">
        <button
          type="button"
          onClick={onToggleEnabled}
          disabled={saving}
          className={cn(
            "text-xs text-muted-foreground hover:text-foreground disabled:opacity-50",
          )}
        >
          {workflow.enabled
            ? t.workflowPage.builder.disableAction
            : t.workflowPage.builder.enableAction}
        </button>
        <button
          type="button"
          onClick={onDelete}
          className="text-xs text-red-600 dark:text-red-400 hover:underline"
        >
          {t.workflowPage.builder.deleteBtn}
        </button>
      </div>
    </div>
  );
}

function EnabledBadge({ enabled, t }: { enabled: boolean; t: ReturnType<typeof useT> }) {
  if (enabled) return null;
  return (
    <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground uppercase tracking-wide">
      {t.workflowPage.builder.disabledLabel}
    </span>
  );
}

/**
 * Map a server-issued validation issue to the UI section the user should
 * land on. Path semantics (see `validationError` in
 * `packages/api/src/routes/workflows.ts`):
 *   `['name'|'description']`             → header field
 *   `['trigger', …]`                     → trigger editor
 *   `['definition', 'steps', N, …]`      → step at index N (resolved to id)
 *   `['definition', 'startStepId'|…]`    → first step (surfaces the graph)
 */
function locateIssueTarget(
  issue: WorkflowIssue,
  steps: WorkflowStep[],
): string | "trigger" | "name" | "description" | null {
  const p = issue.path;
  if (p[0] === "trigger") return "trigger";
  if (p[0] === "name") return "name";
  if (p[0] === "description") return "description";
  if (p[0] === "definition") {
    if (p[1] === "steps" && typeof p[2] === "number") {
      const step = steps[p[2]];
      return step ? step.id : null;
    }
    return steps[0]?.id ?? null;
  }
  return null;
}

function issuesForStepIndex(
  issues: WorkflowIssue[],
  index: number,
): WorkflowIssue[] {
  return issues.filter(
    (i) =>
      i.path[0] === "definition" &&
      i.path[1] === "steps" &&
      i.path[2] === index,
  );
}

function topLevelDefinitionIssues(issues: WorkflowIssue[]): WorkflowIssue[] {
  return issues.filter(
    (i) =>
      i.path[0] === "definition" &&
      !(i.path[1] === "steps" && typeof i.path[2] === "number"),
  );
}
