"use client";
import { useParams } from "next/navigation";
import { OfficeTemplateLibrary } from "@/components/office/template-library";
export default function OfficeTemplatesPage() {
  const { workspaceId = "" } = useParams<{ workspaceId: string }>();
  return <OfficeTemplateLibrary workspaceId={workspaceId} />;
}
