import { existsSync, mkdirSync, mkdtempSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// CI consumers require release/ paths. Reserve that directory exclusively:
// never accept an existing output directory, even after an earlier failed run.
// Local runs keep all previous packages and print their unique destination.
export function allocateOutput(desktop, githubActions = process.env.GITHUB_ACTIONS === 'true') {
  const release = join(desktop, 'release');
  if (githubActions) {
    mkdirSync(release);
    return release;
  }
  const runs = join(release, 'runs');
  mkdirSync(runs, { recursive: true });
  return mkdtempSync(join(runs, 'mac-'));
}

if (process.argv[1] && existsSync(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3) throw new Error('usage: desktop-package-output.mjs DESKTOP_DIRECTORY');
    console.log(allocateOutput(resolve(process.argv[2])));
  } catch (error) {
    console.error(`Cannot reserve fresh package output: ${error.message}. Existing packages were left untouched.`);
    process.exitCode = 1;
  }
}
