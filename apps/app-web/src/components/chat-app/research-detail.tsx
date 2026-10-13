"use client";

/**
 * Saved research in Chat (docs/architecture/features/research.md -> "UI"):
 * the card under a research reply, and the side-pane detail it opens -
 * artifact, sources (read vs found), gaps, follow-ups with their label and
 * uncertainty, lessons with scope and support, and the guarded actions
 * (correct a label, decide a lesson, nominate an improvement). Every action
 * goes through the same server commands Brian and the brain MCP use.
 *
 * [COMP:app-web/research-detail]
 */

import { useCallback, useEffect, useState } from "react";
import { FlaskConical } from "lucide-react";
import { Button } from "@/components/ui/button";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { format, useT } from "@/lib/i18n/client";
import {
  correctResearchFeedback,
  decideResearchLesson,
  getResearchActivity,
  listResearchActivities,
  nominateResearchImprovement,
  RESEARCH_CHANGED_EVENT,
  ResearchApiError,
  type ResearchActivityDetail,
  type ResearchActivityRow,
  type ResearchArtifactRow,
  type ResearchFeedbackKind,
  type ResearchLessonRow,
  type ResearchStatus,
} from "@/lib/api/research";

const FEEDBACK_KINDS: ResearchFeedbackKind[] = [
  "correction", "request_correction", "missing_coverage", "preference",
  "deeper_exploration", "changed_objective", "satisfaction", "uncertain",
];

export function announceResearchChanged(): void {
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(RESEARCH_CHANGED_EVENT));
}

/** Saved research of one chat, keyed by the assistant message that delivered it. */
export function useSessionResearch(workspaceId: string | null, sessionId: string | null): Map<string, ResearchActivityRow> {
  const [byMessage, setByMessage] = useState<Map<string, ResearchActivityRow>>(new Map());
  useEffect(() => {
    if (!workspaceId || !sessionId) {
      setByMessage(new Map());
      return;
    }
    let live = true;
    const load = () => {
      listResearchActivities(workspaceId, { sessionId })
        .then(({ activities }) => {
          if (!live) return;
          setByMessage(new Map(activities.filter((a) => a.outputMessageId).map((a) => [a.outputMessageId!, a])));
        })
        .catch(() => {
          // A failed refresh keeps what is shown; a revoked chat lists nothing next time.
        });
    };
    load();
    window.addEventListener(RESEARCH_CHANGED_EVENT, load);
    return () => {
      live = false;
      window.removeEventListener(RESEARCH_CHANGED_EVENT, load);
    };
  }, [workspaceId, sessionId]);
  return byMessage;
}

/** The card under a research reply. */
export function ChatResearchCard({ status, onOpen }: { status: ResearchStatus; onOpen: () => void }) {
  const t = useT().chatApp.research;
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={t.card.open}
      data-research-status={status}
      className="mt-2 flex min-h-11 w-full max-w-sm items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-left text-sm hover:bg-accent md:min-h-9"
    >
      <FlaskConical className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="flex-1 truncate">{t.card[status]}</span>
      <span className="text-xs text-muted-foreground">{t.card.openShort}</span>
    </button>
  );
}

type ViewState =
  | { kind: "loading" }
  | { kind: "ready"; detail: ResearchActivityDetail }
  | { kind: "gone" };

export function ResearchDetail({
  workspaceId,
  activityId,
  onOpenArtifact,
}: {
  workspaceId: string;
  activityId: string;
  onOpenArtifact: (artifact: ResearchArtifactRow) => void;
}) {
  const t = useT().chatApp.research;
  const [state, setState] = useState<ViewState>({ kind: "loading" });
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const detail = await getResearchActivity(workspaceId, activityId);
      setState({ kind: "ready", detail });
    } catch (error) {
      // Revoked or deleted: evict what was shown rather than keep a stale copy.
      if (error instanceof ResearchApiError && error.status === 404) setState({ kind: "gone" });
    }
  }, [workspaceId, activityId]);

  useEffect(() => {
    setState({ kind: "loading" });
    void load();
    const refresh = () => void load();
    window.addEventListener(RESEARCH_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(RESEARCH_CHANGED_EVENT, refresh);
  }, [load]);

  const act = async (work: () => Promise<unknown>) => {
    setBusy(true);
    setNotice(null);
    try {
      await work();
      announceResearchChanged();
    } catch (error) {
      const code = error instanceof ResearchApiError ? error.code : "";
      setNotice(code === "research_stale" ? t.stale : code === "research_forbidden" ? t.forbidden : t.failed);
      await load();
    } finally {
      setBusy(false);
    }
  };

  if (state.kind === "loading") {
    return (
      <div className="space-y-3 p-4" aria-busy="true" aria-label={t.loading}>
        <div className="h-5 w-1/2 animate-pulse rounded bg-muted" />
        <div className="h-16 animate-pulse rounded bg-muted" />
        <div className="h-24 animate-pulse rounded bg-muted" />
      </div>
    );
  }
  if (state.kind === "gone") return <p className="p-4 text-sm text-muted-foreground">{t.unavailable}</p>;

  const { activity, artifacts, feedback, lessons } = state.detail;
  const saveError = activity.saveError
    ? activity.saveError === "research_confidential_floor" ? t.saveErrors.confidential
      : activity.saveError === "awaiting_answer" ? t.saveErrors.awaiting : t.saveErrors.generic
    : null;

  return (
    <div className="space-y-5 p-4 text-sm" data-research-activity={activity.id}>
      <header className="space-y-1">
        <h2 className="text-base font-semibold">{t.title}</h2>
        <p className="text-muted-foreground" data-testid="research-status">{t.status[activity.status]}</p>
        {saveError && <p className="text-muted-foreground" data-testid="research-save-error">{saveError}</p>}
        {notice && <p role="status" className="text-destructive">{notice}</p>}
      </header>

      <section aria-labelledby="research-artifacts">
        <h3 id="research-artifacts" className="mb-1 font-medium">{t.artifacts}</h3>
        <ul className="space-y-1">
          {artifacts.map((a) => (
            <li key={a.id}>
              <button
                type="button"
                className="min-h-11 rounded-md px-2 text-left underline-offset-2 hover:underline md:min-h-8"
                onClick={() => onOpenArtifact(a)}
              >
                {format(t.openArtifact, { kind: t.kinds[a.kind] })}
                {a.relation === "revision" ? ` (${t.revision})` : ""}
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="research-sources">
        <h3 id="research-sources" className="mb-1 font-medium">{t.sources}</h3>
        {activity.sources.length === 0 ? (
          <p className="text-muted-foreground">{t.noSources}</p>
        ) : (
          <ul className="space-y-1">
            {activity.sources.map((s) => (
              <li key={`${s.kind}:${s.ref}`} className="flex items-baseline gap-2">
                <span className="shrink-0 rounded bg-muted px-1.5 text-xs">{s.inspected ? t.sourceRead : t.sourceFound}</span>
                <span className="break-all">{s.title ?? s.ref}</span>
              </li>
            ))}
          </ul>
        )}
        {activity.gaps.length > 0 && (
          <>
            <h4 className="mb-1 mt-3 font-medium">{t.gaps}</h4>
            <ul className="list-disc space-y-1 pl-5">
              {activity.gaps.map((g) => <li key={g} className="break-all">{g}</li>)}
            </ul>
          </>
        )}
      </section>

      <section aria-labelledby="research-followups">
        <h3 id="research-followups" className="mb-1 font-medium">{t.followUps}</h3>
        {feedback.length === 0 ? (
          <p className="text-muted-foreground">{t.noFollowUps}</p>
        ) : (
          <ul className="space-y-3">
            {feedback.map((f) => (
              <li key={f.id} className="space-y-1" data-feedback-id={f.id}>
                <div className="flex flex-wrap items-center gap-2">
                  <Select
                    value={f.kind}
                    onValueChange={(value) => {
                      if (value && value !== f.kind) void act(() => correctResearchFeedback(workspaceId, f.id, value as ResearchFeedbackKind, f.version));
                    }}
                  >
                    <SelectTrigger aria-label={t.labelAria} className="w-48 max-sm:min-h-11" disabled={busy}>
                      <SelectValue>{t.feedbackKinds[f.kind]}</SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {FEEDBACK_KINDS.map((k) => <SelectItem key={k} value={k}>{t.feedbackKinds[k]}</SelectItem>)}
                    </SelectContent>
                  </Select>
                  <span className="text-xs text-muted-foreground">
                    {f.uncertain ? t.uncertain : f.origin === "human" ? t.humanLabel : t.machineLabel}
                  </span>
                </div>
                {f.revisions.some((r) => r.stance === "disagreement") && (
                  <p className="text-xs text-muted-foreground">{t.disagreement}</p>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="research-lessons">
        <h3 id="research-lessons" className="mb-1 font-medium">{t.lessons}</h3>
        {lessons.length === 0 ? (
          <p className="text-muted-foreground">{t.noLessons}</p>
        ) : (
          <ul className="space-y-3">
            {lessons.map((l) => <LessonRow key={l.id} lesson={l} busy={busy} onDecide={(decision) => act(async () => {
              if (decision !== "approve") {
                const ok = await confirmDialog({
                  title: decision === "retire" ? t.retireConfirmTitle : t.rejectConfirmTitle,
                  description: decision === "retire" ? t.retireConfirm : t.rejectConfirm,
                  confirmLabel: decision === "retire" ? t.retire : t.reject,
                  variant: "destructive",
                });
                if (!ok) return;
              }
              await decideResearchLesson(workspaceId, l.id, decision, l.revision);
            })} />)}
          </ul>
        )}
      </section>

      <ImprovementForm
        busy={busy}
        onSubmit={(input) => act(async () => {
          await nominateResearchImprovement(workspaceId, { ...input, feedbackIds: feedback.map((f) => f.id), activityIds: [activity.id] });
          setNotice(t.improvement.done);
        })}
      />
    </div>
  );
}

function LessonRow({ lesson, busy, onDecide }: {
  lesson: ResearchLessonRow;
  busy: boolean;
  onDecide: (decision: "approve" | "reject" | "retire") => void;
}) {
  const t = useT().chatApp.research;
  return (
    <li className="space-y-1 rounded-md border border-border p-2" data-lesson-id={lesson.id}>
      <p>{lesson.rule}</p>
      <p className="text-xs text-muted-foreground">
        {t.scopes[lesson.scope]} · {t.lessonStatus[lesson.status]}
        {lesson.supportCount != null ? ` · ${format(t.support, { count: String(lesson.supportCount) })}` : ""}
      </p>
      <div className="flex flex-wrap gap-2">
        {lesson.status === "suggested" && (
          <>
            <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => onDecide("approve")}>
              {lesson.scope === "workspace" ? t.approveCompany : t.approve}
            </Button>
            <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => onDecide("reject")}>{t.reject}</Button>
          </>
        )}
        {lesson.status === "active" && (
          <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => onDecide("retire")}>{t.retire}</Button>
        )}
      </div>
    </li>
  );
}

function ImprovementForm({ busy, onSubmit }: {
  busy: boolean;
  onSubmit: (input: { title: string; pattern: string; desiredBehavior: string }) => void;
}) {
  const t = useT().chatApp.research.improvement;
  const [title, setTitle] = useState("");
  const [pattern, setPattern] = useState("");
  const [desired, setDesired] = useState("");
  const ready = title.trim().length >= 3 && pattern.trim().length >= 3 && desired.trim().length >= 3;
  const field = "w-full rounded-md border border-border bg-background px-2 py-1.5 text-base md:text-sm";
  return (
    <section aria-labelledby="research-improvement" className="space-y-2">
      <h3 id="research-improvement" className="font-medium">{t.title}</h3>
      <label className="block space-y-1">
        <span className="text-xs text-muted-foreground">{t.fieldTitle}</span>
        <input className={field} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
      </label>
      <label className="block space-y-1">
        <span className="text-xs text-muted-foreground">{t.pattern}</span>
        <textarea className={field} rows={2} value={pattern} onChange={(e) => setPattern(e.target.value)} maxLength={2000} />
      </label>
      <label className="block space-y-1">
        <span className="text-xs text-muted-foreground">{t.desired}</span>
        <textarea className={field} rows={2} value={desired} onChange={(e) => setDesired(e.target.value)} maxLength={2000} />
      </label>
      <Button
        type="button"
        size="sm"
        disabled={busy || !ready}
        onClick={() => {
          onSubmit({ title: title.trim(), pattern: pattern.trim(), desiredBehavior: desired.trim() });
          setTitle("");
          setPattern("");
          setDesired("");
        }}
      >
        {t.submit}
      </Button>
    </section>
  );
}
