"use client";

// [COMP:app-web/entry-reader]
/**
 * Brain entry reader — `/w/[workspaceId]/brain/entry/[kind]/[id]`.
 *
 * The full-page reading + review surface for brain entries, built for
 * non-technical members (docs/architecture/features/knowledge-base.md →
 * "Knowledge reader + edit proposals"). The `EntryReader` shell is
 * kind-generic; this page wires the per-kind adapters:
 *
 *   knowledge — rendered markdown with clickable wikilinks (rewritten by
 *     `lib/kb-wikilinks.ts`, resolved against the entry's `related`
 *     refs), an ego-network connections graph, source provenance, and
 *     the **Suggest an edit** flow: edit the body + a comment → `POST
 *     /entries/:id/proposals` opens a PR on the source repo through its
 *     bound GitHub connector. A read-only PAT greys the button
 *     (capability probe `GET /entries/:id/edit-capability`); the DB row
 *     is never written here — the repo stays the source of truth.
 *
 *   memories — summary as title, detail as body, the same connections
 *     graph. Read-only (governance lives in the drawer / Reviews queue).
 *
 * Entity kinds keep their own page (`/brain/[entityId]`); graph-node
 * clicks route there. Reached from the Brain detail drawer's "Open full
 * page" affordance and from wikilink / connections navigation.
 */

import { use, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useRouter } from "next/navigation";
import Markdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { ExternalLink, GitPullRequestArrow, Pencil } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT, format } from "@/lib/i18n/client";
import { useWorkspaces } from "@/contexts/workspace-context";
import { getActiveAssistantId } from "@/lib/sidebar-cache";
import {
  getBrainGraph,
  getKnowledgeEditCapability,
  getKnowledgeEntry,
  proposeKnowledgeEdit,
  type BrainGraph,
  type BrainGraphNode,
  type KnowledgeEditCapability,
  type KnowledgeEntryDetail,
} from "@/lib/api/brain";
import { fetchBrainRow, type BrainInboxRowDetail } from "@/lib/api/brain-inbox";
import {
  KB_WIKILINK_SCHEME,
  resolveWikilinkTarget,
  rewriteWikilinks,
} from "@/lib/kb-wikilinks";
import {
  EntryReader,
  ReaderPropRow,
  ReaderRailCard,
  SensitivityBadge,
} from "@/components/brain/entry-reader";
import { ConnectionsGraph } from "@/components/brain/connections-graph";
import { BrainTopbar } from "@/components/brain/brain-topbar";
import { Button } from "@/components/ui/button";

type ReaderKind = "knowledge" | "memories";

/**
 * react-markdown's default URL sanitizer only admits http(s)/mailto-style
 * protocols, so the rewritten `kbwiki:` hrefs were stripped before the
 * link renderer ever saw them (every wikilink rendered as the broken-link
 * span). Admit the wikilink scheme explicitly; everything else keeps the
 * default sanitization.
 */
function kbUrlTransform(url: string): string {
  return url.startsWith(KB_WIKILINK_SCHEME) ? url : defaultUrlTransform(url);
}

/** KB markdown is GFM-authored (tables, strikethrough, task lists). */
const KB_REMARK_PLUGINS = [remarkGfm];

function isReaderKind(kind: string): kind is ReaderKind {
  return kind === "knowledge" || kind === "memories";
}

/** Shared graph-node navigation: every node kind has a home surface. */
function useNodeNavigation(workspaceId: string | null) {
  const router = useRouter();
  return (node: BrainGraphNode) => {
    if (!workspaceId) return;
    const base = `/w/${workspaceId}/brain`;
    if (node.kind === "knowledge") router.push(`${base}/entry/knowledge/${node.id}`);
    else if (node.kind === "memory") router.push(`${base}/entry/memories/${node.id}`);
    else if (node.kind === "skill") router.push(`${base}/skills/${node.id}`);
    else if (node.kind === "connector") return;
    else router.push(`${base}/${node.id}`);
  };
}

// ── Page entry ─────────────────────────────────────────────────────

export default function BrainEntryReaderPage({
  params,
}: {
  params: Promise<{ kind: string; id: string }>;
}) {
  const { kind, id } = use(params);
  // The reader's scroll container — entry-to-entry navigation re-renders
  // this same page (the route segment is stable), so the readers snap it
  // back to the top when the next entry swaps in.
  const scrollRef = useRef<HTMLDivElement>(null);
  return (
    <div ref={scrollRef} className="h-full w-full overflow-y-auto">
      {isReaderKind(kind) ? (
        kind === "knowledge" ? (
          <KnowledgeReader entryId={id} scrollRef={scrollRef} />
        ) : (
          <MemoryReader rowId={id} scrollRef={scrollRef} />
        )
      ) : (
        <ReaderNotFound />
      )}
    </div>
  );
}

function ReaderNotFound() {
  const t = useT();
  const copy = t.brainPage.entryReader;
  const { activeId } = useWorkspaces();
  return (
    <>
      <BrainTopbar
        workspaceId={activeId ?? ""}
        tail={<span className="text-muted-foreground">{copy.notFoundTitle}</span>}
        tailSection="entries"
      />
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-6 py-20 text-center">
        <div className="font-medium">{copy.notFoundTitle}</div>
        <p className="text-sm text-muted-foreground">{copy.notFoundBody}</p>
      </div>
    </>
  );
}

// ── Knowledge adapter ──────────────────────────────────────────────

function KnowledgeReader({
  entryId,
  scrollRef,
}: {
  entryId: string;
  scrollRef: RefObject<HTMLDivElement | null>;
}) {
  const t = useT();
  const copy = t.brainPage.entryReader;
  const { activeId } = useWorkspaces();
  const router = useRouter();
  const onNode = useNodeNavigation(activeId);

  // The loaded entry, tagged with the param it was fetched for. While a
  // NEXT entry is in flight the previous one stays rendered (dimmed by
  // the shell) — a crossfade instead of a blank loading flash. `null`
  // entry = fetched but not found / no access; `null` view = first load.
  const [view, setView] = useState<{
    forId: string;
    entry: KnowledgeEntryDetail | null;
  } | null>(null);
  const [capability, setCapability] = useState<KnowledgeEditCapability | null>(null);
  const [graph, setGraph] = useState<BrainGraph | null>(null);

  // Suggest-an-edit flow state.
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [comment, setComment] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [prUrl, setPrUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!activeId) return;
    let cancelled = false;
    // Deliberately NOT clearing `view` — the previous entry keeps showing
    // (dimmed) until the next one lands. Edit state always resets.
    setCapability(null);
    setEditing(false);
    setPrUrl(null);
    setSubmitError(null);
    getKnowledgeEntry(entryId, activeId, getActiveAssistantId()).then((result) => {
      if (!cancelled) setView({ forId: entryId, entry: result });
    });
    getKnowledgeEditCapability(activeId, entryId).then((result) => {
      if (!cancelled) setCapability(result);
    });
    return () => {
      cancelled = true;
    };
  }, [activeId, entryId]);

  // New entry swapped in → snap the scroller back to the top (the route
  // segment is stable across entry navigation, so it never resets itself).
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [view?.forId, scrollRef]);

  useEffect(() => {
    if (!activeId) return;
    let cancelled = false;
    getBrainGraph({
      workspaceId: activeId,
      viewpointAssistantId: getActiveAssistantId(),
      showMemory: true,
    }).then((result) => {
      if (!cancelled) setGraph(result);
    });
    return () => {
      cancelled = true;
    };
  }, [activeId]);

  const entry = view?.entry ?? null;
  const related = useMemo(() => entry?.related ?? [], [entry]);
  const rewritten = useMemo(
    () => (entry ? rewriteWikilinks(entry.content) : ""),
    [entry],
  );

  if (!activeId || view === null) {
    return <ReaderLoading />;
  }
  if (entry === null) {
    return <ReaderNotFound />;
  }
  const stale = view.forId !== entryId;

  const isGithubSynced = entry.sourceId !== null;
  const canPropose = capability?.canPropose === true;
  const readOnly = isGithubSynced && capability !== null && !canPropose;

  const startEditing = () => {
    setDraft(entry.content);
    setComment("");
    setSubmitError(null);
    setPrUrl(null);
    setEditing(true);
  };

  const submit = async () => {
    if (draft.trim().length === 0) {
      setSubmitError(copy.contentRequired);
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    const result = await proposeKnowledgeEdit(activeId, entry.id, {
      content: draft,
      comment: comment.trim().length > 0 ? comment.trim() : undefined,
    });
    setSubmitting(false);
    if (!result.ok) {
      setSubmitError(format(copy.proposalFailed, { message: result.error }));
      return;
    }
    setPrUrl(result.prUrl);
    setEditing(false);
  };

  return (
    <EntryReader
      workspaceId={activeId}
      contentKey={view.forId}
      stale={stale}
      tail={
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate">{entry.title}</span>
          {readOnly && (
            <span className="shrink-0 rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
              {copy.readOnlyBadge}
            </span>
          )}
        </span>
      }
      rail={
        <>
          {prUrl && (
            <section className="rounded-lg bg-emerald-500/10 px-3 py-2.5 animate-in fade-in-0 slide-in-from-top-1 duration-300">
              <h3 className="pb-1 text-[11px] font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-400">
                {copy.proposalCreatedTitle}
              </h3>
              <p className="pb-2 text-xs text-muted-foreground">
                {copy.proposalCreatedBody}
              </p>
              <a
                href={prUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-xs font-medium text-emerald-700 underline-offset-4 hover:underline dark:text-emerald-400"
              >
                <GitPullRequestArrow className="size-3.5" aria-hidden />
                {copy.viewPr}
              </a>
            </section>
          )}

          {isGithubSynced && !editing && (
            <ReaderRailCard title={copy.actionsHeading}>
              <Button
                className="w-full"
                variant="outline"
                disabled={!canPropose}
                onClick={startEditing}
                title={readOnly ? copy.readOnlyHint : undefined}
              >
                <Pencil className="mr-1.5 size-3.5" aria-hidden />
                {copy.suggestEdit}
              </Button>
              {capability === null ? (
                <p className="pt-1.5 text-[11px] text-muted-foreground">
                  {copy.capabilityLoading}
                </p>
              ) : readOnly ? (
                <p className="pt-1.5 text-[11px] text-muted-foreground">
                  {copy.readOnlyHint}
                </p>
              ) : null}
            </ReaderRailCard>
          )}

          <ReaderRailCard title={copy.connectionsHeading}>
            <ConnectionsGraph graph={graph} focusId={entry.id} onNodeClick={onNode} />
          </ReaderRailCard>

          <ReaderRailCard title={copy.detailsHeading}>
            <dl className="divide-y divide-border/60">
              <ReaderPropRow label={copy.pathLabel}>
                <span className="break-all font-mono text-[11px]">{entry.path}</span>
              </ReaderPropRow>
              <ReaderPropRow label={copy.sensitivityLabel}>
                <SensitivityBadge tier={entry.sensitivity} />
              </ReaderPropRow>
              {entry.tags.length > 0 && (
                <ReaderPropRow label={copy.tagsLabel}>
                  <span className="flex flex-wrap justify-end gap-1">
                    {entry.tags.map((tag) => (
                      <span
                        key={tag}
                        className="rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
                      >
                        {tag}
                      </span>
                    ))}
                  </span>
                </ReaderPropRow>
              )}
              <ReaderPropRow label={copy.updatedLabel}>
                {new Date(entry.updatedAt).toLocaleDateString()}
              </ReaderPropRow>
            </dl>
          </ReaderRailCard>

          {entry.source && (
            <ReaderRailCard title={copy.sourceHeading}>
              <dl className="divide-y divide-border/60">
                <ReaderPropRow label={copy.sourceRepoLabel}>
                  <a
                    href={`https://github.com/${entry.source.repo}`}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 underline-offset-4 hover:underline"
                  >
                    <span className="break-all font-mono text-[11px]">
                      {entry.source.repo}
                    </span>
                    <ExternalLink className="size-3 shrink-0" aria-hidden />
                  </a>
                </ReaderPropRow>
                <ReaderPropRow label={copy.sourceBranchLabel}>
                  <span className="font-mono text-[11px]">{entry.source.branch}</span>
                </ReaderPropRow>
                <ReaderPropRow label={copy.sourceSyncedLabel}>
                  {entry.source.lastSyncedAt
                    ? new Date(entry.source.lastSyncedAt).toLocaleString()
                    : copy.sourceNever}
                </ReaderPropRow>
              </dl>
            </ReaderRailCard>
          )}

          {related.length > 0 && (
            <ReaderRailCard title={copy.relatedHeading}>
              <ul className="flex flex-col">
                {related.map((ref) => (
                  <li key={ref.id}>
                    <button
                      type="button"
                      onClick={() =>
                        router.push(`/w/${activeId}/brain/entry/knowledge/${ref.id}`)
                      }
                      className="block w-full rounded px-1.5 py-1 text-left text-xs text-foreground transition-colors hover:bg-muted"
                    >
                      <span className="block truncate">{ref.title}</span>
                      <span className="block truncate font-mono text-[10px] text-muted-foreground">
                        {ref.path}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </ReaderRailCard>
          )}
        </>
      }
    >
      <article className="flex flex-col gap-3">
        <h1 className="text-3xl font-bold leading-tight text-foreground">
          {entry.title}
        </h1>
        {entry.summary && (
          <p className="text-base text-muted-foreground">{entry.summary}</p>
        )}

        {editing ? (
          <div className="mt-2 flex flex-col gap-3 animate-in fade-in-0 duration-200">
            <div className="rounded-lg bg-muted/40 px-3 py-2.5 text-xs text-muted-foreground">
              {format(copy.editingHint, { repo: capability?.repo ?? "" })}
            </div>
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              spellCheck={false}
              className="min-h-[50vh] w-full resize-y rounded-md border border-border bg-background p-3 font-mono text-[13px] leading-relaxed text-foreground focus:outline-none focus-visible:border-ring"
            />
            <label className="flex flex-col gap-1">
              <span className="text-xs font-medium text-muted-foreground">
                {copy.commentLabel}
              </span>
              <textarea
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                placeholder={copy.commentPlaceholder}
                rows={3}
                className="w-full resize-y rounded-md border border-border bg-background p-2.5 text-sm text-foreground placeholder:text-muted-foreground/50 focus:outline-none focus-visible:border-ring"
              />
            </label>
            {submitError && (
              <p className="text-xs text-destructive">{submitError}</p>
            )}
            <div className="flex items-center gap-2">
              <Button onClick={submit} disabled={submitting}>
                <GitPullRequestArrow className="mr-1.5 size-3.5" aria-hidden />
                {submitting ? copy.submitting : copy.submitProposal}
              </Button>
              <Button
                variant="ghost"
                onClick={() => setEditing(false)}
                disabled={submitting}
              >
                {copy.cancelEdit}
              </Button>
            </div>
          </div>
        ) : entry.content.trim().length > 0 ? (
          <div className="chat-markdown mt-2 break-words text-[15px] leading-7">
            <Markdown
              remarkPlugins={KB_REMARK_PLUGINS}
              urlTransform={kbUrlTransform}
              components={{
                a: (props) => (
                  <KbLink
                    {...props}
                    currentPath={entry.path}
                    related={related}
                    onNavigate={(refId) =>
                      router.push(`/w/${activeId}/brain/entry/knowledge/${refId}`)
                    }
                  />
                ),
              }}
            >
              {rewritten}
            </Markdown>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{copy.noContent}</p>
        )}
      </article>
    </EntryReader>
  );
}

/**
 * Link renderer for KB markdown: `kbwiki:` + relative `.md` hrefs
 * resolve against the entry's related refs and navigate in-app;
 * external links open a new tab; unresolvable targets degrade to a
 * muted dotted-underline span (broken link, or above clearance).
 */
function KbLink({
  href,
  children,
  currentPath,
  related,
  onNavigate,
}: React.AnchorHTMLAttributes<HTMLAnchorElement> & {
  currentPath: string;
  related: { id: string; title: string; path: string }[];
  onNavigate: (refId: string) => void;
}) {
  const target = href ? resolveWikilinkTarget(href, currentPath, related) : null;
  if (target) {
    return (
      <a
        href={`#${target.path}`}
        className="text-primary underline-offset-4 hover:underline"
        onClick={(e) => {
          e.preventDefault();
          onNavigate(target.id);
        }}
      >
        {children}
      </a>
    );
  }
  const isInternalish =
    href?.startsWith(KB_WIKILINK_SCHEME) || (href ? /\.md(#.*)?$/i.test(href) : false);
  if (href && !isInternalish) {
    return (
      <a href={href} target="_blank" rel="noreferrer" className="underline-offset-4 hover:underline">
        {children}
      </a>
    );
  }
  return (
    <span className="cursor-default text-muted-foreground underline decoration-dotted underline-offset-4">
      {children}
    </span>
  );
}

// ── Memory adapter ─────────────────────────────────────────────────

function MemoryReader({
  rowId,
  scrollRef,
}: {
  rowId: string;
  scrollRef: RefObject<HTMLDivElement | null>;
}) {
  const t = useT();
  const copy = t.brainPage.entryReader;
  const { activeId } = useWorkspaces();
  const onNode = useNodeNavigation(activeId);

  // Same crossfade contract as the knowledge reader — the previous row
  // stays rendered (dimmed) while the next one loads.
  const [view, setView] = useState<{
    forId: string;
    row: BrainInboxRowDetail | null;
  } | null>(null);
  const [graph, setGraph] = useState<BrainGraph | null>(null);

  useEffect(() => {
    if (!activeId) return;
    let cancelled = false;
    fetchBrainRow(activeId, "memory", rowId).then((result) => {
      if (!cancelled) setView({ forId: rowId, row: result });
    });
    getBrainGraph({
      workspaceId: activeId,
      viewpointAssistantId: getActiveAssistantId(),
      showMemory: true,
    }).then((result) => {
      if (!cancelled) setGraph(result);
    });
    return () => {
      cancelled = true;
    };
  }, [activeId, rowId]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [view?.forId, scrollRef]);

  if (!activeId || view === null) return <ReaderLoading />;
  const row = view.row;
  if (row === null) return <ReaderNotFound />;
  const stale = view.forId !== rowId;

  const summary = typeof row.body.summary === "string" ? row.body.summary : copy.kindMemory;
  const detail = typeof row.body.detail === "string" ? row.body.detail : "";
  const sensitivity =
    typeof row.body.sensitivity === "string" ? row.body.sensitivity : null;

  return (
    <EntryReader
      workspaceId={activeId}
      contentKey={view.forId}
      stale={stale}
      tail={<span className="truncate">{summary}</span>}
      rail={
        <>
          <ReaderRailCard title={copy.connectionsHeading}>
            <ConnectionsGraph graph={graph} focusId={row.id} onNodeClick={onNode} />
          </ReaderRailCard>
          <ReaderRailCard title={copy.detailsHeading}>
            <dl className="divide-y divide-border/60">
              <ReaderPropRow label={copy.kindLabel}>{copy.kindMemory}</ReaderPropRow>
              {sensitivity && (
                <ReaderPropRow label={copy.sensitivityLabel}>
                  <SensitivityBadge tier={sensitivity} />
                </ReaderPropRow>
              )}
              <ReaderPropRow label={copy.createdLabel}>
                {new Date(row.createdAt).toLocaleDateString()}
              </ReaderPropRow>
            </dl>
          </ReaderRailCard>
        </>
      }
    >
      <article className="flex flex-col gap-3">
        <h1 className="text-3xl font-bold leading-tight text-foreground">{summary}</h1>
        {detail.trim().length > 0 ? (
          <div className="chat-markdown mt-2 break-words text-[15px] leading-7">
            <Markdown remarkPlugins={KB_REMARK_PLUGINS}>{detail}</Markdown>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{copy.noContent}</p>
        )}
      </article>
    </EntryReader>
  );
}

// ── Shared loading state ───────────────────────────────────────────

function ReaderLoading() {
  const t = useT();
  const { activeId } = useWorkspaces();
  return (
    <>
      <BrainTopbar
        workspaceId={activeId ?? ""}
        tail={<span className="text-muted-foreground">…</span>}
        tailSection="entries"
      />
      <div
        className={cn(
          "mx-auto w-full max-w-3xl px-6 py-10 text-sm text-muted-foreground",
        )}
      >
        {t.brainPage.entryReader.loading}
      </div>
    </>
  );
}
