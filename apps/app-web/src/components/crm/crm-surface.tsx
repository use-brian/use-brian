"use client";

/**
 * CRM operator surface — `/w/[id]/crm` (crm-operator-surface §3).
 *
 * The pipeline lens over the SAME entity rows the chat tools and Brain
 * graph read (lens, not data): three sections (Deals — default, board-first
 * — / Contacts / Companies) switched from the sidebar, with a compact top-bar
 * fallback while that sidebar is collapsed or unavailable on narrow layouts;
 * attention quick-filters with summary-owned counts; debounced, server-backed
 * filters/search; independently paged deal columns or keyset tables with inline cell
 * edit; a master-detail record pane with brain context
 * (`crm-record-detail.tsx`). Checking table rows swaps the filter row for
 * the bulk bar (client loop over the per-row adjust wire — no server bulk
 * lane yet, §8 Phase 4).
 *
 * State model: the URL is the single source of truth for the view and record
 * (`crm-view.ts` codec) — the sidebar panel and the Home dock card
 * (`?filter=overdue`) deep-link into it. Canonical field changes use the CRM
 * record PATCH boundary; stage commits retain the dedicated stage route.
 *
 * Spec: docs/architecture/features/crm.md → "Operator surface".
 * [COMP:app-web/crm-surface]
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { BarChart3, ChevronDown, ChevronUp, Inbox, Kanban, Mail, Rows3, Settings2 } from "lucide-react";
import { OperatorTopbar } from "@/components/operator/operator-topbar";
import { cn } from "@/lib/utils";
import { mutateSurfaceCache, useCachedResource } from "@/lib/surface-cache";
import { surfaceDataKey } from "@/lib/surface-prefetch";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n/format";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useWorkspaceContext } from "@/lib/workspace-context";
import { loadWorkspaceRoster } from "@/lib/api/workspace-roster";
import type { FeedWorkspaceMember } from "@/lib/api/feed";
import { memberDisplayName } from "@/components/brain/property-edit";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  fetchCrmDealBoardPages,
  fetchCrmEmailDrafts,
  fetchCrmLookup,
  fetchCrmRecord,
  fetchCrmRecordPage,
  fetchCrmConfig,
  fetchCrmSummary,
  isOpenStage,
  setCrmPipelineStage,
  setCrmRecordArchived,
  updateCrmRecord,
  type CrmCollectionQuery,
  type CrmCompanyRow,
  type CrmContactRow,
  type CrmData,
  type CrmDealBoardPages,
  type CrmDealRow,
  type CrmEmailDraft,
  type CrmFieldDefinition,
  type CrmPipeline,
  type CrmPipelineStage,
  type CrmPublicRecord,
  type CrmRecordBundle,
  type CrmRecordPage,
  type CrmSummary,
} from "@/lib/api/crm";
import {
  appendCrmPage,
  applyCompanyFilters,
  applyContactFilters,
  applyDealFilters,
  companyNameById,
  contactNameById,
  crmColumnRegistry,
  crmCollectionHref,
  crmPageQuery,
  crmRecordHref,
  crmRecordMatchesRoute,
  crmSectionCounts,
  crmTagOptions,
  crmUsesBoardPages,
  CRM_EMPTY_CUSTOM_VALUE,
  groupRowsByCustomField,
  localDateStr,
  legacyStageForPipelineStage,
  normalizeCrmColumns,
  resolveDealPipelineStage,
  searchFromCrmView,
  sortDeals,
  crmViewFromSearch,
  CONTACT_QUICK_FILTERS,
  DEAL_QUICK_FILTERS,
  DEAL_SORT_KEYS,
  CRM_SECTIONS,
  type CrmQuickFilter,
  type CrmColumnDefinition,
  type CrmSection,
  type CrmViewState,
} from "@/lib/crm-view";
import { requestBrainRefresh } from "@/lib/brain-events";
import {
  listApprovals,
  type PendingApprovalRow,
} from "@/lib/api/approvals";
import {
  APPROVALS_REFRESH_EVENT,
  type ApprovalsRefreshDetail,
} from "@/lib/approvals-events";
import { crmEmailApprovalQueue } from "@/lib/crm-r2";
import {
  AmountCell,
  CloseDateCell,
  CompanyCell,
  PipelineStageCell,
  PIPELINE_CATEGORY_DOT,
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
import { CrmActions } from "./crm-actions";
import { CrmConfigDialog } from "./crm-config";
import { CrmReportingDialog } from "./crm-reporting";
import { CrmSavedViews } from "./crm-saved-views";
import { CrmEmailReviewWorkspace } from "./crm-email-review";
import { CrmMobileActions } from "./crm-mobile-actions";
import { CrmSubmissionInbox } from "./operations/submission-inbox";

const NONE = "__none__";
const EMPTY_PIPELINE: CrmPipeline = {
  id: "unavailable",
  name: "",
  isDefault: false,
  position: 0,
  stages: [],
};

type CrmPrimitive = "deal" | "contact" | "company";

export type CrmRouteRecord = { kind: CrmPrimitive; id: string };

type CrmCollectionPayload = {
  section: CrmSection;
  query: CrmCollectionQuery;
  page: CrmRecordPage | null;
  boardPages: CrmDealBoardPages | null;
};

type CrmDirectories = {
  contacts: Awaited<ReturnType<typeof fetchCrmLookup>>;
  companies: Awaited<ReturnType<typeof fetchCrmLookup>>;
  deals: Awaited<ReturnType<typeof fetchCrmLookup>>;
};

function collectionRecords(payload: CrmCollectionPayload | null): CrmPublicRecord[] {
  if (!payload) return [];
  if (payload.boardPages) {
    const rows = new Map<string, CrmPublicRecord>();
    for (const page of Object.values(payload.boardPages)) {
      for (const row of page.items) rows.set(row.id, row);
    }
    return [...rows.values()];
  }
  return payload.page?.items ?? [];
}

function dataFromRecords(records: readonly CrmPublicRecord[]): CrmData {
  return {
    deals: records.filter((row): row is Extract<CrmPublicRecord, { kind: "deal" }> => row.kind === "deal"),
    contacts: records.filter((row): row is Extract<CrmPublicRecord, { kind: "contact" }> => row.kind === "contact"),
    companies: records.filter((row): row is Extract<CrmPublicRecord, { kind: "company" }> => row.kind === "company"),
  };
}

function directoryData(directories: CrmDirectories | null): CrmData {
  if (!directories) return { deals: [], contacts: [], companies: [] };
  return {
    contacts: directories.contacts.map((row) => ({
      id: row.id, name: row.name, email: row.hint, phone: null, companyId: null,
      tags: [], ownerId: null, customFields: {}, archivedAt: null, updatedAt: "",
    })),
    companies: directories.companies.map((row) => ({
      id: row.id, name: row.name, domain: row.hint, tags: [], ownerId: null,
      customFields: {}, archivedAt: null, updatedAt: "",
    })),
    deals: directories.deals.map((row) => ({
      id: row.id, name: row.name, stage: "lead", amount: null, closeDate: null,
      contactId: null, companyId: null, ownerId: null, source: row.hint,
      customFields: {}, archivedAt: null, updatedAt: "",
    })),
  };
}

function mergeCrmData(base: CrmData, overlay: CrmData): CrmData {
  const merge = <T extends { id: string }>(left: readonly T[], right: readonly T[]) => {
    const rows = new Map(left.map((row) => [row.id, row]));
    for (const row of right) rows.set(row.id, row);
    return [...rows.values()];
  };
  return {
    deals: merge(base.deals, overlay.deals),
    contacts: merge(base.contacts, overlay.contacts),
    companies: merge(base.companies, overlay.companies),
  };
}

function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [delayMs, value]);
  return debounced;
}

export function CrmSurface({ workspaceId, routeRecord = null }: {
  workspaceId: string;
  routeRecord?: CrmRouteRecord | null;
}) {
  const t = useT().crmPage;
  const { role, me } = useWorkspaceContext();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // ── View state (URL is the source of truth) ───────────────────────────
  const view = useMemo(() => crmViewFromSearch(searchParams), [searchParams]);
  const setView = useCallback(
    (patch: Partial<CrmViewState>) => {
      const next = { ...view, ...patch };
      const search = searchFromCrmView(next);
      router.replace(search ? `${pathname}?${search}` : pathname, { scroll: false });
    },
    [view, router, pathname],
  );

  // ── Independently cached data regions ─────────────────────────────────
  const crmKey = surfaceDataKey("crm", workspaceId);
  const configKey = `${crmKey}:config`;
  const configResource = useCachedResource(configKey, () => fetchCrmConfig(workspaceId));
  const config = configResource.data ?? null;
  const selectedPipeline = useMemo<CrmPipeline | null>(() => {
    if (!config || config.pipelines.length === 0) return null;
    return config.pipelines.find((pipeline) => pipeline.id === view.pipeline)
      ?? config.pipelines.find((pipeline) => pipeline.isDefault)
      ?? config.pipelines[0];
  }, [config, view.pipeline]);

  const debouncedSearch = useDebouncedValue(view.q, 250);
  const openStageIds = useMemo(
    () => selectedPipeline?.stages.filter((stage) => stage.category === "open").map((stage) => stage.id) ?? [],
    [selectedPipeline],
  );
  const stageSlice = view.section === "deals" && view.stages.length === 0 && !view.quick && !view.closed
    ? openStageIds
    : view.stages;
  const collectionQuery = useMemo(() => crmPageQuery(
    { ...view, pipeline: selectedPipeline?.id ?? view.pipeline },
    debouncedSearch,
    stageSlice,
  ), [debouncedSearch, selectedPipeline?.id, stageSlice, view]);
  const isBoardCollection = crmUsesBoardPages(view, selectedPipeline !== null);
  const boardStageIds = useMemo(() => {
    if (!selectedPipeline) return [];
    if (view.stages.length > 0) return view.stages;
    return selectedPipeline.stages
      .filter((stage) => view.closed || stage.category === "open")
      .map((stage) => stage.id);
  }, [selectedPipeline, view.closed, view.stages]);
  const collectionKey = `${crmKey}:collection:${view.section}:${isBoardCollection ? "board" : "table"}:${JSON.stringify(collectionQuery)}:${boardStageIds.join(",")}`;
  const collectionResource = useCachedResource<CrmCollectionPayload>(collectionKey, async () => {
    if (isBoardCollection) {
      const { kind: _kind, stage: _stage, cursor: _cursor, ...boardQuery } = collectionQuery;
      return {
        section: view.section,
        query: collectionQuery,
        page: null,
        boardPages: await fetchCrmDealBoardPages(workspaceId, boardQuery, boardStageIds),
      };
    }
    return {
      section: view.section,
      query: collectionQuery,
      page: await fetchCrmRecordPage(workspaceId, collectionQuery),
      boardPages: null,
    };
  });
  const [retainedCollection, setRetainedCollection] = useState<CrmCollectionPayload | null>(null);
  useEffect(() => {
    if (collectionResource.data) setRetainedCollection(collectionResource.data);
  }, [collectionResource.data]);
  const collection = collectionResource.data
    ?? (retainedCollection?.section === view.section ? retainedCollection : null);

  const directoriesResource = useCachedResource<CrmDirectories>(`${crmKey}:lookups`, async () => {
    const [contacts, companies, deals] = await Promise.all([
      fetchCrmLookup(workspaceId, "contact"),
      fetchCrmLookup(workspaceId, "company"),
      fetchCrmLookup(workspaceId, "deal"),
    ]);
    return { contacts, companies, deals };
  });
  const summaryKey = `${crmKey}:summary:${selectedPipeline?.id ?? "all"}`;
  const summaryResource = useCachedResource<CrmSummary>(
    summaryKey,
    () => fetchCrmSummary(workspaceId, selectedPipeline?.id),
  );
  const emailContextResource = useCachedResource<CrmData>(
    view.review === "email" ? `${crmKey}:email-context` : null,
    async () => {
      const [contacts, companies, deals] = await Promise.all([
        fetchCrmRecordPage<Extract<CrmPublicRecord, { kind: "contact" }>>(workspaceId, { kind: "contact", limit: 100 }),
        fetchCrmRecordPage<Extract<CrmPublicRecord, { kind: "company" }>>(workspaceId, { kind: "company", limit: 100 }),
        fetchCrmRecordPage<Extract<CrmPublicRecord, { kind: "deal" }>>(workspaceId, { kind: "deal", limit: 100 }),
      ]);
      return { contacts: contacts.items, companies: companies.items, deals: deals.items };
    },
  );
  const emailDraftsResource = useCachedResource<CrmEmailDraft[]>(
    `${crmKey}:email-drafts`,
    () => fetchCrmEmailDrafts(workspaceId),
  );
  const pageData = useMemo(() => dataFromRecords(collectionRecords(collection)), [collection]);
  const mergedData = useMemo(() => mergeCrmData(
    mergeCrmData(directoryData(directoriesResource.data ?? null), emailContextResource.data ?? { deals: [], contacts: [], companies: [] }),
    pageData,
  ), [directoriesResource.data, emailContextResource.data, pageData]);
  const data: CrmData | null = collection || emailContextResource.data ? mergedData : null;

  const recordKey = `${crmKey}:record:${routeRecord?.id ?? "none"}`;
  const recordResource = useCachedResource(
    recordKey,
    () => routeRecord ? fetchCrmRecord(workspaceId, routeRecord.id) : Promise.resolve(null),
  );
  const recordBundle = routeRecord ? recordResource.data : null;
  const loadError = collection === null && collectionResource.error !== undefined;

  const refreshCrm = collectionResource.refresh;
  const reload = useCallback(() => {
    void refreshCrm();
    void configResource.refresh();
    void summaryResource.refresh();
    void directoriesResource.refresh();
  }, [refreshCrm, configResource.refresh, directoriesResource.refresh, summaryResource.refresh]);

  const [pendingApprovals, setPendingApprovals] = useState<PendingApprovalRow[]>([]);
  const [approvalsLoading, setApprovalsLoading] = useState(true);
  const [approvalsError, setApprovalsError] = useState(false);
  const [roster, setRoster] = useState<FeedWorkspaceMember[]>([]);
  useEffect(() => {
    let cancelled = false;
    void loadWorkspaceRoster(workspaceId)
      .then((members) => { if (!cancelled) setRoster(members); })
      .catch(() => { if (!cancelled) setRoster([]); });
    return () => { cancelled = true; };
  }, [workspaceId]);
  const reloadApprovals = useCallback(async () => {
    setApprovalsLoading(true);
    setApprovalsError(false);
    try {
      setPendingApprovals(await listApprovals(workspaceId, { throwOnError: true }));
    } catch {
      setApprovalsError(true);
    } finally {
      setApprovalsLoading(false);
    }
  }, [workspaceId]);
  useEffect(() => {
    void reloadApprovals();
    const handleRefresh = (event: Event) => {
      const detail = (event as CustomEvent<ApprovalsRefreshDetail>).detail;
      if (!detail?.workspaceId || detail.workspaceId === workspaceId) {
        void reloadApprovals();
      }
    };
    window.addEventListener(APPROVALS_REFRESH_EVENT, handleRefresh);
    return () => window.removeEventListener(APPROVALS_REFRESH_EVENT, handleRefresh);
  }, [reloadApprovals, workspaceId]);

  /** Optimistic patch against only the loaded keysets. */
  const setData = useCallback(
    (updater: (previous: CrmData) => CrmData) => {
      mutateSurfaceCache<CrmCollectionPayload>(collectionKey, (previous) => {
        const current = dataFromRecords(collectionRecords(previous));
        const next = updater(current);
        const rows = previous.section === "deals" ? next.deals
          : previous.section === "contacts" ? next.contacts : next.companies;
        if (previous.boardPages) {
          return {
            ...previous,
            boardPages: Object.fromEntries(Object.entries(previous.boardPages).map(([stageId, page]) => [
              stageId,
              { ...page, items: page.items.map((item) => rows.find((row) => row.id === item.id) as Extract<CrmPublicRecord, { kind: "deal" }> ?? item) },
            ])),
          };
        }
        return previous.page ? { ...previous, page: { ...previous.page, items: rows as CrmPublicRecord[] } } : previous;
      });
    },
    [collectionKey],
  );
  const collectionPath = crmCollectionHref(workspaceId);
  const recordHref = useCallback(
    (kind: CrmPrimitive, id: string, search = searchParams.toString()) =>
      crmRecordHref(workspaceId, kind, id, search),
    [searchParams, workspaceId],
  );
  const openRecord = useCallback((kind: CrmPrimitive, id: string, search?: string) => {
    router.push(recordHref(kind, id, search), { scroll: false });
  }, [recordHref, router]);
  const closeRecord = useCallback(() => {
    const search = searchParams.toString();
    router.push(crmCollectionHref(workspaceId, search), { scroll: false });
  }, [router, searchParams, workspaceId]);

  // ── Derived ───────────────────────────────────────────────────────────
  const now = useMemo(() => new Date(), []);
  const deals = pageData.deals;
  const contacts = pageData.contacts;
  const companies = pageData.companies;
  const allDeals = data?.deals ?? [];
  const allContacts = data?.contacts ?? [];
  const allCompanies = data?.companies ?? [];
  const emailQueue = useMemo(
    () => (data ? crmEmailApprovalQueue(data, pendingApprovals) : []),
    [data, pendingApprovals],
  );
  const canonicalEmailDrafts = emailDraftsResource.data ?? [];
  const emailDraftIds = useMemo(
    () => [
      ...canonicalEmailDrafts.map((draft) => draft.id),
      ...emailQueue.map((item) => item.approval.id),
    ],
    [canonicalEmailDrafts, emailQueue],
  );
  const totalEmailDrafts = emailDraftIds.length;
  const companyNames = useMemo(() => companyNameById(allCompanies), [allCompanies]);
  const contactNames = useMemo(() => contactNameById(allContacts), [allContacts]);
  const counts = summaryResource.data?.attention ?? { overdue: 0, stale: 0, noAmount: 0, orphaned: 0 };
  const tagOptions = useMemo(
    () => crmTagOptions(contacts, companies),
    [contacts, companies],
  );
  const ownerOptions = useMemo(
    () => roster.map((member) => ({
      id: member.userId,
      name: memberDisplayName(member) ?? t.r2.memberUnknown,
    })),
    [roster, t.r2.memberUnknown],
  );
  const sectionEntityKind = view.section === "contacts" ? "person" : view.section === "companies" ? "company" : "deal";
  const sectionFields = useMemo(
    () => (config?.fields ?? []).filter((field) => field.entityKind === sectionEntityKind),
    [config, sectionEntityKind],
  );
  const sectionRows = view.section === "deals" ? deals : view.section === "contacts" ? contacts : companies;
  const referenceNames = useMemo(() => new Map([
    ...(data?.contacts ?? []).map((row) => [row.id, row.name] as const),
    ...(data?.companies ?? []).map((row) => [row.id, row.name] as const),
    ...(data?.deals ?? []).map((row) => [row.id, row.name] as const),
  ]), [data]);
  const groupableFields = sectionFields.filter((field) => field.fieldType !== "multi_select");
  const columnRegistry = useMemo(
    () => crmColumnRegistry(view.section, sectionFields),
    [sectionFields, view.section],
  );
  const visibleColumns = useMemo(
    () => normalizeCrmColumns(view.section, sectionFields, view.columns),
    [sectionFields, view.columns, view.section],
  );
  const activeColumns = useMemo(
    () => visibleColumns.flatMap((key) => columnRegistry.find((column) => column.key === key) ?? []),
    [columnRegistry, visibleColumns],
  );
  const ownerNames = useMemo(
    () => new Map(ownerOptions.map((owner) => [owner.id, owner.name])),
    [ownerOptions],
  );
  const selectedGroupField = view.group?.startsWith("cf:")
    ? groupableFields.find((field) => field.fieldKey === view.group?.slice(3)) ?? null
    : null;

  useEffect(() => {
    if (view.review !== "email" || approvalsLoading || emailDraftsResource.data === undefined) return;
    const selectedExists = view.draft ? emailDraftIds.includes(view.draft) : false;
    const nextDraft = selectedExists ? view.draft : emailDraftIds[0] ?? null;
    if (nextDraft !== view.draft) setView({ draft: nextDraft });
  }, [approvalsLoading, emailDraftIds, emailDraftsResource.data, setView, view.draft, view.review]);

  const filteredDeals = useMemo(
    () =>
      sortDeals(
        applyDealFilters(deals, { ...view, q: debouncedSearch }, companyNames, now, selectedPipeline),
        view.sort,
        view.direction,
      ),
    [deals, view, debouncedSearch, companyNames, now, selectedPipeline],
  );
  // The board owns the closed fold itself (rail chips), so it reads the
  // filter WITHOUT the fold applied only when a stage/quick filter is off.
  const boardDeals = useMemo(
    () =>
      sortDeals(
        applyDealFilters(
          deals,
          { ...view, q: debouncedSearch, closed: true },
          companyNames,
          now,
          selectedPipeline,
        ),
        view.sort,
        view.direction,
      ),
    [deals, view, debouncedSearch, companyNames, now, selectedPipeline],
  );
  const filteredContacts = useMemo(
    () => applyContactFilters(contacts, { ...view, q: debouncedSearch }),
    [contacts, view, debouncedSearch],
  );
  const filteredCompanies = useMemo(
    () => applyCompanyFilters(companies, { ...view, q: debouncedSearch }),
    [companies, view, debouncedSearch],
  );

  const stageSummary = useMemo(
    () => new Map((summaryResource.data?.stages ?? []).map((stage) => [stage.stageId, stage])),
    [summaryResource.data?.stages],
  );
  const openDealCount = selectedPipeline?.stages
    .filter((stage) => stage.category === "open")
    .reduce((total, stage) => total + (stageSummary.get(stage.id)?.count ?? 0), 0) ?? 0;

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

  // ── Record detail (canonical URL + cold record resource) ──────────────
  const record: CrmRecordRef | null = useMemo(() => {
    if (!routeRecord || !crmRecordMatchesRoute(recordBundle, routeRecord.kind, routeRecord.id)) return null;
    const row = recordBundle.record;
    if (row.kind === "deal") return { kind: "deal", row };
    if (row.kind === "contact") return { kind: "contact", row };
    return { kind: "company", row };
  }, [recordBundle, routeRecord]);
  const detailData = useMemo<CrmData>(() => {
    const base = data ?? { deals: [], contacts: [], companies: [] };
    if (!recordBundle) return base;
    const merge = <T extends { id: string }>(...groups: readonly T[][]): T[] => {
      const rows = new Map<string, T>();
      for (const group of groups) for (const row of group) rows.set(row.id, row);
      return [...rows.values()];
    };
    return {
      deals: merge(
        base.deals,
        recordBundle.relationships.deals,
        recordBundle.record.kind === "deal" ? [recordBundle.record] : [],
      ),
      contacts: merge(
        base.contacts,
        recordBundle.relationships.contacts,
        recordBundle.record.kind === "contact" ? [recordBundle.record] : [],
      ),
      companies: merge(
        base.companies,
        recordBundle.relationships.companies,
        recordBundle.record.kind === "company" ? [recordBundle.record] : [],
      ),
    };
  }, [data, recordBundle]);

  // ── Mutations (in-place adjusts) ──────────────────────────────────────
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState<Set<string>>(new Set());
  const [configOpen, setConfigOpen] = useState(false);
  const [reportsOpen, setReportsOpen] = useState(false);

  const loadMorePage = useCallback(async () => {
    const payload = collectionResource.data;
    if (!payload?.page?.hasMore || !payload.page.nextCursor || !collectionKey) return;
    setLoadingMore((current) => new Set(current).add("table"));
    setMutationError(null);
    try {
      const next = await fetchCrmRecordPage(workspaceId, {
        ...payload.query,
        cursor: payload.page.nextCursor,
      });
      mutateSurfaceCache<CrmCollectionPayload>(collectionKey, (current) => current.page ? {
        ...current,
        page: { ...next, items: appendCrmPage(current.page.items, next.items) },
      } : current);
    } catch {
      setMutationError(t.r2.loadMoreFailed);
    } finally {
      setLoadingMore((current) => {
        const next = new Set(current); next.delete("table"); return next;
      });
    }
  }, [collectionKey, collectionResource.data, t.r2.loadMoreFailed, workspaceId]);

  const loadMoreStage = useCallback(async (stageId: string) => {
    const payload = collectionResource.data;
    if (!payload?.boardPages) return;
    const page = payload.boardPages[stageId];
    if (!page?.hasMore || !page.nextCursor || !collectionKey) return;
    setLoadingMore((current) => new Set(current).add(stageId));
    setMutationError(null);
    try {
      const next = await fetchCrmRecordPage<Extract<CrmPublicRecord, { kind: "deal" }>>(workspaceId, {
        ...payload.query,
        kind: "deal",
        stage: [stageId],
        cursor: page.nextCursor,
      });
      mutateSurfaceCache<CrmCollectionPayload>(collectionKey, (current) => current.boardPages ? {
        ...current,
        boardPages: {
          ...current.boardPages,
          [stageId]: { ...next, items: appendCrmPage(current.boardPages[stageId]?.items ?? [], next.items) },
        },
      } : current);
    } catch {
      setMutationError(t.r2.loadMoreFailed);
    } finally {
      setLoadingMore((current) => {
        const next = new Set(current); next.delete(stageId); return next;
      });
    }
  }, [collectionKey, collectionResource.data, t.r2.loadMoreFailed, workspaceId]);

  const patchDeal = useCallback((id: string, patch: Partial<CrmDealRow>) => {
    setData((prev) => ({
      ...prev,
      deals: prev.deals.map((d) => (d.id === id ? { ...d, ...patch } : d)),
    }));
  }, []);
  const patchContact = useCallback(
    (id: string, patch: Partial<CrmContactRow>) => {
      setData((prev) => ({
        ...prev,
        contacts: prev.contacts.map((c) => (c.id === id ? { ...c, ...patch } : c)),
      }));
    },
    [],
  );
  const patchCompany = useCallback(
    (id: string, patch: Partial<CrmCompanyRow>) => {
      setData((prev) => ({
        ...prev,
        companies: prev.companies.map((c) =>
          c.id === id ? { ...c, ...patch } : c,
        ),
      }));
    },
    [],
  );

  const reconcileRecord = useCallback((bundle: CrmRecordBundle) => {
    const next = bundle.record;
    if (next.kind === "deal") patchDeal(next.id, next);
    else if (next.kind === "contact") patchContact(next.id, next);
    else patchCompany(next.id, next);
    if (routeRecord?.id === next.id) {
      mutateSurfaceCache<CrmRecordBundle | null>(recordKey, () => bundle);
    }
  }, [patchCompany, patchContact, patchDeal, recordKey, routeRecord?.id]);

  /** One canonical CRM field commit, reconciled from the server record. */
  const commitField = useCallback(
    async (
      id: string,
      changes: Record<string, unknown>,
    ): Promise<{ ok: boolean; error?: string }> => {
      try {
        const bundle = await updateCrmRecord(workspaceId, id, changes);
        reconcileRecord(bundle);
        void summaryResource.refresh();
        setMutationError(null);
        requestBrainRefresh(workspaceId);
        return { ok: true };
      } catch (cause) {
        const error = cause instanceof Error ? cause.message : t.r2.updateFailed;
        setMutationError(error);
        return { ok: false, error };
      }
    },
    [reconcileRecord, summaryResource.refresh, t.r2.updateFailed, workspaceId],
  );

  const commits: RecordCommits = useMemo(
    () => ({
      rename: (ref) => (name) =>
        commitField(ref.row.id, { name }),
      owner: (ref) => (ownerId) => commitField(ref.row.id, { ownerId }),
      dealPipelineStage: (row) => async (stageId) => {
        const stage = config?.pipelines
          .flatMap((pipeline) => pipeline.stages)
          .find((candidate) => candidate.id === stageId);
        if (!stage) return { ok: false, error: t.r2.stageChangeFailed };
        try {
          await setCrmPipelineStage(workspaceId, row.id, stageId);
          patchDeal(row.id, {
            pipelineId: stage.pipelineId,
            pipelineStageId: stage.id,
            stage: legacyStageForPipelineStage(stage),
            probability: stage.probability,
          });
          void summaryResource.refresh();
          setMutationError(null);
          if (routeRecord?.id === row.id) void recordResource.refresh();
          requestBrainRefresh(workspaceId);
          return { ok: true };
        } catch (cause) {
          const error =
            cause instanceof Error ? cause.message : t.r2.stageChangeFailed;
          setMutationError(error);
          return { ok: false, error };
        }
      },
      dealAmount: (row) => (amount) =>
        commitField(row.id, { amount }),
      dealClose: (row) => (closeDate) => commitField(row.id, { closeDate }),
      dealCompany: (row) => (companyId) => commitField(row.id, { companyId }),
      dealContact: (row) => (contactId) => commitField(row.id, { contactId }),
      dealCurrency: (row) => (currencyCode) => commitField(row.id, { currencyCode }),
      dealSource: (row) => (source) => commitField(row.id, { source }),
      dealWinLossReason: (row) => (winLossReason) => commitField(row.id, { winLossReason }),
      contactEmail: (row) => (email) =>
        commitField(row.id, { email }),
      contactPhone: (row) => (phone) =>
        commitField(row.id, { phone }),
      contactCompany: (row) => (companyId) => commitField(row.id, { companyId }),
      contactTags: (row) => (tags) =>
        commitField(row.id, { tags }),
      companyDomain: (row) => (domain) =>
        commitField(row.id, { domain }),
      companyTags: (row) => (tags) =>
        commitField(row.id, { tags }),
    }),
    [commitField, config, patchDeal, recordResource.refresh, routeRecord?.id, summaryResource.refresh, t, workspaceId],
  );

  const archiveRecord = useCallback(async (ref: CrmRecordRef) => {
    const confirmed = await confirmDialog({
      title: t.r2.archiveTitle,
      description: format(t.r2.archiveDescription, { name: ref.row.name }),
      confirmLabel: t.r2.archive,
      cancelLabel: t.r2.cancel,
      variant: "destructive",
    });
    if (!confirmed) return;
    await setCrmRecordArchived(workspaceId, ref.row.id, true);
    closeRecord();
    await refreshCrm();
    await summaryResource.refresh();
    requestBrainRefresh(workspaceId);
  }, [closeRecord, t, workspaceId, refreshCrm, summaryResource.refresh]);

  /** Bulk = client loop over the per-row adjust wire (failed ids STAY
   *  SELECTED for a retry — the Reviews-queue contract; §1.6). */
  const runBulk = useCallback(
    async (
      changesFor: (id: string) => Record<string, unknown> | null,
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
          try {
            reconcileRecord(await updateCrmRecord(workspaceId, id, changes));
          } catch {
            failed.push(id);
          }
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
        void summaryResource.refresh();
        requestBrainRefresh(workspaceId);
      }
    },
    [selectedVisible, bulkBusy, reconcileRecord, summaryResource.refresh, workspaceId, t],
  );

  const runBulkPipelineStage = useCallback(
    async (stageId: string) => {
      const ids = selectedVisible;
      const stage = selectedPipeline?.stages.find(
        (candidate) => candidate.id === stageId,
      );
      if (ids.length === 0 || bulkBusy || !stage) return;
      setBulkBusy(true);
      setBulkError(null);
      const failed: string[] = [];
      try {
        for (const id of ids) {
          try {
            await setCrmPipelineStage(workspaceId, id, stageId);
            patchDeal(id, {
              pipelineId: stage.pipelineId,
              pipelineStageId: stage.id,
              stage: legacyStageForPipelineStage(stage),
              probability: stage.probability,
            });
          } catch {
            failed.push(id);
          }
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
        void summaryResource.refresh();
        requestBrainRefresh(workspaceId);
      }
    }, [
      selectedVisible,
      selectedPipeline,
      bulkBusy,
      workspaceId,
      patchDeal,
      summaryResource.refresh,
      t,
    ],
  );

  // ── Render ────────────────────────────────────────────────────────────
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
    name: t.sortName,
    amount: t.sortAmount,
    close: t.sortClose,
  };
  const sectionCounts = crmSectionCounts(summaryResource.data);
  const sectionQuicks: readonly CrmQuickFilter[] =
    view.section === "deals"
      ? DEAL_QUICK_FILTERS
      : view.section === "contacts"
        ? CONTACT_QUICK_FILTERS
        : [];

  const isTablePresentation = view.section !== "deals" || view.view === "table" || selectedGroupField !== null;
  const hasSelection = selectedVisible.length > 0 && isTablePresentation;
  const today = localDateStr(now);

  // Property → value defs for the FilterBar (Notion-style funnel picker),
  // section-scoped like the old dropdowns were.
  const filterDefs: FilterDef[] = [
    ...(view.section === "deals"
      ? [
          {
            key: "stage",
            label: t.filterStage,
            options: (selectedPipeline?.stages ?? []).map((stage) => ({
              value: stage.id,
              label: stage.name,
              dot: PIPELINE_CATEGORY_DOT[stage.category],
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
              ...allCompanies.map((c) => ({ value: c.id, label: c.name })),
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
    {
      key: "owner",
      label: t.r2.owner,
      options: [
        { value: "none", label: t.r2.noOwner },
        ...ownerOptions.map((owner) => ({ value: owner.id, label: owner.name })),
      ],
    },
    ...sectionFields.map((field) => {
      let options: Array<{ value: string; label: string }>;
      if (field.fieldType === "single_select" || field.fieldType === "multi_select") {
        options = field.options.map((option) => ({ value: option, label: option }));
      } else if (field.fieldType === "boolean") {
        options = [{ value: "true", label: t.r2.yes }, { value: "false", label: t.r2.no }];
      } else if (field.fieldType === "entity_reference") {
        options = [
          ...(field.options.includes("person") ? allContacts : []),
          ...(field.options.includes("company") ? allCompanies : []),
          ...(field.options.includes("deal") ? allDeals : []),
        ].map((row) => ({ value: row.id, label: row.name }));
      } else {
        const values = new Set<string>();
        for (const row of sectionRows) {
          const value = row.customFields?.[field.fieldKey];
          if (value !== null && value !== undefined && value !== "" && !Array.isArray(value)) values.add(String(value));
        }
        options = [...values].sort((a, b) => a.localeCompare(b)).map((value) => ({ value, label: value }));
      }
      return {
        key: `cf:${field.fieldKey}`,
        label: field.label,
        options: [{ value: CRM_EMPTY_CUSTOM_VALUE, label: t.r2.emptyValue }, ...options],
      };
    }),
  ];

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Chrome — the shared operator top bar names the app. The expanded
          desktop sidebar already owns destination navigation, so the center
          switch is only a collapsed-sidebar / narrow-layout fallback. Deals
          controls stay in the right slot ([COMP:app-web/operator-topbar]). */}
      <OperatorTopbar
        app="crm"
        appChipClassName="hidden sm:flex sm:w-[148px] lg:w-[200px]"
        centerVisibility="when-sidebar-unavailable"
        center={
          <div
            data-crm-fallback-navigation
            className="flex shrink-0 items-center gap-1"
          >
            <DropdownMenu>
              <DropdownMenuTrigger
                className="inline-flex h-7 max-w-40 items-center gap-1.5 rounded-md bg-sidebar-accent/60 px-2 text-[12.5px] text-sidebar-accent-foreground md:hidden"
              >
                {view.review === "email" && (
                  <Mail className="size-3.5 shrink-0" aria-hidden />
                )}
                {view.review === "submissions" && (
                  <Inbox className="size-3.5 shrink-0" aria-hidden />
                )}
                <span className="truncate">
                  {view.review === "email"
                    ? t.r2.emailDrafts
                    : view.review === "submissions"
                      ? t.operations.submissions
                      : sectionLabels[view.section]}
                </span>
                <ChevronDown
                  className="size-3.5 shrink-0 text-muted-foreground"
                  aria-hidden
                />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {CRM_SECTIONS.map((section) => (
                  <DropdownMenuItem
                    key={section}
                    onClick={() =>
                      setView({
                        section,
                        review: null,
                        draft: null,
                        submission: null,
                        quick: null,
                        stages: [],
                        custom: {},
                        group: null,
                        q: "",
                        columns: [],
                        sort: "updated",
                        direction: "desc",
                      })
                    }
                  >
                    <span className="min-w-28 flex-1">
                      {sectionLabels[section]}
                    </span>
                    {summaryResource.data && (
                      <span className="tabular-nums text-muted-foreground">
                        {sectionCounts[section]}
                      </span>
                    )}
                  </DropdownMenuItem>
                ))}
                <DropdownMenuItem
                  onClick={() => setView({ review: "submissions", submission: view.submission })}
                >
                  <Inbox className="size-3.5" aria-hidden />
                  <span className="min-w-28 flex-1">{t.operations.submissions}</span>
                </DropdownMenuItem>
                <DropdownMenuItem
                  onClick={() =>
                    setView({
                      review: "email",
                      draft: view.draft ?? emailDraftIds[0] ?? null,
                    })
                  }
                >
                  <Mail className="size-3.5" aria-hidden />
                  <span className="min-w-28 flex-1">{t.r2.emailDrafts}</span>
                  {!approvalsLoading && emailDraftsResource.data !== undefined && totalEmailDrafts > 0 && (
                    <span className="tabular-nums text-muted-foreground">
                      {totalEmailDrafts}
                    </span>
                  )}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <div className="hidden items-center gap-0.5 rounded-lg bg-sidebar-accent/60 p-0.5 md:flex">
              {CRM_SECTIONS.map((section) => (
                <button
                  key={section}
                  type="button"
                  aria-pressed={view.review === null && view.section === section}
                  onClick={() =>
                    setView({
                      section,
                      review: null,
                      draft: null,
                      submission: null,
                      quick: null,
                      stages: [],
                      custom: {},
                      group: null,
                      q: "",
                      columns: [],
                      sort: "updated",
                      direction: "desc",
                    })
                  }
                  className={cn(
                    "inline-flex h-6.5 items-center gap-1.5 rounded-md px-2 text-[12.5px] transition-colors",
                    view.review === null && view.section === section
                      ? "bg-background font-medium shadow-sm"
                      : "text-sidebar-foreground/70 hover:text-sidebar-accent-foreground",
                  )}
                >
                  {sectionLabels[section]}
                  {summaryResource.data && (
                    <span className="tabular-nums text-[11px] text-muted-foreground">
                      {sectionCounts[section]}
                    </span>
                  )}
                </button>
              ))}
              <button
                type="button"
                aria-label={t.operations.submissions}
                aria-pressed={view.review === "submissions"}
                onClick={() => setView({ review: "submissions", submission: view.submission })}
                className={cn(
                  "inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[12.5px] transition-colors",
                  view.review === "submissions"
                    ? "bg-sidebar-accent text-sidebar-accent-foreground"
                    : "text-sidebar-foreground/70 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
                )}
              >
                <Inbox className="size-3.5" aria-hidden />
                <span>{t.operations.submissions}</span>
              </button>
              <button
                type="button"
                aria-label={t.r2.emailDrafts}
                aria-pressed={view.review === "email"}
                onClick={() =>
                  setView({
                    review: "email",
                    draft: view.draft ?? emailDraftIds[0] ?? null,
                  })
                }
                className={cn(
                  "inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[12.5px] transition-colors",
                  view.review === "email"
                    ? "bg-sidebar-accent text-sidebar-accent-foreground"
                    : "text-sidebar-foreground/70 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground",
                )}
              >
                <Mail className="size-3.5" aria-hidden />
                <span>{t.r2.emailDrafts}</span>
                {!approvalsLoading && emailDraftsResource.data !== undefined && totalEmailDrafts > 0 && (
                  <span className="rounded-full bg-amber-500/15 px-1.5 text-[10px] font-semibold tabular-nums text-amber-700 dark:text-amber-300">
                    {totalEmailDrafts}
                  </span>
                )}
              </button>
            </div>
          </div>
        }
        right={
          view.review === null ? <>
            {view.section === "deals" && (
              <>
              {selectedPipeline && config && config.pipelines.length > 1 && (
                <Select
                  value={selectedPipeline.id}
                  onValueChange={(pipeline) => {
                    if (typeof pipeline === "string") {
                      setView({ pipeline, stages: [], quick: null });
                    }
                  }}
                >
                  <SelectTrigger
                    aria-label={t.r2.pipeline}
                    className="hidden h-7 w-36 border-sidebar-border bg-sidebar-accent/40 text-[12.5px] shadow-none sm:flex"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {config.pipelines.map((pipeline) => (
                      <SelectItem key={pipeline.id} value={pipeline.id}>
                        {pipeline.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              {summaryResource.data && (
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
                  "inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[12.5px] max-sm:w-7 max-sm:justify-center max-sm:px-0",
                  view.view === "board"
                    ? "bg-sidebar-accent text-sidebar-accent-foreground"
                    : "text-sidebar-foreground/70 hover:bg-sidebar-accent/60",
                )}
              >
                <Kanban className="size-3.5" aria-hidden />
                <span className="max-sm:hidden">{t.viewBoard}</span>
              </button>
              <button
                type="button"
                aria-pressed={view.view === "table"}
                aria-label={t.viewTable}
                onClick={() => setView({ view: "table" })}
                className={cn(
                  "inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-[12.5px] max-sm:w-7 max-sm:justify-center max-sm:px-0",
                  view.view === "table"
                    ? "bg-sidebar-accent text-sidebar-accent-foreground"
                    : "text-sidebar-foreground/70 hover:bg-sidebar-accent/60",
                )}
              >
                <Rows3 className="size-3.5" aria-hidden />
                <span className="max-sm:hidden">{t.viewTable}</span>
              </button>
              </>
            )}
            <div className="hidden items-center gap-1 sm:flex">
              <CrmSavedViews
                workspaceId={workspaceId}
                section={view.section}
                currentSearch={searchParams.toString()}
                onApply={(search) =>
                  router.replace(search ? `${pathname}?${search}` : pathname, { scroll: false })
                }
              />
              <Button
                size="icon-sm"
                variant="ghost"
                aria-label={t.r2.reportsTitle}
                onClick={() => setReportsOpen(true)}
              >
                <BarChart3 aria-hidden />
              </Button>
              {role !== "member" && (
                <Button size="icon-sm" variant="ghost" aria-label={t.r2.configTitle} onClick={() => setConfigOpen(true)}>
                  <Settings2 aria-hidden />
                </Button>
              )}
              <CrmActions
                workspaceId={workspaceId}
                role={role}
                section={view.section}
                data={data}
                config={config}
                onChanged={reload}
                onCreated={async (created) => {
                  await refreshCrm();
                  openRecord(created.kind, created.id);
                }}
              />
            </div>
            <CrmMobileActions
              workspaceId={workspaceId}
              role={role}
              section={view.section}
              data={data}
              config={config}
              currentSearch={searchParams.toString()}
              onApplySearch={(search) =>
                router.replace(search ? `${pathname}?${search}` : pathname, { scroll: false })
              }
              onChanged={reload}
              onCreated={async (created) => {
                await refreshCrm();
                openRecord(created.kind, created.id);
              }}
              onPipeline={(pipelineId) => setView({ pipeline: pipelineId, stages: [], quick: null })}
              onReports={() => setReportsOpen(true)}
              onConfig={() => setConfigOpen(true)}
            />
          </> : null
        }
      />

      {/* `relative`: the record-detail peek panel positions against THIS box
          and floats OVER the content — it never squeezes the middle pane,
          and never covers the bar. */}
      <div className="relative flex min-h-0 flex-1">
        <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col">

        {view.review === null && <>
          {collectionResource.error !== undefined && collection !== null && (
            <ResourceFailureBar label={t.r2.collectionLoadFailed} retry={t.retry} onRetry={() => void collectionResource.refresh()} />
          )}
          {summaryResource.error !== undefined && (
            <ResourceFailureBar label={t.r2.summaryLoadFailed} retry={t.retry} onRetry={() => void summaryResource.refresh()} />
          )}
          {directoriesResource.error !== undefined && (
            <ResourceFailureBar label={t.r2.lookupLoadFailed} retry={t.retry} onRetry={() => void directoriesResource.refresh()} />
          )}
          {configResource.error !== undefined && (
            <ResourceFailureBar label={t.r2.configLoadFailed} retry={t.retry} onRetry={() => void configResource.refresh()} />
          )}
        </>}

        {view.review === "email" ? (
          data === null ? (
            <div className="p-6 text-sm text-muted-foreground">
              {emailContextResource.error !== undefined ? (
                <span>
                  {t.loadFailed}{" "}
                  <button
                    type="button"
                    onClick={() => {
                      void refreshCrm();
                      void emailContextResource.refresh();
                      void directoriesResource.refresh();
                    }}
                    className="underline hover:text-foreground"
                  >
                    {t.retry}
                  </button>
                </span>
              ) : t.loading}
            </div>
          ) : (
            <CrmEmailReviewWorkspace
              workspaceId={workspaceId}
              data={data}
              items={emailQueue}
              canonicalDrafts={canonicalEmailDrafts}
              selectedId={view.draft}
              loading={approvalsLoading || emailDraftsResource.data === undefined}
              loadError={approvalsError || emailDraftsResource.error !== undefined || emailContextResource.error !== undefined || directoriesResource.error !== undefined}
              onSelect={(draft) => setView({ review: "email", draft })}
              onReload={() => {
                void reloadApprovals();
                void emailDraftsResource.refresh();
                void emailContextResource.refresh();
                void directoriesResource.refresh();
              }}
              onResolved={(approvalId) => {
                const nextDraft = emailDraftIds.find((id) => id !== approvalId) ?? null;
                setPendingApprovals((current) => current.filter((approval) => approval.id !== approvalId));
                setView({ draft: nextDraft });
              }}
              onRevised={(oldId, next) => {
                setPendingApprovals((current) => current.map((approval) => approval.id === oldId ? next : approval));
                setView({ draft: next.id });
              }}
              onOpenContact={(contactId) => {
                const next = searchFromCrmView({
                  ...view,
                  section: "contacts",
                  review: null,
                  draft: null,
                });
                openRecord("contact", contactId, next);
              }}
            />
          )
        ) : view.review === "submissions" ? (
          <CrmSubmissionInbox
            workspaceId={workspaceId}
            selectedId={view.submission}
            onSelect={(submission) => setView({ review: "submissions", submission })}
          />
        ) : (
          <>

        {/* Toolbar — attention presets + filters + search in ONE quiet strip
            (it swaps for the bulk bar while table rows are checked). */}
        {hasSelection ? (
          <BulkBar
            section={view.section}
            count={selectedVisible.length}
            busy={bulkBusy}
            error={bulkError}
            companies={allCompanies}
            tagOptions={tagOptions}
            stages={selectedPipeline?.stages ?? []}
            owners={ownerOptions}
            onClear={() => setSelected(new Set())}
            onDealStage={(stageId) => void runBulkPipelineStage(stageId)}
            onOwner={(ownerId) => void runBulk(() => ({ ownerId }))}
            onContactCompany={(companyId) =>
              void runBulk(() => ({ companyId }))
            }
            onAddTag={(tag) => {
              const rows: readonly (CrmContactRow | CrmCompanyRow)[] =
                view.section === "contacts" ? contacts : companies;
              void runBulk(
                (id) => {
                  const row = rows.find((r) => r.id === id);
                  if (!row || row.tags.includes(tag)) return null;
                  return { tags: [...row.tags, tag] };
                },
              );
            }}
          />
        ) : (
          <div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-4 py-2.5">
            <button
              type="button"
              aria-pressed={view.owner.length === 1 && view.owner[0] === me.id}
              onClick={() => setView({
                owner: view.owner.length === 1 && view.owner[0] === me.id ? [] : [me.id],
              })}
              className={cn(
                "inline-flex h-7 items-center rounded-full border px-2.5 text-xs transition-colors",
                view.owner.length === 1 && view.owner[0] === me.id
                  ? "border-foreground bg-foreground text-background"
                  : "border-border bg-card text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              {t.r2.myRecords}
            </button>
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
                  ? {
                      // A quick-filter owns the stage slice; its pill would lie.
                      stage: view.quick ? [] : view.stages,
                      company: view.company,
                      owner: view.owner,
                      ...Object.fromEntries(Object.entries(view.custom).map(([key, values]) => [`cf:${key}`, values])),
                    }
                  : view.section === "contacts"
                    ? { company: view.company, tag: view.tag, owner: view.owner, ...Object.fromEntries(Object.entries(view.custom).map(([key, values]) => [`cf:${key}`, values])) }
                    : { tag: view.tag, owner: view.owner, ...Object.fromEntries(Object.entries(view.custom).map(([key, values]) => [`cf:${key}`, values])) }
              }
              onSet={(key, values) => {
                if (key === "stage")
                  setView({ quick: null, stages: values });
                else if (key === "company") setView({ company: values });
                else if (key === "tag") setView({ tag: values });
                else if (key === "owner") setView({ owner: values });
                else if (key.startsWith("cf:")) {
                  const fieldKey = key.slice(3);
                  const custom = { ...view.custom };
                  if (values.length === 0) delete custom[fieldKey];
                  else custom[fieldKey] = values;
                  setView({ custom });
                }
              }}
              search={view.q}
              onSearch={(q) => setView({ q })}
              searchPlaceholder={t.searchPlaceholder}
              viewOptions={
                (groupableFields.length > 0 || isTablePresentation) ? (
                  <>
                    {groupableFields.length > 0 && <ViewOptionSection label={t.r2.groupBy}>
                      <ViewOptionRow label={t.r2.noGrouping} selected={!selectedGroupField} onPick={() => setView({ group: null })} />
                      {groupableFields.map((field) => <ViewOptionRow key={field.id} label={field.label} selected={selectedGroupField?.id === field.id} onPick={() => setView({ group: `cf:${field.fieldKey}`, view: "table" })} />)}
                    </ViewOptionSection>}
                    {isTablePresentation && <>
                      <ViewOptionSection label={t.r2.columns}>
                        {columnRegistry.map((column) => (
                          <ColumnOptionRow
                            key={column.key}
                            label={crmColumnLabel(column.key, sectionFields, t)}
                            checked={visibleColumns.includes(column.key)}
                            pinned={column.pinned}
                            canMoveUp={visibleColumns.indexOf(column.key) > 1}
                            canMoveDown={visibleColumns.includes(column.key) && visibleColumns.indexOf(column.key) < visibleColumns.length - 1}
                            onToggle={() => {
                              if (column.pinned) return;
                              setView({
                                columns: visibleColumns.includes(column.key)
                                  ? visibleColumns.filter((key) => key !== column.key)
                                  : [...visibleColumns, column.key],
                              });
                            }}
                            onMove={(offset) => {
                              const index = visibleColumns.indexOf(column.key);
                              if (index < 1) return;
                              const target = index + offset;
                              if (target < 1 || target >= visibleColumns.length) return;
                              const columns = [...visibleColumns];
                              [columns[index], columns[target]] = [columns[target], columns[index]];
                              setView({ columns });
                            }}
                          />
                        ))}
                      </ViewOptionSection>
                      <ViewOptionSection label={t.sortLabel}>
                        {(view.section === "deals" ? DEAL_SORT_KEYS : ["updated", "name"] as const).map((sKey) => (
                          <ViewOptionRow
                            key={sKey}
                            label={sortLabels[sKey] ?? sKey}
                            selected={view.sort === sKey}
                            onPick={() => setView({ sort: sKey })}
                          />
                        ))}
                      </ViewOptionSection>
                      <ViewOptionSection label={t.r2.sortDirection}>
                        <ViewOptionRow label={t.r2.descending} selected={view.direction === "desc"} onPick={() => setView({ direction: "desc" })} />
                        <ViewOptionRow label={t.r2.ascending} selected={view.direction === "asc"} onPick={() => setView({ direction: "asc" })} />
                      </ViewOptionSection>
                      {view.section === "deals" && (
                      <label className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-muted-foreground transition-colors hover:bg-muted">
                        <Checkbox
                          checked={view.closed}
                          onCheckedChange={(checked) => setView({ closed: checked })}
                          aria-label={t.showClosed}
                        />
                        {t.showClosed}
                      </label>
                      )}
                    </>}
                  </>
                ) : undefined
              }
            />
          </div>
        )}

        {mutationError && (
          <div
            role="alert"
            className="flex items-center justify-between gap-3 border-b border-destructive/20 bg-destructive/5 px-4 py-2 text-xs text-destructive"
          >
            <span>{mutationError}</span>
            <button type="button" className="underline" onClick={() => setMutationError(null)}>
              {t.r2.dismiss}
            </button>
          </div>
        )}

        {/* Body. */}
        <div className="min-h-0 flex-1 overflow-auto">
          {collection === null ? (
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
          ) : view.section === "deals" && view.view === "board" && !selectedPipeline ? (
            <div className="p-6 text-sm text-muted-foreground">
              {configResource.error !== undefined ? (
                <span>{t.r2.configLoadFailed} <button type="button" className="underline" onClick={() => void configResource.refresh()}>{t.retry}</button></span>
              ) : config === null ? t.r2.configLoading : t.r2.noPipelines}
            </div>
          ) : view.section === "deals" && view.view === "board" && !selectedGroupField ? (
            (summaryResource.data?.totals.deals ?? 0) === 0 ? (
              <div className="p-6 text-sm text-muted-foreground">{t.emptyDeals}</div>
            ) : (
              <CrmBoard
                rows={boardDeals}
                pipeline={selectedPipeline!}
                stageSummary={stageSummary}
                pages={collectionResource.data?.boardPages ?? {}}
                loadingMore={loadingMore}
                companyNames={companyNames}
                contactNames={contactNames}
                showClosed={view.closed}
                onToggleClosed={() => setView({ closed: !view.closed })}
                onStageDrop={(row, stage) =>
                  commits.dealPipelineStage(row)(stage.id)
                }
                onOpenRecord={(row) =>
                  openRecord("deal", row.id)
                }
                onLoadMore={(stageId) => void loadMoreStage(stageId)}
              />
            )
          ) : view.section === "deals" ? (
            <CrmGroupedRows rows={filteredDeals} field={selectedGroupField} referenceLabels={referenceNames} emptyLabel={t.r2.emptyValue} unavailableLabel={t.r2.referenceUnavailable} booleanLabels={{ true: t.r2.yes, false: t.r2.no }} render={(groupRows) => <DealsTable
              rows={groupRows}
              columns={activeColumns}
              fields={sectionFields}
              ownerNames={ownerNames}
              referenceNames={referenceNames}
              companyNames={companyNames}
              contactNames={contactNames}
              today={today}
              pipeline={selectedPipeline ?? EMPTY_PIPELINE}
              selected={selected}
              onToggle={toggle}
              allSelected={allSelected}
              hasSelection={selectedVisible.length > 0}
              onToggleAll={toggleAll}
              commits={commits}
              onOpenRecord={(row) => openRecord("deal", row.id)}
              empty={deals.length === 0 ? t.emptyDeals : t.emptyFiltered}
            />}/>
          ) : view.section === "contacts" ? (
            <CrmGroupedRows rows={filteredContacts} field={selectedGroupField} referenceLabels={referenceNames} emptyLabel={t.r2.emptyValue} unavailableLabel={t.r2.referenceUnavailable} booleanLabels={{ true: t.r2.yes, false: t.r2.no }} render={(groupRows) => <ContactsTable
              rows={groupRows}
              columns={activeColumns}
              fields={sectionFields}
              ownerNames={ownerNames}
              referenceNames={referenceNames}
              companies={allCompanies}
              selected={selected}
              onToggle={toggle}
              allSelected={allSelected}
              hasSelection={selectedVisible.length > 0}
              onToggleAll={toggleAll}
              commits={commits}
              onOpenRecord={(row) =>
                openRecord("contact", row.id)
              }
              empty={contacts.length === 0 ? t.emptyContacts : t.emptyFiltered}
            />}/>
          ) : (
            <CrmGroupedRows rows={filteredCompanies} field={selectedGroupField} referenceLabels={referenceNames} emptyLabel={t.r2.emptyValue} unavailableLabel={t.r2.referenceUnavailable} booleanLabels={{ true: t.r2.yes, false: t.r2.no }} render={(groupRows) => <CompaniesTable
              rows={groupRows}
              columns={activeColumns}
              fields={sectionFields}
              ownerNames={ownerNames}
              referenceNames={referenceNames}
              selected={selected}
              onToggle={toggle}
              allSelected={allSelected}
              hasSelection={selectedVisible.length > 0}
              onToggleAll={toggleAll}
              commits={commits}
              onOpenRecord={(row) =>
                openRecord("company", row.id)
              }
              empty={companies.length === 0 ? t.emptyCompanies : t.emptyFiltered}
            />}/>
          )}
          {!isBoardCollection && collectionResource.data?.page?.hasMore && (
            <div className="flex justify-center border-t border-border/60 p-3">
              <Button
                variant="outline"
                disabled={loadingMore.has("table")}
                onClick={() => void loadMorePage()}
              >
                {loadingMore.has("table") ? t.r2.loadingMore : t.r2.loadMore}
              </Button>
            </div>
          )}
        </div>
          </>
        )}
      </div>

        {/* Master-detail record pane. */}
        {view.review === null && routeRecord && (
          recordResource.error !== undefined ? (
            <RecordRouteState
              title={t.r2.recordLoadFailed}
              description={t.r2.recordLoadFailedDescription}
              actionLabel={t.retry}
              onAction={() => void recordResource.refresh()}
              secondaryLabel={t.r2.returnToCrm}
              onSecondary={closeRecord}
            />
          ) : recordBundle === undefined ? (
            <RecordRouteState title={t.loading} />
          ) : recordBundle === null || !record ? (
            <RecordRouteState
              title={t.r2.recordNotFound}
              description={t.r2.recordNotFoundDescription}
              actionLabel={t.r2.returnToCrm}
              onAction={closeRecord}
            />
          ) : (
          <CrmRecordDetail
            workspaceId={workspaceId}
            record={record}
            data={detailData}
            config={config ?? { pipelines: [], fields: [] }}
            commits={commits}
            initialParticipants={recordBundle.participants}
            onClose={closeRecord}
            onOpenRecord={(ref) => openRecord(ref.kind, ref.row.id)}
            onReviewEmail={(draft) => {
              const next = searchFromCrmView({ ...view, review: "email", draft });
              router.push(`${collectionPath}?${next}`, { scroll: false });
            }}
            onChanged={() => {
              reload();
              void recordResource.refresh();
            }}
            onArchive={(ref) => void archiveRecord(ref)}
          />
          )
        )}
      </div>
      <CrmConfigDialog
        workspaceId={workspaceId}
        open={configOpen}
        onOpenChange={setConfigOpen}
        onChanged={() => void configResource.refresh()}
      />
      <CrmReportingDialog
        workspaceId={workspaceId}
        open={reportsOpen}
        onOpenChange={setReportsOpen}
      />
    </div>
  );
}

function RecordRouteState({
  title,
  description,
  actionLabel,
  onAction,
  secondaryLabel,
  onSecondary,
}: {
  title: string;
  description?: string;
  actionLabel?: string;
  onAction?: () => void;
  secondaryLabel?: string;
  onSecondary?: () => void;
}) {
  return (
    <aside className="absolute inset-y-0 right-0 z-20 flex w-full items-center justify-center border-l border-border/60 bg-background p-6 shadow-xl lg:max-w-[min(42rem,92vw)]">
      <div className="max-w-sm text-center">
        <h2 className="text-base font-semibold">{title}</h2>
        {description ? (
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        ) : null}
        {actionLabel && onAction ? (
          <div className="mt-4 flex justify-center gap-2">
            {secondaryLabel && onSecondary ? (
              <Button variant="outline" onClick={onSecondary}>{secondaryLabel}</Button>
            ) : null}
            <Button onClick={onAction}>{actionLabel}</Button>
          </div>
        ) : null}
      </div>
    </aside>
  );
}

function ResourceFailureBar({ label, retry, onRetry }: {
  label: string;
  retry: string;
  onRetry: () => void;
}) {
  return (
    <div role="alert" className="flex items-center justify-between gap-3 border-b border-amber-500/20 bg-amber-500/5 px-4 py-2 text-xs text-amber-800 dark:text-amber-200">
      <span>{label}</span>
      <button type="button" className="shrink-0 underline" onClick={onRetry}>{retry}</button>
    </div>
  );
}

// ── Tables ──────────────────────────────────────────────────────────────

type CrmPageDictionary = ReturnType<typeof useT>["crmPage"];

function crmColumnLabel(
  key: string,
  fields: readonly CrmFieldDefinition[],
  t: CrmPageDictionary,
): string {
  if (key.startsWith("cf:")) {
    return fields.find((field) => field.fieldKey === key.slice(3))?.label ?? key.slice(3);
  }
  return ({
    name: t.nameLabel,
    stage: t.stageLabel,
    company: t.companyLabel,
    contact: t.contactLabel,
    amount: t.amountLabel,
    close: t.closeDateLabel,
    owner: t.r2.owner,
    source: t.r2.source,
    updated: t.updatedLabel,
    email: t.emailLabel,
    phone: t.phoneLabel,
    tags: t.tagsLabel,
    domain: t.domainLabel,
  } as Record<string, string>)[key] ?? key;
}

function ColumnOptionRow({
  label,
  checked,
  pinned,
  canMoveUp,
  canMoveDown,
  onToggle,
  onMove,
}: {
  label: string;
  checked: boolean;
  pinned: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onToggle: () => void;
  onMove: (offset: -1 | 1) => void;
}) {
  const t = useT().crmPage.r2;
  return (
    <div className="flex items-center gap-1 rounded-md px-2 py-1 text-[13px] text-muted-foreground hover:bg-muted">
      <Checkbox
        checked={checked}
        disabled={pinned}
        aria-label={label}
        onCheckedChange={onToggle}
      />
      <button type="button" className="min-w-0 flex-1 truncate text-left" onClick={onToggle} disabled={pinned}>
        {label}
      </button>
      {checked && !pinned ? <>
        <button type="button" disabled={!canMoveUp} aria-label={`${t.moveUp}: ${label}`} onClick={() => onMove(-1)} className="rounded p-1 hover:bg-background disabled:opacity-30">
          <ChevronUp className="size-3.5" aria-hidden />
        </button>
        <button type="button" disabled={!canMoveDown} aria-label={`${t.moveDown}: ${label}`} onClick={() => onMove(1)} className="rounded p-1 hover:bg-background disabled:opacity-30">
          <ChevronDown className="size-3.5" aria-hidden />
        </button>
      </> : null}
    </div>
  );
}

function CrmGroupedRows<T extends { id: string; customFields?: Record<string, unknown> }>({
  rows,
  field,
  referenceLabels,
  emptyLabel,
  unavailableLabel,
  booleanLabels,
  render,
}: {
  rows: readonly T[];
  field: CrmFieldDefinition | null;
  referenceLabels: Map<string, string>;
  emptyLabel: string;
  unavailableLabel: string;
  booleanLabels: { true: string; false: string };
  render: (rows: T[]) => React.ReactNode;
}) {
  if (!field || rows.length === 0) return <>{render([...rows])}</>;
  const groups = groupRowsByCustomField(rows, field, referenceLabels, emptyLabel, booleanLabels, unavailableLabel);
  return <div>{groups.map((group) => <section key={group.value}>
    <div className="sticky top-0 z-10 flex items-center gap-2 border-y border-border/60 bg-muted/90 px-4 py-2 text-xs font-medium backdrop-blur-sm">
      <span>{group.label}</span><span className="tabular-nums text-muted-foreground">{group.rows.length}</span>
    </div>
    {render(group.rows)}
  </section>)}</div>;
}

function crmGrid(columns: readonly CrmColumnDefinition[]): React.CSSProperties {
  return {
    gridTemplateColumns: `28px ${columns.map((column) =>
      `minmax(${column.minWidth}px,${column.key === "name" ? "1.35fr" : "1fr"})`).join(" ")}`,
  };
}

/** Quiet sticky column-header strip generated from the personal registry. */
function TableHead({ columns, fields }: {
  columns: readonly CrmColumnDefinition[];
  fields: readonly CrmFieldDefinition[];
}) {
  const t = useT().crmPage;
  return (
    <div
      className="sticky top-0 z-10 grid items-center gap-1 border-b border-border/60 bg-background/95 px-4 py-1.5 backdrop-blur"
      style={crmGrid(columns)}
    >
      <span />
      {columns.map((column) => (
        <span
          key={column.key}
          className="truncate text-[11px] font-medium uppercase tracking-wide text-muted-foreground/60"
        >
          {crmColumnLabel(column.key, fields, t)}
        </span>
      ))}
    </div>
  );
}

function CustomValue({
  row,
  column,
  referenceNames,
}: {
  row: { customFields?: Record<string, unknown> };
  column: CrmColumnDefinition;
  referenceNames: Map<string, string>;
}) {
  const t = useT().crmPage.r2;
  const raw = row.customFields?.[column.key.slice(3)];
  const values = Array.isArray(raw) ? raw : raw === null || raw === undefined || raw === "" ? [] : [raw];
  const rendered = values.map((value) => {
    if (typeof value === "boolean") return value ? t.yes : t.no;
    return referenceNames.get(String(value)) ?? String(value);
  }).join(", ");
  return <span className="truncate px-1.5 text-[12.5px] text-muted-foreground">{rendered || t.emptyValue}</span>;
}

function DealsTable({
  rows,
  columns,
  fields,
  ownerNames,
  referenceNames,
  companyNames,
  contactNames,
  today,
  pipeline,
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
  columns: readonly CrmColumnDefinition[];
  fields: readonly CrmFieldDefinition[];
  ownerNames: Map<string, string>;
  referenceNames: Map<string, string>;
  companyNames: Map<string, string>;
  contactNames: Map<string, string>;
  today: string;
  pipeline: CrmPipeline;
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
    <div className="min-w-max pb-2">
      <TableHead columns={columns} fields={fields} />
      {rows.map((row) => {
        const overdue =
          isOpenStage(row.stage) &&
          row.closeDate !== null &&
          row.closeDate < today;
        return (
          <div
            key={row.id}
            className={cn("group/crm grid items-center gap-1 px-4 py-1.5 transition-colors", selected.has(row.id) ? "bg-primary/5" : "hover:bg-muted/40")}
            style={crmGrid(columns)}
          >
            <RowCheckbox
              checked={selected.has(row.id)}
              name={row.name}
              onToggle={() => onToggle(row.id)}
            />
            {columns.map((column) => {
              if (column.source === "custom") return <CustomValue key={column.key} row={row} column={column} referenceNames={referenceNames} />;
              if (column.key === "name") return <button key={column.key} type="button" onClick={() => onOpenRecord(row)} title={t.openRecord} className="truncate py-1 text-left text-[13.5px] font-medium text-foreground hover:underline">{row.name}</button>;
              if (column.key === "stage") return <PipelineStageCell key={column.key} stageId={resolveDealPipelineStage(row, pipeline)?.id ?? null} stages={pipeline.stages} onCommit={commits.dealPipelineStage(row)} />;
              if (column.key === "company") return <span key={column.key} className="truncate text-[12.5px] text-muted-foreground">{row.companyId ? companyNames.get(row.companyId) ?? "" : ""}</span>;
              if (column.key === "contact") return <span key={column.key} className="truncate text-[12.5px] text-muted-foreground">{row.contactId ? contactNames.get(row.contactId) ?? "" : ""}</span>;
              if (column.key === "amount") return <AmountCell key={column.key} value={row.amount} currencyCode={row.currencyCode} onCommit={commits.dealAmount(row)} />;
              if (column.key === "close") return <CloseDateCell key={column.key} value={row.closeDate} overdue={overdue} onCommit={commits.dealClose(row)} />;
              if (column.key === "owner") return <span key={column.key} className="truncate px-1.5 text-[12.5px] text-muted-foreground">{row.ownerId ? ownerNames.get(row.ownerId) ?? t.r2.memberUnavailable : t.r2.unassigned}</span>;
              if (column.key === "source") return <span key={column.key} className="truncate px-1.5 text-[12.5px] text-muted-foreground">{row.source ?? t.noValue}</span>;
              return <UpdatedCell key={column.key} iso={row.updatedAt} />;
            })}
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
  columns,
  fields,
  ownerNames,
  referenceNames,
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
  columns: readonly CrmColumnDefinition[];
  fields: readonly CrmFieldDefinition[];
  ownerNames: Map<string, string>;
  referenceNames: Map<string, string>;
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
    <div className="min-w-max pb-2">
      <TableHead columns={columns} fields={fields} />
      {rows.map((row) => (
        <div
          key={row.id}
          className={cn("group/crm grid items-center gap-1 px-4 py-1.5 transition-colors", selected.has(row.id) ? "bg-primary/5" : "hover:bg-muted/40")}
          style={crmGrid(columns)}
        >
          <RowCheckbox
            checked={selected.has(row.id)}
            name={row.name}
            onToggle={() => onToggle(row.id)}
          />
          {columns.map((column) => {
            if (column.source === "custom") return <CustomValue key={column.key} row={row} column={column} referenceNames={referenceNames} />;
            if (column.key === "name") return <button key={column.key} type="button" onClick={() => onOpenRecord(row)} title={t.openRecord} className="truncate py-1 text-left text-[13.5px] font-medium text-foreground hover:underline">{row.name}</button>;
            if (column.key === "email") return <TextFieldCell key={column.key} value={row.email} placeholder={t.noValue} ariaLabel={t.emailLabel} inputType="email" onCommit={commits.contactEmail(row)} />;
            if (column.key === "phone") return <TextFieldCell key={column.key} value={row.phone} placeholder={t.noValue} ariaLabel={t.phoneLabel} inputType="tel" onCommit={commits.contactPhone(row)} />;
            if (column.key === "company") return <CompanyCell key={column.key} companyId={row.companyId} companies={companies} onCommit={commits.contactCompany(row)} />;
            if (column.key === "tags") return <TagsCell key={column.key} tags={row.tags} onCommit={commits.contactTags(row)} />;
            if (column.key === "owner") return <span key={column.key} className="truncate px-1.5 text-[12.5px] text-muted-foreground">{row.ownerId ? ownerNames.get(row.ownerId) ?? t.r2.memberUnavailable : t.r2.unassigned}</span>;
            return <UpdatedCell key={column.key} iso={row.updatedAt} />;
          })}
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
  columns,
  fields,
  ownerNames,
  referenceNames,
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
  columns: readonly CrmColumnDefinition[];
  fields: readonly CrmFieldDefinition[];
  ownerNames: Map<string, string>;
  referenceNames: Map<string, string>;
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
    <div className="min-w-max pb-2">
      <TableHead columns={columns} fields={fields} />
      {rows.map((row) => (
          <div
            key={row.id}
            className={cn("group/crm grid items-center gap-1 px-4 py-1.5 transition-colors", selected.has(row.id) ? "bg-primary/5" : "hover:bg-muted/40")}
            style={crmGrid(columns)}
          >
            <RowCheckbox
              checked={selected.has(row.id)}
              name={row.name}
              onToggle={() => onToggle(row.id)}
            />
            {columns.map((column) => {
              if (column.source === "custom") return <CustomValue key={column.key} row={row} column={column} referenceNames={referenceNames} />;
              if (column.key === "name") return <button key={column.key} type="button" onClick={() => onOpenRecord(row)} title={t.openRecord} className="truncate py-1 text-left text-[13.5px] font-medium text-foreground hover:underline">{row.name}</button>;
              if (column.key === "domain") return <TextFieldCell key={column.key} value={row.domain} placeholder={t.noValue} ariaLabel={t.domainLabel} onCommit={commits.companyDomain(row)} />;
              if (column.key === "tags") return <TagsCell key={column.key} tags={row.tags} onCommit={commits.companyTags(row)} />;
              if (column.key === "owner") return <span key={column.key} className="truncate px-1.5 text-[12.5px] text-muted-foreground">{row.ownerId ? ownerNames.get(row.ownerId) ?? t.r2.memberUnavailable : t.r2.unassigned}</span>;
              return <UpdatedCell key={column.key} iso={row.updatedAt} />;
            })}
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
  stages,
  owners,
  onClear,
  onDealStage,
  onOwner,
  onContactCompany,
  onAddTag,
}: {
  section: CrmSection;
  count: number;
  busy: boolean;
  error: string | null;
  companies: readonly CrmCompanyRow[];
  tagOptions: string[];
  stages: readonly CrmPipelineStage[];
  owners: readonly { id: string; name: string }[];
  onClear: () => void;
  onDealStage: (stageId: string) => void;
  onOwner: (ownerId: string | null) => void;
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
            stages.map((stage) => [stage.id, stage.name]),
          )}
          disabled={busy}
          onPick={onDealStage}
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
      <BulkMenu
        label={t.r2.bulkOwner}
        items={{
          [NONE]: t.r2.unassigned,
          ...Object.fromEntries(owners.map((owner) => [owner.id, owner.name])),
        }}
        disabled={busy}
        onPick={(id) => onOwner(id === NONE ? null : id)}
      />
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
