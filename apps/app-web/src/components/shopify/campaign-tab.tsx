"use client";

/**
 * Restock campaign builder.
 *
 * The surface gathers every merchant decision, prepares a typed Shopify
 * segment and a time-limited code, then hands the approved copy to Shopify
 * Messaging. It never reads recipient rows and it never sends bulk email.
 *
 * [COMP:app-web/shopify-campaign]
 */

import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, Copy, ExternalLink, Megaphone, RefreshCw, Sparkles } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { askAssistant, callTool, extractJson, ShopifyCallError } from "@/lib/api/shopify";
import {
  createDefaultCampaignDraft,
  readCampaignStorage,
  recordPreparedCampaign,
  writeCampaignStorage,
  zonedLocalToIso,
  type CampaignHistoryItem,
  type CampaignImage,
  type CampaignProduct,
  type ShopifyCampaignDraft,
} from "@/lib/shopify-campaign";
import { format } from "@/lib/i18n/format";
import { useT } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";
import { Field, Kpi, Note } from "./shopify-shared";

type ShopInfo = {
  name?: string;
  myshopify_domain?: string;
  primary_domain?: string;
  currency?: string;
  timezone?: string;
};

type ProductPage = {
  items?: Array<{
    id?: string;
    title?: string;
    total_inventory?: number;
    featured_image_url?: string;
    featured_image_alt?: string;
  }>;
  has_next_page?: boolean;
  next_cursor?: string;
};

type DiscountPage = {
  items?: Array<{
    id?: string;
    kind?: string;
    title?: string;
    status?: string;
    codes?: string[];
    ends_at?: string;
  }>;
};

type AudiencePreview = { query?: string; total_count?: number };
type SegmentResult = { id?: string; name?: string; query?: string; admin_url?: string };
type DiscountResult = {
  id?: string;
  code?: string;
  status?: string;
  starts_at?: string;
  ends_at?: string;
};
type GeneratedCopy = { subject?: string; preview?: string; body?: string; ctaLabel?: string };

const inputClass = "h-9 w-full rounded-lg border border-border bg-background px-3 text-sm";
const textAreaClass = "w-full rounded-lg border border-border bg-background px-3 py-2 text-sm";
const CAMPAIGN_TOOLS = [
  "shopifyGetShop",
  "shopifyListProducts",
  "shopifyGetProduct",
  "shopifyListDiscounts",
  "shopifyPreviewCustomerSegment",
  "shopifyCreateCustomerSegment",
  "shopifyCreateDiscountCode",
] as const;

function toolMessage(error: unknown): string {
  return error instanceof ShopifyCallError ? error.message : String(error);
}

function choiceClass(active: boolean): string {
  return cn(
    "rounded-xl border p-3 text-left transition-colors",
    active ? "border-primary bg-primary/5" : "border-border bg-card hover:border-primary/40",
  );
}

function campaignProduct(item: NonNullable<ProductPage["items"]>[number]): CampaignProduct | null {
  if (!item.id || !item.title || typeof item.total_inventory !== "number" || item.total_inventory <= 0) {
    return null;
  }
  let imageUrl: string | undefined;
  if (item.featured_image_url) {
    try {
      const url = new URL(item.featured_image_url);
      if (url.protocol === "http:" || url.protocol === "https:") imageUrl = item.featured_image_url;
    } catch {
      // Invalid remote image metadata is ignored instead of entering the preview.
    }
  }
  return {
    id: item.id,
    title: item.title,
    totalInventory: item.total_inventory,
    ...(imageUrl ? { imageUrl } : {}),
    ...(typeof item.featured_image_alt === "string" ? { imageAlt: item.featured_image_alt } : {}),
  };
}

function productImage(product: CampaignProduct | undefined): CampaignImage | undefined {
  if (!product?.imageUrl) return undefined;
  return {
    productId: product.id,
    url: product.imageUrl,
    alt: product.imageAlt || product.title,
  };
}

export function CampaignTab({
  workspaceId,
  availableTools,
}: {
  workspaceId: string;
  availableTools: string[];
}) {
  const t = useT();
  const [shop, setShop] = useState<ShopInfo | null>(null);
  const [products, setProducts] = useState<CampaignProduct[] | null>(null);
  const [moreProducts, setMoreProducts] = useState(false);
  const [productCursor, setProductCursor] = useState<string | null>(null);
  const [automaticDiscounts, setAutomaticDiscounts] = useState<NonNullable<DiscountPage["items"]>>([]);
  const [draft, setDraft] = useState<ShopifyCampaignDraft | null>(null);
  const [history, setHistory] = useState<CampaignHistoryItem[]>([]);
  const [busy, setBusy] = useState<"load" | "audience" | "copy" | "prepare" | null>("load");
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const missingCampaignTools = CAMPAIGN_TOOLS.filter((tool) => !availableTools.includes(tool));

  async function loadStore() {
    setBusy("load");
    setError(null);
    try {
      const [info, productPage, discountPage] = await Promise.all([
        callTool<ShopInfo>(workspaceId, "shopifyGetShop", {}),
        callTool<ProductPage>(workspaceId, "shopifyListProducts", { query: "status:active", first: 50 }),
        callTool<DiscountPage>(workspaceId, "shopifyListDiscounts", { query: "status:active", first: 50 }),
      ]);
      const timeZone = info.timezone || "UTC";
      const fallback = createDefaultCampaignDraft(timeZone, info.primary_domain ?? "");
      const domain = info.myshopify_domain ?? "";
      const stored = readCampaignStorage(workspaceId, domain, fallback);
      const loadedProducts = (productPage.items ?? [])
        .map(campaignProduct)
        .filter((product): product is CampaignProduct => !!product);
      const byId = new Map(loadedProducts.map((product) => [product.id, product]));
      const selectedProducts = stored.draft.selectedProducts.map((product) => byId.get(product.id) ?? product);
      const selectedImage = stored.draft.includeProductImage
        ? productImage(
            selectedProducts.find((product) => product.id === stored.draft.selectedImage?.productId),
          ) ?? selectedProducts.map(productImage).find((image): image is CampaignImage => !!image)
        : undefined;
      setShop(info);
      setProducts(loadedProducts);
      setMoreProducts(productPage.has_next_page === true);
      setProductCursor(productPage.next_cursor ?? null);
      setAutomaticDiscounts(
        (discountPage.items ?? []).filter(
          (item) => item.kind === "automatic" && item.status?.toUpperCase() === "ACTIVE",
        ),
      );
      setDraft({
        ...stored.draft,
        selectedProducts,
        selectedImage,
      });
      setHistory(stored.history);
    } catch (err) {
      setError(toolMessage(err));
    } finally {
      setBusy(null);
      setStatus(null);
    }
  }

  async function loadMoreProducts() {
    if (!productCursor) return;
    setBusy("load");
    setError(null);
    try {
      const page = await callTool<ProductPage>(workspaceId, "shopifyListProducts", {
        query: "status:active",
        first: 50,
        cursor: productCursor,
      });
      const additions = (page.items ?? [])
        .map(campaignProduct)
        .filter((product): product is CampaignProduct => !!product);
      setProducts((current) => {
        const byId = new Map((current ?? []).map((product) => [product.id, product]));
        for (const product of additions) byId.set(product.id, product);
        return [...byId.values()];
      });
      setMoreProducts(page.has_next_page === true);
      setProductCursor(page.next_cursor ?? null);
    } catch (err) {
      setError(toolMessage(err));
    } finally {
      setBusy(null);
    }
  }

  useEffect(() => {
    void loadStore();
    // `loadStore` is intentionally mount/workspace keyed. A manual refresh is
    // provided because store stock can move without route navigation.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

  useEffect(() => {
    if (!shop?.myshopify_domain || !draft) return;
    writeCampaignStorage(workspaceId, shop.myshopify_domain, draft, history);
  }, [workspaceId, shop?.myshopify_domain, draft, history]);

  const prepared = !!draft?.segment && !!draft?.discount;
  const audienceLocked = !!draft?.segment;
  const offerLocked = !!draft?.discount;

  function updateDraft(
    patch: Partial<ShopifyCampaignDraft>,
    options: { invalidateAudience?: boolean } = {},
  ) {
    setDraft((current) => {
      if (!current) return current;
      const next: ShopifyCampaignDraft = {
        ...current,
        ...patch,
        ...(options.invalidateAudience
          ? { audienceCount: undefined, audienceQuery: undefined, segment: undefined }
          : {}),
        updatedAt: Date.now(),
      };
      return next;
    });
  }

  useEffect(() => {
    if (!draft?.segment || !draft.discount || !draft.preparedAt) return;
    setHistory((items) => recordPreparedCampaign(items, draft as CampaignHistoryItem));
  }, [draft]);

  function toggleProduct(product: CampaignProduct) {
    if (!draft || audienceLocked) return;
    const alreadySelected = draft.selectedProducts.some((item) => item.id === product.id);
    if (!alreadySelected && draft.selectedProducts.length >= 500) {
      setError(t.shopifyApp.campaignProductMax);
      return;
    }
    const selected = alreadySelected
      ? draft.selectedProducts.filter((item) => item.id !== product.id)
      : [...draft.selectedProducts, product];
    const selectedImage = draft.includeProductImage
      ? productImage(selected.find((item) => item.id === draft.selectedImage?.productId))
        ?? selected.map(productImage).find((image): image is CampaignImage => !!image)
      : undefined;
    setError(null);
    updateDraft({
      selectedProducts: selected,
      selectedImage,
      checklist: { ...draft.checklist, image: false },
    }, { invalidateAudience: true });
  }

  async function previewAudience() {
    if (!draft) return;
    if (draft.audience === "product_buyers" && draft.selectedProducts.length === 0) {
      setError(t.shopifyApp.campaignNeedProduct);
      return;
    }
    setBusy("audience");
    setError(null);
    try {
      const result = await callTool<AudiencePreview>(workspaceId, "shopifyPreviewCustomerSegment", {
        audience: draft.audience,
        ...(draft.audience === "product_buyers"
          ? { productIds: draft.selectedProducts.map((product) => product.id) }
          : {}),
      });
      updateDraft({
        audienceCount: result.total_count ?? 0,
        audienceQuery: result.query ?? "",
      });
    } catch (err) {
      setError(toolMessage(err));
    } finally {
      setBusy(null);
    }
  }

  async function generateCopy() {
    if (!draft || !shop) return;
    if (!draft.selectedProducts.length) {
      setError(t.shopifyApp.campaignNeedProduct);
      return;
    }
    setBusy("copy");
    setError(null);
    setStatus(t.shopifyApp.campaignDraftingCopy);
    try {
      const offer = draft.discountKind === "percentage"
        ? `${draft.discountValue}%`
        : `${draft.discountValue} ${shop.currency ?? ""}`.trim();
      const language = draft.language === "zh"
        ? "Traditional Chinese"
        : draft.language === "bilingual"
          ? "bilingual English and Traditional Chinese"
          : "English";
      const answer = await askAssistant(workspaceId, `Draft a concise restock email for this Shopify store.

Products: ${draft.selectedProducts.map((product) => product.title).join(", ")}
Audience: ${draft.audience === "all_subscribers" ? "all email subscribers" : "email subscribers who bought one of these products over all time"}
Audience count: ${draft.audienceCount ?? "not previewed"}
Offer: ${offer} off with code ${draft.code}
Send time in ${shop.timezone ?? "UTC"}: ${draft.sendAt}
Expiry in ${shop.timezone ?? "UTC"}: ${draft.expiresAt}
Language: ${language}
CTA URL: ${draft.ctaUrl}

Do not invent product claims, ingredients, stock quantities or urgency beyond the expiry.
Reply with ONLY one JSON object, no prose:
{"subject":"","preview":"","body":"","ctaLabel":""}`);
      const parsed = extractJson<GeneratedCopy>(answer);
      if (!parsed?.subject || !parsed.body || !parsed.ctaLabel) {
        setError(t.shopifyApp.campaignCopyFailed);
        return;
      }
      updateDraft({
        subject: parsed.subject,
        preview: parsed.preview ?? "",
        body: parsed.body,
        ctaLabel: parsed.ctaLabel,
      });
    } catch (err) {
      setError(toolMessage(err));
    } finally {
      setBusy(null);
      setStatus(null);
    }
  }

  function validateForPreparation(current: ShopifyCampaignDraft): string | null {
    if (!current.selectedProducts.length) return t.shopifyApp.campaignNeedProduct;
    if (current.audienceCount === undefined) return t.shopifyApp.campaignNeedAudiencePreview;
    if (current.audienceCount <= 0) return t.shopifyApp.campaignEmptyAudience;
    if (!/^[A-Z0-9-]{4,32}$/.test(current.code)) return t.shopifyApp.campaignBadCode;
    const value = Number(current.discountValue);
    if (!Number.isFinite(value) || value <= 0) return t.shopifyApp.campaignBadDiscount;
    if (current.discountKind === "percentage" && value > 100) return t.shopifyApp.campaignBadDiscount;
    if (current.usageLimit && Number(current.usageLimit) <= 0) {
      return t.shopifyApp.campaignBadUsageLimit;
    }
    if (!current.subject.trim() || !current.body.trim() || !current.ctaLabel.trim()) {
      return t.shopifyApp.campaignNeedCopy;
    }
    if (current.includeProductImage && !current.selectedImage) {
      return t.shopifyApp.campaignNeedPhoto;
    }
    try {
      const url = new URL(current.ctaUrl);
      if (url.protocol !== "http:" && url.protocol !== "https:") return t.shopifyApp.campaignBadUrl;
    } catch {
      return t.shopifyApp.campaignBadUrl;
    }
    try {
      const timeZone = shop?.timezone || "UTC";
      const startsAt = zonedLocalToIso(current.sendAt, timeZone);
      const endsAt = zonedLocalToIso(current.expiresAt, timeZone);
      if (Date.parse(endsAt) <= Date.parse(startsAt)) return t.shopifyApp.campaignBadWindow;
      if (Date.parse(startsAt) < Date.now() - 5 * 60 * 1000) return t.shopifyApp.campaignSendInPast;
    } catch {
      return t.shopifyApp.campaignBadWindow;
    }
    return null;
  }

  async function prepareCampaign() {
    if (!draft || !shop?.myshopify_domain) return;
    const validation = validateForPreparation(draft);
    if (validation) {
      setError(validation);
      return;
    }
    setBusy("prepare");
    setError(null);
    let working = draft;
    try {
      setStatus(t.shopifyApp.campaignRefreshingStock);
      const refreshed = await Promise.all(
        working.selectedProducts.map(async (product) => {
          const current = await callTool<{
            title?: string;
            total_inventory?: number;
            featured_image_url?: string;
            featured_image_alt?: string;
          }>(
            workspaceId,
            "shopifyGetProduct",
            { productId: product.id },
          );
          return {
            ...product,
            title: current.title ?? product.title,
            totalInventory: current.total_inventory ?? 0,
            imageUrl: current.featured_image_url,
            imageAlt: current.featured_image_alt,
          };
        }),
      );
      if (!refreshed.some((product) => product.totalInventory > 0)) {
        throw new Error(t.shopifyApp.campaignAllOutOfStock);
      }
      const refreshedImage = working.includeProductImage
        ? productImage(refreshed.find((product) => product.id === working.selectedImage?.productId))
        : undefined;
      if (working.includeProductImage && !refreshedImage) {
        throw new Error(t.shopifyApp.campaignPhotoUnavailable);
      }
      working = {
        ...working,
        selectedProducts: refreshed,
        selectedImage: refreshedImage,
        updatedAt: Date.now(),
      };

      setStatus(t.shopifyApp.campaignRefreshingAudience);
      const audience = await callTool<AudiencePreview>(workspaceId, "shopifyPreviewCustomerSegment", {
        audience: working.audience,
        ...(working.audience === "product_buyers"
          ? { productIds: refreshed.map((product) => product.id) }
          : {}),
      });
      if ((audience.total_count ?? 0) <= 0) throw new Error(t.shopifyApp.campaignEmptyAudience);
      working = {
        ...working,
        audienceCount: audience.total_count,
        audienceQuery: audience.query,
        updatedAt: Date.now(),
      };

      if (!working.segment) {
        setStatus(t.shopifyApp.campaignCreatingSegment);
        const date = working.sendAt.slice(0, 10);
        const segmentName = `Brian - Restock - ${date} - ${refreshed[0]?.title ?? "Campaign"}`.slice(0, 255);
        const segment = await callTool<SegmentResult>(workspaceId, "shopifyCreateCustomerSegment", {
          name: segmentName,
          audience: working.audience,
          ...(working.audience === "product_buyers"
            ? { productIds: refreshed.map((product) => product.id) }
            : {}),
        });
        if (!segment.id) throw new Error(t.shopifyApp.campaignSegmentFailed);
        working = {
          ...working,
          segment: {
            id: segment.id,
            name: segment.name ?? segmentName,
            query: segment.query ?? audience.query ?? "",
            adminUrl: segment.admin_url ?? `https://${shop.myshopify_domain}/admin/customers/segments`,
          },
          updatedAt: Date.now(),
        };
        setDraft(working);
        writeCampaignStorage(workspaceId, shop.myshopify_domain, working, history);
      }

      if (!working.discount) {
        setStatus(t.shopifyApp.campaignCheckingCode);
        const existing = await callTool<DiscountPage>(workspaceId, "shopifyListDiscounts", {
          query: working.code,
          first: 10,
        });
        const conflict = (existing.items ?? []).some((item) =>
          (item.codes ?? []).some((code) => code.toUpperCase() === working.code.toUpperCase()),
        );
        if (conflict) throw new Error(t.shopifyApp.campaignCodeConflict);

        setStatus(t.shopifyApp.campaignCreatingCode);
        const startsAt = zonedLocalToIso(working.sendAt, shop.timezone || "UTC");
        const endsAt = zonedLocalToIso(working.expiresAt, shop.timezone || "UTC");
        const discount = await callTool<DiscountResult>(workspaceId, "shopifyCreateDiscountCode", {
          code: working.code,
          title: `Brian - Restock - ${working.code}`,
          ...(working.discountKind === "percentage"
            ? { percentage: Number(working.discountValue) }
            : { amount: Number(working.discountValue).toFixed(2) }),
          startsAt,
          endsAt,
          ...(working.usageLimit ? { usageLimit: Number(working.usageLimit) } : {}),
          appliesOncePerCustomer: working.oncePerCustomer,
        });
        if (!discount.id) throw new Error(t.shopifyApp.campaignDiscountFailed);
        working = {
          ...working,
          discount: {
            id: discount.id,
            code: discount.code ?? working.code,
            status: discount.status,
            startsAt: discount.starts_at ?? startsAt,
            endsAt: discount.ends_at ?? endsAt,
          },
          updatedAt: Date.now(),
        };
        setDraft(working);
        writeCampaignStorage(workspaceId, shop.myshopify_domain, working, history);
      }

      const finalDraft: CampaignHistoryItem = {
        ...working,
        segment: working.segment!,
        discount: working.discount!,
        preparedAt: working.preparedAt ?? Date.now(),
        updatedAt: Date.now(),
      };
      const nextHistory = recordPreparedCampaign(history, finalDraft);
      setDraft(finalDraft);
      setHistory(nextHistory);
      writeCampaignStorage(workspaceId, shop.myshopify_domain, finalDraft, nextHistory);
      setStatus(t.shopifyApp.campaignPrepared);
    } catch (err) {
      setError(toolMessage(err));
      setDraft(working);
    } finally {
      setBusy(null);
    }
  }

  function startNewCampaign() {
    if (!shop) return;
    setDraft(createDefaultCampaignDraft(shop.timezone || "UTC", shop.primary_domain ?? ""));
    setError(null);
    setStatus(null);
    setCopied(null);
  }

  async function copyText(key: string, value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(key);
      window.setTimeout(() => setCopied((current) => (current === key ? null : current)), 1800);
    } catch {
      setError(t.shopifyApp.campaignCopyClipboardFailed);
    }
  }

  const selectedIds = useMemo(
    () => new Set(draft?.selectedProducts.map((product) => product.id) ?? []),
    [draft?.selectedProducts],
  );

  if (!draft || !shop || !products) {
    return (
      <div className="space-y-3">
        {error ? <Note tone="error">{error}</Note> : null}
        <Button variant="outline" size="sm" onClick={() => void loadStore()} disabled={busy === "load"}>
          <RefreshCw className="size-3.5" aria-hidden />
          {t.shopifyApp.retry}
        </Button>
      </div>
    );
  }

  const discountAdminUrl = `https://${shop.myshopify_domain}/admin/discounts`;
  const messagingUrl = `https://${shop.myshopify_domain}/admin/marketing`;
  const allChecklistReady =
    draft.checklist.preview &&
    draft.checklist.mobile &&
    (!draft.includeProductImage || draft.checklist.image) &&
    draft.checklist.schedule &&
    (draft.automaticDiscountDecision === "keep" || draft.checklist.automaticDiscount);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">{t.shopifyApp.campaignTitle}</h2>
          <p className="mt-1 max-w-3xl text-[13px] text-muted-foreground">
            {t.shopifyApp.campaignIntro}
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void loadStore()} disabled={busy !== null}>
          <RefreshCw className="size-3.5" aria-hidden />
          {t.shopifyApp.campaignRefreshStore}
        </Button>
      </div>
      {missingCampaignTools.length ? <Note tone="warn">{t.shopifyApp.campaignMissingAccess}</Note> : null}

      <CampaignSection number="1" title={t.shopifyApp.campaignProductsTitle}>
        <p className="text-[13px] text-muted-foreground">{t.shopifyApp.campaignProductsHelp}</p>
        {products.length === 0 ? <Note tone="muted">{t.shopifyApp.campaignNoInStockProducts}</Note> : null}
        {moreProducts ? (
          <div className="flex flex-wrap items-center gap-2">
            <Note>{t.shopifyApp.campaignProductLimit}</Note>
            <Button
              variant="outline"
              size="sm"
              disabled={busy !== null || !productCursor}
              onClick={() => void loadMoreProducts()}
            >
              {t.shopifyApp.campaignLoadMoreProducts}
            </Button>
          </div>
        ) : null}
        <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          {products.map((product) => (
            <label
              key={product.id}
              className={cn(choiceClass(selectedIds.has(product.id)), audienceLocked && "opacity-70")}
            >
              <div className="flex items-start gap-2">
                {product.imageUrl ? (
                  <img
                    src={product.imageUrl}
                    alt={product.imageAlt || product.title}
                    className="size-12 rounded-lg border border-border object-cover"
                  />
                ) : null}
                <Checkbox
                  checked={selectedIds.has(product.id)}
                  disabled={audienceLocked}
                  onCheckedChange={() => toggleProduct(product)}
                  aria-label={product.title}
                />
                <span className="min-w-0">
                  <span className="block truncate text-[13px] font-medium">{product.title}</span>
                  <span className="text-[12px] text-muted-foreground">
                    {format(t.shopifyApp.campaignInventoryCount, { count: product.totalInventory })}
                  </span>
                </span>
              </div>
            </label>
          ))}
        </div>
      </CampaignSection>

      <CampaignSection number="2" title={t.shopifyApp.campaignAudienceTitle}>
        <div className="grid gap-2 sm:grid-cols-2">
          <button
            type="button"
            disabled={audienceLocked}
            className={choiceClass(draft.audience === "all_subscribers")}
            onClick={() => updateDraft({ audience: "all_subscribers" }, { invalidateAudience: true })}
          >
            <span className="block text-[13px] font-medium">{t.shopifyApp.campaignAllSubscribers}</span>
            <span className="mt-1 block text-[12px] text-muted-foreground">
              {t.shopifyApp.campaignAllSubscribersHelp}
            </span>
          </button>
          <button
            type="button"
            disabled={audienceLocked}
            className={choiceClass(draft.audience === "product_buyers")}
            onClick={() => updateDraft({ audience: "product_buyers" }, { invalidateAudience: true })}
          >
            <span className="block text-[13px] font-medium">{t.shopifyApp.campaignPastBuyers}</span>
            <span className="mt-1 block text-[12px] text-muted-foreground">
              {t.shopifyApp.campaignPastBuyersHelp}
            </span>
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={busy !== null || audienceLocked || missingCampaignTools.length > 0}
            onClick={() => void previewAudience()}
          >
            {t.shopifyApp.campaignPreviewAudience}
          </Button>
          <span className="text-[12px] text-muted-foreground">{t.shopifyApp.campaignPrivacyNote}</span>
        </div>
        {draft.audienceCount !== undefined ? (
          <div className="max-w-xs">
            <Kpi label={t.shopifyApp.campaignEligibleSubscribers} value={draft.audienceCount.toLocaleString()} />
          </div>
        ) : null}
      </CampaignSection>

      <CampaignSection number="3" title={t.shopifyApp.campaignOfferTitle}>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <Field label={t.shopifyApp.campaignDiscountType}>
            <SearchableSelect
              value={draft.discountKind}
              disabled={offerLocked}
              onValueChange={(value) => updateDraft({ discountKind: value as ShopifyCampaignDraft["discountKind"] })}
              items={[
                { value: "percentage", label: t.shopifyApp.campaignPercentage },
                { value: "fixed", label: t.shopifyApp.campaignFixedAmount },
              ]}
            />
          </Field>
          <Field label={t.shopifyApp.campaignDiscountValue}>
            <input
              className={inputClass}
              value={draft.discountValue}
              inputMode="decimal"
              disabled={offerLocked}
              onChange={(event) => updateDraft({ discountValue: event.target.value })}
            />
          </Field>
          <Field label={t.shopifyApp.campaignCode}>
            <input
              className={inputClass}
              value={draft.code}
              disabled={offerLocked}
              onChange={(event) => updateDraft({ code: event.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, "") })}
            />
          </Field>
          <Field label={t.shopifyApp.campaignUsageLimit}>
            <input
              className={inputClass}
              value={draft.usageLimit}
              inputMode="numeric"
              disabled={offerLocked}
              placeholder={t.shopifyApp.campaignUnlimited}
              onChange={(event) => updateDraft({ usageLimit: event.target.value.replace(/\D/g, "") })}
            />
          </Field>
        </div>
        <label className="flex items-center gap-2 text-[13px]">
          <Checkbox
            checked={draft.oncePerCustomer}
            disabled={offerLocked}
            onCheckedChange={(checked) => updateDraft({ oncePerCustomer: checked })}
          />
          {t.shopifyApp.campaignOncePerCustomer}
        </label>
        <div className="grid gap-2 sm:grid-cols-2">
          <Field label={format(t.shopifyApp.campaignSendAt, { timezone: shop.timezone ?? "UTC" })}>
            <input
              type="datetime-local"
              className={inputClass}
              value={draft.sendAt}
              disabled={offerLocked}
              onChange={(event) => updateDraft({ sendAt: event.target.value })}
            />
          </Field>
          <Field label={format(t.shopifyApp.campaignExpiresAt, { timezone: shop.timezone ?? "UTC" })}>
            <input
              type="datetime-local"
              className={inputClass}
              value={draft.expiresAt}
              disabled={offerLocked}
              onChange={(event) => updateDraft({ expiresAt: event.target.value })}
            />
          </Field>
        </div>

        <div className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t.shopifyApp.campaignAutomaticDiscounts}
          </h3>
          {automaticDiscounts.length ? (
            <ul className="space-y-1 text-[12.5px] text-muted-foreground">
              {automaticDiscounts.map((discount) => (
                <li key={discount.id ?? discount.title}>
                  {discount.title ?? t.shopifyApp.campaignUnnamedDiscount}
                  {discount.ends_at ? ` (${discount.ends_at.slice(0, 10)})` : ""}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[12.5px] text-muted-foreground">{t.shopifyApp.campaignNoAutomaticDiscounts}</p>
          )}
          <div className="grid gap-2 sm:grid-cols-2">
            <button
              type="button"
              className={choiceClass(draft.automaticDiscountDecision === "keep")}
              onClick={() => updateDraft({ automaticDiscountDecision: "keep" })}
            >
              <span className="text-[13px] font-medium">{t.shopifyApp.campaignKeepDiscounts}</span>
            </button>
            <button
              type="button"
              className={choiceClass(draft.automaticDiscountDecision === "pause")}
              onClick={() => updateDraft({ automaticDiscountDecision: "pause" })}
            >
              <span className="text-[13px] font-medium">{t.shopifyApp.campaignPauseDiscounts}</span>
            </button>
          </div>
        </div>
      </CampaignSection>

      <CampaignSection number="4" title={t.shopifyApp.campaignMessageTitle}>
        <div className="flex flex-wrap items-end gap-2">
          <Field label={t.shopifyApp.campaignLanguage}>
            <SearchableSelect
              value={draft.language}
              onValueChange={(value) => updateDraft({ language: value as ShopifyCampaignDraft["language"] })}
              items={[
                { value: "en", label: t.shopifyApp.campaignEnglish },
                { value: "zh", label: t.shopifyApp.campaignChinese },
                { value: "bilingual", label: t.shopifyApp.campaignBilingual },
              ]}
              className="min-w-[220px]"
            />
          </Field>
          <Button variant="outline" size="sm" disabled={busy !== null} onClick={() => void generateCopy()}>
            <Sparkles className="size-3.5" aria-hidden />
            {t.shopifyApp.campaignDraftMessage}
          </Button>
        </div>
        <div className="grid gap-2 sm:grid-cols-2">
          <Field label={t.shopifyApp.campaignSubject}>
            <input className={inputClass} value={draft.subject} onChange={(event) => updateDraft({ subject: event.target.value })} />
          </Field>
          <Field label={t.shopifyApp.campaignPreviewText}>
            <input className={inputClass} value={draft.preview} onChange={(event) => updateDraft({ preview: event.target.value })} />
          </Field>
        </div>
        <Field label={t.shopifyApp.campaignBody}>
          <textarea rows={7} className={textAreaClass} value={draft.body} onChange={(event) => updateDraft({ body: event.target.value })} />
        </Field>
        <div className="grid gap-2 sm:grid-cols-2">
          <Field label={t.shopifyApp.campaignCtaLabel}>
            <input className={inputClass} value={draft.ctaLabel} onChange={(event) => updateDraft({ ctaLabel: event.target.value })} />
            <span className="text-[11.5px] text-muted-foreground">{t.shopifyApp.campaignCtaLabelHelp}</span>
          </Field>
          <Field label={t.shopifyApp.campaignCtaUrl}>
            <input className={inputClass} value={draft.ctaUrl} onChange={(event) => updateDraft({ ctaUrl: event.target.value })} />
            <span className="text-[11.5px] text-muted-foreground">{t.shopifyApp.campaignCtaUrlHelp}</span>
          </Field>
        </div>

        <div className="space-y-2">
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t.shopifyApp.campaignPhotoTitle}
            </h3>
            <p className="mt-1 text-[12px] text-muted-foreground">{t.shopifyApp.campaignPhotoHelp}</p>
          </div>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            <button
              type="button"
              className={choiceClass(!draft.includeProductImage)}
              aria-label={t.shopifyApp.campaignNoPhoto}
              onClick={() => updateDraft({
                includeProductImage: false,
                selectedImage: undefined,
                checklist: { ...draft.checklist, image: false },
              })}
            >
              <span className="block text-[13px] font-medium">{t.shopifyApp.campaignNoPhoto}</span>
              <span className="mt-1 block text-[12px] text-muted-foreground">
                {t.shopifyApp.campaignNoPhotoHelp}
              </span>
            </button>
            {draft.selectedProducts.filter((product) => product.imageUrl).map((product) => (
              <button
                type="button"
                key={product.id}
                className={cn(choiceClass(
                  draft.includeProductImage && draft.selectedImage?.productId === product.id,
                ), "flex items-center gap-3")}
                aria-label={format(t.shopifyApp.campaignUseProductPhoto, { product: product.title })}
                onClick={() => updateDraft({
                  includeProductImage: true,
                  selectedImage: productImage(product),
                  checklist: { ...draft.checklist, image: false },
                })}
              >
                <img
                  src={product.imageUrl}
                  alt={product.imageAlt || product.title}
                  className="size-16 shrink-0 rounded-lg border border-border object-cover"
                />
                <span className="min-w-0 text-[13px] font-medium">{product.title}</span>
              </button>
            ))}
          </div>
          {draft.selectedProducts.length > 0 && !draft.selectedProducts.some((product) => product.imageUrl) ? (
            <Note tone="muted">{t.shopifyApp.campaignNoProductPhotos}</Note>
          ) : null}
        </div>

        <div className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t.shopifyApp.campaignMessagePreviewTitle}
          </h3>
          <div
            aria-label={t.shopifyApp.campaignMessagePreviewTitle}
            className="overflow-hidden rounded-xl border border-border bg-muted/40 p-3 sm:p-5"
          >
            <div className="mx-auto max-w-xl overflow-hidden rounded-xl border border-border bg-background shadow-sm">
              <div className="border-b border-border px-4 py-3">
                <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {t.shopifyApp.campaignSubject}
                </p>
                <p className="mt-1 text-sm font-semibold">
                  {draft.subject || t.shopifyApp.campaignPreviewSubjectPlaceholder}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {draft.preview || t.shopifyApp.campaignPreviewTextPlaceholder}
                </p>
              </div>
              {draft.includeProductImage && draft.selectedImage ? (
                <img
                  src={draft.selectedImage.url}
                  alt={draft.selectedImage.alt}
                  className="aspect-[16/9] w-full object-cover"
                />
              ) : null}
              <div className="space-y-4 px-5 py-6 sm:px-8">
                <p className="whitespace-pre-wrap text-sm leading-6 text-foreground">
                  {draft.body || t.shopifyApp.campaignPreviewBodyPlaceholder}
                </p>
                <span className="inline-flex min-h-10 items-center justify-center rounded-lg bg-foreground px-5 py-2 text-sm font-semibold text-background">
                  {draft.ctaLabel || t.shopifyApp.campaignPreviewButtonPlaceholder}
                </span>
                <p className="break-all text-[11px] text-muted-foreground">
                  {draft.ctaUrl || t.shopifyApp.campaignPreviewUrlPlaceholder}
                </p>
              </div>
            </div>
          </div>
        </div>
      </CampaignSection>

      <CampaignSection number="5" title={t.shopifyApp.campaignReviewTitle}>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          <Kpi label={t.shopifyApp.campaignSelectedProducts} value={draft.selectedProducts.length} />
          <Kpi label={t.shopifyApp.campaignEligibleSubscribers} value={draft.audienceCount?.toLocaleString() ?? "-"} />
          <Kpi label={t.shopifyApp.campaignCode} value={draft.code || "-"} />
          <Kpi label={t.shopifyApp.campaignExpiry} value={draft.expiresAt || "-"} />
        </div>
        {!prepared ? (
          <>
            <Note>{t.shopifyApp.campaignPrepareWarning}</Note>
            <Button disabled={busy !== null || missingCampaignTools.length > 0} onClick={() => void prepareCampaign()}>
              <Megaphone className="size-4" aria-hidden />
              {draft.segment ? t.shopifyApp.campaignRetryPreparation : t.shopifyApp.campaignPrepare}
            </Button>
          </>
        ) : null}
      </CampaignSection>

      {prepared ? (
        <CampaignSection number="6" title={t.shopifyApp.campaignHandoffTitle}>
          <div className="flex items-start gap-2 rounded-xl border border-emerald-500/35 bg-emerald-500/10 p-3">
            <CheckCircle2 className="mt-0.5 size-4 text-emerald-600" aria-hidden />
            <div>
              <p className="text-[13px] font-medium">{t.shopifyApp.campaignPrepared}</p>
              <p className="text-[12px] text-muted-foreground">{t.shopifyApp.campaignHandoffHelp}</p>
            </div>
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            <CopyField label={t.shopifyApp.campaignSegment} value={draft.segment!.name} copyKey="segment" copied={copied} onCopy={copyText} copyLabel={t.shopifyApp.copy} copiedLabel={t.shopifyApp.copied} />
            <CopyField label={t.shopifyApp.campaignEligibleSubscribers} value={String(draft.audienceCount ?? 0)} copyKey="audience" copied={copied} onCopy={copyText} copyLabel={t.shopifyApp.copy} copiedLabel={t.shopifyApp.copied} />
            <CopyField label={t.shopifyApp.campaignCode} value={draft.discount!.code} copyKey="code" copied={copied} onCopy={copyText} copyLabel={t.shopifyApp.copy} copiedLabel={t.shopifyApp.copied} />
            <CopyField label={t.shopifyApp.campaignExactExpiry} value={draft.discount!.endsAt} copyKey="expiry" copied={copied} onCopy={copyText} copyLabel={t.shopifyApp.copy} copiedLabel={t.shopifyApp.copied} />
            <CopyField label={t.shopifyApp.campaignSubject} value={draft.subject} copyKey="subject" copied={copied} onCopy={copyText} copyLabel={t.shopifyApp.copy} copiedLabel={t.shopifyApp.copied} />
            <CopyField label={t.shopifyApp.campaignPreviewText} value={draft.preview} copyKey="preview" copied={copied} onCopy={copyText} copyLabel={t.shopifyApp.copy} copiedLabel={t.shopifyApp.copied} />
          </div>
          <CopyField label={t.shopifyApp.campaignBody} value={draft.body} copyKey="body" copied={copied} onCopy={copyText} copyLabel={t.shopifyApp.copy} copiedLabel={t.shopifyApp.copied} multiline />
          <div className="grid gap-2 sm:grid-cols-2">
            <CopyField label={t.shopifyApp.campaignCtaLabel} value={draft.ctaLabel} copyKey="cta" copied={copied} onCopy={copyText} copyLabel={t.shopifyApp.copy} copiedLabel={t.shopifyApp.copied} />
            <CopyField label={t.shopifyApp.campaignCtaUrl} value={draft.ctaUrl} copyKey="url" copied={copied} onCopy={copyText} copyLabel={t.shopifyApp.copy} copiedLabel={t.shopifyApp.copied} />
          </div>
          {draft.includeProductImage && draft.selectedImage ? (
            <div className="grid gap-3 rounded-xl border border-border bg-background p-3 sm:grid-cols-[160px_1fr]">
              <img
                src={draft.selectedImage.url}
                alt={draft.selectedImage.alt}
                className="aspect-square w-full rounded-lg border border-border object-cover"
              />
              <div className="space-y-2">
                <CopyField
                  label={t.shopifyApp.campaignPhotoUrl}
                  value={draft.selectedImage.url}
                  copyKey="photo"
                  copied={copied}
                  onCopy={copyText}
                  copyLabel={t.shopifyApp.copy}
                  copiedLabel={t.shopifyApp.copied}
                />
                <a
                  href={draft.selectedImage.url}
                  target="_blank"
                  rel="noreferrer"
                  className={buttonVariants({ variant: "outline", size: "sm" })}
                >
                  {t.shopifyApp.campaignOpenPhoto}<ExternalLink className="size-3.5" aria-hidden />
                </a>
              </div>
            </div>
          ) : null}

          <div className="flex flex-wrap gap-2">
            <a href={draft.segment!.adminUrl} target="_blank" rel="noreferrer" className={buttonVariants({ variant: "outline", size: "sm" })}>
              {t.shopifyApp.campaignOpenSegment}<ExternalLink className="size-3.5" aria-hidden />
            </a>
            <a href={discountAdminUrl} target="_blank" rel="noreferrer" className={buttonVariants({ variant: "outline", size: "sm" })}>
              {t.shopifyApp.campaignOpenDiscounts}<ExternalLink className="size-3.5" aria-hidden />
            </a>
            <a href={messagingUrl} target="_blank" rel="noreferrer" className={buttonVariants({ size: "sm" })}>
              {t.shopifyApp.campaignOpenMessaging}<ExternalLink className="size-3.5" aria-hidden />
            </a>
          </div>

          <div className="space-y-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {t.shopifyApp.campaignLaunchChecklist}
            </h3>
            <ChecklistRow checked={draft.checklist.preview} onChange={(checked) => updateDraft({ checklist: { ...draft.checklist, preview: checked } })} label={t.shopifyApp.campaignChecklistPreview} />
            <ChecklistRow checked={draft.checklist.mobile} onChange={(checked) => updateDraft({ checklist: { ...draft.checklist, mobile: checked } })} label={t.shopifyApp.campaignChecklistMobile} />
            {draft.includeProductImage ? (
              <ChecklistRow checked={draft.checklist.image} onChange={(checked) => updateDraft({ checklist: { ...draft.checklist, image: checked } })} label={t.shopifyApp.campaignChecklistImage} />
            ) : null}
            {draft.automaticDiscountDecision === "pause" ? (
              <ChecklistRow checked={draft.checklist.automaticDiscount} onChange={(checked) => updateDraft({ checklist: { ...draft.checklist, automaticDiscount: checked } })} label={t.shopifyApp.campaignChecklistAutomatic} />
            ) : null}
            <ChecklistRow checked={draft.checklist.schedule} onChange={(checked) => updateDraft({ checklist: { ...draft.checklist, schedule: checked } })} label={t.shopifyApp.campaignChecklistSchedule} />
          </div>
          {!allChecklistReady ? <Note>{t.shopifyApp.campaignChecklistIncomplete}</Note> : <Note tone="muted">{t.shopifyApp.campaignChecklistReady}</Note>}

          <Button variant="outline" size="sm" onClick={startNewCampaign}>
            {t.shopifyApp.campaignStartNew}
          </Button>
        </CampaignSection>
      ) : null}

      {history.length ? (
        <CampaignSection number="" title={t.shopifyApp.campaignRecentPackages}>
          <p className="text-[12px] text-muted-foreground">{t.shopifyApp.thisBrowserOnly}</p>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {history.map((item) => (
              <button
                type="button"
                key={item.discount.id}
                className={choiceClass(item.discount.id === draft.discount?.id)}
                onClick={() => setDraft(item)}
              >
                <span className="block text-[13px] font-medium">{item.discount.code}</span>
                <span className="text-[11.5px] text-muted-foreground">
                  {new Date(item.preparedAt).toLocaleString()}
                </span>
              </button>
            ))}
          </div>
        </CampaignSection>
      ) : null}

      {status ? <Note tone={prepared ? "muted" : "warn"}>{status}</Note> : null}
      {error ? <Note tone="error">{error}</Note> : null}
    </div>
  );
}

function CampaignSection({
  number,
  title,
  children,
}: {
  number: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-3 rounded-xl border border-border bg-card/40 p-3">
      <h2 className="flex items-center gap-2 text-sm font-semibold">
        {number ? (
          <span className="flex size-5 items-center justify-center rounded-full bg-primary/10 text-[11px] text-primary">
            {number}
          </span>
        ) : null}
        {title}
      </h2>
      {children}
    </section>
  );
}

function ChecklistRow({ checked, onChange, label }: { checked: boolean; onChange: (checked: boolean) => void; label: string }) {
  return (
    <label className="flex items-center gap-2 text-[13px]">
      <Checkbox checked={checked} onCheckedChange={onChange} />
      {label}
    </label>
  );
}

function CopyField({
  label,
  value,
  copyKey,
  copied,
  onCopy,
  copyLabel,
  copiedLabel,
  multiline = false,
}: {
  label: string;
  value: string;
  copyKey: string;
  copied: string | null;
  onCopy: (key: string, value: string) => Promise<void>;
  copyLabel: string;
  copiedLabel: string;
  multiline?: boolean;
}) {
  return (
    <div className="rounded-xl border border-border bg-background p-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{label}</span>
        <Button variant="ghost" size="xs" onClick={() => void onCopy(copyKey, value)}>
          <Copy className="size-3" aria-hidden />
          {copied === copyKey ? copiedLabel : copyLabel}
        </Button>
      </div>
      <p className={cn("mt-1 text-[13px]", multiline && "whitespace-pre-wrap")}>{value || "-"}</p>
    </div>
  );
}
