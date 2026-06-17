"use client";

// [COMP:app-web/block-code]
/**
 * Phase 2 — Code block.
 *
 * Code editing is fundamentally different from rich text — the editor is a
 * plain `<textarea>`, no Tiptap. A language `<select>` sits above the
 * textarea (the project's CLAUDE.md exempts in-table / in-cell-style native
 * selects from the no-native-select rule; the code block's language picker
 * sits in the same "inline cell editor" category). A copy button mirrors
 * GitHub / Notion code-block affordances.
 *
 * `shiki` is not installed (checked `apps/app-web/package.json`), so
 * syntax highlighting is stubbed at a monospace `<pre>` for Phase 2.
 * Phase 4 will wire shiki and re-render `block.code` as a highlighted
 * tree in read mode.
 *
 * Shape matches the Phase-2 extension to the doc Block union:
 *   { kind: 'code'; id; language: string; code: string }
 */

import { useState } from "react";
import { useT } from "@/lib/i18n/client";

/** Local block shape — the Phase-2 extension to the doc Block union. */
export type CodeBlock = {
  kind: "code";
  id: string;
  language: string;
  code: string;
};

type BlockProps = {
  block: CodeBlock;
  blockId: string;
  readOnly?: boolean;
  onChange?: (next: Partial<CodeBlock>) => void;
  onAction?: (action: string, params?: unknown) => void;
};

const LANGUAGES = [
  "plain",
  "typescript",
  "javascript",
  "tsx",
  "jsx",
  "python",
  "go",
  "rust",
  "java",
  "kotlin",
  "swift",
  "ruby",
  "php",
  "csharp",
  "cpp",
  "c",
  "shell",
  "bash",
  "sql",
  "json",
  "yaml",
  "toml",
  "html",
  "css",
  "markdown",
  "diff",
] as const;

export function BlockCode({ block, blockId, readOnly, onChange }: BlockProps) {
  const t = useT().docPage;
  const [copied, setCopied] = useState(false);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(block.code ?? "");
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard refusal is best-effort UX; ignore silently.
    }
  };

  return (
    <div
      data-block-id={blockId}
      className="rounded-md border border-border bg-[var(--muted)]/30"
    >
      <div className="flex items-center justify-between gap-2 border-b border-border px-2 py-1">
        <select
          aria-label={t.blocks.codeLanguageAria}
          title={t.blocks.codeLanguageAria}
          value={block.language || "plain"}
          disabled={readOnly}
          onChange={(e) => onChange?.({ language: e.target.value })}
          className="rounded bg-transparent px-1 py-0.5 text-xs text-muted-foreground hover:bg-background focus:outline-none focus:ring-1 focus:ring-border"
        >
          {LANGUAGES.map((lang) => (
            <option key={lang} value={lang}>
              {lang}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={onCopy}
          aria-label={t.blocks.codeCopyAria}
          title={t.blocks.codeCopyAria}
          className="rounded px-2 py-0.5 text-xs text-muted-foreground hover:bg-background hover:text-foreground focus:outline-none focus:ring-1 focus:ring-border"
        >
          {copied ? t.blocks.codeCopied : t.blocks.codeCopyAria}
        </button>
      </div>
      {readOnly ? (
        <pre
          className="overflow-x-auto whitespace-pre px-3 py-2 font-mono text-[13px] leading-6 text-foreground"
          data-language={block.language || "plain"}
        >
          {block.code ?? ""}
        </pre>
      ) : (
        <textarea
          value={block.code ?? ""}
          onChange={(e) => onChange?.({ code: e.target.value })}
          placeholder={t.blocks.codePlaceholder}
          spellCheck={false}
          rows={Math.max(3, (block.code ?? "").split("\n").length)}
          className="block w-full resize-y bg-transparent px-3 py-2 font-mono text-[13px] leading-6 text-foreground outline-none focus:ring-0"
          data-language={block.language || "plain"}
        />
      )}
    </div>
  );
}
