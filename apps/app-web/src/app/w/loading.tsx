/** Cold server-route fallback; live session/workspace admission uses the shared client boundary. */
import { AppShellSkeleton } from "@/components/chrome/surface-skeleton";

export default function WorkspaceBootLoading() {
  return <AppShellSkeleton />;
}
