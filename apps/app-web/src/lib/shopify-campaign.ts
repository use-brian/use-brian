/**
 * PII-free local state for the Shopify restock campaign builder.
 *
 * A campaign draft is configuration, aggregate counts and Shopify resource
 * ids. It never contains customer rows, ids, names or email addresses. The
 * store key includes workspace + shop because one browser can operate more
 * than one shop through the same workspace over time.
 *
 * [COMP:app-web/shopify-campaign]
 */

type CampaignAudience = "all_subscribers" | "product_buyers";
type CampaignDiscountKind = "percentage" | "fixed";
type CampaignLanguage = "en" | "zh" | "bilingual";
type AutomaticDiscountDecision = "keep" | "pause";

export type CampaignProduct = {
  id: string;
  title: string;
  totalInventory: number;
  imageUrl?: string;
  imageAlt?: string;
};

export const CAMPAIGN_IMAGE_MIME = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const;

export const MAX_CAMPAIGN_IMAGE_BYTES = 20 * 1024 * 1024;

export type CampaignProductImage = {
  kind: "product";
  productId: string;
  url: string;
  alt: string;
};

export type CampaignUploadImage = {
  kind: "upload";
  fileId: string;
  mimeType: (typeof CAMPAIGN_IMAGE_MIME)[number];
  sizeBytes: number;
};

export type CampaignImage = CampaignProductImage | CampaignUploadImage;

type PreparedCampaignSegment = {
  id: string;
  name: string;
  query: string;
  adminUrl: string;
};

type PreparedCampaignDiscount = {
  id: string;
  code: string;
  status?: string;
  startsAt: string;
  endsAt: string;
};

type CampaignChecklist = {
  preview: boolean;
  mobile: boolean;
  image: boolean;
  schedule: boolean;
  automaticDiscount: boolean;
};

export type ShopifyCampaignDraft = {
  version: 1;
  selectedProducts: CampaignProduct[];
  audience: CampaignAudience;
  audienceCount?: number;
  audienceQuery?: string;
  discountKind: CampaignDiscountKind;
  discountValue: string;
  code: string;
  usageLimit: string;
  oncePerCustomer: boolean;
  sendAt: string;
  expiresAt: string;
  automaticDiscountDecision: AutomaticDiscountDecision;
  language: CampaignLanguage;
  subject: string;
  preview: string;
  body: string;
  ctaLabel: string;
  ctaUrl: string;
  includeProductImage: boolean;
  selectedImage?: CampaignImage;
  segment?: PreparedCampaignSegment;
  discount?: PreparedCampaignDiscount;
  preparedAt?: number;
  checklist: CampaignChecklist;
  updatedAt: number;
};

export type CampaignHistoryItem = ShopifyCampaignDraft & {
  segment: PreparedCampaignSegment;
  discount: PreparedCampaignDiscount;
  preparedAt: number;
};

type CampaignStorage = {
  version: 1;
  draft: ShopifyCampaignDraft;
  history: CampaignHistoryItem[];
};

const MAX_CAMPAIGN_HISTORY = 5;

const storageKey = (workspaceId: string, shopDomain: string) =>
  `shopify:campaign:${workspaceId}:${shopDomain.toLowerCase()}`;

/** `YYYY-MM-DDTHH:mm` in an IANA timezone, suitable for datetime-local. */
function localDateTimeInZone(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((entry) => entry.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}`;
}

/** Add calendar days to a datetime-local value without applying browser TZ. */
export function addLocalDays(value: string, days: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) return value;
  const date = new Date(Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]) + days,
    Number(match[4]),
    Number(match[5]),
  ));
  return date.toISOString().slice(0, 16);
}

/**
 * Interpret a datetime-local value in the shop timezone and return an instant.
 * Iteration handles offset changes near DST boundaries; a nonexistent local
 * time is rejected instead of silently shifting the campaign window.
 */
export function zonedLocalToIso(value: string, timeZone: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new Error("invalid_local_datetime");
  const wanted = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
  );
  let candidate = wanted;
  for (let i = 0; i < 3; i += 1) {
    const observedLocal = localDateTimeInZone(new Date(candidate), timeZone);
    const observed = Date.parse(`${observedLocal}:00Z`);
    candidate += wanted - observed;
  }
  if (localDateTimeInZone(new Date(candidate), timeZone) !== value) {
    throw new Error("invalid_local_datetime");
  }
  return new Date(candidate).toISOString();
}

export function createDefaultCampaignDraft(
  timeZone: string,
  primaryDomain = "",
  now = new Date(),
): ShopifyCampaignDraft {
  const nextHour = new Date(now.getTime() + 60 * 60 * 1000);
  nextHour.setUTCMinutes(0, 0, 0);
  const sendAt = localDateTimeInZone(nextHour, timeZone);
  return {
    version: 1,
    selectedProducts: [],
    audience: "all_subscribers",
    discountKind: "percentage",
    discountValue: "10",
    code: "RESTOCK10",
    usageLimit: "",
    oncePerCustomer: true,
    sendAt,
    expiresAt: addLocalDays(sendAt, 7),
    automaticDiscountDecision: "keep",
    language: "en",
    subject: "",
    preview: "",
    body: "",
    ctaLabel: "",
    ctaUrl: primaryDomain ? `https://${primaryDomain}` : "",
    includeProductImage: true,
    checklist: {
      preview: false,
      mobile: false,
      image: false,
      schedule: false,
      automaticDiscount: false,
    },
    updatedAt: now.getTime(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function normalizedHttpUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? value : undefined;
  } catch {
    return undefined;
  }
}

function normalizeDraft(
  value: unknown,
  fallback: ShopifyCampaignDraft,
): ShopifyCampaignDraft {
  if (!isRecord(value) || value.version !== 1) return fallback;
  const candidate = value as Partial<ShopifyCampaignDraft>;
  const selectedProducts = Array.isArray(value.selectedProducts)
    ? value.selectedProducts.flatMap((item): CampaignProduct[] => {
        if (
          !isRecord(item) ||
          typeof item.id !== "string" ||
          typeof item.title !== "string" ||
          typeof item.totalInventory !== "number"
        ) return [];
        const imageUrl = normalizedHttpUrl(item.imageUrl);
        return [{
          id: item.id,
          title: item.title,
          totalInventory: item.totalInventory,
          ...(imageUrl ? { imageUrl } : {}),
          ...(typeof item.imageAlt === "string" ? { imageAlt: item.imageAlt } : {}),
        }];
      })
    : [];
  const checklist = isRecord(value.checklist) ? value.checklist : {};
  const segment = isRecord(value.segment) &&
    typeof value.segment.id === "string" &&
    typeof value.segment.name === "string" &&
    typeof value.segment.query === "string" &&
    typeof value.segment.adminUrl === "string"
    ? {
        id: value.segment.id,
        name: value.segment.name,
        query: value.segment.query,
        adminUrl: value.segment.adminUrl,
      }
    : undefined;
  const discount = isRecord(value.discount) &&
    typeof value.discount.id === "string" &&
    typeof value.discount.code === "string" &&
    typeof value.discount.startsAt === "string" &&
    typeof value.discount.endsAt === "string"
    ? {
        id: value.discount.id,
        code: value.discount.code,
        ...(typeof value.discount.status === "string" ? { status: value.discount.status } : {}),
        startsAt: value.discount.startsAt,
        endsAt: value.discount.endsAt,
      }
    : undefined;
  const rawSelectedImage = isRecord(value.selectedImage) ? value.selectedImage : undefined;
  const selectedImageUrl = normalizedHttpUrl(rawSelectedImage?.url);
  let selectedImage: CampaignImage | undefined;
  if (
    rawSelectedImage?.kind === "upload" &&
    typeof rawSelectedImage.fileId === "string" &&
    rawSelectedImage.fileId.length > 0 &&
    rawSelectedImage.fileId.length <= 128 &&
    typeof rawSelectedImage.mimeType === "string" &&
    (CAMPAIGN_IMAGE_MIME as readonly string[]).includes(rawSelectedImage.mimeType) &&
    typeof rawSelectedImage.sizeBytes === "number" &&
    Number.isInteger(rawSelectedImage.sizeBytes) &&
    rawSelectedImage.sizeBytes > 0 &&
    rawSelectedImage.sizeBytes <= MAX_CAMPAIGN_IMAGE_BYTES
  ) {
    selectedImage = {
      kind: "upload",
      fileId: rawSelectedImage.fileId,
      mimeType: rawSelectedImage.mimeType as CampaignUploadImage["mimeType"],
      sizeBytes: rawSelectedImage.sizeBytes,
    };
  } else if (
    rawSelectedImage &&
    (rawSelectedImage.kind === undefined || rawSelectedImage.kind === "product") &&
    typeof rawSelectedImage.productId === "string" &&
    selectedImageUrl &&
    selectedProducts.some((product) => product.id === rawSelectedImage.productId)
  ) {
    // `kind` was added after product-photo selection shipped. Treat the old
    // safe shape as a product image so prepared packages stay usable.
    selectedImage = {
      kind: "product",
      productId: rawSelectedImage.productId,
      url: selectedImageUrl,
      alt: typeof rawSelectedImage.alt === "string" ? rawSelectedImage.alt : "",
    };
  }
  // Drafts saved before the photo picker existed are text-only packages.
  // New drafts write this decision explicitly, so old prepared history does
  // not become invalid merely by being opened after the feature ships.
  const includeProductImage = candidate.includeProductImage === true;
  return {
    version: 1,
    selectedProducts,
    audience: candidate.audience === "product_buyers" ? "product_buyers" : "all_subscribers",
    ...(typeof candidate.audienceCount === "number" ? { audienceCount: candidate.audienceCount } : {}),
    ...(typeof candidate.audienceQuery === "string" ? { audienceQuery: candidate.audienceQuery } : {}),
    discountKind: candidate.discountKind === "fixed" ? "fixed" : "percentage",
    discountValue: typeof candidate.discountValue === "string" ? candidate.discountValue : fallback.discountValue,
    code: typeof candidate.code === "string" ? candidate.code : fallback.code,
    usageLimit: typeof candidate.usageLimit === "string" ? candidate.usageLimit : fallback.usageLimit,
    oncePerCustomer: candidate.oncePerCustomer !== false,
    sendAt: typeof candidate.sendAt === "string" ? candidate.sendAt : fallback.sendAt,
    expiresAt: typeof candidate.expiresAt === "string" ? candidate.expiresAt : fallback.expiresAt,
    automaticDiscountDecision: candidate.automaticDiscountDecision === "pause" ? "pause" : "keep",
    language: candidate.language === "zh" || candidate.language === "bilingual" ? candidate.language : "en",
    subject: typeof candidate.subject === "string" ? candidate.subject : "",
    preview: typeof candidate.preview === "string" ? candidate.preview : "",
    body: typeof candidate.body === "string" ? candidate.body : "",
    ctaLabel: typeof candidate.ctaLabel === "string" ? candidate.ctaLabel : "",
    ctaUrl: typeof candidate.ctaUrl === "string" ? candidate.ctaUrl : fallback.ctaUrl,
    includeProductImage,
    ...(includeProductImage && selectedImage ? { selectedImage } : {}),
    ...(segment ? { segment } : {}),
    ...(discount ? { discount } : {}),
    ...(typeof candidate.preparedAt === "number" ? { preparedAt: candidate.preparedAt } : {}),
    checklist: {
      preview: checklist.preview === true,
      mobile: checklist.mobile === true,
      image: checklist.image === true,
      schedule: checklist.schedule === true,
      automaticDiscount: checklist.automaticDiscount === true,
    },
    updatedAt: typeof candidate.updatedAt === "number" ? candidate.updatedAt : fallback.updatedAt,
  };
}

export function readCampaignStorage(
  workspaceId: string,
  shopDomain: string,
  fallback: ShopifyCampaignDraft,
): CampaignStorage {
  if (typeof window === "undefined" || !workspaceId || !shopDomain) {
    return { version: 1, draft: fallback, history: [] };
  }
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(storageKey(workspaceId, shopDomain)) ?? "null");
    if (!isRecord(parsed) || parsed.version !== 1) {
      return { version: 1, draft: fallback, history: [] };
    }
    const draft = normalizeDraft(parsed.draft, fallback);
    const history = Array.isArray(parsed.history)
      ? parsed.history
          .map((item) => normalizeDraft(item, fallback))
          .filter((item): item is CampaignHistoryItem =>
            !!item.segment?.id && !!item.discount?.id && typeof item.preparedAt === "number",
          )
          .slice(0, MAX_CAMPAIGN_HISTORY)
      : [];
    return { version: 1, draft, history };
  } catch {
    return { version: 1, draft: fallback, history: [] };
  }
}

export function writeCampaignStorage(
  workspaceId: string,
  shopDomain: string,
  draft: ShopifyCampaignDraft,
  history: CampaignHistoryItem[],
): void {
  if (typeof window === "undefined" || !workspaceId || !shopDomain) return;
  try {
    const safeDraft = normalizeDraft(draft, draft);
    const safeHistory = history
      .map((item) => normalizeDraft(item, safeDraft))
      .filter((item): item is CampaignHistoryItem =>
        !!item.segment?.id && !!item.discount?.id && typeof item.preparedAt === "number",
      )
      .slice(0, MAX_CAMPAIGN_HISTORY);
    window.localStorage.setItem(
      storageKey(workspaceId, shopDomain),
      JSON.stringify({ version: 1, draft: safeDraft, history: safeHistory }),
    );
  } catch {
    // Campaign work remains usable in memory when storage is disabled.
  }
}

export function recordPreparedCampaign(
  history: CampaignHistoryItem[],
  draft: CampaignHistoryItem,
): CampaignHistoryItem[] {
  return [draft, ...history.filter((item) => item.discount.id !== draft.discount.id)]
    .slice(0, MAX_CAMPAIGN_HISTORY);
}
