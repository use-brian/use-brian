#!/usr/bin/env node
// Each invocation owns a fresh output directory. A failed build must never
// make a previous release/usebrian.zip look like the result of this invocation.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { allocateOutput } from './desktop-package-output.mjs';

const desktop = fileURLToPath(new URL('../apps/app-desktop/', import.meta.url));
const platform = process.argv[2];
if (platform !== 'mac' || process.argv.length !== 3) {
  console.error('usage: package-desktop.mjs mac');
  process.exit(1);
}
let output;
function run(args) {
  const result = spawnSync('pnpm', args, { cwd: desktop, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`pnpm ${args.join(' ')} failed (${result.signal ?? result.status})`);
}
try {
  output = allocateOutput(desktop);
  console.log(`==> This run's output directory: ${output}`);
  run(['run', 'build:renderer']);
  run(['run', 'build']);
  run(['run', 'build:native-computer']);
  run(['run', 'build:siri']);
  run(['exec', 'electron-builder', '--mac',
    '--publish', 'never', `--config.directories.output=${output}`]);
  for (const file of ['usebrian.zip', 'usebrian.dmg']) {
    if (!existsSync(join(output, file))) throw new Error(`Missing output: ${file}`);
  }
  console.log(`==> Package succeeded. Artifacts: ${output}`);
} catch (error) {
  console.error(`==> PACKAGE FAILED: ${error.message}\nNo successful package from this run. Do not use partial outputs in ${output ?? '(not allocated)'}.\nPrevious packages were left untouched; they are NOT results of this run.`);
  process.exitCode = 1;
}
