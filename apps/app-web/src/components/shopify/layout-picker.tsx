"use client";

/**
 * Pick the page layout for a new product, by SECTION rather than by file name.
 *
 * The picker this replaces listed one card per `templates/product.*.json`. On
 * a store that names a template after every product that is fifty cards, most
 * of them byte-identical stacks under names of OTHER products - which is no
 * help at all when the question is "should this page have a comparison table
 * and an FAQ". So the question is inverted: tick the sections, and the
 * templates are what get filtered.
 *
 * Nothing is hidden by the filter. What qualifies sits under Matches, what
 * falls short sits under Closest naming exactly what it lacks, because "no
 * results" is the one answer that says nothing about what to do next.
 *
 * [COMP:app-web/shopify-app]
 */

import { useEffect, useMemo, useState } from "react";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n/format";
import { callTool, ShopifyCallError } from "@/lib/api/shopify";
import { Note } from "./shopify-shared";
import {
  groupTemplates,
  sectionFacets,
  matchShapes,
  extrasOf,
  remainingIfAlso,
  productHandleFromUrl,
  type LayoutShape,
  type Template,
} from "./layout-match";
import { BuildLayoutButton } from "./build-layout-button";

type TemplateList = { theme?: string; templates?: Template[] };

export function LayoutPicker({
  workspaceId,
  productName,
  chosen,
  onChoose,
  wanted,
  onWanted,
}: {
  workspaceId: string;
  /** Names the template the build path would write. */
  productName: string;
  chosen: string;
  onChoose: (suffix: string) => void;
  wanted: string[];
  onWanted: (next: string[]) => void;
}) {
  const t = useT();
  const [templates, setTemplates] = useState<Template[] | null>(null);
  const [templateError, setTemplateError] = useState<string | null>(null);
  const [showClosest, setShowClosest] = useState(false);
  const [link, setLink] = useState("");
  const [linkBusy, setLinkBusy] = useState(false);
  const [linkNote, setLinkNote] = useState<string | null>(null);
  const [copiedFrom, setCopiedFrom] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const res = await callTool<TemplateList>(workspaceId, "shopifyListProductTemplates", {});
        if (alive) setTemplates(res.templates ?? []);
      } catch (err) {
        // Theme access is a grant the merchant turns on for their own app, not
        // something to work around. Relay it and keep the rest usable.
        if (alive) setTemplateError(err instanceof ShopifyCallError ? err.message : String(err));
      }
    })();
    return () => {
      alive = false;
    };
  }, [workspaceId]);

  const sectionLabel = (type: string): string => {
    const labels = t.shopifyApp.sectionLabels as Record<string, string | undefined>;
    return labels[type] ?? type.replace(/[-_]/g, " ").replace(/^./, (c) => c.toUpperCase());
  };

  const shapes = useMemo(() => groupTemplates(templates ?? []), [templates]);
  const facets = useMemo(() => sectionFacets(templates ?? []), [templates]);
  const { matches, closest } = useMemo(() => matchShapes(shapes, wanted), [shapes, wanted]);

  const universal = facets.filter((f) => f.universal);
  const filterable = facets.filter((f) => !f.universal);

  const toggle = (type: string) =>
    onWanted(wanted.includes(type) ? wanted.filter((w) => w !== type) : [...wanted, type]);

  /** "Give my product a page like THAT one." */
  async function useLayoutFromLink() {
    const handle = productHandleFromUrl(link);
    setCopiedFrom(null);
    if (!handle) {
      setLinkNote(t.shopifyApp.linkLooksWrong);
      return;
    }
    setLinkBusy(true);
    setLinkNote(null);
    try {
      const found = await callTool<{ items?: Array<{ id?: string; title?: string }> }>(
        workspaceId,
        "shopifyListProducts",
        { query: `handle:${handle}`, first: 1 },
      );
      const hit = (found.items ?? [])[0];
      if (!hit?.id) {
        setLinkNote(t.shopifyApp.productNotFound);
        return;
      }
      const full = await callTool<{ title?: string; template_suffix?: string | null }>(
        workspaceId,
        "shopifyGetProduct",
        { productId: hit.id },
      );
      const suffix = full.template_suffix ?? null;
      if (!suffix) {
        setLinkNote(t.shopifyApp.usesThemeDefault);
        return;
      }
      onChoose(suffix);
      setCopiedFrom(full.title ?? hit.title ?? handle);
    } catch (err) {
      setLinkNote(err instanceof ShopifyCallError ? err.message : String(err));
    } finally {
      setLinkBusy(false);
    }
  }

  return (
    <div className="space-y-2">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {t.shopifyApp.pageLayout}
      </h2>
      <p className="text-[13px] text-muted-foreground">{t.shopifyApp.layoutHelp}</p>

      {templateError ? <Note>{templateError}</Note> : null}
      {!templates && !templateError ? (
        <p className="text-sm text-muted-foreground">{t.shopifyApp.loading}</p>
      ) : null}
      {/* A theme with no custom templates is the ordinary starting state, not
          an error - the picker would otherwise show a single "Theme default"
          card and look broken. */}
      {templates && templates.filter((x) => x.suffix).length === 0 ? (
        <Note tone="muted">{t.shopifyApp.noTemplates}</Note>
      ) : null}

      {filterable.length > 0 ? (
        <div className="space-y-1.5 rounded-xl border border-border bg-card p-3">
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-xs font-medium text-muted-foreground">
              {t.shopifyApp.whatShouldPageHave}
            </span>
            {wanted.length > 0 ? (
              <button
                type="button"
                onClick={() => onWanted([])}
                className="text-[11.5px] text-muted-foreground underline underline-offset-2 hover:text-foreground"
              >
                {t.shopifyApp.clearSections}
              </button>
            ) : null}
          </div>

          {/* Worth SAYING rather than offering as a filter that narrows nothing. */}
          {universal.length > 0 ? (
            <p className="text-[12px] text-muted-foreground">
              {t.shopifyApp.everyLayoutHas}{" "}
              {universal.map((f) => sectionLabel(f.type)).join(", ")}
            </p>
          ) : null}

          <div className="flex flex-wrap gap-1.5 pt-0.5">
            {filterable.map((f) => {
              const on = wanted.includes(f.type);
              // A dead end says so on its face rather than emptying the page
              // when clicked.
              const remaining = remainingIfAlso(shapes, wanted, f.type);
              const dead = !on && remaining === 0;
              return (
                <button
                  key={f.type}
                  type="button"
                  onClick={() => toggle(f.type)}
                  disabled={dead}
                  aria-pressed={on}
                  title={dead ? t.shopifyApp.sectionNoneLeft : format(t.shopifyApp.sectionRemaining, { count: remaining })}
                  className={`rounded-full border px-2.5 py-1 text-[12px] transition-colors ${
                    on
                      ? "border-primary bg-primary/5 font-medium"
                      : dead
                        ? "cursor-not-allowed border-border/60 text-muted-foreground/40"
                        : "border-border bg-background hover:border-primary/40"
                  }`}
                >
                  {sectionLabel(f.type)}{" "}
                  <span className={dead ? "" : "text-muted-foreground"}>{remaining}</span>
                </button>
              );
            })}
          </div>
        </div>
      ) : null}

      {templates && shapes.length > 0 ? (
        <div className="space-y-2">
          <div className="flex items-baseline gap-2">
            <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              {t.shopifyApp.matchesHeading}
            </h3>
            <span className="text-[11px] text-muted-foreground">
              {format(t.shopifyApp.matchesCount, { count: matches.length })}
            </span>
          </div>

          {matches.length === 0 ? (
            <BuildLayoutButton
              workspaceId={workspaceId}
              productName={productName}
              templates={templates}
              wanted={wanted}
              nearest={closest[0]}
              sectionLabel={sectionLabel}
              onCreated={(suffix, created) => {
                setTemplates([...templates, created]);
                onChoose(suffix);
              }}
            />
          ) : null}

          <div className="grid gap-2 lg:grid-cols-2">
            {matches.map((shape) => (
              <ShapeCard
                key={shape.signature + (shape.representative.suffix ?? "")}
                shape={shape}
                wanted={wanted}
                chosen={chosen}
                onChoose={onChoose}
                sectionLabel={sectionLabel}
              />
            ))}
          </div>

          {closest.length > 0 ? (
            <div className="space-y-2">
              <button
                type="button"
                onClick={() => setShowClosest((v) => !v)}
                className="flex items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground"
              >
                <ChevronDown
                  className={`size-3.5 transition-transform ${showClosest ? "" : "-rotate-90"}`}
                  aria-hidden
                />
                {t.shopifyApp.closestHeading}
                {": "}
                {format(t.shopifyApp.closestToggle, { count: closest.length })}
              </button>
              {showClosest ? (
                <div className="grid gap-2 lg:grid-cols-2">
                  {closest.map(({ shape, missing }) => (
                    <ShapeCard
                      key={shape.signature + (shape.representative.suffix ?? "")}
                      shape={shape}
                      wanted={wanted}
                      missing={missing}
                      chosen={chosen}
                      onChoose={onChoose}
                      sectionLabel={sectionLabel}
                    />
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="space-y-1.5 rounded-xl border border-dashed border-border p-3">
        <span className="text-xs font-medium text-muted-foreground">{t.shopifyApp.orPasteLink}</span>
        <p className="text-[12.5px] text-muted-foreground">{t.shopifyApp.pasteLinkHint}</p>
        <div className="flex flex-wrap gap-2">
          <input
            value={link}
            onChange={(e) => setLink(e.target.value)}
            placeholder={t.shopifyApp.pasteLinkPlaceholder}
            className="h-9 min-w-[280px] flex-1 rounded-lg border border-border bg-background px-3 text-sm"
          />
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={linkBusy || !link.trim()}
            onClick={() => void useLayoutFromLink()}
          >
            {t.shopifyApp.useThisLayout}
          </Button>
        </div>
        {linkNote ? <Note>{linkNote}</Note> : null}
        {copiedFrom ? (
          <p className="text-[12.5px] text-muted-foreground">
            {t.shopifyApp.copiedFrom}{" "}
            <span className="font-medium text-foreground">{copiedFrom}</span>
          </p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * One distinct layout.
 *
 * The stack renders as inline text rather than a stack of bordered rows: the
 * rows are what made fifty of these unreadable, and the ORDER is the only part
 * of the stack that the label list does not already carry.
 */
function ShapeCard({
  shape,
  wanted,
  missing,
  chosen,
  onChoose,
  sectionLabel,
}: {
  shape: LayoutShape;
  wanted: string[];
  missing?: string[];
  chosen: string;
  onChoose: (suffix: string) => void;
  sectionLabel: (type: string) => string;
}) {
  const t = useT();
  const covered = shape.templates.map((x) => x.suffix ?? "");
  const selected = covered.includes(chosen);
  // Which FILE gets pointed at, when the shape covers several. Defaults to the
  // representative but stays the merchant's call: they may know that one of
  // these is the page they actually think of as the good one.
  const active = selected ? chosen : covered[0];
  const extras = wanted.length > 0 ? extrasOf(shape, wanted) : [];

  return (
    <div
      className={`rounded-xl border p-3 transition-colors ${
        selected ? "border-primary bg-primary/5" : "border-border bg-card"
      }`}
    >
      <button
        type="button"
        onClick={() => onChoose(active)}
        aria-pressed={selected}
        className="w-full text-left"
      >
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-[13px] font-semibold">
            {shape.representative.suffix === null
              ? t.shopifyApp.themeDefault
              : `${shape.sections.length} ${t.shopifyApp.sections}`}
          </span>
          {shape.templates.length > 1 ? (
            <span className="text-[11px] text-muted-foreground">
              {format(t.shopifyApp.sharedBy, { count: shape.templates.length })}
            </span>
          ) : null}
        </div>

        {shape.sections.length > 0 ? (
          <p className="mt-1.5 text-[12px] leading-relaxed">
            {shape.sections.map((s) => sectionLabel(s)).join(" › ")}
          </p>
        ) : null}

        {missing?.length ? (
          <p className="mt-1.5 text-[11.5px] text-muted-foreground">
            <span className="font-medium">{t.shopifyApp.missingLabel}</span>{" "}
            {missing.map((s) => sectionLabel(s)).join(", ")}
          </p>
        ) : extras.length ? (
          <p className="mt-1.5 text-[11.5px] text-muted-foreground">
            {t.shopifyApp.alsoHas} {extras.map((s) => sectionLabel(s)).join(", ")}
          </p>
        ) : null}
      </button>

      {shape.representative.suffix !== null ? (
        <div className="mt-2 flex items-center gap-2">
          <span className="shrink-0 text-[11px] text-muted-foreground">{t.shopifyApp.willUse}</span>
          {shape.templates.length > 1 ? (
            <SearchableSelect
              value={active}
              onValueChange={onChoose}
              items={shape.templates.map((x) => ({ value: x.suffix ?? "", label: x.suffix ?? "" }))}
              className="h-7 flex-1 text-[11.5px]"
              popupClassName="w-72"
              aria-label={t.shopifyApp.willUse}
            />
          ) : (
            <span className="font-mono text-[11px] text-muted-foreground">{active}</span>
          )}
        </div>
      ) : null}
    </div>
  );
}
