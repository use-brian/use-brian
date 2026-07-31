"use client";

/**
 * Custom Home app route — every workspace-built app renders here, identified
 * by the id in the path rather than by a segment of its own. Thin wrapper: the
 * frame lives in `@/components/home-apps/app-frame`
 * (`[COMP:app-web/home-app-frame]`).
 *
 * Spec: docs/architecture/features/home-apps.md → "Custom apps".
 */

import { useParams } from "next/navigation";
import { AppFrame } from "@/components/home-apps/app-frame";

export default function CustomHomeAppPage() {
  const params = useParams<{ workspaceId: string; appId: string }>();
  return (
    <AppFrame
      workspaceId={params?.workspaceId ?? ""}
      appId={params?.appId ?? ""}
    />
  );
}
