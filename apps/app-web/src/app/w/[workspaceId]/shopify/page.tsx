"use client";

/**
 * Shopify operator surface route — thin wrapper, matching the CRM/Feed
 * disposition: the meat lives in `@/components/shopify/shopify-surface`
 * (`[COMP:app-web/shopify-app]`) so the desktop SPA can import the client
 * component directly.
 *
 * Spec: docs/architecture/integrations/shopify.md → "The built-in app".
 */

import { useParams } from "next/navigation";
import { ShopifySurface } from "@/components/shopify/shopify-surface";

export default function ShopifyPage() {
  const params = useParams<{ workspaceId: string }>();
  return <ShopifySurface workspaceId={params?.workspaceId ?? ""} />;
}
