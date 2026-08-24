"use client";

/** One narrow-screen overflow for every CRM action displaced from the top bar. [COMP:app-web/crm-responsive] */

import { useState } from "react";
import { BarChart3, MoreHorizontal, Settings2 } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useT } from "@/lib/i18n/client";
import type { CrmConfig, CrmData } from "@/lib/api/crm";
import type { CrmSection } from "@/lib/crm-view";
import { CrmActions, type CrmActionDialog } from "./crm-actions";
import { CrmSavedViewMenuItems } from "./crm-saved-views";

export function CrmMobileActions({
  workspaceId,
  role,
  section,
  data,
  config,
  currentSearch,
  onApplySearch,
  onChanged,
  onCreated,
  onPipeline,
  onReports,
  onConfig,
}: {
  workspaceId: string;
  role: string | null | undefined;
  section: CrmSection;
  data: CrmData | null;
  config: CrmConfig | null;
  currentSearch: string;
  onApplySearch: (search: string) => void;
  onChanged: () => void;
  onCreated: (record: { id: string; kind: "deal" | "contact" | "company" }) => void | Promise<void>;
  onPipeline: (pipelineId: string) => void;
  onReports: () => void;
  onConfig: () => void;
}) {
  const t = useT().crmPage.r2;
  const [actionDialog, setActionDialog] = useState<CrmActionDialog>(null);
  return (
    <><DropdownMenu>
      <DropdownMenuTrigger
        data-crm-mobile-actions
        className="inline-flex size-7 items-center justify-center rounded-md text-sidebar-foreground/70 hover:bg-sidebar-accent sm:hidden"
        aria-label={t.crmActions}
      >
        <MoreHorizontal className="size-4" aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-60 sm:hidden">
        <CrmActions
          mobileMenu
          renderDialogs={false}
          activeDialog={actionDialog}
          onDialogChange={setActionDialog}
          workspaceId={workspaceId}
          role={role}
          section={section}
          data={data}
          config={config}
          onChanged={onChanged}
          onCreated={onCreated}
        />
        <DropdownMenuSeparator />
        <CrmSavedViewMenuItems
          workspaceId={workspaceId}
          section={section}
          currentSearch={currentSearch}
          onApply={onApplySearch}
        />
        <DropdownMenuSeparator />
        {section === "deals" && config && config.pipelines.length > 1 && config.pipelines.map((pipeline) => (
          <DropdownMenuItem key={pipeline.id} onClick={() => onPipeline(pipeline.id)}>
            {t.pipeline}: {pipeline.name}
          </DropdownMenuItem>
        ))}
        <DropdownMenuItem data-crm-mobile-action="reports" onClick={onReports}>
          <BarChart3 aria-hidden />{t.reportsTitle}
        </DropdownMenuItem>
        {role !== "member" && (
          <DropdownMenuItem data-crm-mobile-action="configuration" onClick={onConfig}>
            <Settings2 aria-hidden />{t.configTitle}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
    <CrmActions
      dialogsOnly
      activeDialog={actionDialog}
      onDialogChange={setActionDialog}
      workspaceId={workspaceId}
      role={role}
      section={section}
      data={data}
      config={config}
      onChanged={onChanged}
      onCreated={onCreated}
    /></>
  );
}
