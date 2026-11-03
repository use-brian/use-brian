import { CrmWorkspace } from "@/components/crm/crm-workspace";

/** Route leaves are inert; CRM stays mounted through collection/detail swaps. */
export default function CrmLayout() {
  return <CrmWorkspace />;
}
