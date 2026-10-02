#!/usr/bin/env node
import { isAbsolute, resolve } from 'node:path';
import { lstatSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { strictJSON, validateHeader } from './eval.mjs';
import { collect, readPrivateConfig } from './collection.mjs';

async function main() {
  const args = process.argv.slice(2), options = new Map();
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (!['--driver', '--config', '--output', '--attended', '--synthetic'].includes(key) || options.has(key)) throw new Error();
    if (key === '--attended' || key === '--synthetic') options.set(key, true);
    else { const value = args[++i]; if (!value || !isAbsolute(value)) throw new Error(); options.set(key, value); }
  }
  if (!options.get('--attended') || ['--driver', '--config', '--output'].some(k => !options.has(k))) throw new Error();
  const path = options.get('--driver');
  if (!path.endsWith('.mjs') || !lstatSync(path).isFile() || realpathSync(path) !== resolve(path)) throw new Error();
  const header = validateHeader(strictJSON(readPrivateConfig(options.get('--config'))));
  if (header.version !== 2 || header.source !== 'synthetic' || !options.get('--synthetic')) throw new Error();
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort); process.once('SIGTERM', abort);
  try {
    // Sole executable-loading boundary: operator argv, absolute local module.
    // Never take this path from configuration JSON, renderer IPC, or a model.
    const { driver } = await import(pathToFileURL(path).href);
    const result = await collect({ output: options.get('--output'), header, driver, attended: true, signal: controller.signal });
    console.log(JSON.stringify(result));
  } finally { process.removeListener('SIGINT', abort); process.removeListener('SIGTERM', abort); }
}
main().catch(() => {
  console.error('Collection incomplete; no release evidence published. Check trusted driver and local consent.');
  process.exitCode = 2;
});
