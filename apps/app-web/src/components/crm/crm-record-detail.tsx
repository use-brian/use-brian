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
  Building2,
  Calendar,
  CircleDashed,
  DollarSign,
  ExternalLink,
  Globe,
  Handshake,
  Mail,
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
  DEAL_STAGES,
  isOpenStage,
  type CrmCompanyRow,
  type CrmContactRow,
  type CrmDealRow,
  type CrmData,
  type DealStage,
} from "@/lib/api/crm";
import { formatAmount } from "@/lib/crm-view";
import {
  DateProperty,
  PageTitle,
  PropertyRow,
  SelectProperty,
  StaticProperty,
  TagsProperty,
  TextProperty,
  type SelectPropertyOption,
} from "@/components/brain/property-field";
import { AmountCell, CompanyCell, STAGE_DOT, type CellCommit } from "./crm-cells";
import { ResizablePeek } from "@/components/operator/resizable-peek";

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

const KIND_ICON = {
  deal: <Handshake />,
  contact: <UserRound />,
  company: <Building2 />,
} as const;

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

  return (
    // A floating peek panel, NOT a flex sibling — it overlays the content
    // pane so opening a record never reflows the table/board underneath.
    <ResizablePeek storageKey="operator:peek-width" ariaLabel={record.row.name} onDismiss={onClose}>
      {/* Slim action toolbar — the Brain entry page's top-row shape. */}
      <div className="flex items-center justify-end gap-1 border-b border-border/60 px-3 py-2">
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
          className="rounded-md p-1.5 text-muted-foreground hover:bg-accent/60 hover:text-foreground"
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
          {record.kind === "deal" && (
            <DealFields
              row={record.row}
              data={data}
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

        {/* Relationships — joined client-side from the flat payload. */}
        <Relationships
          record={record}
          data={data}
          onOpenRecord={onOpenRecord}
        />

        {/* From the brain — the rollup's embedded context. */}
        <section className="mt-4 border-t border-border/60 pt-4">
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
    </ResizablePeek>
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
  const t = useT();
  const tc = t.crmPage;
  const stageLabels = tc.stage as Record<string, string>;
  const drawerLabels = t.brainPage.detailDrawer.propertyLabels as Record<
    string,
    string
  >;
  const stageOptions: SelectPropertyOption[] = DEAL_STAGES.map((s) => ({
    value: s,
    label: stageLabels[s] ?? s,
    dotClassName: STAGE_DOT[s],
  }));
  const company = row.companyId
    ? data.companies.find((c) => c.id === row.companyId)
    : null;
  const contact = row.contactId
    ? data.contacts.find((c) => c.id === row.contactId)
    : null;
  return (
    <>
      <SelectProperty
        icon={<CircleDashed />}
        label={drawerLabels.stage ?? tc.stageLabel}
        value={row.stage}
        options={stageOptions}
        onCommit={(stage) => commits.dealStage(row)(stage as DealStage)}
      />
      <PropertyRow icon={<DollarSign />} label={drawerLabels.amount ?? tc.amountLabel}>
        <div className="flex min-h-9 items-center">
          <AmountCell value={row.amount} onCommit={commits.dealAmount(row)} />
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
      {company && (
        <StaticProperty
          icon={<Building2 />}
          label={tc.companyLabel}
        >
          <RecordLink
            name={company.name}
            onClick={() => onOpenRecord({ kind: "company", row: company })}
          />
        </StaticProperty>
      )}
      {contact && (
        <StaticProperty icon={<UserRound />} label={tc.contactLabel}>
          <RecordLink
            name={contact.name}
            onClick={() => onOpenRecord({ kind: "contact", row: contact })}
          />
        </StaticProperty>
      )}
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
    const pipeline = openDeals.reduce((sum, d) => sum + (d.amount ?? 0), 0);
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
      <section className="mt-4 border-t border-border/60 pt-4">
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
