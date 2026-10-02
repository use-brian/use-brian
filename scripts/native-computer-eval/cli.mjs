#!/usr/bin/env node
import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { TextDecoder } from 'node:util';
import { evaluate, parseEvidence, manifest, manifestDigest, limits } from './eval.mjs';

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--manifest') {
    console.log(JSON.stringify({ ...manifest, digest: manifestDigest }, null, 2));
    return;
  }
  if (args.length !== 1 || args[0].startsWith('-')) {
    console.error('Usage: node scripts/native-computer-eval/cli.mjs <metadata.jsonl> | --manifest');
    process.exitCode = 2; return;
  }
  // Bound bytes before decoding; avoid reading arbitrarily large files, FIFOs,
  // or invalid UTF-8 that would otherwise be silently replaced by readFile.
  const file = await open(args[0], constants.O_RDONLY | constants.O_NONBLOCK);
  let bytes;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > limits.bytes) throw new Error();
    bytes = Buffer.alloc(Math.min(stat.size + 1, limits.bytes + 1));
    let used = 0;
    while (used < bytes.length) {
      const { bytesRead } = await file.read(bytes, used, bytes.length - used, null);
      if (!bytesRead) break;
      used += bytesRead;
    }
    if (used > stat.size || used > limits.bytes) throw new Error();
    bytes = bytes.subarray(0, used);
  } finally { await file.close(); }
  const report = evaluate(parseEvidence(new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)));
  console.log(JSON.stringify(report, null, 2));
  // Synthetic/live numerical success never changes pending release status.
  process.exitCode = report.source === 'live-attended' ? 2 : report.provisionalNumericalGatesPass ? 0 : 1;
}
main().catch(() => {
  // Never reflect untrusted content, paths, keys, or filesystem errors.
  console.error('Rejected: invalid, incomplete, confounded, or unreadable metadata evidence.');
  process.exitCode = 2;
});
