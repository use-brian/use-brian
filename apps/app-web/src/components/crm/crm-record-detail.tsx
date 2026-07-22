"use client";

/**
 * CRM record detail — the master-detail pane of the CRM operator surface
 * (crm-operator-surface §4). Typed fields on top (the SAME inline cells
 * the table uses, committing through the surface's adjust wire), then the
 * relationship block (contacts-at-company / deals-for-contact — computed
 * client-side from the one flat payload), then **From the brain**: the
 * entity rollup's embedded context (recent memories, open tasks, graph
 * edges) — the §1.7 differentiator a standalone CRM cannot have. The
 * rollup rides the existing `GET /api/brain/entities/:id` read
 * ([COMP:brain/entity-rollup-http]); no new aggregation endpoint.
 *
 * [COMP:app-web/crm-surface] (the record-detail flavour)
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { Brain, ExternalLink, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n/format";
import { getEntity, type EntityRollup } from "@/lib/api/brain";
import { brainRowUrl } from "@/lib/brain-deep-link";
import { EditableTitle } from "@/components/operator/editable-title";
import {
  isOpenStage,
  type CrmCompanyRow,
  type CrmContactRow,
  type CrmDealRow,
  type CrmData,
  type DealStage,
} from "@/lib/api/crm";
import { formatAmount, localDateStr } from "@/lib/crm-view";
import {
  AmountCell,
  CloseDateCell,
  CompanyCell,
  StageCell,
  TagsCell,
  TextFieldCell,
  type CellCommit,
} from "./crm-cells";

export type CrmRecordRef =
  | { kind: "deal"; row: CrmDealRow }
  | { kind: "contact"; row: CrmContactRow }
  | { kind: "company"; row: CrmCompanyRow };

/** Field-commit callbacks the surface wires to its adjust helpers. */
export type RecordCommits = {
  /** Rename any record (`display_name` through the shared adjust path). */
  rename: (ref: CrmRecordRef) => CellCommit<string>;
  dealStage: (row: CrmDealRow) => CellCommit<DealStage>;
  dealAmount: (row: CrmDealRow) => CellCommit<number | null>;
  dealClose: (row: CrmDealRow) => CellCommit<string | null>;
  contactEmail: (row: CrmContactRow) => CellCommit<string | null>;
  contactPhone: (row: CrmContactRow) => CellCommit<string | null>;
  contactCompany: (row: CrmContactRow) => CellCommit<string | null>;
  contactTags: (row: CrmContactRow) => CellCommit<string[]>;
  companyDomain: (row: CrmCompanyRow) => CellCommit<string | null>;
  companyTags: (row: CrmCompanyRow) => CellCommit<string[]>;
};

export function CrmRecordDetail({
  workspaceId,
  record,
  data,
  commits,
  onClose,
  onOpenRecord,
}: {
  workspaceId: string;
  record: CrmRecordRef;
  /** The whole flat payload — relationships join client-side. */
  data: CrmData;
  commits: RecordCommits;
  onClose: () => void;
  onOpenRecord: (ref: CrmRecordRef) => void;
}) {
  const t = useT().crmPage;
  const kindLabels = t.kind as Record<string, string>;

  // ── From the brain — the entity rollup (row id IS the entity id) ──────
  const [rollup, setRollup] = useState<EntityRollup | null>(null);
  const [rollupMissed, setRollupMissed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setRollup(null);
    setRollupMissed(false);
    void getEntity(record.row.id, workspaceId).then((r) => {
      if (cancelled) return;
      if (r) setRollup(r);
      else setRollupMissed(true);
    });
    return () => {
      cancelled = true;
    };
  }, [record.row.id, workspaceId]);

  const name = record.row.name;

  return (
    // A floating peek panel, NOT a flex sibling — it overlays the content
    // pane so opening a record never reflows the table/board underneath.
    <aside className="absolute inset-y-0 right-0 z-20 flex w-[380px] max-w-[92vw] flex-col border-l border-border/60 bg-background shadow-2xl animate-in slide-in-from-right-4 fade-in duration-200">
      {/* Header */}
      <div className="flex items-start gap-2 border-b border-border px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="mb-0.5 px-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/60">
            {kindLabels[record.kind] ?? record.kind}
          </div>
          <EditableTitle
            value={name}
            ariaLabel={t.nameLabel}
            onCommit={commits.rename(record)}
          />
        </div>
        <Link
          href={brainRowUrl("", workspaceId, record.row.id, record.kind)}
          title={t.openInBrain}
          className="mt-0.5 rounded-md p-1 text-muted-foreground hover:bg-accent/60 hover:text-foreground"
        >
          <ExternalLink className="size-4" aria-hidden />
        </Link>
        <button
          type="button"
          aria-label={t.closeDetail}
          onClick={onClose}
          className="mt-0.5 rounded-md p-1 text-muted-foreground hover:bg-accent/60 hover:text-foreground"
        >
          <X className="size-4" aria-hidden />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {/* Typed fields — same cells as the table. */}
        <section className="border-b border-border px-4 py-3">
          {record.kind === "deal" && (
            <DealFields
              row={record.row}
              data={data}
              commits={commits}
              onOpenRecord={onOpenRecord}
            />
          )}
          {record.kind === "contact" && (
            <>
              <FieldRow label={t.emailLabel}>
                <TextFieldCell
                  value={record.row.email}
                  placeholder={t.noValue}
                  ariaLabel={t.emailLabel}
                  inputType="email"
                  onCommit={commits.contactEmail(record.row)}
                />
              </FieldRow>
              <FieldRow label={t.phoneLabel}>
                <TextFieldCell
                  value={record.row.phone}
                  placeholder={t.noValue}
                  ariaLabel={t.phoneLabel}
                  inputType="tel"
                  onCommit={commits.contactPhone(record.row)}
                />
              </FieldRow>
              <FieldRow label={t.companyLabel}>
                <CompanyCell
                  companyId={record.row.companyId}
                  companies={data.companies}
                  onCommit={commits.contactCompany(record.row)}
                />
              </FieldRow>
              <FieldRow label={t.tagsLabel}>
                <TagsCell
                  tags={record.row.tags}
                  onCommit={commits.contactTags(record.row)}
                />
              </FieldRow>
            </>
          )}
          {record.kind === "company" && (
            <>
              <FieldRow label={t.domainLabel}>
                <TextFieldCell
                  value={record.row.domain}
                  placeholder={t.noValue}
                  ariaLabel={t.domainLabel}
                  onCommit={commits.companyDomain(record.row)}
                />
              </FieldRow>
              <FieldRow label={t.tagsLabel}>
                <TagsCell
                  tags={record.row.tags}
                  onCommit={commits.companyTags(record.row)}
                />
              </FieldRow>
            </>
          )}
        </section>

        {/* Relationships — joined client-side from the flat payload. */}
        <Relationships
          record={record}
          data={data}
          onOpenRecord={onOpenRecord}
        />

        {/* From the brain — the rollup's embedded context. */}
        <section className="px-4 py-3">
          <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/60">
            <Brain className="size-3.5" aria-hidden />
            {t.fromBrain}
          </div>
          {rollupMissed ? (
            <div className="text-[12.5px] text-muted-foreground/60">
              {t.fromBrainEmpty}
            </div>
          ) : rollup === null ? (
            <div className="text-[12.5px] text-muted-foreground/60">
              {t.fromBrainLoading}
            </div>
          ) : (
            <FromBrain workspaceId={workspaceId} rollup={rollup} />
          )}
        </section>
      </div>
    </aside>
  );
}

function FieldRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-8 items-center gap-2">
      <span className="w-20 shrink-0 text-[12px] text-muted-foreground">
        {label}
      </span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

function DealFields({
  row,
  data,
  commits,
  onOpenRecord,
}: {
  row: CrmDealRow;
  data: CrmData;
  commits: RecordCommits;
  onOpenRecord: (ref: CrmRecordRef) => void;
}) {
  const t = useT().crmPage;
  const company = row.companyId
    ? data.companies.find((c) => c.id === row.companyId)
    : null;
  const contact = row.contactId
    ? data.contacts.find((c) => c.id === row.contactId)
    : null;
  const overdue =
    isOpenStage(row.stage) &&
    row.closeDate !== null &&
    row.closeDate < localDateStr(new Date());
  return (
    <>
      <FieldRow label={t.stageLabel}>
        <StageCell value={row.stage} onCommit={commits.dealStage(row)} />
      </FieldRow>
      <FieldRow label={t.amountLabel}>
        <AmountCell value={row.amount} onCommit={commits.dealAmount(row)} />
      </FieldRow>
      <FieldRow label={t.closeDateLabel}>
        <CloseDateCell
          value={row.closeDate}
          overdue={overdue}
          onCommit={commits.dealClose(row)}
        />
      </FieldRow>
      {company && (
        <FieldRow label={t.companyLabel}>
          <RecordLink
            name={company.name}
            onClick={() => onOpenRecord({ kind: "company", row: company })}
          />
        </FieldRow>
      )}
      {contact && (
        <FieldRow label={t.contactLabel}>
          <RecordLink
            name={contact.name}
            onClick={() => onOpenRecord({ kind: "contact", row: contact })}
          />
        </FieldRow>
      )}
    </>
  );
}

function RecordLink({
  name,
  meta,
  onClick,
}: {
  name: string;
  meta?: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left text-[13px] hover:bg-muted/60"
    >
      <span className="min-w-0 flex-1 truncate">{name}</span>
      {meta && (
        <span className="shrink-0 text-[11.5px] tabular-nums text-muted-foreground">
          {meta}
        </span>
      )}
    </button>
  );
}

function Relationships({
  record,
  data,
  onOpenRecord,
}: {
  record: CrmRecordRef;
  data: CrmData;
  onOpenRecord: (ref: CrmRecordRef) => void;
}) {
  const t = useT().crmPage;

  if (record.kind === "company") {
    const contacts = data.contacts.filter(
      (c) => c.companyId === record.row.id,
    );
    const deals = data.deals.filter((d) => d.companyId === record.row.id);
    const openDeals = deals.filter((d) => isOpenStage(d.stage));
    const pipeline = openDeals.reduce((sum, d) => sum + (d.amount ?? 0), 0);
    return (
      <section className="border-b border-border px-4 py-3">
        <RelationBlock
          title={t.contactsHere}
          count={contacts.length}
          empty={t.noneYet}
        >
          {contacts.map((c) => (
            <RecordLink
              key={c.id}
              name={c.name}
              meta={c.email ?? undefined}
              onClick={() => onOpenRecord({ kind: "contact", row: c })}
            />
          ))}
        </RelationBlock>
        <RelationBlock
          title={
            pipeline > 0
              ? format(t.openDealsWithValue, { value: formatAmount(pipeline) })
              : t.openDeals
          }
          count={openDeals.length}
          empty={t.noneYet}
        >
          {deals.map((d) => (
            <RecordLink
              key={d.id}
              name={d.name}
              meta={d.amount !== null ? formatAmount(d.amount) : undefined}
              onClick={() => onOpenRecord({ kind: "deal", row: d })}
            />
          ))}
        </RelationBlock>
      </section>
    );
  }

  if (record.kind === "contact") {
    const deals = data.deals.filter((d) => d.contactId === record.row.id);
    if (deals.length === 0) return null;
    return (
      <section className="border-b border-border px-4 py-3">
        <RelationBlock title={t.dealsFor} count={deals.length} empty={t.noneYet}>
          {deals.map((d) => (
            <RecordLink
              key={d.id}
              name={d.name}
              meta={d.amount !== null ? formatAmount(d.amount) : undefined}
              onClick={() => onOpenRecord({ kind: "deal", row: d })}
            />
          ))}
        </RelationBlock>
      </section>
    );
  }

  return null;
}

function RelationBlock({
  title,
  count,
  empty,
  children,
}: {
  title: string;
  count: number;
  empty: string;
  children: React.ReactNode;
}) {
  return (
    <div className="mb-2 last:mb-0">
      <div className="mb-1 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/60">
        {title}
        <span className="tabular-nums font-normal">{count}</span>
      </div>
      {count === 0 ? (
        <div className="px-1.5 text-[12.5px] text-muted-foreground/60">{empty}</div>
      ) : (
        children
      )}
    </div>
  );
}

/** The rollup's embedded context: recent memories + open tasks (deep-linked
 *  into the Brain drawer) and the graph edges with target names. */
function FromBrain({
  workspaceId,
  rollup,
}: {
  workspaceId: string;
  rollup: EntityRollup;
}) {
  const t = useT().crmPage;
  const memories = rollup.embedded.recentMemories.slice(0, 5);
  const tasks = rollup.embedded.openTasks.slice(0, 5);
  const edges = rollup.embedded.edges.slice(0, 6);
  const empty =
    memories.length === 0 && tasks.length === 0 && edges.length === 0;

  if (empty) {
    return (
      <div className="text-[12.5px] text-muted-foreground/60">
        {t.fromBrainEmpty}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {memories.length > 0 && (
        <div>
          <div className="mb-1 text-[11px] font-medium text-muted-foreground/70">
            {format(t.brainMemories, {
              count: String(rollup.summary.memoriesCount),
            })}
          </div>
          {memories.map((m) => (
            <BrainRowLink
              key={m.id}
              href={brainRowUrl("", workspaceId, m.id, "memory")}
              name={m.name}
            />
          ))}
        </div>
      )}
      {tasks.length > 0 && (
        <div>
          <div className="mb-1 text-[11px] font-medium text-muted-foreground/70">
            {format(t.brainTasks, { count: String(rollup.summary.tasksCount) })}
          </div>
          {tasks.map((task) => (
            <BrainRowLink
              key={task.id}
              href={brainRowUrl("", workspaceId, task.id, "task")}
              name={task.name}
            />
          ))}
        </div>
      )}
      {edges.length > 0 && (
        <div>
          <div className="mb-1 text-[11px] font-medium text-muted-foreground/70">
            {t.brainConnections}
          </div>
          {edges.map((edge, i) => (
            <div
              key={`${edge.targetEntityId}-${i}`}
              className="flex items-center gap-1.5 px-1.5 py-0.5 text-[12.5px]"
            >
              <span className="truncate">{edge.targetName}</span>
              <span className="shrink-0 rounded bg-muted px-1 py-px text-[10px] text-muted-foreground">
                {edge.kind}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function BrainRowLink({ href, name }: { href: string; name: string }) {
  return (
    <Link
      href={href}
      className={cn(
        "block truncate rounded-md px-1.5 py-0.5 text-[12.5px] text-foreground/90 hover:bg-muted/60 hover:underline",
      )}
    >
      {name}
    </Link>
  );
}
