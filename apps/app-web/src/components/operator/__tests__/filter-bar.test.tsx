/**
 * [COMP:app-web/operator-filter-bar] Operator filter bar — static render
 * contract (the feed-inbox test shape: node-only `renderToString`).
 *
 * Asserts the Notion-style resting state (Filter funnel + View button +
 * collapsed search, NO always-visible dropdowns) and that an applied
 * filter materializes as a pill carrying the property label + the option
 * label. Popover contents and click flows are web-QA.
 */

import { describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";

vi.mock("@/lib/i18n/client", () => ({
  useT: () => ({
    filterBar: {
      filter: "Filter",
      clearFilter: "Clear filter",
      view: "View",
      more: "+{count}",
    },
  }),
}));

import { FilterBar } from "../filter-bar";

const DEFS = [
  {
    key: "stage",
    label: "Stage",
    options: [
      { value: "lead", label: "Lead" },
      { value: "proposal", label: "Proposal" },
    ],
  },
  {
    key: "company",
    label: "Company",
    options: [{ value: "co1", label: "Acme" }],
  },
];

describe("[COMP:app-web/operator-filter-bar] FilterBar render contract", () => {
  it("resting state: funnel + view + collapsed search, no pills", () => {
    const html = renderToString(
      <FilterBar
        defs={DEFS}
        active={{}}
        onSet={() => {}}
        search=""
        onSearch={() => {}}
        searchPlaceholder="Search"
        viewOptions={<div>view-options-content</div>}
      />,
    );
    expect(html).toContain("Filter");
    expect(html).toContain("View");
    // Search is a collapsed icon button (aria-label), not an input.
    expect(html).not.toContain("<input");
    // No applied filter → no pill, and no always-visible option labels.
    expect(html).not.toContain("Proposal");
  });

  it("an applied filter renders as a pill: property label + option label + clear", () => {
    const html = renderToString(
      <FilterBar
        defs={DEFS}
        active={{ stage: ["proposal"] }}
        onSet={() => {}}
        search=""
        onSearch={() => {}}
        searchPlaceholder="Search"
      />,
    );
    expect(html).toContain("Stage");
    expect(html).toContain("Proposal");
    expect(html).toContain("Clear filter");
    // A single value carries no overflow badge.
    expect(html).not.toContain("+1");
    // The other def stays behind the funnel.
    expect(html).not.toContain("Acme");
  });

  it("a multi-value filter stays pill-sized: lead label + overflow count", () => {
    const html = renderToString(
      <FilterBar
        defs={DEFS}
        active={{ stage: ["proposal", "lead"] }}
        onSet={() => {}}
        search=""
        onSearch={() => {}}
        searchPlaceholder="Search"
      />,
    );
    // Selection order leads, so the pill reads "Stage · Proposal +1"...
    expect(html).toContain("Proposal");
    expect(html).toContain("+1");
    // ...and the full set is still reachable, in the trigger's title.
    expect(html).toContain("Proposal, Lead");
    // Only ONE pill for the property, however many values it holds.
    expect(html.match(/Clear filter/g)).toHaveLength(1);
  });

  it("an empty value array is inactive — no pill", () => {
    const html = renderToString(
      <FilterBar
        defs={DEFS}
        active={{ stage: [] }}
        onSet={() => {}}
        search=""
        onSearch={() => {}}
        searchPlaceholder="Search"
      />,
    );
    expect(html).not.toContain("Clear filter");
    expect(html).not.toContain("Proposal");
  });

  it("an option's leading art rides its pill, sized for the pill", () => {
    const html = renderToString(
      <FilterBar
        defs={[
          {
            key: "assignee",
            label: "Assignee",
            options: [
              {
                value: "u1",
                label: "Ada Lovelace",
                icon: (size: number) => (
                  <img src="/a.png" width={size} height={size} alt="" />
                ),
              },
            ],
          },
        ]}
        active={{ assignee: ["u1"] }}
        onSet={() => {}}
        search=""
        onSearch={() => {}}
        searchPlaceholder="Search"
      />,
    );
    expect(html).toContain('src="/a.png"');
    expect(html).toContain('width="14"');
  });

  it("search keeps the input open while a query is applied", () => {
    const html = renderToString(
      <FilterBar
        defs={DEFS}
        active={{}}
        onSet={() => {}}
        search="acme"
        onSearch={() => {}}
        searchPlaceholder="Search"
      />,
    );
    expect(html).toContain("<input");
  });
});
