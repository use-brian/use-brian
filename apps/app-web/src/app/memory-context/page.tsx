import { SessionWorkspacePicker } from "@/components/app-session";
import { MEMORY_CONTEXT_WORKSPACE_PATH } from "@/lib/memory-context-path";

export default function MemoryContextWorkspacePage() {
  return <SessionWorkspacePicker next={MEMORY_CONTEXT_WORKSPACE_PATH} />;
}
