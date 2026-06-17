# @sidanclaw/sidanclaw-kb

Parser, wikilink resolver, and lint checks for [sidanclaw](https://sidan.ai) knowledge bases. Shared between the API sync worker and the public CLI — single source of truth for how KB markdown is read and validated.

## Install (CLI use)

```
npm install -g @sidanclaw/sidanclaw-kb
# or invoke directly:
npx @sidanclaw/sidanclaw-kb <command>
```

## CLI — `kb lint`

Audit a KB directory against the parser contract and sensitivity safety rules.

```
kb lint                                  # current directory
kb lint ./my-team-kb                     # explicit path
kb lint --json ./my-team-kb              # JSON output for CI
kb lint --quiet ./my-team-kb             # errors only
kb lint --strict ./my-team-kb            # exit non-zero on warnings too
```

### Checks

| Severity | Check | Catches |
|---|---|---|
| error | `invalid-sensitivity` | Frontmatter `sensitivity` value is not `public` / `internal` / `confidential` |
| error | `unresolved-wikilink` | `[[target]]` that doesn't resolve via exact / relative / filename search |
| error | `unresolved-md-link` | `[text](target.md)` that points at no existing entry |
| error | `mixed-tier-index` | `index.md` body names a higher-tier sub-entry (leaks name to lower-cleared readers) |
| error | `secret:*` | Body contains an AWS key, GitHub token, Stripe key, private-key block, or `api_key = ...` assignment |
| warning | `missing-frontmatter` | No YAML frontmatter at all |
| warning | `missing-description` | `description` absent or empty |
| warning | `missing-tags` | `tags` absent or empty |
| warning | `missing-sensitivity` | `sensitivity` omitted (defaults to `internal` — be explicit) |
| warning | `nested-frontmatter` | Frontmatter key has a nested object — parser silently flattens |
| warning | `numeric-prefix-filename` | `31-foo.md` — leaks into the KB path |
| warning | `date-prefix-filename` | `2026-04-20-foo.md` — prefer metadata |
| warning | `missing-directory-index` | Folder has entries but no `index.md` |
| warning | `cross-tier-body-link` | Body link from lower-tier entry to higher-tier target |
| info | `orphan` | Entry is not linked from anywhere |

### Exit codes

- `0` — clean (or warnings/info only)
- `1` — errors present, or warnings with `--strict`
- `2` — bad invocation

**Code blocks are skipped** — wikilinks / markdown links inside fenced (```) and inline (`` ` ``) code spans are ignored so example snippets don't false-positive.

**Root `README.md` is skipped** — repo-level README, not a KB entry.

## Library API

```typescript
import {
  parseMarkdownFile,       // sync worker: path + raw markdown → ParsedEntry
  buildPathIndex,          // sync worker: paths[] → filename-index
  resolveWikilink,         // sync worker: link string → path string (pass 2)

  walkKbFromFs,            // CLI: filesystem directory → LintIndex
  buildLintIndex,          // sync worker: pre-fetched entries → LintIndex
  runAllChecks,            // both: LintIndex → Finding[]

  readFrontmatter,         // low-level utility
  report,                  // CLI-side formatter
} from '@sidanclaw/sidanclaw-kb'
```

### Sync-worker use (pre-parsed entries, no filesystem)

```typescript
const index = buildLintIndex(
  entries.map((e) => ({
    source: `${owner}/${repo}:${e.path}`,
    relativePath: e.path,
    rawContent: e.rawMarkdown,
  })),
)
const findings = runAllChecks(index)
for (const f of findings) logger.warn('kb-lint', f)
```

### CLI use

```typescript
const index = await walkKbFromFs('./my-team-kb')
const findings = runAllChecks(index)
const exit = report(findings, { format: 'human', quiet: false, strict: false })
process.exit(exit)
```

## Scaffolding a new KB

Not this package's job — use the template directly:
<https://github.com/sidanclaw/sidanclaw-kb-template> ("Use this template")

## License

MIT
