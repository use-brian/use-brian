"use client";

/**
 * Guest comment composer for the public /share route (Phase 2).
 *
 * Shown only when the link role allows commenting. A guest enters a display
 * name on their first comment; the server mints a guest_session_token which we
 * persist in sessionStorage (per-token, not localStorage — avoids cross-tab
 * leaks) and reuse for replies + listing. A guest sees only their OWN comments
 * (the server scopes by token); member/AI replies are not shown in Phase 2.
 *
 * [COMP:app-web/share-dialog]
 */

import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n/client";
import { listGuestComments, postGuestComment, type GuestThreadView } from "@/lib/api/public-share";

export function GuestComments({ token, pageId }: { token: string; pageId?: string }) {
  const t = useT().sharedPage.comments;
  // The guest identity is per-LINK (one name across the whole shared subtree);
  // the viewed page only scopes which threads list/anchor (subtree cascade).
  const storageKey = `doc:share-guest:${token}`;
  const [guestToken, setGuestToken] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [draft, setDraft] = useState("");
  const [threads, setThreads] = useState<GuestThreadView[]>([]);
  const [posting, setPosting] = useState(false);

  useEffect(() => {
    const saved = typeof window !== "undefined" ? window.sessionStorage.getItem(storageKey) : null;
    if (saved) {
      setGuestToken(saved);
      listGuestComments(token, saved, pageId).then(setThreads).catch(() => {});
    }
  }, [token, storageKey, pageId]);

  async function post() {
    const body = draft.trim();
    if (!body || posting) return;
    if (!guestToken && !name.trim()) return;
    setPosting(true);
    try {
      const result = await postGuestComment(
        token,
        {
          guestName: name.trim() || "Guest",
          guestSessionToken: guestToken ?? undefined,
          body,
        },
        pageId,
      );
      if (result) {
        if (!guestToken) {
          setGuestToken(result.guestSessionToken);
          window.sessionStorage.setItem(storageKey, result.guestSessionToken);
        }
        setDraft("");
        setThreads(await listGuestComments(token, result.guestSessionToken, pageId));
      }
    } finally {
      setPosting(false);
    }
  }

  const canPost = !!draft.trim() && (!!guestToken || !!name.trim());

  return (
    <section className="mt-12 border-t border-border pt-6">
      <h2 className="text-sm font-semibold text-muted-foreground">{t.heading}</h2>

      {threads.length > 0 ? (
        <ul className="mt-3 space-y-3">
          {threads.map((th) => (
            <li key={th.threadId} className="rounded-md border border-border p-3">
              {th.quote ? (
                <div className="mb-1 truncate text-xs text-muted-foreground">{th.quote}</div>
              ) : null}
              {th.comments.map((c, i) => (
                <p key={i} className="whitespace-pre-wrap text-sm">
                  {c.body}
                </p>
              ))}
            </li>
          ))}
        </ul>
      ) : null}

      <div className="mt-3 space-y-2">
        {!guestToken ? (
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t.namePlaceholder}
            maxLength={80}
            className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
          />
        ) : null}
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={t.placeholder}
          rows={3}
          className="w-full resize-y rounded-md border border-border bg-background px-3 py-2 text-sm"
        />
        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => void post()}
            disabled={posting || !canPost}
            className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {posting ? t.posting : t.post}
          </button>
        </div>
      </div>
    </section>
  );
}
