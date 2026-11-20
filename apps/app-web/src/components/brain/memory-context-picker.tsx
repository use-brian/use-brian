"use client";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Copy, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SurfaceSkeletonFor } from "@/components/chrome/surface-skeleton";
import { useT } from "@/lib/i18n/client";
import {
  fetchMemoryContext, findMemoryContext, MemoryContextDenied, reportMemoryContextCopy,
  type MemoryContextSelection, type MemoryContextSummary,
} from "@/lib/api/memory-context";

type Memory = MemoryContextSelection["memory"];
type Preview = { id: string; memory: Memory };
type Operation = "search" | "preview" | "copy";
type CopyOutcome =
  | { kind: "ready"; text: string; receipt?: string }
  | { kind: "changed"; memory: Memory }
  | { kind: "denied" | "unavailable" };

function contextText(memory: Memory, updated: string) {
  return [memory.summary, memory.detail, `${updated} ${memory.updatedAt.slice(0, 10)}`].filter(Boolean).join("\n\n");
}

export function MemoryContextPicker({ workspaceId, initialId }: { workspaceId: string; initialId?: string }) {
  const t = useT().brainPage.memoryContext;
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<MemoryContextSummary[] | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [pending, setPending] = useState<Operation | null>(null);
  const [status, setStatus] = useState<"copied" | "changed" | "denied" | "unavailable" | null>(null);
  const [manual, setManual] = useState<{ text: string; receipt?: string } | null>(null);
  const [retryId, setRetryId] = useState<string>();
  const request = useRef<AbortController | null>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const manualInput = useRef<HTMLTextAreaElement>(null);

  const begin = useCallback((operation: Operation) => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setPending(operation);
    setStatus(null);
    setManual(null);
    setRetryId(undefined);
    return controller;
  }, []);

  async function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!query.trim()) return;
    const { signal } = begin("search");
    setPreview(null);
    setResults(null);
    try {
      const matches = await findMemoryContext(workspaceId, query.trim(), signal);
      if (!signal.aborted) setResults(matches);
    } catch (error) {
      if (!signal.aborted) setStatus(error instanceof MemoryContextDenied ? "denied" : "unavailable");
    } finally {
      if (!signal.aborted) setPending(null);
    }
  }

  const select = useCallback(async (id: string) => {
    const { signal } = begin("preview");
    setPreview(null);
    try {
      const { memory } = await fetchMemoryContext(workspaceId, id, "preview", signal);
      if (!signal.aborted) setPreview({ id, memory });
    } catch (error) {
      if (!signal.aborted) {
        if (error instanceof MemoryContextDenied) {
          setResults(null);
          setStatus("denied");
        } else {
          setRetryId(id);
          setStatus("unavailable");
        }
      }
    } finally {
      if (!signal.aborted) setPending(null);
    }
  }, [begin, workspaceId]);

  useEffect(() => {
    if (initialId) void select(initialId);
    return () => request.current?.abort();
  }, [initialId, select]);
  useEffect(() => { if (preview) heading.current?.focus(); }, [preview]);
  useEffect(() => { if (manual) manualInput.current?.focus(); }, [manual]);

  async function copy(selection: Preview) {
    const { signal } = begin("copy");
    const prepared = fetchMemoryContext(workspaceId, selection.id, "copy", signal)
      .then(({ memory, receipt }): CopyOutcome => {
        signal.throwIfAborted();
        const text = contextText(memory, t.updated);
        return text === contextText(selection.memory, t.updated)
          ? { kind: "ready", text, receipt }
          : { kind: "changed", memory };
      })
      .catch((error): CopyOutcome => ({ kind: error instanceof MemoryContextDenied ? "denied" : "unavailable" }));

    // Start the browser write within the user gesture. Safari can require
    // activation before the fresh read resolves, even on a secure origin.
    const clipboard = navigator.clipboard;
    let written = false;
    if (clipboard?.write && typeof ClipboardItem !== "undefined") {
      const content = prepared.then(result => {
        signal.throwIfAborted();
        if (result.kind !== "ready") throw new Error("Memory context unavailable for copy");
        return new Blob([result.text], { type: "text/plain" });
      });
      void content.catch(() => {});
      try {
        await clipboard.write([new ClipboardItem({ "text/plain": content })]);
        written = true;
      } catch {
        // When clipboard write is blocked, the same fresh payload is selectable below.
      }
    }

    const result = await prepared;
    if (signal.aborted) return;
    if (result.kind === "ready") {
      if (!written && clipboard?.writeText) {
        try { await clipboard.writeText(result.text); written = true; } catch { /* Manual copy remains available. */ }
      }
      if (signal.aborted) return;
      if (written) {
        reportMemoryContextCopy(result.receipt);
        setStatus("copied");
      } else setManual({ text: result.text, receipt: result.receipt });
    } else if (result.kind === "changed") {
      setPreview({ id: selection.id, memory: result.memory });
      setStatus("changed");
    } else {
      if (result.kind === "denied") {
        setPreview(null);
        setResults(null);
      }
      setStatus(result.kind);
    }
    setPending(null);
  }

  return <div className="grid min-w-0 gap-6 md:grid-cols-[minmax(0,1fr)_minmax(0,1.35fr)] lg:gap-10">
    <div className="min-w-0 space-y-3">
      <form onSubmit={search} aria-label={t.searchLabel} className="space-y-2">
        <label htmlFor="memory-context-topic" className="text-sm font-medium">{t.searchLabel}</label>
        <div className="flex min-w-0 items-center gap-2">
          <input id="memory-context-topic" type="search" value={query} maxLength={200}
            onChange={event => setQuery(event.target.value)} placeholder={t.searchPlaceholder}
            className="min-h-8 min-w-0 flex-1 rounded-md border border-input bg-background px-3 text-base text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring max-md:min-h-11" />
          <Button type="submit" variant="outline" disabled={!query.trim()} className="shrink-0 max-md:min-h-11">
            <Search className="size-4" aria-hidden />{t.search}
          </Button>
        </div>
      </form>
      {pending === "search" && <SurfaceSkeletonFor surface="tasks" chrome={false} />}
      {results?.length === 0 && <p role="status" className="text-sm text-muted-foreground">{t.empty}</p>}
      {results && results.length > 0 && <ul className="overflow-hidden rounded-lg border border-border divide-y divide-border">
        {results.map(memory => <li key={memory.id}>
          <button type="button" onClick={() => void select(memory.id)} aria-pressed={preview?.id === memory.id}
            className="block min-h-8 w-full break-words px-3 py-1.5 text-left text-sm hover:bg-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring aria-pressed:bg-accent aria-pressed:text-accent-foreground max-md:min-h-11">
            {memory.summary}
          </button>
        </li>)}
      </ul>}
    </div>
    <section aria-label={t.preview} className="min-w-0 space-y-4">
      {pending === "preview" && <SurfaceSkeletonFor surface="tasks" chrome={false} />}
      {preview && <div className="space-y-4 rounded-xl border border-border bg-card p-4 sm:p-5">
        <div>
          <h2 ref={heading} tabIndex={-1} className="break-words text-lg font-semibold focus:outline-none">{preview.memory.summary}</h2>
          <p className="mt-1 text-sm text-muted-foreground">{t.updated} <time dateTime={preview.memory.updatedAt}>{preview.memory.updatedAt.slice(0, 10)}</time></p>
        </div>
        {preview.memory.detail && <p className="whitespace-pre-wrap break-words text-sm leading-6">{preview.memory.detail}</p>}
        <Button type="button" className="max-md:min-h-11" disabled={pending === "copy"} aria-busy={pending === "copy"} onClick={() => void copy(preview)}>
          <Copy className="size-4" aria-hidden />{t.action}
        </Button>
      </div>}
      {status && <p role={status === "unavailable" || status === "denied" ? "alert" : "status"} className="text-sm text-muted-foreground">{t[status]}</p>}
      {retryId && <Button type="button" variant="outline" className="max-md:min-h-11" onClick={() => void select(retryId)}>{t.retry}</Button>}
      {manual && <div className="space-y-2 rounded-xl border border-border p-4">
        <label htmlFor="memory-context-manual" className="block text-sm font-medium">{t.manual}</label>
        <textarea id="memory-context-manual" ref={manualInput} value={manual.text} readOnly
          onFocus={event => event.currentTarget.select()}
          onCopy={event => {
            const input = event.currentTarget;
            if (input.selectionStart === 0 && input.selectionEnd === manual.text.length) {
              reportMemoryContextCopy(manual.receipt);
              setManual({ text: manual.text });
              setStatus("copied");
            }
          }}
          className="min-h-36 w-full resize-y rounded-md border border-input bg-background px-3 py-2 text-base leading-6 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring" />
      </div>}
    </section>
  </div>;
}
