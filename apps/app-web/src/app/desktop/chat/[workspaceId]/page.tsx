import { DesktopChatWindow } from "@/components/chrome/desktop-chat-window";

export default async function DesktopChatPage({
  params,
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  return <DesktopChatWindow workspaceId={workspaceId} />;
}
