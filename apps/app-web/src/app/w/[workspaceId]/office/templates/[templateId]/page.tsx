"use client";
import { useParams } from "next/navigation";
import { OfficeTemplateLibrary } from "@/components/office/template-library";
export default function OfficeTemplatePage() {
  const { workspaceId = "", templateId = "" } = useParams<{ workspaceId: string; templateId: string }>();
  return <OfficeTemplateLibrary workspaceId={workspaceId} templateId={templateId} />;
}
