"use client";

/**
 * Guest comment composer for the public share surfaces (Phase 2).
 *
 * Shown only when the resolved visitor role allows commenting - a token link
 * minted at `comment`, a page published with "Allow comments" (the universal
 * `/share/p/<id>` URL), or a custom-domain site whose anchor is. A guest
 * enters a display name on their first comment; the server mints a
 * guest_session_token which we persist in sessionStorage (keyed per share
 * IDENTITY, not per page, so one name carries across the shared subtree; not
 * localStorage - avoids cross-tab leaks) and reuse for replies + listing. A
 * guest sees only their OWN comments (the server scopes by token); member/AI
 * replies are not shown in Phase 2.
 *
 * [COMP:app-web/share-dialog]
 */

import { useCallback, useEffect, useState } from "react";
import { useT } from "@/lib/i18n/client";
import {
  listGuestComments,
  postGuestComment,
  type GuestThreadView,
  type PublicSource,
} from "@/lib/api/public-share";

/** The share identity a guest's name + token are stored under: the token for
 *  a link, the hostname for a site, and the published ROOT for the universal
 *  URL (so navigating the published subtree keeps the guest's identity). */
export function guestIdentityKey(source: PublicSource, rootPageId?: string): string {
  if (source.kind === "link") return `link:${source.token}`;
  if (source.kind === "site") return `site:${source.host}`;
  return `published:${rootPageId ?? source.pageId}`;
}

/** Window event fired when a guest's session token is minted, so every
 *  composer on the page (the page-level section + the selection composer)
 *  learns the identity at once — they share one name and one token. */
const GUEST_TOKEN_EVENT = "doc:share-guest-token";

/**
 * The guest's identity for one share: the session token (null until their
 * first comment mints it) + the display name they typed. Persisted in
 * sessionStorage under the share identity key; `adopt(token)` stores a freshly
 * minted token and broadcasts it to every other mounted instance.
 */
export function useGuestIdentity(identityKey: string): {
  guestToken: string | null;
  adopt: (token: string) => void;
  name: string;
  setName: (name: string) => void;
} {
  const storageKey = `doc:share-guest:${identityKey}`;
  const [guestToken, setGuestToken] = useState<string | null>(null);
  const [name, setName] = useState("");

  useEffect(() => {
    const read = () => {
      const saved = typeof window !== "undefined" ? window.sessionStorage.getItem(storageKey) : null;
      setGuestToken(saved);
    };
    read();
    const onMinted = (e: Event) => {
      const key = (e as CustomEvent<{ storageKey: string }>).detail?.storageKey;
      if (key === storageKey) read();
    };
    window.addEventListener(GUEST_TOKEN_EVENT, onMinted);
    return () => window.removeEventListener(GUEST_TOKEN_EVENT, onMinted);
  }, [storageKey]);

  const adopt = useCallback(
    (token: string) => {
      window.sessionStorage.setItem(storageKey, token);
      setGuestToken(token);
      window.dispatchEvent(new CustomEvent(GUEST_TOKEN_EVENT, { detail: { storageKey } }));
    },
    [storageKey],
  );

  return { guestToken, adopt, name, setName };
}

export function GuestComments({
  source,
  identityKey,
  onPosted,
}: {
  source: PublicSource;
  identityKey: string;
  /** Fired after a comment lands — the page view re-fetches so the new thread
   *  shows in the rail (a guest's threads are in the public payload). */
  onPosted?: () => void;
}) {
  const t = useT().sharedPage.comments;
  const { guestToken, adopt, name, setName } = useGuestIdentity(identityKey);
  const [draft, setDraft] = useState("");
  const [threads, setThreads] = useState<GuestThreadView[]>([]);
  const [posting, setPosting] = useState(false);

  // `source` is the route's prop (stable per navigation), so it is a safe dep.
  // Re-lists whenever the token changes — including when the SELECTION
  // composer mints it (the shared identity broadcasts), so a range comment
  // posted up in the text shows in this list too.
  useEffect(() => {
    if (!guestToken) return;
    listGuestComments(source, guestToken).then(setThreads).catch(() => {});
  }, [guestToken, source]);

  async function post() {
    const body = draft.trim();
    if (!body || posting) return;
    if (!guestToken && !name.trim()) return;
    setPosting(true);
    try {
      const result = await postGuestComment(source, {
        guestName: name.trim() || "Guest",
        guestSessionToken: guestToken ?? undefined,
        body,
      });
      if (result) {
        if (!guestToken) adopt(result.guestSessionToken);
        setDraft("");
        setThreads(await listGuestComments(source, result.guestSessionToken));
        onPosted?.();
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
            className="rounded-md bg-action px-3 py-1.5 text-sm font-medium text-action-foreground transition-opacity hover:opacity-90 disabled:opacity-50"
          >
            {posting ? t.posting : t.post}
          </button>
        </div>
      </div>
    </section>
  );
}
