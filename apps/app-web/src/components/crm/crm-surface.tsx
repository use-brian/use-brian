"use client";

/**
 * CRM operator surface — `/w/[id]/crm` (crm-operator-surface §3).
 *
 * The pipeline lens over the SAME entity rows the chat tools and Brain
 * graph read (lens, not data): three sections (Deals — default, board-first
 * — / Contacts / Companies) switched in the header + sidebar panel;
 * attention quick-filters with live counts; per-section filter row +
 * search; the deal board (drag-to-stage) or dense tables with inline cell
 * edit; a master-detail record pane with brain context
 * (`crm-record-detail.tsx`). Checking table rows swaps the filter row for
 * the bulk bar (client loop over the per-row adjust wire — no server bulk
 * lane yet, §8 Phase 4).
 *
 * State model: the URL is the single source of truth for the view
 * (`crm-view.ts` codec) — the sidebar panel and the Home dock card
 * (`?filter=overdue`) deep-link into it. Mutations ride the brain-inbox
 * adjust wire (`adjustBrainRow`; CRM adjusts are IN PLACE — the id never
 * changes); stage commits route through `setDealStage` server-side.
 *
 * Spec: docs/architecture/features/crm.md → "Operator surface".
 * [COMP:app-web/crm-surface]
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Kanban, Rows3 } from "lucide-react";
import { OperatorTopbar } from "@/components/operator/operator-topbar";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n/format";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  adjustBrainRow,
  type AdjustMemoryChanges,
} from "@/lib/api/brain-inbox";
import {
  DEAL_STAGES,
  fetchWorkspaceCrm,
  isOpenStage,
  type CrmCompanyRow,
  type CrmContactRow,
  type CrmData,
  type CrmDealRow,
  type DealStage,
} from "@/lib/api/crm";
import {
  applyCompanyFilters,
  applyContactFilters,
  applyDealFilters,
  companyNameById,
  companyStats,
  contactNameById,
  crmQuickCounts,
  crmTagOptions,
  localDateStr,
  matchesDealQuickFilter,
  searchFromCrmView,
  sortDeals,
  crmViewFromSearch,
  CONTACT_QUICK_FILTERS,
  DEAL_QUICK_FILTERS,
  DEAL_SORT_KEYS,
  CRM_SECTIONS,
  type CrmQuickFilter,
  type CrmSection,
  type CrmViewState,
} from "@/lib/crm-view";
import { requestBrainRefresh } from "@/lib/brain-events";
import {
  AmountCell,
  CloseDateCell,
  CompanyCell,
  StageCell,
  STAGE_DOT,
  TagsCell,
  TextFieldCell,
} from "./crm-cells";
import {
  FilterBar,
  ViewOptionRow,
  ViewOptionSection,
  type FilterDef,
} from "@/components/operator/filter-bar";
import { CrmBoard } from "./crm-board";
import {
  CrmRecordDetail,
  type CrmRecordRef,
  type RecordCommits,
} from "./crm-record-detail";

const NONE = "__none__";

type CrmPrimitive = "deal" | "contact" | "company";

export function CrmSurface({ workspaceId }: { workspaceId: string }) {
  const t = useT().crmPage;
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // ── Data ──────────────────────────────────────────────────────────────
  const [data, setData] = useState<CrmData | null>(null);
  const [loadError, setLoadError] = useState(false);

  const reload = useCallback(() => {
    setLoadError(false);
    fetchWorkspaceCrm(workspaceId)
      .then(setData)
      .catch(() => setLoadError(true));
  }, [workspaceId]);

  useEffect(() => {
    setData(null);
    reload();
  }, [workspaceId, reload]);

  // ── View state (URL is the source of truth) ───────────────────────────
  const view = useMemo(() => crmViewFromSearch(searchParams), [searchParams]);
  const setView = useCallback(
    (patch: Partial<CrmViewState>) => {
      const next = { ...view, ...patch };
      const search = searchFromCrmView(next);
      router.replace(search ? `${pathname}?${search}` : pathname, {
        scroll: false,
      });
    },
    [view, router, pathname],
  );

  // ── Derived ───────────────────────────────────────────────────────────
  const now = useMemo(() => new Date(), []);
  const deals = data?.deals ?? [];
  const contacts = data?.contacts ?? [];
  const companies = data?.companies ?? [];
  const companyNames = useMemo(() => companyNameById(companies), [companies]);
  const contactNames = useMemo(() => contactNameById(contacts), [contacts]);
  const counts = useMemo(
    () => crmQuickCounts(deals, contacts, now),
    [deals, contacts, now],
  );
  const stats = useMemo(() => companyStats(contacts, deals), [contacts, deals]);
  const tagOptions = useMemo(
    () => crmTagOptions(contacts, companies),
    [contacts, companies],
  );

  const filteredDeals = useMemo(
    () => sortDeals(applyDealFilters(deals, view, companyNames, now), view.sort),
    [deals, view, companyNames, now],
  );
  // The board owns the closed fold itself (rail chips), so it reads the
  // filter WITHOUT the fold applied only when a stage/quick filter is off.
  const boardDeals = useMemo(
    () =>
      sortDeals(
        applyDealFilters(deals, { ...view, closed: true }, companyNames, now),
        view.sort,
      ),
    [deals, view, companyNames, now],
  );
  const filteredContacts = useMemo(
    () => applyContactFilters(contacts, view),
    [contacts, view],
  );
  const filteredCompanies = useMemo(
    () => applyCompanyFilters(companies, view),
    [companies, view],
  );

  const openDealCount = useMemo(
    () => deals.filter((d) => isOpenStage(d.stage)).length,
    [deals],
  );

  // ── Selection (table rows) ────────────────────────────────────────────
  const [selected, setSelected] = useState<Set<string>>(new Set());
  useEffect(() => {
    // Section switches invalidate the selection (different primitive).
    setSelected(new Set());
  }, [view.section]);
  const visibleRows: readonly { id: string }[] =
    view.section === "deals"
      ? filteredDeals
      : view.section === "contacts"
        ? filteredContacts
        : filteredCompanies;
  const visibleIds = useMemo(
    () => new Set(visibleRows.map((r) => r.id)),
    [visibleRows],
  );
  const selectedVisible = useMemo(
    () => [...selected].filter((id) => visibleIds.has(id)),
    [selected, visibleIds],
  );
  const toggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const allSelected =
    visibleRows.length > 0 && selectedVisible.length === visibleRows.length;
  const toggleAll = useCallback(() => {
    setSelected(
      allSelected ? new Set() : new Set(visibleRows.map((r) => r.id)),
    );
  }, [allSelected, visibleRows]);

  // ── Record detail ─────────────────────────────────────────────────────
  const [openRecord, setOpenRecord] = useState<{
    kind: CrmPrimitive;
    id: string;
  } | null>(null);
  // Re-derive the record from fresh data so inline patches show live.
  const record: CrmRecordRef | null = useMemo(() => {
    if (!openRecord || !data) return null;
    if (openRecord.kind === "deal") {
      const row = data.deals.find((d) => d.id === openRecord.id);
      return row ? { kind: "deal", row } : null;
    }
    if (openRecord.kind === "contact") {
      const row = data.contacts.find((c) => c.id === openRecord.id);
      return row ? { kind: "contact", row } : null;
    }
    const row = data.companies.find((c) => c.id === openRecord.id);
    return row ? { kind: "company", row } : null;
  }, [openRecord, data]);

  // ── Mutations (in-place adjusts) ──────────────────────────────────────
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);

  const patchDeal = useCallback((id: string, patch: Partial<CrmDealRow>) => {
    setData((prev) =>
      prev
        ? {
            ...prev,
            deals: prev.deals.map((d) => (d.id === id ? { ...d, ...patch } : d)),
          }
        : prev,
    );
  }, []);
  const patchContact = useCallback(
    (id: string, patch: Partial<CrmContactRow>) => {
      setData((prev) =>
        prev
          ? {
              ...prev,
              contacts: prev.contacts.map((c) =>
                c.id === id ? { ...c, ...patch } : c,
              ),
            }
          : prev,
      );
    },
    [],
  );
  const patchCompany = useCallback(
    (id: string, patch: Partial<CrmCompanyRow>) => {
      setData((prev) =>
        prev
          ? {
              ...prev,
              companies: prev.companies.map((c) =>
                c.id === id ? { ...c, ...patch } : c,
              ),
            }
          : prev,
      );
    },
    [],
  );

  /** One inline-cell commit: adjust (in place) + local patch + repaint. */
  const commitField = useCallback(
    async (
      primitive: CrmPrimitive,
      id: string,
      changes: AdjustMemoryChanges,
      apply: () => void,
    ): Promise<{ ok: boolean; error?: string }> => {
      const result = await adjustBrainRow(workspaceId, primitive, id, changes);
      if (!result.ok) return { ok: false, error: result.error };
      apply();
      requestBrainRefresh(workspaceId);
      return { ok: true };
    },
    [workspaceId],
  );

  const commits: RecordCommits = useMemo(
    () => ({
      rename: (ref) => (name) =>
        commitField(ref.kind, ref.row.id, { display_name: name }, () => {
          if (ref.kind === "deal") patchDeal(ref.row.id, { name });
          else if (ref.kind === "contact") patchContact(ref.row.id, { name });
          else patchCompany(ref.row.id, { name });
        }),
      dealStage: (row) => (stage) =>
        commitField("deal", row.id, { stage }, () =>
          patchDeal(row.id, { stage }),
        ),
      dealAmount: (row) => (amount) =>
        commitField("deal", row.id, { amount }, () =>
          patchDeal(row.id, { amount }),
        ),
      dealClose: (row) => (close_date) =>
        commitField("deal", row.id, { close_date }, () =>
          patchDeal(row.id, { closeDate: close_date }),
        ),
      contactEmail: (row) => (email) =>
        commitField("contact", row.id, { email }, () =>
          patchContact(row.id, { email }),
        ),
      contactPhone: (row) => (phone) =>
        commitField("contact", row.id, { phone }, () =>
          patchContact(row.id, { phone }),
        ),
      contactCompany: (row) => (company_id) =>
        commitField("contact", row.id, { company_id }, () =>
          patchContact(row.id, { companyId: company_id }),
        ),
      contactTags: (row) => (tags) =>
        commitField("contact", row.id, { tags }, () =>
          patchContact(row.id, { tags }),
        ),
      companyDomain: (row) => (domain) =>
        commitField("company", row.id, { domain }, () =>
          patchCompany(row.id, { domain }),
        ),
      companyTags: (row) => (tags) =>
        commitField("company", row.id, { tags }, () =>
          patchCompany(row.id, { tags }),
        ),
    }),
    [commitField, patchDeal, patchContact, patchCompany],
  );

  /** Bulk = client loop over the per-row adjust wire (failed ids STAY
   *  SELECTED for a retry — the Reviews-queue contract; §1.6). */
  const runBulk = useCallback(
    async (
      primitive: CrmPrimitive,
      changesFor: (id: string) => AdjustMemoryChanges | null,
      applyFor: (id: string) => void,
    ) => {
      const ids = selectedVisible;
      if (ids.length === 0 || bulkBusy) return;
      setBulkBusy(true);
      setBulkError(null);
      try {
        const failed: string[] = [];
        for (const id of ids) {
          const changes = changesFor(id);
          if (!changes) continue;
          const result = await adjustBrainRow(workspaceId, primitive, id, changes);
          if (result.ok) applyFor(id);
          else failed.push(id);
        }
        if (failed.length > 0) {
          setSelected(new Set(failed));
          setBulkError(
            format(t.bulkPartialFail, {
              failed: String(failed.length),
              total: String(ids.length),
            }),
          );
        } else {
          setSelected(new Set());
        }
      } finally {
        setBulkBusy(false);
        requestBrainRefresh(workspaceId);
      }
    },
    [selectedVisible, bulkBusy, workspaceId, t],
  );

  // ── Render ────────────────────────────────────────────────────────────
  const stageLabels = t.stage as Record<string, string>;
  const sectionLabels: Record<CrmSection, string> = {
    deals: t.sectionDeals,
    contacts: t.sectionContacts,
    companies: t.sectionCompanies,
  };
  const quickLabels: Record<CrmQuickFilter, string> = {
    overdue: t.quickOverdue,
    stale: t.quickStale,
    noAmount: t.quickNoAmount,
    orphaned: t.quickOrphaned,
  };
  const sortLabels: Record<string, string> = {
    updated: t.sortUpdated,
    amount: t.sortAmount,
    close: t.sortClose,
  };
  const sectionCounts: Record<CrmSection, number> = {
    deals: deals.length,
    contacts: contacts.length,
    companies: companies.length,
  };
  const sectionQuicks: readonly CrmQuickFilter[] =
    view.section === "deals"
      ? DEAL_QUICK_FILTERS
      : view.section === "contacts"
        ? CONTACT_QUICK_FILTERS
        : [];

  const hasSelection = selectedVisible.length > 0 && view.view === "table";
  const today = localDateStr(now);

  // Property → value defs for the FilterBar (Notion-style funnel picker),
  // section-scoped like the old dropdowns were.
  const filterDefs: FilterDef[] = [
    ...(view.section === "deals"
      ? [
          {
            key: "stage",
            label: t.filterStage,
            options: DEAL_STAGES.map((sKey) => ({
              value: sKey,
              label: stageLabels[sKey] ?? sKey,
              dot: STAGE_DOT[sKey],
            })),
          },
        ]
      : []),
    ...(view.section !== "companies"
      ? [
          {
            key: "company",
            label: t.filterCompany,
            options: [
              { value: "none", label: t.noCompany },
              ...companies.map((c) => ({ value: c.id, label: c.name })),
            ],
          },
        ]
      : []),
    ...(view.section !== "deals"
      ? [
          {
            key: "tag",
            label: t.filterTag,
            options: tagOptions.map((tag) => ({ value: tag, label: tag })),
          },
        ]
      : []),
  ];

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Chrome — the shared operator top bar names the app; the section
          switch rides its center slot, the deals count + view toggle its
          right slot, replacing the old icon+title header row
          ([COMP:app-web/operator-topbar]). */}
      <OperatorTopbar
        app="crm"
        center={
          <div className="flex shrink-0 items-center gap-0.5 rounded-lg bg-sidebar-accent/60 p-0.5">
            {CRM_SECTIONS.map((section) => (
              <button
                key={section}
                type="button"
                aria-pressed={view.section === section}
                onClick={() =>
                  setView({ section, quick: null, stages: [], q: "" })
                }
                className={cn(
                  "inline-flex h-6.5 items-center gap-1.5 rounded-md px-2 text-[12.5px] transition-colors",
                  view.section === section
                    ? "bg-background font-medium shadow-sm"
                    : "text-sidebar-foreground/70 hover:text-sidebar-accent-foreground",
                )}
              >
                {sectionLabels[section]}
                {data !== null && (
                  <span className="tabular-nums text-[11px] text-muted-foreground">
                    {sectionCounts[section]}
                  </span>
                )}
              </button>
            ))}
          </div>
        }
        right={
          view.section === "deals" ? (
            <>
              {data !== null && (
                <span className="text-[12.5px] text-sidebar-foreground/70 max-lg:hidden">
                  {format(t.dealCountSummary, {
                    open: String(openDealCount),
                  })}
                </span>
              )}
              <button
                type="button"
                aria-pressed={view.view === "board"}
                aria-label={t.viewBoard}
                onClick={() => setView({ view: "board" })}
                className={cn(
                  "inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[12.5px]",
                  view.view === "board"
                    ? "bg-sidebar-accent text-sidebar-accent-foreground"
                    : "text-sidebar-foreground/70 hover:bg-sidebar-accent/60",
                )}
              >
                <Kanban className="size-3.5" aria-hidden />
                {t.viewBoard}
              </button>
              <button
                type="button"
                aria-pressed={view.view === "table"}
                aria-label={t.viewTable}
                onClick={() => setView({ view: "table" })}
                className={cn(
                  "inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[12.5px]",
                  view.view === "table"
                    ? "bg-sidebar-accent text-sidebar-accent-foreground"
                    : "text-sidebar-foreground/70 hover:bg-sidebar-accent/60",
                )}
              >
                <Rows3 className="size-3.5" aria-hidden />
                {t.viewTable}
              </button>
            </>
          ) : undefined
        }
      />

      {/* `relative`: the record-detail peek panel positions against THIS box
          and floats OVER the content — it never squeezes the middle pane,
          and never covers the bar. */}
      <div className="relative flex min-h-0 flex-1">
        <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">

        {/* Toolbar — attention presets + filters + search in ONE quiet strip
            (it swaps for the bulk bar while table rows are checked). */}
        {hasSelection ? (
          <BulkBar
            section={view.section}
            count={selectedVisible.length}
            busy={bulkBusy}
            error={bulkError}
            companies={companies}
            tagOptions={tagOptions}
            stageLabels={stageLabels}
            onClear={() => setSelected(new Set())}
            onDealStage={(stage) =>
              void runBulk(
                "deal",
                () => ({ stage }),
                (id) => patchDeal(id, { stage }),
              )
            }
            onContactCompany={(companyId) =>
              void runBulk(
                "contact",
                () => ({ company_id: companyId }),
                (id) => patchContact(id, { companyId }),
              )
            }
            onAddTag={(tag) => {
              const primitive: CrmPrimitive =
                view.section === "contacts" ? "contact" : "company";
              const rows: readonly (CrmContactRow | CrmCompanyRow)[] =
                view.section === "contacts" ? contacts : companies;
              void runBulk(
                primitive,
                (id) => {
                  const row = rows.find((r) => r.id === id);
                  if (!row || row.tags.includes(tag)) return null;
                  return { tags: [...row.tags, tag] };
                },
                (id) => {
                  const row = rows.find((r) => r.id === id);
                  if (!row || row.tags.includes(tag)) return;
                  const tags = [...row.tags, tag];
                  if (view.section === "contacts") patchContact(id, { tags });
                  else patchCompany(id, { tags });
                },
              );
            }}
          />
        ) : (
          <div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-4 py-2.5">
            {sectionQuicks.map((f) => {
              const active = view.quick === f;
              const count = counts[f];
              return (
                <button
                  key={f}
                  type="button"
                  disabled={count === 0 && !active}
                  aria-pressed={active}
                  onClick={() =>
                    setView({ quick: active ? null : f, stages: [] })
                  }
                  className={cn(
                    "inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs transition-colors",
                    active
                      ? "border-foreground bg-foreground text-background"
                      : "border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground",
                    count === 0 && !active && "opacity-40",
                  )}
                >
                  {quickLabels[f]}
                  <span className="tabular-nums opacity-70">{count}</span>
                </button>
              );
            })}
            {sectionQuicks.length > 0 && (
              <span className="mx-1 hidden h-4 w-px bg-border sm:block" aria-hidden />
            )}
            <FilterBar
              defs={filterDefs}
              active={
                view.section === "deals"
                  ? { stage: view.quick ? null : (view.stages[0] ?? null), company: view.company }
                  : view.section === "contacts"
                    ? { company: view.company, tag: view.tag }
                    : { tag: view.tag }
              }
              onSet={(key, value) => {
                if (key === "stage")
                  setView({ quick: null, stages: value ? [value as DealStage] : [] });
                else if (key === "company") setView({ company: value });
                else if (key === "tag") setView({ tag: value });
              }}
              search={view.q}
              onSearch={(q) => setView({ q })}
              searchPlaceholder={t.searchPlaceholder}
              viewOptions={
                view.section === "deals" && view.view === "table" ? (
                  <>
                    <ViewOptionSection label={t.sortLabel}>
                      {DEAL_SORT_KEYS.map((sKey) => (
                        <ViewOptionRow
                          key={sKey}
                          label={sortLabels[sKey] ?? sKey}
                          selected={view.sort === sKey}
                          onPick={() => setView({ sort: sKey })}
                        />
                      ))}
                    </ViewOptionSection>
                    <label className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-muted-foreground transition-colors hover:bg-muted">
                      <Checkbox
                        checked={view.closed}
                        onCheckedChange={(checked) => setView({ closed: checked })}
                        aria-label={t.showClosed}
                      />
                      {t.showClosed}
                    </label>
                  </>
                ) : undefined
              }
            />
          </div>
        )}

        {/* Body. */}
        <div className="min-h-0 flex-1 overflow-auto">
          {data === null ? (
            <div className="p-6 text-sm text-muted-foreground">
              {loadError ? (
                <span>
                  {t.loadFailed}{" "}
                  <button
                    type="button"
                    onClick={reload}
                    className="underline hover:text-foreground"
                  >
                    {t.retry}
                  </button>
                </span>
              ) : (
                t.loading
              )}
            </div>
          ) : view.section === "deals" && view.view === "board" ? (
            boardDeals.length === 0 && deals.length === 0 ? (
              <div className="p-6 text-sm text-muted-foreground">{t.emptyDeals}</div>
            ) : (
              <CrmBoard
                rows={boardDeals}
                companyNames={companyNames}
                contactNames={contactNames}
                showClosed={view.closed}
                onToggleClosed={() => setView({ closed: !view.closed })}
                onStageDrop={(row, stage) =>
                  void commits.dealStage(row)(stage)
                }
                onOpenRecord={(row) =>
                  setOpenRecord({ kind: "deal", id: row.id })
                }
              />
            )
          ) : view.section === "deals" ? (
            <DealsTable
              rows={filteredDeals}
              companies={companies}
              companyNames={companyNames}
              contactNames={contactNames}
              today={today}
              selected={selected}
              onToggle={toggle}
              allSelected={allSelected}
              hasSelection={selectedVisible.length > 0}
              onToggleAll={toggleAll}
              commits={commits}
              onOpenRecord={(row) => setOpenRecord({ kind: "deal", id: row.id })}
              empty={deals.length === 0 ? t.emptyDeals : t.emptyFiltered}
            />
          ) : view.section === "contacts" ? (
            <ContactsTable
              rows={filteredContacts}
              companies={companies}
              selected={selected}
              onToggle={toggle}
              allSelected={allSelected}
              hasSelection={selectedVisible.length > 0}
              onToggleAll={toggleAll}
              commits={commits}
              onOpenRecord={(row) =>
                setOpenRecord({ kind: "contact", id: row.id })
              }
              empty={contacts.length === 0 ? t.emptyContacts : t.emptyFiltered}
            />
          ) : (
            <CompaniesTable
              rows={filteredCompanies}
              stats={stats}
              selected={selected}
              onToggle={toggle}
              allSelected={allSelected}
              hasSelection={selectedVisible.length > 0}
              onToggleAll={toggleAll}
              commits={commits}
              onOpenRecord={(row) =>
                setOpenRecord({ kind: "company", id: row.id })
              }
              empty={companies.length === 0 ? t.emptyCompanies : t.emptyFiltered}
            />
          )}
        </div>
      </div>

        {/* Master-detail record pane. */}
        {record && data && (
          <CrmRecordDetail
            workspaceId={workspaceId}
            record={record}
            data={data}
            commits={commits}
            onClose={() => setOpenRecord(null)}
            onOpenRecord={(ref) => setOpenRecord({ kind: ref.kind, id: ref.row.id })}
          />
        )}
      </div>
    </div>
  );
}

// ── Tables ──────────────────────────────────────────────────────────────

// One grid template per table, shared by the header strip and the rows so
// the columns can never drift apart.
const DEAL_GRID =
  "grid-cols-[28px_minmax(0,1fr)_130px_minmax(0,140px)_110px_105px_82px]";
const CONTACT_GRID =
  "grid-cols-[28px_minmax(0,1fr)_minmax(0,180px)_120px_minmax(0,150px)_110px_82px]";
const COMPANY_GRID =
  "grid-cols-[28px_minmax(0,1fr)_minmax(0,170px)_minmax(0,150px)_92px_92px_82px]";

/** Quiet sticky column-header strip. */
function TableHead({
  grid,
  labels,
}: {
  grid: string;
  labels: (string | null)[];
}) {
  return (
    <div
      className={cn(
        "sticky top-0 z-10 grid items-center gap-1 border-b border-border/60 bg-background/95 px-4 py-1.5 backdrop-blur",
        grid,
      )}
    >
      {labels.map((label, i) => (
        <span
          key={i}
          className="truncate text-[11px] font-medium uppercase tracking-wide text-muted-foreground/60"
        >
          {label ?? ""}
        </span>
      ))}
    </div>
  );
}

function DealsTable({
  rows,
  companies,
  companyNames,
  contactNames,
  today,
  selected,
  onToggle,
  allSelected,
  hasSelection,
  onToggleAll,
  commits,
  onOpenRecord,
  empty,
}: {
  rows: CrmDealRow[];
  companies: readonly CrmCompanyRow[];
  companyNames: Map<string, string>;
  contactNames: Map<string, string>;
  today: string;
  selected: Set<string>;
  onToggle: (id: string) => void;
  allSelected: boolean;
  hasSelection: boolean;
  onToggleAll: () => void;
  commits: RecordCommits;
  onOpenRecord: (row: CrmDealRow) => void;
  empty: string;
}) {
  const t = useT().crmPage;
  if (rows.length === 0)
    return <div className="p-6 text-sm text-muted-foreground">{empty}</div>;
  return (
    <div className="min-w-[720px] pb-2">
      <TableHead
        grid={DEAL_GRID}
        labels={[
          null,
          t.nameLabel,
          t.stageLabel,
          t.companyLabel,
          t.amountLabel,
          t.closeDateLabel,
          t.updatedLabel,
        ]}
      />
      {rows.map((row) => {
        const overdue =
          isOpenStage(row.stage) &&
          row.closeDate !== null &&
          row.closeDate < today;
        return (
          <div
            key={row.id}
            className={cn(
              "group/crm grid items-center gap-1 px-4 py-1.5 transition-colors",
              DEAL_GRID,
              selected.has(row.id) ? "bg-primary/5" : "hover:bg-muted/40",
            )}
          >
            <RowCheckbox
              checked={selected.has(row.id)}
              name={row.name}
              onToggle={() => onToggle(row.id)}
            />
            <button
              type="button"
              onClick={() => onOpenRecord(row)}
              title={t.openRecord}
              className="truncate py-1 text-left text-[13.5px] font-medium text-foreground hover:underline"
            >
              {row.name}
            </button>
            <StageCell value={row.stage} onCommit={commits.dealStage(row)} />
            <span className="truncate text-[12.5px] text-muted-foreground">
              {(row.companyId ? companyNames.get(row.companyId) : null) ??
                (row.contactId ? contactNames.get(row.contactId) : null) ??
                ""}
            </span>
            <AmountCell value={row.amount} onCommit={commits.dealAmount(row)} />
            <CloseDateCell
              value={row.closeDate}
              overdue={overdue}
              onCommit={commits.dealClose(row)}
            />
            <UpdatedCell iso={row.updatedAt} />
          </div>
        );
      })}
      <SelectAllFooter
        allSelected={allSelected}
        hasSelection={hasSelection}
        count={rows.length}
        onToggleAll={onToggleAll}
      />
    </div>
  );
}

function ContactsTable({
  rows,
  companies,
  selected,
  onToggle,
  allSelected,
  hasSelection,
  onToggleAll,
  commits,
  onOpenRecord,
  empty,
}: {
  rows: CrmContactRow[];
  companies: readonly CrmCompanyRow[];
  selected: Set<string>;
  onToggle: (id: string) => void;
  allSelected: boolean;
  hasSelection: boolean;
  onToggleAll: () => void;
  commits: RecordCommits;
  onOpenRecord: (row: CrmContactRow) => void;
  empty: string;
}) {
  const t = useT().crmPage;
  if (rows.length === 0)
    return <div className="p-6 text-sm text-muted-foreground">{empty}</div>;
  return (
    <div className="min-w-[720px] pb-2">
      <TableHead
        grid={CONTACT_GRID}
        labels={[
          null,
          t.nameLabel,
          t.emailLabel,
          t.phoneLabel,
          t.companyLabel,
          t.tagsLabel,
          t.updatedLabel,
        ]}
      />
      {rows.map((row) => (
        <div
          key={row.id}
          className={cn(
            "group/crm grid items-center gap-1 px-4 py-1.5 transition-colors",
            CONTACT_GRID,
            selected.has(row.id) ? "bg-primary/5" : "hover:bg-muted/40",
          )}
        >
          <RowCheckbox
            checked={selected.has(row.id)}
            name={row.name}
            onToggle={() => onToggle(row.id)}
          />
          <button
            type="button"
            onClick={() => onOpenRecord(row)}
            title={t.openRecord}
            className="truncate py-1 text-left text-[13.5px] font-medium text-foreground hover:underline"
          >
            {row.name}
          </button>
          <TextFieldCell
            value={row.email}
            placeholder={t.noValue}
            ariaLabel={t.emailLabel}
            inputType="email"
            onCommit={commits.contactEmail(row)}
          />
          <TextFieldCell
            value={row.phone}
            placeholder={t.noValue}
            ariaLabel={t.phoneLabel}
            inputType="tel"
            onCommit={commits.contactPhone(row)}
          />
          <CompanyCell
            companyId={row.companyId}
            companies={companies}
            onCommit={commits.contactCompany(row)}
          />
          <TagsCell tags={row.tags} onCommit={commits.contactTags(row)} />
          <UpdatedCell iso={row.updatedAt} />
        </div>
      ))}
      <SelectAllFooter
        allSelected={allSelected}
        hasSelection={hasSelection}
        count={rows.length}
        onToggleAll={onToggleAll}
      />
    </div>
  );
}

function CompaniesTable({
  rows,
  stats,
  selected,
  onToggle,
  allSelected,
  hasSelection,
  onToggleAll,
  commits,
  onOpenRecord,
  empty,
}: {
  rows: CrmCompanyRow[];
  stats: Map<string, { contacts: number; openDeals: number }>;
  selected: Set<string>;
  onToggle: (id: string) => void;
  allSelected: boolean;
  hasSelection: boolean;
  onToggleAll: () => void;
  commits: RecordCommits;
  onOpenRecord: (row: CrmCompanyRow) => void;
  empty: string;
}) {
  const t = useT().crmPage;
  if (rows.length === 0)
    return <div className="p-6 text-sm text-muted-foreground">{empty}</div>;
  return (
    <div className="min-w-[680px] pb-2">
      <TableHead
        grid={COMPANY_GRID}
        labels={[
          null,
          t.nameLabel,
          t.domainLabel,
          t.tagsLabel,
          t.sectionContacts,
          t.sectionDeals,
          t.updatedLabel,
        ]}
      />
      {rows.map((row) => {
        const s = stats.get(row.id) ?? { contacts: 0, openDeals: 0 };
        return (
          <div
            key={row.id}
            className={cn(
              "group/crm grid items-center gap-1 px-4 py-1.5 transition-colors",
              COMPANY_GRID,
              selected.has(row.id) ? "bg-primary/5" : "hover:bg-muted/40",
            )}
          >
            <RowCheckbox
              checked={selected.has(row.id)}
              name={row.name}
              onToggle={() => onToggle(row.id)}
            />
            <button
              type="button"
              onClick={() => onOpenRecord(row)}
              title={t.openRecord}
              className="truncate py-1 text-left text-[13.5px] font-medium text-foreground hover:underline"
            >
              {row.name}
            </button>
            <TextFieldCell
              value={row.domain}
              placeholder={t.noValue}
              ariaLabel={t.domainLabel}
              onCommit={commits.companyDomain(row)}
            />
            <TagsCell tags={row.tags} onCommit={commits.companyTags(row)} />
            <span className="px-1.5 text-[12.5px] tabular-nums text-muted-foreground">
              {s.contacts}
            </span>
            <span className="px-1.5 text-[12.5px] tabular-nums text-muted-foreground">
              {s.openDeals}
            </span>
            <UpdatedCell iso={row.updatedAt} />
          </div>
        );
      })}
      <SelectAllFooter
        allSelected={allSelected}
        hasSelection={hasSelection}
        count={rows.length}
        onToggleAll={onToggleAll}
      />
    </div>
  );
}

// ── Shared bits ─────────────────────────────────────────────────────────

function RowCheckbox({
  checked,
  name,
  onToggle,
}: {
  checked: boolean;
  name: string;
  onToggle: () => void;
}) {
  const t = useT().crmPage;
  return (
    <Checkbox
      checked={checked}
      onCheckedChange={onToggle}
      aria-label={format(t.selectRowAria, { name })}
      className={cn(
        "transition-opacity",
        !checked &&
          "opacity-0 group-hover/crm:opacity-100 group-focus-within/crm:opacity-100",
      )}
    />
  );
}

function UpdatedCell({ iso }: { iso: string }) {
  return (
    <span className="text-[12px] tabular-nums text-muted-foreground/70">
      {new Date(iso).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
      })}
    </span>
  );
}

function SelectAllFooter({
  allSelected,
  hasSelection,
  count,
  onToggleAll,
}: {
  allSelected: boolean;
  hasSelection: boolean;
  count: number;
  onToggleAll: () => void;
}) {
  const t = useT().crmPage;
  return (
    <div className="flex items-center gap-2 px-4 py-2 text-[12px] text-muted-foreground">
      <Checkbox
        checked={allSelected}
        indeterminate={hasSelection && !allSelected}
        onCheckedChange={onToggleAll}
        aria-label={t.selectAll}
      />
      {t.selectAll}
      <span className="tabular-nums">({count})</span>
    </div>
  );
}


/** The bulk bar — swaps in for the filter row while table rows are checked.
 *  Actions are section-scoped: deals set stage (incl. mark won/lost);
 *  contacts re-link a company; contacts+companies add a tag. No bulk
 *  delete — no delete path exists by design (crm.md decision 11). */
function BulkBar({
  section,
  count,
  busy,
  error,
  companies,
  tagOptions,
  stageLabels,
  onClear,
  onDealStage,
  onContactCompany,
  onAddTag,
}: {
  section: CrmSection;
  count: number;
  busy: boolean;
  error: string | null;
  companies: readonly CrmCompanyRow[];
  tagOptions: string[];
  stageLabels: Record<string, string>;
  onClear: () => void;
  onDealStage: (stage: DealStage) => void;
  onContactCompany: (companyId: string | null) => void;
  onAddTag: (tag: string) => void;
}) {
  const t = useT().crmPage;
  const [tagDraft, setTagDraft] = useState("");
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border bg-accent/30 px-4 py-2">
      <span className="text-[12.5px] font-medium">
        {format(t.selectedCount, { count: String(count) })}
      </span>
      {section === "deals" && (
        <BulkMenu
          label={t.bulkStage}
          items={Object.fromEntries(
            DEAL_STAGES.map((s) => [s, stageLabels[s] ?? s]),
          )}
          disabled={busy}
          onPick={(s) => onDealStage(s as DealStage)}
        />
      )}
      {section === "contacts" && (
        <BulkMenu
          label={t.bulkCompany}
          items={{
            [NONE]: t.noCompany,
            ...Object.fromEntries(companies.map((c) => [c.id, c.name])),
          }}
          disabled={busy}
          onPick={(id) => onContactCompany(id === NONE ? null : id)}
        />
      )}
      {section !== "deals" && (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <button
                type="button"
                disabled={busy}
                className="inline-flex h-7 items-center rounded-md border border-border px-2 text-[12.5px] font-medium hover:bg-accent/60 disabled:opacity-50"
              >
                {t.bulkAddTag}
              </button>
            }
          />
          <DropdownMenuContent>
            {tagOptions.map((tag) => (
              <DropdownMenuItem key={tag} onClick={() => onAddTag(tag)}>
                {tag}
              </DropdownMenuItem>
            ))}
            <div className="p-1">
              <input
                type="text"
                value={tagDraft}
                placeholder={t.addTagPlaceholder}
                onChange={(e) => setTagDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    const name = tagDraft.trim();
                    setTagDraft("");
                    if (name.length > 0) onAddTag(name);
                  }
                }}
                className="h-7 w-full rounded-md border border-border bg-background px-2 text-[13px] outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
              />
            </div>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <button
        type="button"
        aria-label={t.bulkClear}
        onClick={onClear}
        className="ml-auto inline-flex h-7 items-center rounded-md px-2 text-[12.5px] text-muted-foreground hover:bg-accent/60"
      >
        {t.bulkClear}
      </button>
      {error && (
        <span className="w-full text-[12px] text-red-500" role="alert">
          {error}
        </span>
      )}
    </div>
  );
}

/** Action menu for the bulk bar — picking an item fires over the whole
 *  selection (a menu, not a value binding). */
function BulkMenu({
  label,
  items,
  disabled,
  onPick,
}: {
  label: string;
  items: Record<string, string>;
  disabled?: boolean;
  onPick: (value: string) => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <button
            type="button"
            disabled={disabled}
            className="inline-flex h-7 items-center rounded-md border border-border px-2 text-[12.5px] font-medium hover:bg-accent/60 disabled:opacity-50"
          >
            {label}
          </button>
        }
      />
      <DropdownMenuContent>
        {Object.entries(items).map(([value, itemLabel]) => (
          <DropdownMenuItem key={value} onClick={() => onPick(value)}>
            {itemLabel}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
