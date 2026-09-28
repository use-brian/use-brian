"use client";

/** Website → Pages & sections: one card per page the websites read, with a plain publication status. [COMP:app-web/site-content] */
import Link from "next/link";
import { BookOpen, CalendarDays, FileText, Globe, Handshake, Home, ImageIcon, Newspaper, Settings2, Users, WalletCards, type LucideIcon } from "lucide-react";
import { websiteSiteLabel, type SiteContentCollection } from "@/lib/api/association";
import { format } from "@/lib/i18n/format";
import { useT } from "@/lib/i18n/client";
import { associationHref } from "../navigation";
import { AssociationListState } from "../operator-controls";
import { PageHeader, associationDate } from "../ui";
import { PublicationStatus, publicationState, useWebsiteSiteNames, useWebsiteStatus, type PublicationState } from "./website-status";

const ICONS: Record<SiteContentCollection, LucideIcon> = { people: Users, partners: Handshake, settings: Settings2, news: Newspaper, "home-oasa": Home, "home-sea": Home, "event-pages": CalendarDays };
const isHomePage = (collection: string) => collection.startsWith("home-");

type Card = { key: string; title: string; help: string; icon: LucideIcon; href: string; state: PublicationState | null; sites: string[]; publishedAt: string | null };

function PageCard({ card, names }: { card: Card; names: Record<string, string> }) {
  const c = useT().associationPage.content;
  return <Link href={card.href} data-website-card={card.key}
    className="flex min-h-11 flex-col gap-3 rounded-2xl border border-border bg-background p-5 transition-colors hover:border-primary/40 hover:bg-accent/40 focus-visible:outline-2 focus-visible:outline-ring">
    <div className="flex items-start justify-between gap-3">
      <span className="flex items-center gap-2 font-semibold"><card.icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />{card.title}</span>
      {card.state ? <PublicationStatus state={card.state} names={names} /> : null}
    </div>
    <p className="text-sm text-muted-foreground">{card.help}</p>
    <p className="mt-auto text-xs text-muted-foreground">
      {card.sites.length ? format(c.usedOn, { sites: card.sites.map(site => websiteSiteLabel(site, names)).join(", ") }) : null}
      {card.sites.length && card.publishedAt ? " · " : null}
      {card.publishedAt ? format(c.lastPublishedOn, { date: associationDate(card.publishedAt, "date") }) : null}
    </p>
  </Link>;
}

export function WebsitePagesHome({ workspaceId }: { workspaceId: string }) {
  const c = useT().associationPage.content;
  const status = useWebsiteStatus(workspaceId);
  const names = useWebsiteSiteNames(workspaceId, true);
  const titles = c.collections as Record<SiteContentCollection, { title: string; help: string }>;
  const href = (params: Record<string, string>) => associationHref(workspaceId, "website", params);
  const pages: Card[] = (status.data?.collections ?? []).map(row => ({
    key: row.collection, icon: ICONS[row.collection], help: titles[row.collection].help, href: row.collection === "event-pages" ? associationHref(workspaceId, "events") : href({ collection: row.collection }),
    title: isHomePage(row.collection) ? format(c.homePageFor, { site: row.readers.map(site => websiteSiteLabel(site, names)).join(", ") }) : titles[row.collection].title,
    state: publicationState(row, row.readers), sites: isHomePage(row.collection) ? [] : [...row.readers].sort(), publishedAt: row.publishedAt,
  }));
  const catalogues: Card[] = status.data ? [
    { key: "membership", icon: WalletCards, title: c.membershipPage, help: c.membershipPageHelp, href: href({ page: "membership" }),
      state: publicationState(status.data.membership, Object.keys(status.data.membership.observations)), sites: Object.keys(status.data.membership.observations).sort(), publishedAt: status.data.membership.publishedAt },
    { key: "programmes", icon: BookOpen, title: c.sections.programmes, help: c.programmesHelp, href: href({ page: "programmes" }),
      state: publicationState(status.data.programmes, Object.keys(status.data.programmes.observations)), sites: Object.keys(status.data.programmes.observations).sort(), publishedAt: status.data.programmes.publishedAt },
    { key: "media", icon: ImageIcon, title: c.sections.media, help: c.mediaHelp, href: href({ page: "media" }), state: null, sites: [], publishedAt: null },
  ] : [];
  const homes = pages.filter(card => isHomePage(card.key)), shared = pages.filter(card => !isHomePage(card.key));
  return <section className="space-y-6" data-website-home>
    <PageHeader title={c.pagesTitle} description={c.pagesHelp} />
    <AssociationListState {...status}>
      {[{ id: "homes", icon: Globe, cards: homes }, { id: "shared", icon: FileText, cards: [...shared, ...catalogues] }].map(group => group.cards.length ?
        <div key={group.id} className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">{group.cards.map(card => <PageCard key={card.key} card={card} names={names} />)}</div> : null)}
    </AssociationListState>
  </section>;
}
