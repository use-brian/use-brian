"use client";
/** Website (owner/admin): Pages & sections, then one page, the membership page, programmes or the media library. [COMP:app-web/site-content] */
import { useSearchParams } from "next/navigation";
import { SITE_CONTENT_COLLECTIONS, type SiteContentCollection } from "@/lib/api/association";
import { useT } from "@/lib/i18n/client";
import { MembershipPublishingPanel } from "./membership-publishing";
import { ProgrammePublishingPanel } from "./programme-publishing";
import { SiteContentPanel } from "./site-content/site-content-panel";
import { WebsiteMediaPanel } from "./website-media";
import { WebsitePagesHome } from "./website/website-home";
import { associationHref } from "./navigation";
import { PageHeader } from "./ui";

type WebsitePage = "pages" | "programmes" | "membership" | "media";

export function AssociationWebsiteSection({ workspaceId }: { workspaceId: string }) {
  const c = useT().associationPage.content;
  const search = useSearchParams();
  const collection = search?.get("collection") ?? "";
  const page = search?.get("page") as WebsitePage | null;
  const back = { label: c.backToPages, href: associationHref(workspaceId, "website") };
  if ((SITE_CONTENT_COLLECTIONS as readonly string[]).includes(collection)) {
    return <div className="space-y-5"><SiteContentPanel key={collection} workspaceId={workspaceId} collection={collection as SiteContentCollection} back={back} /></div>;
  }
  if (page === "membership") return <div className="space-y-5"><PageHeader title={c.membershipPage} description={c.membershipPageHelp} back={back} /><MembershipPublishingPanel workspaceId={workspaceId} /></div>;
  if (page === "programmes") return <div className="space-y-5"><PageHeader title={c.sections.programmes} description={c.programmesHelp} back={back} /><ProgrammePublishingPanel workspaceId={workspaceId} /></div>;
  if (page === "media") return <div className="space-y-5"><PageHeader title={c.sections.media} description={c.mediaHelp} back={back} /><WebsiteMediaPanel workspaceId={workspaceId} /></div>;
  return <WebsitePagesHome workspaceId={workspaceId} />;
}
