"use client";

/**
 * Chat operator surface route — thin wrapper: the meat lives in
 * `@/components/chat-app/chat-surface` (`[COMP:app-web/chat-surface]`) so the
 * desktop SPA can import the client component directly (the feed-port
 * disposition rule, feed-web-consolidation §6/§10). The Suspense boundary
 * covers `useSearchParams` (the `?s=<sessionId>` open-thread state).
 *
 * Spec: docs/architecture/features/chat-app.md.
 */

import { Suspense } from "react";
import { useParams } from "next/navigation";
import { ChatSurface } from "@/components/chat-app/chat-surface";

export default function ChatPage() {
  const params = useParams<{ workspaceId: string }>();
  const workspaceId = params?.workspaceId ?? "";
  return (
    <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">…</div>}>
      <ChatSurface workspaceId={workspaceId} />
    </Suspense>
  );
}
