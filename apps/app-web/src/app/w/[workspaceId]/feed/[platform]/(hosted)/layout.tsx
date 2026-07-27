/**
 * Provider-backed Feed pages are part of the hosted platform integration.
 * Route groups do not affect the public URL, so the existing deep links stay
 * stable while OSS receives a hard 404 for hand-entered integration routes.
 */

import { notFound } from "next/navigation";
import { isOssEdition } from "@/lib/edition";

export default function HostedFeedPlatformLayout(props: {
  children: React.ReactNode;
}) {
  if (isOssEdition()) notFound();
  return props.children;
}
