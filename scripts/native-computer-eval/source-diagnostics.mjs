#!/usr/bin/env node
// Metadata diagnostics only; NEVER returns an accepted-live-publication result.
import { openSync, fstatSync, readSync, closeSync, constants } from 'node:fs';
async function main() {
  if (process.argv.length !== 3 || process.argv[2].startsWith('-')) throw new Error();
  const { createSourceIngestor, sourceLimits } = await import('./source-ingestor.mjs');
  const fd = openSync(process.argv[2], constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let bytes;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > sourceLimits.totalBytes) throw new Error();
    bytes = Buffer.alloc(stat.size + 1); let used = 0;
    while (used < bytes.length) { const n = readSync(fd, bytes, used, bytes.length - used, null); if (!n) break; used += n; }
    if (used !== stat.size) throw new Error(); bytes = bytes.subarray(0, used);
  } finally { closeSync(fd); }
  const text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  const lines = text.split('\n'); if (lines.at(-1) === '') lines.pop();
  const sink = createSourceIngestor();
  if (!lines.length || lines.length > sourceLimits.events) sink.invalidate('missing-sequence');
  else for (const line of lines) if (!sink.ingestJSON(line)) break;
  sink.endInput();
  const diagnostics = sink.diagnostics(); console.log(JSON.stringify(diagnostics, null, 2));
  process.exitCode = diagnostics.state === 'poisoned' ? 2 : 1;
}
main().catch(() => { console.error('Source metadata diagnostics unavailable or invalid; live publication refused.'); process.exitCode = 2; });
