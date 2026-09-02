import { DesktopChatWindow } from "@/components/chrome/desktop-chat-window";

export default async function DesktopChatPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<{ prompt?: string }>;
}) {
  const { workspaceId } = await params;
  const { prompt } = await searchParams;
  return <DesktopChatWindow workspaceId={workspaceId} initialPrompt={prompt} />;
}
