"use client";

/**
 * Brain entity panel — `/w/[workspaceId]/brain/[entityId]` (app-web).
 *
 * Ported from `apps/web/src/app/(app)/brain/[entityId]/page.tsx` as part
 * of the brain surface migration
 * (docs/architecture/features/doc.md §5a). Single-entity detail
 * view: header, overview attributes, memories / knowledge / files /
 * edges / recent episodes, and an inline pending-changes banner.
 *
 * app-web ADAPTATIONS (vs apps/web):
 *   - Data fetch scoped by `activeId` via the `useWorkspaces()` adapter.
 *   - Back / edge links target `/w/[id]/brain[/...]` instead of `/brain`,
 *     built from the `workspaceId` route param (always present here).
 *   - `useProvenance()` is satisfied by a locally-mounted
 *     `ProvenanceProvider` + `ProvenanceSheet` (apps/web gets these from
 *     app-chrome; app-web's `/w/[id]` layout doesn't, so each brain
 *     route hosts its own).
 *   - Renders full-width in the `/w/[workspaceId]` layout `<main>`.
 *
 * Spec: docs/plans/company-brain/ui.md → §J3 → Entity panel composition.
 *
 * [COMP:app-web/brain-entity]
 */

import { Fragment, use, useEffect, useState } from "react";
import Link from "next/link";
import { BackButton } from "@/components/ui/back-button";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n/format";
import { useWorkspaces } from "@/contexts/workspace-context";
import { getEntity, type EntityRollup, type BrainRow } from "@/lib/api/brain";
import { EntityRow } from "@/components/brain/entity-row";
import {
  ProvenanceProvider,
  useProvenance,
  useProvenanceState,
} from "@/components/provenance/provenance-context";
import { ProvenanceSheet } from "@/components/provenance/provenance-sheet";
import { cn } from "@/lib/utils";
import type { ProvenanceRow, ProvenanceSourceKind } from "@/lib/api/provenance";

function BrainEntityInner({
  workspaceId,
  entityId,
}: {
  workspaceId: string;
  entityId: string;
}) {
  const t = useT();
  const { activeId } = useWorkspaces();
  const [entity, setEntity] = useState<EntityRollup | null | undefined>(undefined);
  const { open } = useProvenance();
  const backHref = `/w/${workspaceId}/brain`;

  useEffect(() => {
    if (!activeId) return;
    let cancelled = false;
    getEntity(entityId, activeId).then((result) => {
      if (cancelled) return;
      setEntity(result);
    });
    return () => {
      cancelled = true;
    };
  }, [entityId, activeId]);

  if (entity === undefined) {
    return (
      <div className="max-w-3xl mx-auto w-full px-6 py-10 text-sm text-muted-foreground">
        …
      </div>
    );
  }

  if (entity === null) {
    return (
      <div className="max-w-3xl mx-auto w-full px-6 py-20 text-center flex flex-col gap-3">
        <svg
          width="40"
          height="40"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          aria-hidden
          className="text-muted-foreground/40 mx-auto"
        >
          <circle cx="12" cy="12" r="9" />
          <path d="M9.5 9a2.5 2.5 0 1 1 4 2c-.8.5-1.5 1-1.5 2" />
          <circle cx="12" cy="17" r="0.5" fill="currentColor" />
        </svg>
        <div className="font-medium">{t.brainPage.entityPanel.notFoundTitle}</div>
        <p className="text-sm text-muted-foreground">
          {t.brainPage.entityPanel.notFoundBody}
        </p>
        <BackButton
          href={backHref}
          label={t.brainPage.entityPanel.goBack}
          className="mx-auto"
        />
      </div>
    );
  }

  const handleOpenProvenance = () => {
    const row: ProvenanceRow = {
      id: entity.id,
      kind: "entity" as ProvenanceSourceKind,
      title: entity.name,
      sensitivity: entity.sensitivity,
      authorship: {
        createdByUserId: entity.authorship.createdByUserId,
        createdByAssistantId: entity.authorship.createdByAssistantId,
        sourceEpisodeId: entity.authorship.sourceEpisodeId,
        createdAt: new Date().toISOString(),
      },
    };
    open(row);
  };

  const sections = t.brainPage.entityPanel.sections;

  return (
    <div className="max-w-3xl mx-auto w-full px-6 py-6 flex flex-col gap-6">
      <BackButton href={backHref} label={t.brainPage.entityPanel.goBack} />

      <header className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">
            {entity.kind}
          </div>
          <h1 className="text-2xl font-semibold truncate">{entity.name}</h1>
        </div>
        <button
          type="button"
          onClick={handleOpenProvenance}
          className="text-xs px-3 py-1.5 rounded border border-border hover:bg-muted shrink-0"
        >
          {t.brainPage.entityPanel.viewProvenance}
        </button>
      </header>

      {entity.pendingChanges.length > 0 && (
        <>
          <div className="flex items-start gap-3 p-4 rounded-md border border-amber-500/30 bg-amber-500/5">
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.75"
              aria-hidden
              className="text-amber-600 dark:text-amber-400 shrink-0 mt-[2px]"
            >
              <path d="M12 9v4M12 17h.01" />
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            </svg>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium">
                {format(t.brainPage.entityPanel.pendingBannerHeading, {
                  count: entity.pendingChanges.length,
                })}
              </div>
              <p className="text-xs text-muted-foreground mt-0.5">
                {t.brainPage.entityPanel.pendingBannerBody}
              </p>
            </div>
          </div>

          <Section title={sections.pending} accent="amber">
            <ul className="divide-y divide-border">
              {entity.pendingChanges.map((row) => (
                <li key={`pending:${row.id}`}>
                  <EntityRow row={row} />
                </li>
              ))}
            </ul>
          </Section>
        </>
      )}

      <Section title={sections.overview}>
        <OverviewBody entity={entity} />
      </Section>

      <Section
        title={sections.memories}
        emptyMessage={t.brainPage.entityPanel.noMemories}
        items={entity.embedded.recentMemories}
        total={entity.summary.memoriesCount}
        seeAllLabel={format(t.brainPage.entityPanel.seeAll, {
          count: entity.summary.memoriesCount,
        })}
      />

      <Section
        title={sections.knowledge}
        emptyMessage={t.brainPage.entityPanel.noKnowledge}
        items={entity.embedded.knowledge}
        total={entity.summary.knowledgeCount}
        seeAllLabel={format(t.brainPage.entityPanel.seeAll, {
          count: entity.summary.knowledgeCount,
        })}
      />

      <Section
        title={sections.files}
        emptyMessage={t.brainPage.entityPanel.noFiles}
        items={entity.embedded.files}
        total={entity.summary.filesCount}
        seeAllLabel={format(t.brainPage.entityPanel.seeAll, {
          count: entity.summary.filesCount,
        })}
      />

      <Section title={sections.edges}>
        {entity.embedded.edges.length === 0 ? (
          <p className="text-xs text-muted-foreground py-2">
            {t.brainPage.entityPanel.noEdges}
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {entity.embedded.edges.map((edge) => (
              <li key={`${edge.kind}:${edge.targetEntityId}`} className="text-sm">
                <span className="text-muted-foreground mr-2">{edge.kind}</span>
                <Link
                  href={`${backHref}/${encodeURIComponent(edge.targetEntityId)}`}
                  className="hover:underline"
                >
                  {edge.targetName}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section
        title={sections.episodes}
        emptyMessage={t.brainPage.entityPanel.noEpisodes}
        items={entity.embedded.recentEpisodes}
        total={entity.summary.episodesCount}
        seeAllLabel={format(t.brainPage.entityPanel.seeAll, {
          count: entity.summary.episodesCount,
        })}
      />
    </div>
  );
}

/** Renders the provenance sheet from provider state (mounted inside the
 *  ProvenanceProvider so `useProvenanceState()` resolves). */
function ProvenanceSheetHost() {
  const { row, episode, close } = useProvenanceState();
  return <ProvenanceSheet row={row} episode={episode} onClose={close} />;
}

export default function BrainEntityPage({
  params,
}: {
  params: Promise<{ workspaceId: string; entityId: string }>;
}) {
  const { workspaceId, entityId } = use(params);
  return (
    <ProvenanceProvider>
      <div className="h-full w-full overflow-y-auto">
        <BrainEntityInner workspaceId={workspaceId} entityId={entityId} />
      </div>
      <ProvenanceSheetHost />
    </ProvenanceProvider>
  );
}

function Section({
  title,
  children,
  accent,
  emptyMessage,
  items,
  total,
  seeAllLabel,
}: {
  title: string;
  children?: React.ReactNode;
  accent?: "amber";
  emptyMessage?: string;
  items?: BrainRow[];
  total?: number;
  seeAllLabel?: string;
}) {
  const list = items ?? null;
  const isEmpty = list !== null && list.length === 0;

  return (
    <section
      className={cn(
        "border rounded-md overflow-hidden",
        accent === "amber"
          ? "border-amber-500/30 bg-amber-500/5"
          : "border-border bg-card",
      )}
    >
      <div className="px-4 py-2 border-b border-border text-xs uppercase tracking-wide text-muted-foreground font-medium">
        {title}
      </div>
      <div>
        {list !== null ? (
          isEmpty && emptyMessage ? (
            <p className="text-xs text-muted-foreground py-3 px-4">{emptyMessage}</p>
          ) : (
            <>
              <ul className="divide-y divide-border">
                {list.slice(0, 5).map((row) => (
                  <li key={`${row.kind}:${row.id}`}>
                    <EntityRow row={row} />
                  </li>
                ))}
              </ul>
              {total !== undefined && total > 5 && seeAllLabel && (
                <div className="px-4 py-2 text-xs text-muted-foreground border-t border-border">
                  {seeAllLabel}
                </div>
              )}
            </>
          )
        ) : (
          <div className="px-4 py-3">{children}</div>
        )}
      </div>
    </section>
  );
}

function OverviewBody({ entity }: { entity: EntityRollup }) {
  const t = useT();
  const a = entity.authorship;
  const labels = t.brainPage.entityPanel.overviewLabels;
  const attributeLabels = t.brainPage.entityPanel.attributeLabels as Record<string, string>;

  const attrRows = Object.entries(entity.attributes ?? {})
    .filter(([key, value]) => key !== "self" && value !== null && value !== undefined && value !== "")
    .map(([key, value]) => ({
      key,
      label: attributeLabels[key] ?? humaniseKey(key),
      value: typeof value === "string" ? value : JSON.stringify(value),
    }));

  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
      {attrRows.map((row) => (
        <Fragment key={`attr:${row.key}`}>
          <dt className="text-muted-foreground">{row.label}</dt>
          <dd className="break-words">{row.value}</dd>
        </Fragment>
      ))}
      <dt className="text-muted-foreground">{labels.sensitivity}</dt>
      <dd>{entity.sensitivity}</dd>
      <dt className="text-muted-foreground">{labels.authorship}</dt>
      <dd>
        {a.createdByAssistantId
          ? format(t.chrome.provenanceSheet.createdByAssistant, {
              assistantName: a.createdByAssistantId,
            })
          : t.chrome.provenanceSheet.createdByUser}
      </dd>
    </dl>
  );
}

function humaniseKey(key: string): string {
  return key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
