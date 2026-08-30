"use client";

/**
 * CRM record detail — the master-detail peek of the CRM operator surface
 * (crm-operator-surface §4). Built from the SAME property-page primitives
 * the Brain entry page uses (`brain/property-field.tsx`: big muted kind
 * icon + `PageTitle`, icon-led `PropertyRow`s, Notion-style dot-pill
 * values, "Empty" placeholders) so a record reads identically here and in
 * Brain. Below the fields: the relationship block (contacts-at-company /
 * deals-for-contact — computed client-side from the one flat payload),
 * then **From the brain**: the entity rollup's embedded context (recent
 * memories, open tasks, graph edges) — the §1.7 differentiator a
 * standalone CRM cannot have. The rollup rides the existing
 * `GET /api/brain/entities/:id` read ([COMP:brain/entity-rollup-http]).
 *
 * A floating overlay, never a flex sibling — opening a record must not
 * reflow the table/board underneath.
 *
 * [COMP:app-web/crm-surface] (the record-detail flavour)
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  Brain,
  Archive,
  ArrowLeft,
  Building2,
  Calendar,
  CircleDashed,
  DollarSign,
  ExternalLink,
  Globe,
  Handshake,
  Mail,
  Percent,
  Phone,
  Tags,
  UserRound,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n/format";
import { getEntity, type EntityRollup } from "@/lib/api/brain";
import { brainRowUrl } from "@/lib/brain-deep-link";
import {
  isOpenStage,
  type CrmCompanyRow,
  type CrmConfig,
  type CrmContactRow,
  type CrmDealRow,
  type CrmData,
  type CrmDealParticipant,
} from "@/lib/api/crm";
import { loadWorkspaceRoster } from "@/lib/api/workspace-roster";
import type { FeedWorkspaceMember } from "@/lib/api/feed";
import {
  memberDisplayName,
} from "@/components/brain/property-edit";
import { formatAmount, formatCurrencyTotals, resolveDealPipelineStage } from "@/lib/crm-view";
import {
  DateProperty,
  PageTitle,
  PersonProperty,
  PropertyRow,
  StaticProperty,
  TagsProperty,
  TextProperty,
  type PersonPropertyOption,
} from "@/components/brain/property-field";
import { AmountCell, CompanyCell, PipelineStageCell, type CellCommit } from "./crm-cells";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { ResizablePeek } from "@/components/operator/resizable-peek";
import { CrmActivityTimeline } from "./crm-activity";
import { CrmCustomFields } from "./crm-custom-fields";
import { CrmParticipants } from "./crm-participants";
import { CrmContactCompliance } from "./operations/contact-compliance";
import { CrmContactLifecycle } from "./operations/contact-lifecycle";

export type CrmRecordRef =
  | { kind: "deal"; row: CrmDealRow }
  | { kind: "contact"; row: CrmContactRow }
  | { kind: "company"; row: CrmCompanyRow };

/** Field-commit callbacks the surface wires to its adjust helpers. */
export type RecordCommits = {
  /** Rename any record (`display_name` through the shared adjust path). */
  rename: (ref: CrmRecordRef) => CellCommit<string>;
  owner: (ref: CrmRecordRef) => CellCommit<string | null>;
  dealPipelineStage: (row: CrmDealRow) => CellCommit<string>;
  dealAmount: (row: CrmDealRow) => CellCommit<number | null>;
  dealClose: (row: CrmDealRow) => CellCommit<string | null>;
  dealCompany: (row: CrmDealRow) => CellCommit<string | null>;
  dealContact: (row: CrmDealRow) => CellCommit<string | null>;
  dealCurrency: (row: CrmDealRow) => CellCommit<string>;
  dealSource: (row: CrmDealRow) => CellCommit<string | null>;
  dealWinLossReason: (row: CrmDealRow) => CellCommit<string | null>;
  contactEmail: (row: CrmContactRow) => CellCommit<string | null>;
  contactPhone: (row: CrmContactRow) => CellCommit<string | null>;
  contactCompany: (row: CrmContactRow) => CellCommit<string | null>;
  contactTags: (row: CrmContactRow) => CellCommit<string[]>;
  companyDomain: (row: CrmCompanyRow) => CellCommit<string | null>;
  companyTags: (row: CrmCompanyRow) => CellCommit<string[]>;
};

const KIND_ICON = {
  deal: <Handshake />,
  contact: <UserRound />,
  company: <Building2 />,
} as const;

export function CrmRecordDetail({
  workspaceId,
  record,
  data,
  config,
  commits,
  onClose,
  onOpenRecord,
  onReviewEmail,
  onChanged,
  onArchive,
  initialParticipants,
}: {
  workspaceId: string;
  record: CrmRecordRef;
  /** The whole flat payload — relationships join client-side. */
  data: CrmData;
  config: CrmConfig;
  commits: RecordCommits;
  onClose: () => void;
  onOpenRecord: (ref: CrmRecordRef) => void;
  onReviewEmail: (approvalId: string) => void;
  onChanged: () => void;
  onArchive: (ref: CrmRecordRef) => void;
  initialParticipants: CrmDealParticipant[];
}) {
  const dictionary = useT();
  const t = dictionary.crmPage;
  const [roster, setRoster] = useState<FeedWorkspaceMember[] | null>(null);
  const [rosterLoading, setRosterLoading] = useState(true);
  useEffect(() => {
    let cancelled = false;
    setRosterLoading(true);
    loadWorkspaceRoster(workspaceId)
      .then((rows) => {
        if (!cancelled) setRoster(rows);
      })
      .catch(() => {
        if (!cancelled) setRoster([]);
      })
      .finally(() => {
        if (!cancelled) setRosterLoading(false);
      });
    return () => { cancelled = true; };
  }, [workspaceId]);
  const ownerId = record.row.ownerId ?? null;
  const owner = ownerId && roster
    ? roster.find((member) => member.userId === ownerId) ?? null
    : null;
  const memberRoleLabels = dictionary.brainPage.detailDrawer.memberRole as Record<string, string>;
  const ownerOptions: PersonPropertyOption[] = (roster ?? []).map((member) => ({
    id: member.userId,
    name: memberDisplayName(member) ?? t.r2.memberUnknown,
    email: member.email,
    avatarUrl: member.avatarUrl,
    roleLabel: memberRoleLabels[member.role] ?? null,
  }));
  const ownerValue = owner ? {
    name: memberDisplayName(owner) ?? t.r2.memberUnknown,
    email: owner.email,
    avatarUrl: owner.avatarUrl,
    roleLabel: memberRoleLabels[owner.role] ?? null,
  } : null;

  // ── From the brain — the entity rollup (row id IS the entity id) ──────
  const [rollup, setRollup] = useState<EntityRollup | null>(null);
  const [rollupMissed, setRollupMissed] = useState(false);
  const [rollupError, setRollupError] = useState(false);
  const [rollupAttempt, setRollupAttempt] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setRollup(null);
    setRollupMissed(false);
    setRollupError(false);
    void getEntity(record.row.id, workspaceId)
      .then((r) => {
        if (cancelled) return;
        if (r) setRollup(r);
        else setRollupMissed(true);
      })
      .catch(() => {
        if (!cancelled) setRollupError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [record.row.id, workspaceId, rollupAttempt]);

  return (
    // A floating peek panel, NOT a flex sibling — it overlays the content
    // pane so opening a record never reflows the table/board underneath.
    <ResizablePeek responsiveFullWidth storageKey="operator:peek-width" ariaLabel={record.row.name} onDismiss={onClose}>
      {/* Slim action toolbar — the Brain entry page's top-row shape. */}
      <div className="flex items-center justify-end gap-1 border-b border-border/60 px-3 py-2">
        <button
          type="button"
          onClick={onClose}
          className="mr-auto inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm font-medium text-muted-foreground hover:bg-accent/60 hover:text-foreground lg:hidden"
        >
          <ArrowLeft className="size-4" aria-hidden />
          {t.r2.returnToCrm}
        </button>
        <button
          type="button"
          aria-label={t.r2.archive}
          title={t.r2.archive}
          onClick={() => onArchive(record)}
          className="rounded-md p-1.5 text-muted-foreground hover:bg-accent/60 hover:text-foreground"
        >
          <Archive className="size-4" aria-hidden />
        </button>
        <Link
          href={brainRowUrl("", workspaceId, record.row.id, record.kind)}
          title={t.openInBrain}
          className="rounded-md p-1.5 text-muted-foreground hover:bg-accent/60 hover:text-foreground"
        >
          <ExternalLink className="size-4" aria-hidden />
        </Link>
        <button
          type="button"
          aria-label={t.closeDetail}
          onClick={onClose}
          className="hidden rounded-md p-1.5 text-muted-foreground hover:bg-accent/60 hover:text-foreground lg:inline-flex"
        >
          <X className="size-4" aria-hidden />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {/* Big muted kind icon leading the editable record name. */}
        <PageTitle
          value={record.row.name}
          editable
          onCommit={commits.rename(record)}
          icon={KIND_ICON[record.kind]}
        />

        {/* Typed fields — the entry page's field block. */}
        <div className="mt-3 flex flex-col">
          <PersonProperty
            icon={<UserRound />}
            label={t.r2.owner}
            value={ownerValue}
            loading={rosterLoading}
            unknownLabel={ownerId && !owner ? t.r2.memberUnavailable : null}
            options={ownerOptions}
            currentId={ownerId}
            clearLabel={t.r2.unassigned}
            onCommit={commits.owner(record)}
          />
          {record.kind === "deal" && (
            <DealFields
              row={record.row}
              data={data}
              config={config}
              commits={commits}
              onOpenRecord={onOpenRecord}
            />
          )}
          {record.kind === "contact" && (
            <ContactFields
              row={record.row}
              data={data}
              commits={commits}
            />
          )}
          {record.kind === "company" && (
            <CompanyFields row={record.row} commits={commits} />
          )}
        </div>

        <CrmActivityTimeline
          workspaceId={workspaceId}
          record={record}
          data={data}
          onOpenContact={(contact) => onOpenRecord({ kind: "contact", row: contact })}
          onReviewEmail={onReviewEmail}
        />

        {/* Relationships — joined client-side from the flat payload. */}
        <Relationships
          record={record}
          data={data}
          onOpenRecord={onOpenRecord}
        />

        {record.kind === "deal" && (
          <CrmParticipants
            workspaceId={workspaceId}
            dealId={record.row.id}
            contacts={data.contacts}
            initialParticipants={initialParticipants}
            onChanged={onChanged}
          />
        )}

        <CrmCustomFields
          workspaceId={workspaceId}
          record={record}
          config={config}
          data={data}
          onChanged={onChanged}
        />

        {record.kind === "contact" && (
          <>
            <CrmContactCompliance workspaceId={workspaceId} contactId={record.row.id} />
            <CrmContactLifecycle
              workspaceId={workspaceId}
              contactId={record.row.id}
              contactName={record.row.name}
              contactEmail={record.row.email}
            />
          </>
        )}

        {/* From the brain — the rollup's embedded context. */}
        <section className="mt-4 border-t border-border/60 pt-4">
          <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/60">
            <Brain className="size-3.5" aria-hidden />
            {t.fromBrain}
          </div>
          {rollupError ? (
            <div className="flex items-center justify-between gap-2 text-[12.5px] text-destructive">
              <span>{t.fromBrainFailed}</span>
              <button type="button" className="underline" onClick={() => setRollupAttempt((attempt) => attempt + 1)}>{t.retry}</button>
            </div>
          ) : rollupMissed ? (
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
    </ResizablePeek>
  );
}

function DealFields({
  row,
  data,
  config,
  commits,
  onOpenRecord,
}: {
  row: CrmDealRow;
  data: CrmData;
  config: CrmConfig;
  commits: RecordCommits;
  onOpenRecord: (ref: CrmRecordRef) => void;
}) {
  const t = useT();
  const tc = t.crmPage;
  const drawerLabels = t.brainPage.detailDrawer.propertyLabels as Record<
    string,
    string
  >;
  const pipeline = config.pipelines.find((candidate) => candidate.id === row.pipelineId)
    ?? config.pipelines.find((candidate) => candidate.isDefault)
    ?? config.pipelines[0];
  const pipelineStage = pipeline ? resolveDealPipelineStage(row, pipeline) : null;
  return (
    <>
      {pipeline && (
        <PropertyRow icon={<CircleDashed />} label={drawerLabels.stage ?? tc.r2.pipelineStage}>
          <div className="flex min-h-9 items-center">
            <PipelineStageCell
              stageId={pipelineStage?.id ?? null}
              stages={pipeline.stages}
              onCommit={commits.dealPipelineStage(row)}
            />
          </div>
        </PropertyRow>
      )}
      <PropertyRow icon={<DollarSign />} label={drawerLabels.amount ?? tc.amountLabel}>
        <div className="flex min-h-9 items-center">
          <AmountCell value={row.amount} currencyCode={row.currencyCode} onCommit={commits.dealAmount(row)} />
        </div>
      </PropertyRow>
      <DateProperty
        icon={<Calendar />}
        label={drawerLabels.close_date ?? tc.closeDateLabel}
        value={row.closeDate ?? ""}
        onCommit={(next) =>
          commits.dealClose(row)(next.length > 0 ? next : null)
        }
      />
      <ReferenceProperty
        icon={<Building2 />}
        label={tc.companyLabel}
        value={row.companyId}
        rows={data.companies}
        clearLabel={tc.r2.noCompany}
        onCommit={commits.dealCompany(row)}
        onOpen={(company) => onOpenRecord({ kind: "company", row: company })}
      />
      <ReferenceProperty
        icon={<UserRound />}
        label={tc.contactLabel}
        value={row.contactId}
        rows={data.contacts}
        clearLabel={tc.r2.noContact}
        onCommit={commits.dealContact(row)}
        onOpen={(contact) => onOpenRecord({ kind: "contact", row: contact })}
      />
      <TextProperty
        icon={<DollarSign />}
        label={tc.r2.currency}
        value={row.currencyCode ?? "USD"}
        onCommit={(next) => commits.dealCurrency(row)(next.trim().toUpperCase())}
        maxLength={3}
      />
      <StaticProperty icon={<Percent />} label={tc.r2.probability}>
        {`${row.probability ?? pipelineStage?.probability ?? 0}%`}
      </StaticProperty>
      <TextProperty
        icon={<CircleDashed />}
        label={tc.r2.source}
        value={row.source ?? ""}
        onCommit={(next) => commits.dealSource(row)(next.trim() || null)}
        maxLength={256}
      />
      <TextProperty
        icon={<CircleDashed />}
        label={tc.r2.winLossReason}
        value={row.winLossReason ?? ""}
        onCommit={(next) => commits.dealWinLossReason(row)(next.trim() || null)}
        maxLength={1_000}
      />
    </>
  );
}

function ContactFields({
  row,
  data,
  commits,
}: {
  row: CrmContactRow;
  data: CrmData;
  commits: RecordCommits;
}) {
  const t = useT();
  const tc = t.crmPage;
  const drawerLabels = t.brainPage.detailDrawer.propertyLabels as Record<
    string,
    string
  >;
  return (
    <>
      <TextProperty
        icon={<Mail />}
        label={drawerLabels.email ?? tc.emailLabel}
        value={row.email ?? ""}
        onCommit={(next) =>
          commits.contactEmail(row)(next.length > 0 ? next : null)
        }
        maxLength={320}
      />
      <TextProperty
        icon={<Phone />}
        label={drawerLabels.phone ?? tc.phoneLabel}
        value={row.phone ?? ""}
        onCommit={(next) =>
          commits.contactPhone(row)(next.length > 0 ? next : null)
        }
        maxLength={64}
      />
      <PropertyRow icon={<Building2 />} label={tc.companyLabel}>
        <div className="flex min-h-9 items-center">
          <CompanyCell
            companyId={row.companyId}
            companies={data.companies}
            onCommit={commits.contactCompany(row)}
          />
        </div>
      </PropertyRow>
      <TagsProperty
        icon={<Tags />}
        label={drawerLabels.tags ?? tc.tagsLabel}
        tags={row.tags}
        onCommit={commits.contactTags(row)}
      />
    </>
  );
}

function CompanyFields({
  row,
  commits,
}: {
  row: CrmCompanyRow;
  commits: RecordCommits;
}) {
  const t = useT();
  const tc = t.crmPage;
  const drawerLabels = t.brainPage.detailDrawer.propertyLabels as Record<
    string,
    string
  >;
  return (
    <>
      <TextProperty
        icon={<Globe />}
        label={drawerLabels.domain ?? tc.domainLabel}
        value={row.domain ?? ""}
        onCommit={(next) =>
          commits.companyDomain(row)(next.length > 0 ? next : null)
        }
        maxLength={256}
      />
      <TagsProperty
        icon={<Tags />}
        label={drawerLabels.tags ?? tc.tagsLabel}
        tags={row.tags}
        onCommit={commits.companyTags(row)}
      />
    </>
  );
}

function ReferenceProperty<T extends CrmContactRow | CrmCompanyRow>({
  icon,
  label,
  value,
  rows,
  clearLabel,
  onCommit,
  onOpen,
}: {
  icon: React.ReactNode;
  label: string;
  value: string | null;
  rows: T[];
  clearLabel: string;
  onCommit: CellCommit<string | null>;
  onOpen: (row: T) => void;
}) {
  const t = useT().crmPage;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selected = value ? rows.find((row) => row.id === value) ?? null : null;
  const none = "__none__";
  return (
    <PropertyRow icon={icon} label={label} error={error}>
      <div className="flex min-h-9 min-w-0 items-center gap-1">
        <SearchableSelect
          value={value ?? none}
          onValueChange={(next) => {
            const nextId = next === none ? null : next;
            if (nextId === value) return;
            setBusy(true);
            setError(null);
            void onCommit(nextId).then((result) => {
              setBusy(false);
              if (!result.ok) setError(result.error ?? t.r2.updateFailed);
            });
          }}
          items={[
            { value: none, label: clearLabel },
            ...rows.map((row) => ({ value: row.id, label: row.name })),
          ]}
          searchPlaceholder={t.r2.searchRecords}
          emptyMessage={t.r2.noMatchingRecords}
          disabled={busy}
          className="h-8 min-w-0 flex-1 border-0 bg-transparent px-1.5 shadow-none"
          aria-label={label}
        />
        {selected ? (
          <button
            type="button"
            aria-label={t.openRecord}
            title={t.openRecord}
            onClick={() => onOpen(selected)}
            className="shrink-0 rounded-md p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <ExternalLink className="size-3.5" aria-hidden />
          </button>
        ) : null}
      </div>
    </PropertyRow>
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
      className="-ml-1.5 flex w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left text-sm hover:bg-muted/70"
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
    const pipelineTotals = openDeals.reduce<Record<string, number>>((totals, deal) => {
      if (deal.amount === null) return totals;
      const currency = deal.currencyCode?.toUpperCase() || "USD";
      totals[currency] = Math.round(((totals[currency] ?? 0) + deal.amount) * 100) / 100;
      return totals;
    }, {});
    const pipelineValue = formatCurrencyTotals(pipelineTotals, true);
    return (
      <section className="mt-4 border-t border-border/60 pt-4">
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
            pipelineValue
              ? format(t.openDealsWithValue, { value: pipelineValue })
              : t.openDeals
          }
          count={openDeals.length}
          empty={t.noneYet}
        >
          {openDeals.map((d) => (
            <RecordLink
              key={d.id}
              name={d.name}
              meta={d.amount !== null ? formatAmount(d.amount, d.currencyCode) : undefined}
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
      <section className="mt-4 border-t border-border/60 pt-4">
        <RelationBlock title={t.dealsFor} count={deals.length} empty={t.noneYet}>
          {deals.map((d) => (
            <RecordLink
              key={d.id}
              name={d.name}
              meta={d.amount !== null ? formatAmount(d.amount, d.currencyCode) : undefined}
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
    <div className="mb-3 last:mb-0">
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
