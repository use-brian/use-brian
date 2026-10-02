"use client";
import { useParams } from "next/navigation";
import { NativeComputerPage } from "@/components/computer/native-computer-page";
export default function Page() {
  const { workspaceId } = useParams<{ workspaceId: string }>();
  return <NativeComputerPage key={workspaceId} workspaceId={workspaceId} />;
}
