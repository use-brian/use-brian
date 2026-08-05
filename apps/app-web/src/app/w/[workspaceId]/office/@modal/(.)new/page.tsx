"use client";

import { useParams } from "next/navigation";
import { OfficeCreateDialog } from "@/components/office/office-create";

export default function InterceptedNewOfficePage() {
  const { workspaceId = "" } = useParams<{ workspaceId: string }>();
  return <OfficeCreateDialog workspaceId={workspaceId} />;
}
