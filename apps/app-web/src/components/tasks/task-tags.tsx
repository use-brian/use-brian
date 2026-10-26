"use client";

/** Saved task classification, shared by table, phone, board and peek.
 * [COMP:app-web/task-tags] */
import { useT } from "@/lib/i18n/client";

export function TaskTags({ tags }: { tags: readonly string[] }) {
  const label = useT().brainPage.detailDrawer.propertyLabels.tags;
  if (tags.length === 0) return null;
  return (
    <ul aria-label={label} className="flex min-w-0 flex-wrap gap-1">
      {tags.map((tag, index) => (
        <li
          key={`${index}:${tag}`}
          className="max-w-full rounded border border-border bg-muted px-1.5 py-0.5 text-[11px] font-normal leading-snug text-muted-foreground [overflow-wrap:anywhere]"
        >
          {tag}
        </li>
      ))}
    </ul>
  );
}
