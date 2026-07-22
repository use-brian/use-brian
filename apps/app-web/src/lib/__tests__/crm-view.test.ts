/**
 * CRM operator surface — pure view logic tests.
 * [COMP:app-web/crm-view]
 */
import { describe, it, expect } from "vitest";
import type {
  CrmCompanyRow,
  CrmContactRow,
  CrmDealRow,
} from "@/lib/api/crm";
import {
  applyContactFilters,
  applyDealFilters,
  companyStats,
  crmQuickCounts,
  crmViewFromSearch,
  formatAmount,
  groupDealsByStage,
  localDateStr,
  matchesDealQuickFilter,
  searchFromCrmView,
  sectionForQuickFilter,
  sortDeals,
  DEFAULT_CRM_VIEW,
} from "@/lib/crm-view";

const NOW = new Date("2026-07-22T12:00:00Z");

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
        company: "none",
      }).map((r) => r.id),
    ).toEqual(["orphan"]);
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

  it("a bare ?filter deep link resolves its home section (the dock card link)", () => {
    // The dock card sends /crm?filter=overdue with no section param.
    expect(crmViewFromSearch("filter=overdue").section).toBe("deals");
    expect(crmViewFromSearch("filter=orphaned").section).toBe("contacts");
    expect(sectionForQuickFilter("overdue")).toBe("deals");
  });
});

describe("[COMP:app-web/crm-board] Deal board grouping", () => {
  it("every stage gets a column; sums skip null amounts", () => {
    const rows = [
      deal({ id: "d1", stage: "lead", amount: 100 }),
      deal({ id: "d2", stage: "lead", amount: null }),
    ];
    const groups = groupDealsByStage(rows, ["lead", "qualified"]);
    expect(groups).toHaveLength(2);
    expect(groups[0].rows).toHaveLength(2);
    expect(groups[0].amountSum).toBe(100);
    expect(groups[1].rows).toHaveLength(0);
  });

  it("formatAmount compacts to k/M for column headers", () => {
    expect(formatAmount(950)).toBe("$950");
    expect(formatAmount(12_500)).toBe("$12.5k");
    expect(formatAmount(140_000)).toBe("$140k");
    expect(formatAmount(1_200_000)).toBe("$1.2M");
  });
});
