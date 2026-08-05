"use client";
import { useParams } from "next/navigation";
import { OfficeEditorShell } from "@/components/office/office-editor-shell";
export default function OfficeArtifactPage() {
  const { workspaceId = "", artifactId = "" } = useParams<{ workspaceId: string; artifactId: string }>();
  return <OfficeEditorShell workspaceId={workspaceId} artifactId={artifactId} />;
}
