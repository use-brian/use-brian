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
 * Instant navigation (N1-N3, `[COMP:app-web/workflow-detail-cache]`): the
 * full row reads `workflowDetailCacheKey(wid, id)` through
 * `useCachedResource`, so a revisit paints on the first frame and the spine
 * (`WORKFLOW_REFRESH_EVENT` -> `workflow-detail:<wid>:`) revalidates behind
 * it. A cold entry seeds the header from the `workflow:<wid>` list row the
 * user just came from and paints a board skeleton below, never a "…". The
 * definition is an EDITABLE DRAFT: a revalidated row is adopted only while
 * the draft is clean (realtime-sync.md -> "Editable-draft surfaces"), so an
 * in-progress edit is never clobbered. Assistants share the Studio
 * `assistants:<wid>` slot.
 *
 * Spec: docs/architecture/features/workflow.md → "Board view".
 * [COMP:app-web/workflow]
 */

import { use, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Pencil } from "lucide-react";
import { BackButton } from "@/components/ui/back-button";
import { Button } from "@/components/ui/button";
import { leaseSurfaceContent, surfaceContentRemaining, useSurfaceContentRenewal } from "@/lib/offline/surface-content-cache";
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
  listConnectedWorkflowToolSources,
  listWorkspaceChannelOptions,
  listWorkspaceSlackChannels,
  runWorkflowNow,
  updateWorkflow,
  type ChannelDestination,
  type SlackChannelOption,
  type WorkspaceChannelOption,
  type WorkflowFull,
  type WorkflowIssue,
  type WorkflowStep,
  type WorkflowSummary,
  type WorkflowTrigger,
} from "@/lib/api/workflow";
import { useWorkflowLiveRun } from "@/lib/workflow-live-run";
import { listAssistants, type StudioAssistantSummary } from "@/lib/api/studio";
import {
  mutateSurfaceCache,
  readSurfaceCache,
  useCachedResource,
} from "@/lib/surface-cache";
import {
  assistantsCacheKey,
  surfaceDataKey,
  workflowDetailCacheKey,
} from "@/lib/surface-prefetch";
import { Skeleton } from "@/components/skeleton";
import { Switch } from "@/components/ui/switch";
import {
  listCustomPageTemplates,
  listViews,
  type ViewListRow,
} from "@/lib/api/views";
import type { CustomPageTemplateSummary } from "@use-brian/doc-model";
import { listWorkspaceSkills, type WorkspaceSkillSummary } from "@/lib/api/skills";
import { WorkflowPublicationConsent } from "@/components/workflow/publication-consent";
import { WorkflowBoard } from "@/components/workflow/workflow-board";
import {
  MAX_FAN_OUT_WIDTH,
  connectEdge,
  removeStep as removeStepFromDefinition,
} from "@/lib/workflow-canvas";
import { buildToolCatalog } from "@/lib/workflow-tools";
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
import { ContextScopePicker } from "@/components/context/context-scope-picker";
import {
  listContextProjects,
  listContextTeams,
  type ContextProject,
  type ContextTeam,
} from "@/lib/api/context-scopes";
import { useLeasedResource } from "@/lib/offline/surface-content-cache";

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

  // The full row, cache-backed. `workflow` below is the SAVED baseline the
  // page has adopted and `draft` the editable copy; the adopt effect (after
  // the dirty check) is the only bridge from the cache into them.
  const detailKey = workflowDetailCacheKey(workspaceId, id);
  // Content lease (perceived-performance.md, "Content lease for protected
  // lists"): a denied (null) or unrenewed definition leaves the cache within
  // 30 seconds, and the page stops rendering it below.
  const detail = useCachedResource<WorkflowFull | null>(detailKey, () =>
    leaseSurfaceContent(() => getWorkflowFull(id)),
    { expiresInMs: surfaceContentRemaining },
  );
  useSurfaceContentRenewal(detail.refresh);
  // The list row the user came from (the rail hover / list page already
  // filled `workflow:<wid>`): seeds the header on a cold entry. A plain read,
  // not a subscription - it is only a seed, and the list is never fetched on
  // the detail page's behalf.
  const listKey = surfaceDataKey("workflow", workspaceId);
  const listRow = useMemo(
    () =>
      readSurfaceCache<WorkflowSummary[]>(listKey).data?.find((w) => w.id === id) ??
      null,
    [listKey, id],
  );

  const [workflow, setWorkflow] = useState<WorkflowFull | null | undefined>(undefined);
  const [draft, setDraft] = useState<WorkflowFull | null>(null);
  /** The cache value most recently adopted into `workflow` / `draft`. */
  const adoptedRef = useRef<WorkflowFull | null | undefined>(undefined);
  // Assistants for the picker + board node labels: the Studio `assistants:`
  // slot, filtered to this workspace like Studio does.
  const assistantsRes = useLeasedResource<StudioAssistantSummary[]>(
    activeId ? assistantsCacheKey(activeId) : null,
    () => listAssistants(activeId as string),
  );
  const assistantRows = assistantsRes.data;
  const assistants = useMemo(
    () => (assistantRows ?? []).filter((a) => a.workspaceId === activeId),
    [assistantRows, activeId],
  );
  const [destinations, setDestinations] = useState<ChannelDestination[]>([]);
  const [channelOptions, setChannelOptions] = useState<WorkspaceChannelOption[]>([]);
  const [slackChannels, setSlackChannels] = useState<SlackChannelOption[]>([]);
  const [pages, setPages] = useState<ViewListRow[]>([]);
  const [blueprints, setBlueprints] = useState<CustomPageTemplateSummary[]>([]);
  const [skills, setSkills] = useState<WorkspaceSkillSummary[]>([]);
  const [toolGroups, setToolGroups] = useState(() => buildToolCatalog([]));
  const [contextTeams, setContextTeams] = useState<ContextTeam[]>([]);
  const [contextProjects, setContextProjects] = useState<ContextProject[]>([]);
  // Origin-aware induction: skills distilled from THIS workflow's runs —
  // derived from the same workspace-skills list the SkillsField uses.
  const learnedSkills = useMemo(
    () => skills.filter((s) => s.learnedFromWorkflowId === id),
    [skills, id],
  );
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<WorkflowIssue[]>([]);
  // Non-blocking authoring advisories returned on a successful save (e.g. a
  // research-mode step that will likely fail on snippet/marketplace discovery).
  const [warnings, setWarnings] = useState<WorkflowIssue[]>([]);
  const [runMessage, setRunMessage] = useState<string | null>(null);
  /**
   * Snapshot armed by the most recent step removal, offered as Undo. Cleared
   * by ANY other edit and by a successful save: restoring a stale snapshot
   * would silently discard whatever the user did in between, so Undo is only
   * ever offered for a removal that is still the last thing that happened.
   */
  const [undoRemove, setUndoRemove] = useState<{
    definition: WorkflowFull["definition"];
    selectedKey: string | null;
  } | null>(null);

  // Recent runs + live-run overlay. The hook owns the runs list (poll-based:
  // 2.5 s while a run is executing, 15 s idle, so a schedule/webhook fire
  // lights the board up too). `running` (the Run-now POST in flight) keeps
  // the fast cadence through the gap before the new run row is visible.
  const { runs, liveView, pollNow } = useWorkflowLiveRun(id, {
    forceActive: running,
  });

  useEffect(() => {
    if (!activeId) return;
    let cancelled = false;
    Promise.all([listContextTeams(activeId), listContextProjects(activeId)])
      .then(([teams, projects]) => {
        if (!cancelled) { setContextTeams(teams); setContextProjects(projects); }
      })
      .catch(() => {
        if (!cancelled) { setContextTeams([]); setContextProjects([]); }
      });
    return () => { cancelled = true; };
  }, [activeId]);

  // Load only connector tools actually available to this workspace. Official
  // catalogs are static; custom MCP catalogs are discovered live by the API
  // helper. Built-in first-party tools remain available if this fetch fails.
  useEffect(() => {
    if (!activeId) {
      setToolGroups(buildToolCatalog([]));
      return;
    }
    // Clear the prior workspace immediately; never flash its connector names
    // while the next workspace inventory is loading.
    setToolGroups(buildToolCatalog([]));
    let cancelled = false;
    void (async () => {
      try {
        const sources = await listConnectedWorkflowToolSources(activeId, assistants[0]?.id);
        if (!cancelled) setToolGroups(buildToolCatalog(sources));
      } catch {
        if (!cancelled) setToolGroups(buildToolCatalog([]));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [activeId, assistants]);

  // Load recent chat destinations for the per-step `deliver.channelId` dropdown.
  useEffect(() => {
    if (!activeId) return;
    let cancelled = false;
    void (async () => {
      const [destinationList, channelList] = await Promise.all([
        listChannelDestinations(activeId),
        listWorkspaceChannelOptions(activeId),
      ]);
      if (!cancelled) {
        setDestinations(destinationList);
        setChannelOptions(channelList);
      }
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

  const refresh = detail.refresh;

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

  // Adopt the cached / revalidated row into the page (the editable-draft
  // rule, realtime-sync.md). The spine marks `workflow-detail:<wid>:` stale
  // on every workflow signal and the hook refetches behind the paint; the
  // fresh row lands here and is adopted ONLY while the draft is clean, so an
  // in-progress edit is never clobbered. A dirty draft keeps its edits AND
  // its baseline until the user saves (which adopts the save result) or
  // reverts (dirty flips false and the newest row is adopted then). A row
  // older than the one already on screen is never adopted - the server
  // toggles write the fresh row into the cache and `adoptedRef` first.
  const cached = detail.data;
  useEffect(() => {
    if (cached === undefined) return;
    if (cached === adoptedRef.current) return;
    if (workflow !== undefined && dirty) return;
    const previous = adoptedRef.current;
    if (
      cached &&
      previous &&
      Date.parse(cached.updatedAt) < Date.parse(previous.updatedAt)
    ) {
      return;
    }
    adoptedRef.current = cached;
    setWorkflow(cached);
    setDraft(cached);
  }, [cached, dirty, workflow]);

  // Cold entry (nothing cached for this row yet): the frame paints at once -
  // header seeded from the list row when the user came from the list, a
  // board-shaped skeleton below - never a "…" (N4). A cold load that failed
  // outright falls through to the not-found block.
  if (workflow === undefined && detail.error === undefined) {
    return (
      <WorkflowDetailEntrySkeleton
        listHref={listHref}
        listRow={listRow}
        backLabel={t.workflowPage.detail.backToList}
        disabledLabel={t.workflowPage.builder.disabledLabel}
      />
    );
  }

  // Authority lapsed or was denied after the definition was on screen. Stop
  // showing it; any unsaved draft stays in state (not rendered) until the user
  // leaves, and comes back if a retry succeeds while the draft is dirty.
  if (workflow && detail.data === undefined && detail.error !== undefined) {
    return (
      <div className="w-full px-6 py-20 text-center flex flex-col items-center gap-3" role="status">
        <div className="font-medium">{t.workflowPage.detail.unavailableTitle}</div>
        <p className="max-w-md text-sm text-muted-foreground">{t.workflowPage.detail.unavailableHint}</p>
        <div className="flex flex-wrap justify-center gap-2">
          <Button type="button" variant="outline" className="max-sm:min-h-11" onClick={() => void detail.refresh()}>
            {t.workflowPage.detail.unavailableRetry}
          </Button>
          <BackButton href={listHref} label={t.workflowPage.detail.backToList} />
        </div>
      </div>
    );
  }

  if (workflow === undefined || workflow === null || !draft) {
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
    setUndoRemove(null);
    setDraft((d) => {
      if (!d) return d;
      const steps = d.definition.steps.slice();
      steps[idx] = next;
      return { ...d, definition: { ...d.definition, steps } };
    });
  };

  // Canvas edits (node drop, wire connect, edge removal) hand back a whole
  // rewired definition — same draft, same dirty check, same Save path.
  const updateDefinition = (definition: WorkflowFull["definition"]) => {
    setUndoRemove(null);
    setDraft((d) => (d ? { ...d, definition } : d));
  };

  const moveStep = (idx: number, dir: -1 | 1) => {
    setUndoRemove(null);
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

  /**
   * Remove a step. The graph edit lives in `removeStep` (workflow-canvas),
   * which HEALS the wiring around the step: every predecessor is bridged to
   * the step's successors and the non-wiring references (`page.fromStep`,
   * `deliver.thread.fromStep`) are cleared. Skipping that heal leaves a
   * reference the schema refuses on Save and the board cannot render for the
   * user to repair, so the draft becomes a dead end.
   */
  const removeStepById = (stepId: string) => {
    const result = removeStepFromDefinition(draft.definition, stepId);
    if (!result.ok) {
      setError(
        result.reason === "last"
          ? t.workflowPage.board.removeStepRefusedLast
          : t.workflowPage.board.removeStepRefusedWidth.replace(
              "{n}",
              String(MAX_FAN_OUT_WIDTH),
            ),
      );
      return;
    }
    commitStepRemoval(result.definition, stepId);
  };

  /**
   * Adopt a healed definition and arm Undo. Removal is draft-only (nothing
   * persists until Save), so it is gated by a reversible Undo rather than a
   * confirmation dialog.
   */
  const commitStepRemoval = (
    definition: WorkflowFull["definition"],
    removedStepId: string,
  ) => {
    setError(null);
    setUndoRemove({ definition: draft.definition, selectedKey });
    setDraft({ ...draft, definition });
    // Keep a surviving step focused so the editor panel doesn't go blank.
    const idx = draft.definition.steps.findIndex((s) => s.id === removedStepId);
    const survivors = definition.steps;
    setSelectedKey(
      survivors[Math.min(Math.max(idx, 0), survivors.length - 1)]?.id ?? null,
    );
  };

  const undoStepRemoval = () => {
    if (!undoRemove) return;
    setDraft((d) => (d ? { ...d, definition: undoRemove.definition } : d));
    setSelectedKey(undoRemove.selectedKey);
    setUndoRemove(null);
  };

  const addStep = () => {
    setUndoRemove(null);
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

  /**
   * Wire `stepId` -> `targetStepId` from the step editor's "Connect to" row
   * (the non-drag path, responsive contract M9). Same `connectEdge` as the
   * board's port drag, so the refusals are identical; they surface in the
   * header error line since the editor sits below the board.
   */
  const connectStep = (
    stepId: string,
    targetStepId: string,
    port?: "true" | "false",
  ) => {
    const result = connectEdge(
      draft.definition,
      { kind: "step", stepId, port },
      targetStepId,
    );
    if (!result.ok) {
      const bd = t.workflowPage.board;
      setError(
        result.reason === "cycle"
          ? bd.wireRefusedCycle
          : result.reason === "width"
            ? bd.wireRefusedWidth.replace("{n}", String(MAX_FAN_OUT_WIDTH))
            : result.reason === "self"
              ? bd.wireRefusedSelf
              : bd.wireRefusedDuplicate,
      );
      return;
    }
    setError(null);
    updateDefinition(result.definition);
  };

  // ── Board node selection → open that node's editor below the board ───
  const selectStep = (stepId: string) => setSelectedKey(stepId);
  const selectTrigger = () => setSelectedKey("trigger");

  // Server-side writes that bypass the draft (rotate / enable / pin /
  // restore) adopt the fresh server row but graft the draft's editable
  // fields back on, so an in-progress edit is never silently discarded.
  // The row is written into the cache and marked adopted FIRST, so the
  // adopt effect never sees the pre-write cached row as "newer".
  const adoptServerRow = (next: WorkflowFull) => {
    adoptedRef.current = next;
    mutateSurfaceCache<WorkflowFull | null>(detailKey, () => next);
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
      contextGroupId: draft.contextGroupId,
      contextProjectId: draft.contextProjectId,
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
    // The save result is the newest row: cache + adopt it before the spine
    // signal below marks the key stale and the revalidation (which also
    // brings `triggerJobs` back) lands behind it.
    adoptedRef.current = result.workflow;
    mutateSurfaceCache<WorkflowFull | null>(detailKey, () => result.workflow);
    setWorkflow(result.workflow);
    setDraft(result.workflow);
    setUndoRemove(null);
    setWarnings(result.warnings ?? []);
    requestWorkflowRefresh(result.workflow.workspaceId);
    void refresh();
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
    // terminates. History appears once canonical source evidence is captured.
    pollNow();
    const result = await runWorkflowNow(workflow.id, {});
    setRunning(false);
    pollNow();
    if (!result) {
      setError(t.workflowPage.builder.runFail);
      return;
    }
    if ("unavailable" in result) {
      setError(t.workflowPage.builder.runResultUnavailable);
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
    <div className="w-full h-full overflow-y-auto px-4 md:px-6 pt-4 md:pt-6 pb-28 flex flex-col gap-6 [&>*]:shrink-0">
      <BackButton href={listHref} label={t.workflowPage.detail.backToList} />

      <header className="flex flex-col gap-3">
        {/* Title block, then the action cluster on its own line below `sm`
            (C 8): at 360px the cluster is wider than the room the name has. */}
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
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
              // 16px below `md` so the in-place field does not zoom iOS (M4);
              // the view-mode copy shares the class so nothing jumps on edit.
              textClassName="text-[16px] md:text-sm text-muted-foreground"
              className="mt-1"
            />
            {descriptionIssues.length > 0 && (
              <p className="mt-1 text-xs text-red-600 dark:text-red-400">
                {descriptionIssues.map((i) => i.message).join("; ")}
              </p>
            )}
            {/* Origin-aware induction: skills the curator distilled from
                this workflow's runs (`learned_from` edge, skill → workflow).
                Each links into the skill editor; the step editor's Skills
                field below is where one gets attached. */}
            {learnedSkills.length > 0 && (
              <div className="mt-2 flex flex-col gap-1">
                <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
                  {t.workflowPage.detail.learnedSkillsTitle}
                </span>
                <div className="flex flex-wrap gap-1.5">
                  {learnedSkills.map((s) => (
                    <Link
                      key={s.rowId}
                      href={`/w/${workspaceId}/brain/skills/${s.rowId}`}
                      className="text-xs px-2 py-0.5 rounded border border-border hover:bg-muted truncate max-w-[16rem]"
                    >
                      {s.name}
                    </Link>
                  ))}
                </div>
                <span className="text-[11px] text-muted-foreground">
                  {t.workflowPage.detail.learnedSkillsHint}
                </span>
              </div>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2 shrink-0">
            {/* Enabled switch (C 9): the one on/off control, in the header
                where it is reachable, not a 12px link at the page foot. The
                label is the 44px target on a phone; the switch keeps the
                primitive's geometry. */}
            <label className="inline-flex min-h-11 sm:min-h-0 items-center gap-2 pr-1 text-xs text-muted-foreground cursor-pointer">
              <Switch
                checked={workflow.enabled}
                onCheckedChange={() => void onToggleEnabled()}
                disabled={saving}
                aria-label={t.workflowPage.builder.enabledSwitch}
              />
              {t.workflowPage.builder.enabledSwitch}
            </label>
            {workflow.lifecycleState === "archived" && (
              <button
                type="button"
                onClick={onRestoreLifecycle}
                disabled={saving}
                className="inline-flex h-11 sm:h-8 items-center px-3 rounded-md border border-border text-sm font-medium hover:bg-muted disabled:opacity-50"
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
                "inline-flex size-11 sm:size-8 items-center justify-center rounded-md border text-sm disabled:opacity-50 transition-colors",
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
              className="inline-flex h-11 sm:h-8 items-center px-3 rounded-md bg-action text-action-foreground text-sm font-medium hover:opacity-90 disabled:opacity-50"
            >
              {running ? t.workflowPage.builder.running : t.workflowPage.builder.runNowBtn}
            </button>
            <button
              type="button"
              onClick={onSave}
              disabled={saving || !dirty}
              className="inline-flex h-11 sm:h-8 items-center px-3 rounded-md bg-action text-action-foreground text-sm font-medium hover:opacity-90 disabled:opacity-50"
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
        {undoRemove && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span>{t.workflowPage.builder.stepRemoved}</span>
            <button
              type="button"
              onClick={undoStepRemoval}
              className="font-medium text-foreground underline hover:no-underline"
            >
              {t.workflowPage.builder.undoRemoveStep}
            </button>
          </div>
        )}
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

      <section className="rounded-xl border border-border bg-card p-4">
        <div className="mb-3">
          <h2 className="text-sm font-semibold">{t.contextScope.workflowContextTitle}</h2>
          <p className="text-xs text-muted-foreground">{t.contextScope.workflowContextDescription}</p>
        </div>
        <ContextScopePicker
          teams={contextTeams}
          projects={contextProjects}
          teamId={draft.contextGroupId ?? null}
          projectId={draft.contextProjectId ?? null}
          onTeamChange={(contextGroupId) => updateDraft({ contextGroupId })}
          onProjectChange={(contextProjectId) => updateDraft({ contextProjectId })}
          disabled={Boolean(draft.managedBy)}
        />
      </section>

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

      <WorkflowPublicationConsent workflow={workflow} dirty={dirty || saving} />

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
        onRemoveStep={commitStepRemoval}
        onDefinitionChange={updateDefinition}
        editable={!draft.managedBy}
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
            className="inline-flex h-11 sm:h-7 items-center px-3 text-xs rounded border border-border hover:bg-muted"
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
                failureDelivery={draft.definition.failureDelivery}
                onFailureDeliveryChange={(failureDelivery) =>
                  updateDefinition({ ...draft.definition, failureDelivery })
                }
                destinations={destinations}
                channelOptions={channelOptions}
                slackChannels={slackChannels}
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
                channelOptions={channelOptions}
                slackChannels={slackChannels}
                pages={pages}
                blueprints={blueprints}
                skills={skills}
                toolGroups={toolGroups}
                steps={draft.definition.steps}
                onChange={(next) => updateStep(selectedStepIdx, next)}
                onMoveUp={() => moveStep(selectedStepIdx, -1)}
                onMoveDown={() => moveStep(selectedStepIdx, 1)}
                onRemove={() => removeStepById(selectedStep.id)}
                onConnect={
                  draft.managedBy
                    ? undefined
                    : (target, port) => connectStep(selectedStep.id, target, port)
                }
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

      {/* Footer actions. Enable / Disable moved into the header switch. */}
      <div className="flex items-center justify-end pt-2 border-t border-border">
        <button
          type="button"
          onClick={onDelete}
          className="inline-flex h-11 sm:h-7 items-center px-2 text-xs text-red-600 dark:text-red-400 hover:underline"
        >
          {t.workflowPage.builder.deleteBtn}
        </button>
      </div>
    </div>
  );
}

/**
 * The cold-entry frame (instant-navigation N4): Back, the header seeded from
 * the list row when there is one (name, disabled badge, description) or a
 * title-shaped bar when there is not, and a board-shaped skeleton (three
 * node cards on a wire) where the canvas will land. Geometry matches the
 * real page so the swap-in does not jump.
 */
function WorkflowDetailEntrySkeleton({
  listHref,
  listRow,
  backLabel,
  disabledLabel,
}: {
  listHref: string;
  listRow: WorkflowSummary | null;
  backLabel: string;
  disabledLabel: string;
}) {
  return (
    <div
      className="w-full h-full overflow-y-auto px-4 md:px-6 pt-4 md:pt-6 pb-28 flex flex-col gap-6 [&>*]:shrink-0 animate-fade-in"
      data-testid="workflow-detail-entry"
    >
      <BackButton href={listHref} label={backLabel} />
      <header className="flex flex-col gap-3">
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
          <div className="flex-1 min-w-0">
            {listRow ? (
              <>
                <div className="flex items-center gap-2 min-w-0">
                  <h1 className="text-xl font-semibold truncate">{listRow.name}</h1>
                  {!listRow.enabled && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground uppercase tracking-wide">
                      {disabledLabel}
                    </span>
                  )}
                </div>
                {listRow.description ? (
                  <p className="mt-1 text-[16px] md:text-sm text-muted-foreground whitespace-pre-wrap break-words">
                    {listRow.description}
                  </p>
                ) : null}
              </>
            ) : (
              <>
                <Skeleton className="h-6 w-56 max-w-full" />
                <Skeleton className="mt-2 h-3.5 w-80 max-w-full" />
              </>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2 shrink-0">
            <Skeleton className="h-11 sm:h-8 w-20 rounded-md" />
            <Skeleton className="h-11 sm:h-8 w-24 rounded-md" />
          </div>
        </div>
      </header>
      <div className="rounded-xl border border-border bg-muted/20 p-10 overflow-hidden">
        <div className="flex items-center gap-20">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="relative flex shrink-0 items-start gap-2.5 rounded-xl border border-border bg-card p-3 w-[210px] h-[84px]">
              <Skeleton className="size-8 rounded-lg" />
              <div className="flex min-w-0 flex-1 flex-col gap-2 pt-0.5">
                <Skeleton className="h-2.5 w-14" />
                <Skeleton className="h-3.5 w-3/4" />
                <Skeleton className="h-3 w-1/2" />
              </div>
              {i < 2 && (
                <Skeleton className="absolute -right-20 top-1/2 h-0.5 w-20 rounded-none" />
              )}
            </div>
          ))}
        </div>
      </div>
      <div className="flex justify-end">
        <Skeleton className="h-11 sm:h-7 w-24 rounded" />
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
      {/* Touch reveal (M2 / C 58): a dim pencil is always there below `md`
          so the title reads as editable; hover / focus reveal above it. */}
      <Pencil
        className="size-3.5 shrink-0 text-muted-foreground/70 opacity-60 md:opacity-0 md:group-hover:opacity-100 md:group-focus-visible:opacity-100 transition-opacity"
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
