"use client";

/**
 * useGenerateFromBrain — the shared "fill this blueprint from the brain" flow:
 * estimate the credit cost (cheap pre-flight), confirm cost + output shape
 * with the subject prompt, run the fill, then navigate to the produced page.
 * Credit-metered on the server (POST .../generate charges a surcharge on
 * success). One implementation for BOTH surfaces that offer the action — the
 * Blueprints library row and the blueprint detail editor — so the
 * preflight-confirmation invariant can't drift between them.
 *
 * Spec: docs/architecture/brain/structural-synthesis.md -> "Generate is
 * user-surfaced".
 *
 * [COMP:web/blueprints-library]
 */

import { useCallback } from "react";
import { useRouter } from "next/navigation";
import { useT, format } from "@/lib/i18n/client";
import {
  estimateBlueprintGenerate,
  generateBlueprintFromBrain,
} from "@/lib/api/views";
import { docPagePath } from "@/lib/doc-page-url";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { promptDialog } from "@/components/ui/prompt-dialog";

export function useGenerateFromBrain(workspaceId: string) {
  const t = useT();
  const copy = t.brainPage.blueprints;
  const router = useRouter();

  return useCallback(
    async (blueprint: { id: string; name: string }) => {
      let credits: number;
      try {
        const est = await estimateBlueprintGenerate(workspaceId, blueprint.id);
        credits = est.surchargeCredits;
      } catch {
        await confirmDialog({
          title: copy.generateErrorTitle,
          description: copy.generateEstimateError,
          confirmLabel: copy.generateErrorOk,
        });
        return;
      }
      const subject = await promptDialog({
        title: copy.generateTitle,
        // Cost + what the run produces (preflight-confirmation invariant: the
        // confirm states both the price and the output shape — record + page).
        description: `${
          credits === 1
            ? copy.generateCostOne
            : format(copy.generateCostMany, { count: credits })
        } ${copy.generateRendersPage}`,
        placeholder: copy.generateSubjectPlaceholder,
        confirmLabel: copy.generateConfirm,
        cancelLabel: copy.generateCancel,
      });
      if (!subject) return;
      try {
        const result = await generateBlueprintFromBrain(workspaceId, blueprint.id, {
          subject,
          requestId: crypto.randomUUID(),
        });
        if (result.pageId) {
          router.push(docPagePath(workspaceId, result.pageId));
        } else {
          await confirmDialog({
            title: copy.generateErrorTitle,
            description: copy.generateNoPage,
            confirmLabel: copy.generateErrorOk,
          });
        }
      } catch (err) {
        const outOfCredits = String(err).includes("HTTP 402");
        await confirmDialog({
          title: copy.generateErrorTitle,
          description: outOfCredits ? copy.generateCreditLimit : copy.generateFailed,
          confirmLabel: copy.generateErrorOk,
        });
      }
    },
    [workspaceId, copy, router],
  );
}
