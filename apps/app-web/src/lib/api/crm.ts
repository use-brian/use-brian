/**
 * CRM operator-surface SDK — the flat CRM read behind `/w/[id]/crm`
 * (`GET /api/brain/crm`, [COMP:brain/crm-list-http]): every live deal /
 * contact / company the viewer can see, one payload, 500/kind cap, full
 * operator fields. The client joins display names by id (`crm-view.ts`).
 * Mutations reuse the existing brain-inbox adjust wire (`adjustBrainRow`
 * in `lib/api/brain-inbox.ts`) — the CRM-typed fields ride the same
 * endpoint (crm.md → "Operator surface"); stage changes route through
 * `setDealStage` server-side.
 *
 * Spec: docs/architecture/features/crm.md → "Operator surface".
 * [COMP:app-web/crm-surface]
 */

import { authFetch } from "@/lib/auth-fetch";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export type DealStage =
  | "lead"
  | "qualified"
  | "proposal"
  | "negotiation"
  | "won"
  | "lost";

/** The six locked stages, pipeline order (crm.md decision 2). */
export const DEAL_STAGES: DealStage[] = [
  "lead",
  "qualified",
  "proposal",
  "negotiation",
  "won",
  "lost",
];

/** The four working-pipeline stages — the board's columns. */
export const OPEN_STAGES: DealStage[] = [
  "lead",
  "qualified",
  "proposal",
  "negotiation",
];

export const CLOSED_STAGES: DealStage[] = ["won", "lost"];

export function isOpenStage(stage: DealStage): boolean {
  return stage !== "won" && stage !== "lost";
}

/** One flat deal row off `GET /api/brain/crm`. */
export type CrmDealRow = {
  id: string;
  /** The deal entity's display name (e.g. "Deal - Acme"). */
  name: string;
  stage: DealStage;
  amount: number | null;
  /** Calendar date `YYYY-MM-DD`, or null (crm.md decision 4). */
  closeDate: string | null;
  contactId: string | null;
  companyId: string | null;
  /** ISO timestamp. */
  updatedAt: string;
};

export type CrmContactRow = {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  companyId: string | null;
  tags: string[];
  /** ISO timestamp. */
  updatedAt: string;
};

export type CrmCompanyRow = {
  id: string;
  name: string;
  domain: string | null;
  tags: string[];
  /** ISO timestamp. */
  updatedAt: string;
};

export type CrmData = {
  deals: CrmDealRow[];
  contacts: CrmContactRow[];
  companies: CrmCompanyRow[];
};

export async function fetchWorkspaceCrm(workspaceId: string): Promise<CrmData> {
  const res = await authFetch(
    `${API_URL}/api/brain/crm?workspaceId=${encodeURIComponent(workspaceId)}`,
  );
  if (!res.ok) throw new Error(`Failed to load CRM (${res.status})`);
  const body = (await res.json()) as Partial<CrmData>;
  return {
    deals: body.deals ?? [],
    contacts: body.contacts ?? [],
    companies: body.companies ?? [],
  };
}
