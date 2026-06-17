"use client";

/**
 * `child_page` block — an inline clickable row inside a page that links
 * to a nested sub-page. Renders the child's icon (its user/AI emoji from
 * `saved_views.icon`, else a type-derived lucide glyph) + its *live*
 * title and navigates to the child on click.
 *
 * Freshness rule (app-web/CLAUDE.md): neither the title nor the emoji
 * is snapshotted into the block. We resolve them from the parent shell's
 * loaded sidebar list when available (`titleHint`/`iconHint`), and fall
 * back to a light
 * `getView(childPageId)` fetch when the child isn't in the list (e.g. a
 * freshly-created sub-page not yet refetched, or a child outside the
 * current list scope). A rename of the child therefore reflects here on
 * the next list refresh / remount.
 *
 * [COMP:app-web/block-child-page]
 */

import { useEffect, useState } from "react";
import { ChevronRight, FileText } from "lucide-react";
import {
  derivePageIcon,
  getView,
  type ChildPageBlock,
  type NameOrigin,
  type ViewEntity,
  type ViewType,
} from "@/lib/api/views";
import { useT } from "@/lib/i18n/client";

type BlockChildPageProps = {
  block: ChildPageBlock;
  /**
   * Resolver from the shell's loaded sidebar list, keyed by view id.
   * When it returns a row the block skips the network fetch entirely.
   */
  resolve?: (
    childPageId: string,
  ) => {
    name: string;
    entity: ViewEntity;
    viewType: ViewType;
    nameOrigin: NameOrigin;
    /** User/AI page emoji (`saved_views.icon`), or null for the glyph. */
    icon: string | null;
  } | null;
  onNavigate: (viewId: string) => void;
};

export function BlockChildPage({
  block,
  resolve,
  onNavigate,
}: BlockChildPageProps) {
  const t = useT().docPage;
  const hinted = resolve?.(block.childPageId) ?? null;

  const [fetched, setFetched] = useState<{
    name: string;
    entity: ViewEntity;
    viewType: ViewType;
    nameOrigin: NameOrigin;
    icon: string | null;
  } | null>(null);

  // Only fetch when the parent list couldn't resolve the child. Re-runs
  // if the hint appears later (then we clear the fetched copy and defer
  // to the fresher list value).
  useEffect(() => {
    if (hinted) {
      setFetched(null);
      return;
    }
    let cancelled = false;
    getView(block.childPageId)
      .then((meta) => {
        if (cancelled) return;
        setFetched({
          name: meta.name,
          entity: meta.entity,
          viewType: meta.viewType,
          nameOrigin: meta.nameOrigin,
          icon: meta.icon,
        });
      })
      .catch(() => {
        // Soft-fail: the row still renders with the untitled fallback so
        // the user can at least click through.
        if (!cancelled) setFetched(null);
      });
    return () => {
      cancelled = true;
    };
  }, [block.childPageId, hinted]);

  const resolved = hinted ?? fetched;
  const title = resolved?.name?.trim() ? resolved.name : t.breadcrumbUntitled;
  // An explicit page emoji wins (matching the sidebar tree row) — this is the
  // common case for AI-filed sub-pages, which were rendering as a generic
  // document glyph here while showing their emoji in the sidebar (the reported
  // bug). When there's no emoji, fall back to the type-derived glyph.
  //
  // Pass `nameOrigin` to the glyph fallback so a fresh/untouched draft (and a
  // hand-renamed page) keeps the generic document glyph — WITHOUT it
  // `derivePageIcon` falls through to the page's default `tasks` entity and
  // renders the task checkbox. The pre-resolve fallback is the same document
  // glyph, not a data-table icon, since a child_page is a page, not a binding.
  const emoji = resolved?.icon?.trim() ? resolved.icon : null;
  const Icon = resolved
    ? derivePageIcon({
        entity: resolved.entity,
        viewType: resolved.viewType,
        nameOrigin: resolved.nameOrigin,
      })
    : FileText;

  return (
    <button
      type="button"
      aria-label={t.blockChildPageAria}
      onClick={() => onNavigate(block.childPageId)}
      className="group/childpage flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left text-foreground/90 hover:bg-accent hover:text-foreground"
    >
      {emoji ? (
        <span className="flex size-5 shrink-0 items-center justify-center text-[1.05rem] leading-none">
          {emoji}
        </span>
      ) : (
        <Icon className="size-5 shrink-0 text-muted-foreground" />
      )}
      <span className="min-w-0 flex-1 truncate text-base font-medium underline-offset-2 group-hover/childpage:underline">
        {title}
      </span>
      <ChevronRight className="size-5 shrink-0 text-muted-foreground opacity-0 group-hover/childpage:opacity-100" />
    </button>
  );
}
