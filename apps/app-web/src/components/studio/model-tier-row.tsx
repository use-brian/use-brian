"use client";

/**
 * One labelled model-tier picker row (standard / pro / max).
 *
 * Extracted from `assistant-detail.tsx` by migration 416, which split the
 * assistant's model tiers along the axis that actually matters - whether a
 * surface has a `channel_assistants` routing row to carry its tier:
 *
 *   - Settings tab -> "Default model tier" (`default_model_alias`): the
 *     surfaces with no routing row (the hosted official Telegram / WhatsApp
 *     bots), plus the seed for a newly connected channel.
 *   - API tab -> "Model tier" (`api_model_alias`): owner-paid public traffic,
 *     the `sk_live_` API and the `/c/<token>` chat link.
 *
 * A connected channel's own tier is not edited here at all - it lives on the
 * routing row in Studio > Channels.
 *
 * Hosted plan access matches the backend resolver (`resolveModel` clamps a
 * tier the plan doesn't allow, so the gate here is UX, not enforcement). OSS
 * has no plans, so every built-in tier stays selectable.
 *
 * `plan` is the *workspace* plan (billing is per-workspace, migration 143);
 * callers read it from the workspace context. The legacy `users.plan` cookie
 * field is stale post-migration and would lock out members of a paid
 * workspace whose own user row is still 'free'.
 *
 * [COMP:app-web/model-tier-row]
 */

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useT } from "@/lib/i18n/client";
import { isHostedEdition } from "@/lib/edition";
import { modelTierPlanGateApplies } from "@/lib/plan-gate";

export type ModelAlias = "standard" | "pro" | "max";

export function isModelAlias(v: unknown): v is ModelAlias {
  return v === "standard" || v === "pro" || v === "max";
}

export function ModelTierRow({
  label,
  value,
  onChange,
  disabled,
  saving,
  plan,
}: {
  label: string;
  value: ModelAlias;
  onChange: (v: ModelAlias) => void;
  disabled: boolean;
  saving: boolean;
  plan: string;
}) {
  const t = useT();
  const edition = isHostedEdition() ? "hosted" : "oss";
  const proDisabled = modelTierPlanGateApplies(edition, plan, "pro");
  const maxDisabled = modelTierPlanGateApplies(edition, plan, "max");
  return (
    <div className="px-5 py-3 flex items-center justify-between gap-3">
      <span className="text-[14px] font-medium text-foreground">{label}</span>
      <div className="flex items-center gap-2">
        {saving && (
          <span className="text-[11px] text-muted-foreground animate-pulse">
            {t.assistant.modelSelector.saving}
          </span>
        )}
        <Select
          value={value}
          onValueChange={(v) => {
            if (isModelAlias(v) && v !== value) onChange(v);
          }}
          disabled={disabled}
        >
          <SelectTrigger
            size="sm"
            className="text-xs gap-1.5 bg-muted/50 hover:bg-muted border-transparent h-7 w-auto min-w-24"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent side="bottom" align="end" alignItemWithTrigger={false} className="w-auto min-w-52">
            <SelectItem value="standard">
              <div className="flex flex-col gap-0.5 py-0.5">
                <span className="text-sm font-medium">{t.assistant.modelSelector.standard}</span>
                <span className="text-[11px] text-muted-foreground">{t.assistant.modelSelector.standardDesc}</span>
              </div>
            </SelectItem>
            <SelectItem value="pro" disabled={proDisabled}>
              <div className="flex flex-col gap-0.5 py-0.5">
                <div className="flex items-center gap-1.5">
                  <span className="text-sm font-medium">{t.assistant.modelSelector.pro}</span>
                  {proDisabled && (
                    <span className="rounded-sm bg-muted px-1 py-px text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
                      {t.assistant.modelSelector.proPlanBadge}
                    </span>
                  )}
                </div>
                <span className="text-[11px] text-muted-foreground">{t.assistant.modelSelector.proDesc}</span>
              </div>
            </SelectItem>
            <SelectItem value="max" disabled={maxDisabled}>
              <div className="flex flex-col gap-0.5 py-0.5">
                <div className="flex items-center gap-1.5">
                  <span className="text-sm font-medium">{t.assistant.modelSelector.max}</span>
                  {maxDisabled && (
                    <span className="rounded-sm bg-muted px-1 py-px text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
                      {t.assistant.modelSelector.maxPlanBadge}
                    </span>
                  )}
                </div>
                <span className="text-[11px] text-muted-foreground">{t.assistant.modelSelector.maxDesc}</span>
              </div>
            </SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
