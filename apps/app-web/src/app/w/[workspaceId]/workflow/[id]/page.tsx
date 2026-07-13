"use client";

/**
 * Workflow detail page — `/w/[workspaceId]/workflow/[id]` (app-web).
 *
 * Ported from `apps/web/src/app/(app)/workflow/[id]/page.tsx` (app
 * consolidation §5a). Board-centric, single-mode surface: there is no
 * edit/view split. The centerpiece is the WorkflowBoard, an n8n-style
 * illustration of the trigger + step chain; clicking a board node opens
 * that node's editor below and scrolls to it. The name + description are
 * view-styled text that edit in place (`InlineEditableText` — pencil
 * affordance, borderless field on click). "Save changes" is always in the
 * header and stays disabled until the draft actually differs from the
 * saved workflow (there is no Cancel — the draft is the page). "Run now"
 * kicks off a manual run via POST /api/workflows/:id/run, and recent runs
 * stay visible below in a compact list even while editing.
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

import { use, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pencil } from "lucide-react";
import { BackButton } from "@/components/ui/back-button";
import { useRouter } from "next/navigation";
import { useT } from "@/lib/i18n/client";
import { format as fmt } from "@/lib/i18n";
import { useWorkspaces } from "@/contexts/workspace-context";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { requestWorkflowRefresh } from "@/lib/workflow-events";
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
import { ButtonBindingsList, TriggerJobsList } from "@/components/workflow/trigger-jobs-list";
import { RunHistory } from "@/components/workflow/run-history";
import { LiveRunBanner } from "@/components/workflow/live-run-banner";
import {
  fieldUnderlineCls,
  quietFieldCls,
} from "@/components/brain/skill-document";
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
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<WorkflowIssue[]>([]);
  // Non-blocking authoring advisories returned on a successful save (e.g. a
  // research-mode step that will likely fail on snippet/marketplace discovery).
  const [warnings, setWarnings] = useState<WorkflowIssue[]>([]);
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
    if (!selectedKey) return;
    const domId =
      selectedKey === "trigger" ? "wf-trigger-editor" : `wf-step-${selectedKey}`;
    const tid = window.setTimeout(() => {
      document
        .getElementById(domId)
        ?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }, 60);
    return () => window.clearTimeout(tid);
  }, [selectedKey]);

  const refresh = useCallback(() => setRefetchTick((n) => n + 1), []);

  // Single-mode dirty check — the header Save button is the only commit
  // path, enabled exactly when the draft's editable fields differ from the
  // saved workflow. Server-side toggles (enable / pin / restore / webhook
  // rotate) write through immediately and merge into the draft, so they
  // never trip this.
  const dirty = useMemo(() => {
    if (!workflow || !draft) return false;
    return (
      draft.name !== workflow.name ||
      (draft.description ?? "") !== (workflow.description ?? "") ||
      JSON.stringify(draft.definition) !== JSON.stringify(workflow.definition) ||
      JSON.stringify(draft.trigger) !== JSON.stringify(workflow.trigger)
    );
  }, [draft, workflow]);

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

  // ── Board node selection → open that node's editor below the board ───
  const selectStep = (stepId: string) => setSelectedKey(stepId);
  const selectTrigger = () => setSelectedKey("trigger");

  // Server-side writes that bypass the draft (rotate / enable / pin /
  // restore) adopt the fresh server row but graft the draft's editable
  // fields back on, so an in-progress edit is never silently discarded.
  const adoptServerRow = (next: WorkflowFull) => {
    setWorkflow(next);
    setDraft((d) =>
      d
        ? {
            ...next,
            name: d.name,
            description: d.description,
            definition: d.definition,
            trigger: d.trigger,
          }
        : next,
    );
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
    adoptServerRow(result.workflow);
  };

  const onSave = async () => {
    if (!draft) return;
    setError(null);
    setIssues([]);
    setWarnings([]);
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
        if (target === "trigger" || typeof target === "string") {
          setSelectedKey(target);
        }
        // Header errors (name/description) don't change focus — they're
        // already visible at the top.
      }
      return;
    }
    setWorkflow(result.workflow);
    setDraft(result.workflow);
    setWarnings(result.warnings ?? []);
    requestWorkflowRefresh(result.workflow.workspaceId);
    refresh();
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
    if (deleted) {
      requestWorkflowRefresh(workflow.workspaceId);
      router.push(listHref);
    }
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
    adoptServerRow(result.workflow);
    requestWorkflowRefresh(result.workflow.workspaceId);
  };

  // Mig 308 — lifecycle controls: the pin veto and the archived restore.
  const onTogglePinned = async () => {
    setError(null);
    setSaving(true);
    const result = await updateWorkflow(workflow.id, { pinned: !workflow.pinned });
    setSaving(false);
    if (!result.ok) {
      setError(result.error || t.workflowPage.builder.saveFail);
      return;
    }
    adoptServerRow(result.workflow);
  };

  const onRestoreLifecycle = async () => {
    setError(null);
    setSaving(true);
    const result = await updateWorkflow(workflow.id, { lifecycleState: "active" });
    setSaving(false);
    if (!result.ok) {
      setError(result.error || t.workflowPage.builder.saveFail);
      return;
    }
    adoptServerRow(result.workflow);
    requestWorkflowRefresh(result.workflow.workspaceId);
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
            <div className="flex items-center gap-2 min-w-0">
              <InlineEditableText
                value={draft.name}
                onChange={(v) => updateDraft({ name: v })}
                editLabel={t.workflowPage.builder.editNameAction}
                placeholder={t.workflowPage.builder.namePlaceholder}
                maxLength={120}
                hasIssues={nameIssues.length > 0}
                textClassName="text-xl font-semibold"
              />
              <EnabledBadge enabled={workflow.enabled} t={t} />
              {workflow.lifecycleState === "stale" && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-700 dark:text-amber-400 uppercase tracking-wide">
                  {t.workflowPage.lifecycle.staleBadge}
                </span>
              )}
              {workflow.lifecycleState === "archived" && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground uppercase tracking-wide">
                  {t.workflowPage.lifecycle.archivedBadge}
                </span>
              )}
              {workflow.pinned && (
                <span className="text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary uppercase tracking-wide">
                  {t.workflowPage.lifecycle.pinnedBadge}
                </span>
              )}
            </div>
            {nameIssues.length > 0 && (
              <p className="mt-1 text-xs text-red-600 dark:text-red-400">
                {nameIssues.map((i) => i.message).join("; ")}
              </p>
            )}
            {!workflow.enabled && workflow.pausedReason ? (
              <p className="mt-1 text-xs rounded-md border border-amber-300/60 bg-amber-500/10 text-amber-700 dark:text-amber-400 px-2 py-1.5">
                <span className="font-medium">
                  {t.workflowPage.builder.stormPausedTitle}
                </span>{" "}
                {workflow.pausedReason}
              </p>
            ) : null}
            {workflow.lifecycleState !== "active" && workflow.lifecycleReason ? (
              <p className="mt-1 text-xs text-muted-foreground">
                {workflow.lifecycleReason}
              </p>
            ) : null}
            <InlineEditableText
              value={draft.description ?? ""}
              onChange={(v) => updateDraft({ description: v || null })}
              editLabel={t.workflowPage.builder.editDescriptionAction}
              placeholder={t.workflowPage.builder.descriptionPlaceholder}
              maxLength={2000}
              multiline
              hasIssues={descriptionIssues.length > 0}
              textClassName="text-sm text-muted-foreground"
              className="mt-1"
            />
            {descriptionIssues.length > 0 && (
              <p className="mt-1 text-xs text-red-600 dark:text-red-400">
                {descriptionIssues.map((i) => i.message).join("; ")}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {workflow.lifecycleState === "archived" && (
              <button
                type="button"
                onClick={onRestoreLifecycle}
                disabled={saving}
                className="px-3 py-1.5 rounded-md border border-border text-sm font-medium hover:bg-muted disabled:opacity-50"
              >
                {t.workflowPage.lifecycle.restore}
              </button>
            )}
            <button
              type="button"
              onClick={onTogglePinned}
              disabled={saving}
              title={
                workflow.pinned
                  ? t.workflowPage.lifecycle.unpinHint
                  : t.workflowPage.lifecycle.pinHint
              }
              aria-pressed={workflow.pinned ?? false}
              className={cn(
                "p-1.5 rounded-md border text-sm disabled:opacity-50 transition-colors",
                workflow.pinned
                  ? "border-primary/50 bg-primary/10 text-primary"
                  : "border-border text-muted-foreground hover:bg-muted",
              )}
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill={workflow.pinned ? "currentColor" : "none"}
                stroke="currentColor"
                strokeWidth="1.85"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <path d="M12 17v5" />
                <path d="M9 3h6l-1 7 3 3H7l3-3-1-7Z" />
              </svg>
            </button>
            <button
              type="button"
              onClick={onRunNow}
              disabled={running || !workflow.enabled}
              className="px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 disabled:opacity-50"
            >
              {running ? t.workflowPage.builder.running : t.workflowPage.builder.runNowBtn}
            </button>
            <button
              type="button"
              onClick={onSave}
              disabled={saving || !dirty}
              className="px-3 py-1.5 rounded-md bg-primary text-primary-foreground text-sm font-medium hover:opacity-90 disabled:opacity-50"
            >
              {saving ? t.workflowPage.builder.saving : t.workflowPage.builder.saveChanges}
            </button>
          </div>
        </div>

        {dirty && !saving && (
          <div className="text-xs text-amber-600 dark:text-amber-400">
            {t.workflowPage.builder.unsavedChanges}
          </div>
        )}
        {runMessage && !liveView && (
          <div className="text-xs text-green-700 dark:text-green-400">{runMessage}</div>
        )}
        {error && <div className="text-xs text-red-600 dark:text-red-400">{error}</div>}
        {warnings.length > 0 && (
          <div className="text-xs rounded-md border border-amber-300/60 bg-amber-500/10 text-amber-700 dark:text-amber-400 px-2 py-1.5">
            <p className="font-medium">{t.workflowPage.builder.advisoryTitle}</p>
            <ul className="mt-1 list-disc pl-4 space-y-0.5">
              {warnings.map((w, i) => (
                <li key={i}>{w.message}</li>
              ))}
            </ul>
          </div>
        )}
      </header>

      {/* Live activity — visible whenever a run is in flight (Run now,
          schedule, webhook or event), so the user sees which step the
          assistant is working on instead of a silent board. A run paused on
          an approval resolves right here (Approve / Reject in the banner). */}
      {liveView && (
        <LiveRunBanner
          workspaceId={workspaceId}
          workflowId={workflow.id}
          view={liveView}
          definition={workflow.definition}
          assistants={assistants}
          onApprovalResolved={pollNow}
        />
      )}

      {/* Board — the n8n-style illustration. Always visible; reflects the
          live draft. Clicking a node opens its editor. */}
      <WorkflowBoard
        definition={draft.definition}
        trigger={draft.trigger}
        assistants={assistants}
        pages={pages}
        selectedKey={selectedKey}
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

      {/* Page-action buttons that fire this workflow (mig 321) — the second
          honesty block: "shows Manual but runs from a button" must be
          visible here, same discipline as the trigger-jobs reality check. */}
      {workflow.buttonBindings && workflow.buttonBindings.length > 0 && (
        <ButtonBindingsList bindings={workflow.buttonBindings} />
      )}

      {/* Editor panel — always live (no edit mode). Shows only the editor
          for the node focused on the board (the trigger or a single step);
          nothing selected keeps the page at board + runs. */}
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

        {selectedKey && (
          <>
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
          </>
        )}
      </div>

      {/* Recent runs — always visible (compact), even mid-edit. */}
      <RunHistory
        workspaceId={workspaceId}
        workflowId={workflow.id}
        runs={runs}
      />

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

/**
 * View-styled text that edits in place. Reads as ordinary page copy (the
 * h1 / description look) with a pencil affordance revealed on hover/focus;
 * clicking swaps in a borderless field with identical typography (the
 * skill-document quiet-field treatment), autofocused, closed on blur /
 * Enter / Escape. The value binds straight to the page draft — persistence
 * stays with the header Save button, so "closing" the field never loses or
 * commits anything by itself.
 */
function InlineEditableText({
  value,
  onChange,
  editLabel,
  placeholder,
  maxLength,
  multiline = false,
  hasIssues = false,
  textClassName,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  editLabel: string;
  placeholder: string;
  maxLength: number;
  multiline?: boolean;
  hasIssues?: boolean;
  textClassName: string;
  className?: string;
}) {
  const [editing, setEditing] = useState(false);
  const fieldRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (editing) fieldRef.current?.focus();
  }, [editing]);

  // A validation issue forces the field open — the fix happens here.
  const open = editing || hasIssues;

  const fieldCls = cn(
    quietFieldCls,
    "w-full bg-transparent p-0 placeholder:text-muted-foreground/60",
    textClassName,
  );
  const closeOnKey = (e: React.KeyboardEvent) => {
    if (e.key === "Escape" || (e.key === "Enter" && !multiline)) {
      e.preventDefault();
      setEditing(false);
    }
  };

  if (open) {
    return (
      <div
        className={cn(
          "flex-1 min-w-0",
          fieldUnderlineCls,
          hasIssues && "after:scale-x-100 after:from-red-500 after:via-red-500/40",
          className,
        )}
      >
        {multiline ? (
          <textarea
            ref={(el) => {
              fieldRef.current = el;
            }}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onBlur={() => setEditing(false)}
            onKeyDown={closeOnKey}
            placeholder={placeholder}
            rows={Math.max(2, value.split("\n").length)}
            maxLength={maxLength}
            className={cn(fieldCls, "resize-none")}
          />
        ) : (
          <input
            ref={(el) => {
              fieldRef.current = el;
            }}
            type="text"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onBlur={() => setEditing(false)}
            onKeyDown={closeOnKey}
            placeholder={placeholder}
            maxLength={maxLength}
            // Plain label field — keep browser autofill and password
            // managers (1Password / LastPass / Dashlane) off it.
            autoComplete="off"
            data-1p-ignore="true"
            data-lpignore="true"
            data-form-type="other"
            className={fieldCls}
          />
        )}
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => setEditing(true)}
      aria-label={editLabel}
      title={editLabel}
      className={cn(
        "group flex gap-1.5 min-w-0 max-w-full text-left rounded-sm",
        multiline ? "items-start" : "items-center",
        className,
      )}
    >
      <span
        className={cn(
          multiline ? "whitespace-pre-wrap break-words" : "truncate",
          textClassName,
          !value && "italic text-muted-foreground/60",
        )}
      >
        {value || placeholder}
      </span>
      <Pencil
        className="size-3.5 shrink-0 text-muted-foreground/70 opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 transition-opacity"
        aria-hidden
      />
    </button>
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
