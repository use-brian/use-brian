"use client";
import { useParams } from "next/navigation";
import { OfficeCreate } from "@/components/office/office-create";
export default function NewOfficePage() {
  const { workspaceId = "" } = useParams<{ workspaceId: string }>();
  return <OfficeCreate workspaceId={workspaceId} />;
}
