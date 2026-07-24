"use client";

/**
 * Public chat view — the anonymous client for `/c/[token]`.
 *
 * No auth, no workspace context: a localStorage visitor id keys the
 * session, turns are synchronous JSON (`sendPublicChatMessage`), and
 * history hydrates on load. Assistant replies render through the shared
 * `ChatMarkdown` (GFM) from `@use-brian/chat-ui`.
 *
 * Spec: docs/architecture/features/public-chat-link.md.
 * [COMP:app-web/public-chat-page]
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ChatMarkdown } from "@use-brian/chat-ui";
import remarkGfm from "remark-gfm";
import { ArrowUp, Loader2 } from "lucide-react";
import { AssistantAvatar } from "@/components/assistant-avatar";
import { useT } from "@/lib/i18n/client";
import {
  getPublicChatHistory,
  sendPublicChatMessage,
  type PublicChatMeta,
  type PublicChatMessage,
} from "@/lib/api/public-chat";

const VISITOR_KEY = "ub_chat_visitor";
const REMARK_PLUGINS = [remarkGfm];

/** Stable anonymous visitor id, minted once per browser. */
function getVisitorId(): string {
  try {
    const existing = localStorage.getItem(VISITOR_KEY);
    if (existing) return existing;
    const fresh = crypto.randomUUID();
    localStorage.setItem(VISITOR_KEY, fresh);
    return fresh;
  } catch {
    // Storage blocked (private mode) — session-scoped identity is fine.
    return crypto.randomUUID();
  }
}

type LocalMessage = Pick<PublicChatMessage, "role" | "content"> & { key: string };

export function PublicChatView({ token, meta }: { token: string; meta: PublicChatMeta }) {
  const t = useT().publicChat;
  const [visitorId, setVisitorId] = useState<string | null>(null);
  const [messages, setMessages] = useState<LocalMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Mint the visitor id + hydrate history once, client-side only.
  useEffect(() => {
    const id = getVisitorId();
    setVisitorId(id);
    getPublicChatHistory(token, id).then((rows) => {
      setMessages(rows.map((r) => ({ key: r.id, role: r.role, content: r.content })));
    });
  }, [token]);

  // Keep the newest message in view. (Feature-checked: jsdom and some
  // embedded webviews don't implement Element.scrollTo.)
  useEffect(() => {
    const el = scrollRef.current;
    if (el && typeof el.scrollTo === "function") {
      el.scrollTo({ top: el.scrollHeight });
    }
  }, [messages, pending]);

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text || pending || !visitorId) return;
    setDraft("");
    setNotice(null);
    setMessages((prev) => [...prev, { key: `local-${Date.now()}`, role: "user", content: text }]);
    setPending(true);
    try {
      const result = await sendPublicChatMessage(token, visitorId, text);
      if (result.ok) {
        setMessages((prev) => [
          ...prev,
          { key: `local-${Date.now()}-a`, role: "assistant", content: result.reply },
        ]);
      } else if (result.error === "link_budget_exhausted") {
        setNotice(t.dailyLimitReached);
      } else if (result.error === "budget_exhausted" || result.error === "link_not_found") {
        setNotice(t.linkUnavailable);
      } else if (result.error === "rate_limited") {
        setNotice(t.slowDown);
      } else {
        setNotice(t.sendFailed);
      }
    } finally {
      setPending(false);
    }
  }, [draft, pending, visitorId, token, t]);

  return (
    <div className="flex h-dvh flex-col bg-background text-foreground">
      {/* ── Header ─────────────────────────────────────────────── */}
      <header className="flex items-center gap-3 border-b border-border px-4 py-3">
        <AssistantAvatar id={token} name={meta.assistantName} iconSeed={meta.assistantIconSeed} size="md" />
        <div className="min-w-0">
          <h1 className="truncate text-sm font-semibold">{meta.assistantName}</h1>
          {meta.assistantBio && (
            <p className="truncate text-xs text-muted-foreground">{meta.assistantBio}</p>
          )}
        </div>
      </header>

      {/* ── Messages ───────────────────────────────────────────── */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-6">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-4">
          {messages.length === 0 && !pending && (
            <p className="py-16 text-center text-sm text-muted-foreground">
              {t.emptyState.replace("{name}", meta.assistantName)}
            </p>
          )}
          {messages.map((m) =>
            m.role === "user" ? (
              <div key={m.key} className="ml-auto max-w-[85%] rounded-2xl bg-primary px-4 py-2.5 text-sm text-primary-foreground whitespace-pre-wrap">
                {m.content}
              </div>
            ) : (
              <div key={m.key} className="max-w-[95%] text-sm leading-relaxed [&_pre]:overflow-x-auto [&_pre]:rounded-lg [&_pre]:bg-muted [&_pre]:p-3 [&_table]:block [&_table]:overflow-x-auto">
                <ChatMarkdown text={m.content} remarkPlugins={REMARK_PLUGINS} />
              </div>
            ),
          )}
          {pending && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" />
              {t.thinking}
            </div>
          )}
          {notice && (
            <p className="rounded-lg bg-muted px-3 py-2 text-center text-xs text-muted-foreground">
              {notice}
            </p>
          )}
        </div>
      </div>

      {/* ── Composer ───────────────────────────────────────────── */}
      <div className="border-t border-border px-4 py-3">
        <form
          className="mx-auto flex w-full max-w-2xl items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            placeholder={t.composerPlaceholder}
            rows={1}
            className="max-h-40 min-h-[42px] flex-1 resize-none rounded-xl border border-border bg-background px-3 py-2.5 text-sm outline-none focus:ring-1 focus:ring-ring"
          />
          <button
            type="submit"
            disabled={pending || !draft.trim()}
            aria-label={t.send}
            className="flex h-[42px] w-[42px] shrink-0 items-center justify-center rounded-xl bg-primary text-primary-foreground disabled:opacity-40"
          >
            <ArrowUp className="h-4 w-4" />
          </button>
        </form>
        <p className="mx-auto mt-2 w-full max-w-2xl text-center text-[10px] text-muted-foreground">
          {t.poweredBy}
        </p>
      </div>
    </div>
  );
}
