import { DesktopChatWindow } from "@/components/chrome/desktop-chat-window";

export default async function DesktopChatPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<{ assistant?: string }>;
}) {
  const { workspaceId } = await params;
  const { assistant } = await searchParams;
  return <DesktopChatWindow workspaceId={workspaceId} assistantId={assistant} />;
}
