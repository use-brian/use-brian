"use client";
import { useParams } from "next/navigation";
import { OfficeHome } from "@/components/office/office-home";
export default function OfficePage() {
  const { workspaceId = "" } = useParams<{ workspaceId: string }>();
  return <OfficeHome workspaceId={workspaceId} />;
}
