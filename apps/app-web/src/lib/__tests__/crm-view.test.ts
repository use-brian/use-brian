/**
 * CRM operator surface — pure view logic tests.
 * [COMP:app-web/crm-view]
 */
import { describe, it, expect } from "vitest";
import type {
  CrmCompanyRow,
  CrmContactRow,
  CrmDealRow,
  CrmPipeline,
  CrmFieldDefinition,
} from "@/lib/api/crm";
import {
  applyContactFilters,
  applyDealFilters,
  companyStats,
  crmQuickCounts,
  crmViewFromSearch,
  formatAmount,
  groupDealsByPipelineStage,
  groupRowsByCustomField,
  localDateStr,
  matchesDealQuickFilter,
  searchFromCrmView,
  sectionForQuickFilter,
  sortDeals,
  DEFAULT_CRM_VIEW,
} from "@/lib/crm-view";

const NOW = new Date("2026-07-22T12:00:00Z");

const PIPELINE: CrmPipeline = {
  id: "pipeline-sales",
  name: "Sales",
  isDefault: true,
  position: 0,
  stages: [
    { id: "stage-lead", pipelineId: "pipeline-sales", name: "Lead", legacyKey: "lead", category: "open", position: 0, probability: 10, requiredFields: [] },
    { id: "stage-qualified", pipelineId: "pipeline-sales", name: "Qualified", legacyKey: "qualified", category: "open", position: 1, probability: 30, requiredFields: [] },
    { id: "stage-won", pipelineId: "pipeline-sales", name: "Won", legacyKey: "won", category: "won", position: 2, probability: 100, requiredFields: [] },
  ],
};

function deal(over: Partial<CrmDealRow> = {}): CrmDealRow {
  return {
    id: "d1",
    name: "Deal - Acme",
    stage: "proposal",
    amount: 50000,
    closeDate: "2026-09-30",
    contactId: null,
    companyId: "co1",
    updatedAt: "2026-07-20T00:00:00Z",
    ...over,
  };
}

function contact(over: Partial<CrmContactRow> = {}): CrmContactRow {
  return {
    id: "c1",
    name: "Sam Lee",
    email: "sam@acme.com",
    phone: null,
    companyId: "co1",
    tags: [],
    updatedAt: "2026-07-20T00:00:00Z",
    ...over,
  };
}

function company(over: Partial<CrmCompanyRow> = {}): CrmCompanyRow {
  return {
    id: "co1",
    name: "Acme",
    domain: "acme.com",
    tags: [],
    updatedAt: "2026-07-20T00:00:00Z",
    ...over,
  };
}

describe("[COMP:app-web/crm-view] CRM view logic", () => {
  it("overdue matches an open deal past its close date — the deal_attention contract", () => {
    // Strictly before today, open stage → overdue.
    expect(
      matchesDealQuickFilter(deal({ closeDate: "2026-07-21" }), "overdue", NOW),
    ).toBe(true);
    // Today is NOT overdue (strict less-than, matching the SQL `< CURRENT_DATE`).
    expect(
      matchesDealQuickFilter(
        deal({ closeDate: localDateStr(NOW) }),
        "overdue",
        NOW,
      ),
    ).toBe(false);
    // A closed (won/lost) deal never counts, however old the date.
    expect(
      matchesDealQuickFilter(
        deal({ stage: "won", closeDate: "2020-01-01" }),
        "overdue",
        NOW,
      ),
    ).toBe(false);
    // No close date → not overdue.
    expect(
      matchesDealQuickFilter(deal({ closeDate: null }), "overdue", NOW),
    ).toBe(false);
  });

  it("stale + noAmount only match open deals", () => {
    expect(
      matchesDealQuickFilter(
        deal({ updatedAt: "2026-05-01T00:00:00Z" }),
        "stale",
        NOW,
      ),
    ).toBe(true);
    expect(
      matchesDealQuickFilter(
        deal({ stage: "lost", updatedAt: "2026-05-01T00:00:00Z" }),
        "stale",
        NOW,
      ),
    ).toBe(false);
    expect(matchesDealQuickFilter(deal({ amount: null }), "noAmount", NOW)).toBe(
      true,
    );
    expect(
      matchesDealQuickFilter(
        deal({ amount: null, stage: "won" }),
        "noAmount",
        NOW,
      ),
    ).toBe(false);
  });

  it("counts every preset in one pass (chips + sidebar + dock agree)", () => {
    const counts = crmQuickCounts(
      [
        deal({ id: "d1", closeDate: "2026-01-01" }),
        deal({ id: "d2", amount: null, closeDate: null }),
        deal({ id: "d3", stage: "won", closeDate: "2026-01-01" }),
      ],
      [contact({ id: "c1", companyId: null }), contact({ id: "c2" })],
      NOW,
    );
    expect(counts.overdue).toBe(1);
    expect(counts.noAmount).toBe(1);
    expect(counts.orphaned).toBe(1);
  });

  it("round-trips the dedicated email review and selected draft in the CRM URL", () => {
    const view = crmViewFromSearch("review=email&draft=approval-2&section=contacts");
    expect(view.review).toBe("email");
    expect(view.draft).toBe("approval-2");
    expect(searchFromCrmView(view)).toContain("review=email");
    expect(searchFromCrmView(view)).toContain("draft=approval-2");
    expect(crmViewFromSearch("draft=orphaned").draft).toBeNull();
  });

  it("round-trips owner state and applies the same owner filter to every section", () => {
    const view = crmViewFromSearch("owner=user-1,none&section=contacts");
    expect(view.owner).toEqual(["user-1", "none"]);
    expect(searchFromCrmView(view)).toContain("owner=user-1%2Cnone");
    expect(applyDealFilters([
      deal({ id: "mine", ownerId: "user-1" }),
      deal({ id: "other", ownerId: "user-2" }),
    ], { ...DEFAULT_CRM_VIEW, owner: ["user-1"] }, new Map(), NOW).map((row) => row.id)).toEqual(["mine"]);
    expect(applyContactFilters([
      contact({ id: "mine", ownerId: "user-1" }),
      contact({ id: "empty", ownerId: null }),
    ], { ...DEFAULT_CRM_VIEW, owner: ["none"] }).map((row) => row.id)).toEqual(["empty"]);
  });

  it("deal filtering: closed fold by default, quick filters pick their own slice", () => {
    const rows = [
      deal({ id: "open" }),
      deal({ id: "won", stage: "won" }),
      deal({ id: "overdue", closeDate: "2026-01-01" }),
    ];
    const names = new Map([["co1", "Acme"]]);
    // Default view hides won/lost.
    const defaulted = applyDealFilters(rows, DEFAULT_CRM_VIEW, names, NOW);
    expect(defaulted.map((r) => r.id)).toEqual(["open", "overdue"]);
    // closed=1 reveals them.
    const revealed = applyDealFilters(
      rows,
      { ...DEFAULT_CRM_VIEW, closed: true },
      names,
      NOW,
    );
    expect(revealed).toHaveLength(3);
    // The overdue quick-filter lands exactly the chip's count.
    const overdue = applyDealFilters(
      rows,
      { ...DEFAULT_CRM_VIEW, quick: "overdue" },
      names,
      NOW,
    );
    expect(overdue.map((r) => r.id)).toEqual(["overdue"]);
  });

  it("deal search matches the joined company name", () => {
    const rows = [deal({ id: "d1" }), deal({ id: "d2", companyId: null })];
    const names = new Map([["co1", "Globex"]]);
    const hits = applyDealFilters(
      rows,
      { ...DEFAULT_CRM_VIEW, q: "globex" },
      names,
      NOW,
    );
    expect(hits.map((r) => r.id)).toEqual(["d1"]);
  });

  it("filters by the selected stable pipeline and custom stage id", () => {
    const customPipeline: CrmPipeline = {
      ...PIPELINE,
      id: "pipeline-custom",
      isDefault: false,
      stages: [{ ...PIPELINE.stages[0], id: "stage-review", pipelineId: "pipeline-custom", name: "Review", legacyKey: null }],
    };
    const rows = [
      deal({ id: "custom", pipelineId: customPipeline.id, pipelineStageId: "stage-review" }),
      deal({ id: "default", pipelineId: PIPELINE.id, pipelineStageId: "stage-lead", stage: "lead" }),
    ];
    const hits = applyDealFilters(
      rows,
      { ...DEFAULT_CRM_VIEW, pipeline: customPipeline.id, stages: ["stage-review"] },
      new Map(),
      NOW,
      customPipeline,
    );
    expect(hits.map((row) => row.id)).toEqual(["custom"]);
  });

  it("contact filtering: orphaned preset + company facet", () => {
    const rows = [
      contact({ id: "linked" }),
      contact({ id: "orphan", companyId: null }),
    ];
    expect(
      applyContactFilters(rows, {
        ...DEFAULT_CRM_VIEW,
        section: "contacts",
        quick: "orphaned",
      }).map((r) => r.id),
    ).toEqual(["orphan"]);
    expect(
      applyContactFilters(rows, {
        ...DEFAULT_CRM_VIEW,
        section: "contacts",
        company: ["none"],
      }).map((r) => r.id),
    ).toEqual(["orphan"]);
  });

  it("ORs within a property: two companies show both, unlinked included", () => {
    const rows = [
      contact({ id: "a", companyId: "c1" }),
      contact({ id: "b", companyId: "c2" }),
      contact({ id: "c", companyId: "c3" }),
      contact({ id: "orphan", companyId: null }),
    ];
    const withCompany = (company: string[]) =>
      applyContactFilters(rows, {
        ...DEFAULT_CRM_VIEW,
        section: "contacts",
        company,
      }).map((r) => r.id);
    expect(withCompany(["c1", "c2"])).toEqual(["a", "b"]);
    expect(withCompany(["c1", "none"])).toEqual(["a", "orphan"]);
  });

  it("sortDeals: amount sinks unpriced, close sinks undated", () => {
    const rows = [
      deal({ id: "cheap", amount: 10 }),
      deal({ id: "unpriced", amount: null }),
      deal({ id: "big", amount: 1000 }),
    ];
    expect(sortDeals(rows, "amount").map((r) => r.id)).toEqual([
      "big",
      "cheap",
      "unpriced",
    ]);
    const dated = [
      deal({ id: "later", closeDate: "2026-12-01" }),
      deal({ id: "none", closeDate: null }),
      deal({ id: "soon", closeDate: "2026-08-01" }),
    ];
    expect(sortDeals(dated, "close").map((r) => r.id)).toEqual([
      "soon",
      "later",
      "none",
    ]);
  });

  it("companyStats counts contacts and OPEN deals only", () => {
    const stats = companyStats(
      [contact({ id: "c1" }), contact({ id: "c2", companyId: null })],
      [deal({ id: "d1" }), deal({ id: "d2", stage: "won" })],
    );
    expect(stats.get("co1")).toEqual({ contacts: 1, openDeals: 1 });
  });

  it("filters typed custom fields with OR within a field and AND across fields", () => {
    const rows = [
      deal({ id: "saas-referral", customFields: { work_type: "SaaS", opportunity_type: "Referral" } }),
      deal({ id: "services-referral", customFields: { work_type: "Services", opportunity_type: "Referral" } }),
      deal({ id: "saas-new", customFields: { work_type: "SaaS", opportunity_type: "New business" } }),
    ];
    const filtered = applyDealFilters(rows, {
      ...DEFAULT_CRM_VIEW,
      custom: { work_type: ["SaaS", "Services"], opportunity_type: ["Referral"] },
    }, new Map(), NOW);
    expect(filtered.map((row) => row.id)).toEqual(["saas-referral", "services-referral"]);
  });

  it("groups a single-valued reference field with an explicit empty group", () => {
    const field: CrmFieldDefinition = {
      id: "f1", entityKind: "deal", fieldKey: "referral_source", label: "Referral source",
      fieldType: "entity_reference", options: ["company"], isRequired: false, position: 0,
    };
    const groups = groupRowsByCustomField([
      deal({ id: "linked", customFields: { referral_source: "co1" } }),
      deal({ id: "unavailable", customFields: { referral_source: "co-archived" } }),
      deal({ id: "empty", customFields: {} }),
    ], field, new Map([["co1", "Partner Co"]]), "No value", undefined, "Unavailable record");
    expect(groups.map((group) => [group.label, group.rows.map((row) => row.id)])).toEqual([
      ["Partner Co", ["linked"]],
      ["Unavailable record", ["unavailable"]],
      ["No value", ["empty"]],
    ]);
  });

});

describe("[COMP:app-web/crm-surface] CRM surface state contract", () => {
  it("URL codec round-trips and defaults stay off the URL", () => {
    expect(searchFromCrmView(DEFAULT_CRM_VIEW)).toBe("");
    const state = crmViewFromSearch("section=contacts&filter=orphaned&q=sam");
    expect(state.section).toBe("contacts");
    expect(state.quick).toBe("orphaned");
    expect(state.q).toBe("sam");
    expect(crmViewFromSearch(searchFromCrmView(state))).toEqual(state);
  });

  it("round-trips MULTI-value filters; tags repeat, ids comma-join", () => {
    const state = {
      ...DEFAULT_CRM_VIEW,
      pipeline: "pipeline-sales",
      stages: ["stage-proposal", "stage-negotiation"] as const,
      company: ["co1", "co2"],
      tag: ["vip", "asia, pacific"],
      custom: { work_type: ["SaaS", "Consulting, design"] },
      group: "cf:opportunity_type",
    };
    const search = searchFromCrmView({ ...state, stages: [...state.stages] });
    const params = new URLSearchParams(search);
    expect(params.getAll("company")).toEqual(["co1,co2"]);
    // A tag containing a comma must stay one tag.
    expect(params.getAll("tag")).toEqual(["vip", "asia, pacific"]);
    expect(params.getAll("cf.work_type")).toEqual(["SaaS", "Consulting, design"]);
    expect(crmViewFromSearch(search)).toEqual({
      ...state,
      stages: [...state.stages],
    });
  });

  it("parses both shapes, so pre-multi single-value links survive", () => {
    expect(crmViewFromSearch("company=co1").company).toEqual(["co1"]);
    expect(crmViewFromSearch("stage=lead,won").stages).toEqual(["lead", "won"]);
    expect(crmViewFromSearch("stage=stage-lead&stage=custom-review").stages).toEqual(["stage-lead", "custom-review"]);
    expect(crmViewFromSearch("tag=vip").tag).toEqual(["vip"]);
  });

  it("a bare ?filter deep link resolves its home section (the dock card link)", () => {
    // The dock card sends /crm?filter=overdue with no section param.
    expect(crmViewFromSearch("filter=overdue").section).toBe("deals");
    expect(crmViewFromSearch("filter=orphaned").section).toBe("contacts");
    expect(sectionForQuickFilter("overdue")).toBe("deals");
  });
});

describe("[COMP:app-web/crm-board] Deal board grouping", () => {
  it("every stable stage gets a column and keeps currencies separate", () => {
    const rows = [
      deal({ id: "d1", stage: "lead", pipelineId: PIPELINE.id, pipelineStageId: "stage-lead", amount: 100, currencyCode: "USD" }),
      deal({ id: "d2", stage: "lead", pipelineId: PIPELINE.id, pipelineStageId: "stage-lead", amount: 80, currencyCode: "EUR" }),
      deal({ id: "d3", stage: "lead", pipelineId: PIPELINE.id, pipelineStageId: "stage-lead", amount: null }),
    ];
    const groups = groupDealsByPipelineStage(rows, PIPELINE, PIPELINE.stages.slice(0, 2));
    expect(groups).toHaveLength(2);
    expect(groups[0].rows).toHaveLength(3);
    expect(groups[0].currencyTotals).toEqual({ USD: 100, EUR: 80 });
    expect(groups[1].rows).toHaveLength(0);
  });

  it("formatAmount always makes currency explicit", () => {
    expect(formatAmount(950)).toBe("USD 950");
    expect(formatAmount(12_500, "EUR")).toBe("EUR 12.5k");
    expect(formatAmount(140_000, "JPY")).toBe("JPY 140k");
    expect(formatAmount(1_200_000)).toBe("USD 1.2M");
  });
});
