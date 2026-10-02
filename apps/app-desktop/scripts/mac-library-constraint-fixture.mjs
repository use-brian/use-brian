// Opt-in, disposable FORMAT collection only. No import-time work, DER decoder,
// credentials, network, app signing, execution of generated code, or authority.
import { spawn } from 'node:child_process';
import { constants, accessSync, chmodSync, closeSync, fstatSync, lstatSync, mkdirSync,
  mkdtempSync, openSync, readSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractStaticLibraryConstraintFormat } from './mac-library-constraints.mjs';

// Apple documents implicit top-level AND, validation-category 6 = Developer ID,
// team-identifier string, cdhash binary data and $in array (NOT hex strings):
// https://developer.apple.com/documentation/security/defining-launch-environment-and-library-constraints
// https://developer.apple.com/documentation/security/applying-launch-environment-and-library-constraints
// codesign(1), Apple's installed manual (public transcription):
// https://keith.github.io/xcode-man-pages/codesign.1.html
// --library-constraint takes this direct plist, not an invented DER envelope.
// Category 6 describes the hypothetical libraries, NOT our ad-hoc signer.
// Deliberately fake team and repeated-byte 20-byte hashes, never image digests.
export const policyPlist = `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0">
<dict>
  <key>validation-category</key><integer>6</integer>
  <key>team-identifier</key><string>ZZZZZZZZZZ</string>
  <key>cdhash</key>
  <dict><key>$in</key><array>
    <data>ERERERERERERERERERERERERERE=</data>
    <data>IiIiIiIiIiIiIiIiIiIiIiIiIiI=</data>
  </array></dict>
</dict>
</plist>
`;
export const inertSource = 'int main(void) { return 0; }\n';
const OPT_IN = '--allow-ad-hoc-format-fixture';
const MAX_LOG = 64 * 1024;
const fail = () => { throw new Error('format fixture failed; inspect private results locally'); };
function exclusive(path, data) {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, data); } finally { closeSync(fd); }
}
function readBounded(path, maximum, owned = false) {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size < 1 || st.size > maximum || (owned && (st.uid !== process.getuid() || st.nlink !== 1))) fail();
    const b = Buffer.alloc(st.size + 1);
    let at = 0, n;
    while (at < b.length && (n = readSync(fd, b, at, b.length - at, null)) > 0) at += n;
    if (at !== st.size || fstatSync(fd).size !== st.size) fail();
    return b.subarray(0, at);
  } finally { closeSync(fd); }
}
function safeExecutable(path) {
  const actual = realpathSync(path);
  if (!statSync(actual).isFile()) fail();
  accessSync(actual, constants.X_OK);
  return actual;
}

/**
 * Bounded single attempt. Only close (not exit, kill()'s return, or error) confirms
 * reaping/pipe closure. On limit/error/timeout kill the owned detached process
 * group once, wait at most two seconds for close, otherwise report UNCONFIRMED.
 * No retry or later pipeline steps after any failure. Arguments/output remain
 * private. Dependencies/limits are unit-test seams, not command-line options.
 */
export function runPrivateChild({ command, args, directory, label, env, deadlineMs = 15000 },
  { spawnChild = spawn, killGroup = pid => process.kill(-pid, 'SIGKILL'), closeGraceMs = 2000, cap = MAX_LOG } = {}) {
  const outFd = openSync(join(directory, `${label}.stdout.log`), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  let errFd;
  try { errFd = openSync(join(directory, `${label}.stderr.log`), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); }
  catch (e) { closeSync(outFd); throw e; }
  return new Promise(resolveResult => {
    let child, timer, grace, finished = false, leaderExited = false, failure = null, killAttempted = false, killSent = false;
    const outputs = [[], []], sizes = [0, 0], fds = [outFd, errFd];
    const finish = (code, signal, closeConfirmed) => {
      if (finished) return;
      finished = true; clearTimeout(timer); clearTimeout(grace);
      for (const fd of fds) {
        try { closeSync(fd); } catch { failure ??= 'log-close-error'; }
      }
      if (!closeConfirmed) {
        child?.stdout?.destroy(); child?.stderr?.destroy(); child?.unref();
      }
      resolveResult({ ok: closeConfirmed && !failure && code === 0 && signal === null,
        code, signal, failure, closeConfirmed, killAttempted, killSent,
        stdout: Buffer.concat(outputs[0]).toString('utf8'), stderr: Buffer.concat(outputs[1]).toString('utf8') });
    };
    const stop = why => {
      failure ??= why;
      if (finished || grace) return;
      // After exit, the former group leader's PID may be reused. Stuck pipes
      // do not justify signaling that numeric group ID after known leader death.
      if (!leaderExited && Number.isSafeInteger(child?.pid) && child.pid > 0) {
        killAttempted = true;
        try { killSent = killGroup(child.pid) !== false; } catch { /* NOT confirmation */ }
      }
      grace = setTimeout(() => finish(null, null, false), closeGraceMs);
    };
    try {
      child = spawnChild(command, args, { cwd: directory, env, shell: false, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      for (const [i, stream] of [child.stdout, child.stderr].entries()) {
        stream.on('error', () => stop('pipe-error'));
        stream.on('data', chunk => {
          if (finished) return;
          const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk), keep = b.subarray(0, Math.max(0, cap - sizes[i]));
          try {
            if (keep.length) { writeFileSync(fds[i], keep); outputs[i].push(Buffer.from(keep)); sizes[i] += keep.length; }
          } catch { stop('log-error'); }
          if (keep.length < b.length) stop('output-limit');
        });
      }
      child.on('error', () => stop('spawn-error'));
      child.on('close', (code, signal) => finish(code, signal, true));
      // exit stops future signaling but cannot resolve the attempt.
      child.on('exit', () => { leaderExited = true; });
      timer = setTimeout(() => stop('timeout'), deadlineMs);
    } catch { failure = 'spawn-error'; finish(null, null, false); }
  });
}

// Production always uses these defaults. Injection is solely for portable unit
// tests; no CLI/env configuration, arbitrary input path, PID or signing identity.
const nativeHost = { platform: process.platform, arch: process.arch, node: process.versions.node,
  tempRoot: tmpdir, notice: text => console.log(text), childDependencies: undefined,
  checkSystemTools: () => {
    for (const tool of ['/usr/bin/xcode-select', '/usr/bin/sw_vers', '/usr/sbin/sysctl', '/usr/bin/codesign']) safeExecutable(tool);
  } };
export async function collectFormatFixture(args, host = nativeHost) {
  if (args.length !== 1 || args[0] !== OPT_IN) throw new Error(`Explicit ${OPT_IN} required; no other arguments accepted`);
  if (host.platform !== 'darwin' || !['arm64', 'x64'].includes(host.arch) || !/^\d+\.\d+\.\d+$/.test(host.node) || Number(host.node.split('.')[0]) < 20) throw new Error('Native macOS and Node 20+ required');
  // No filesystem or child side effects before both checks above.
  const oldMask = process.umask(0o077);
  let directory, phase = 'setup';
  try {
    const root = realpathSync(host.tempRoot());
    directory = mkdtempSync(join(root, 'brian-library-format-'));
    chmodSync(directory, 0o700);
    const st = lstatSync(directory);
    if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid() || (st.mode & 0o777) !== 0o700 || realpathSync(dirname(directory)) !== root) fail();
    host.notice(`Private format-fixture results directory: ${directory}`);
    host.checkSystemTools(); // Filesystem checks only; never launch an installer shim.
    // Child HOME/temp/module caches are private. Never inherit developer overrides,
    // PATH shims, DYLD_*, compiler flags, keychain/provider credentials or proxies.
    const env = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', HOME: directory, TMPDIR: directory, LANG: 'C', LC_ALL: 'C' };
    let sequence = 0;
    const step = async (command, args, deadlineMs = 15000) => {
      const label = String(++sequence).padStart(2, '0');
      phase = `tool-${label}`;
      const result = await runPrivateChild({ command, args, directory, label, env, deadlineMs }, host.childDependencies);
      // Status contains no output/paths; detailed child text stays in private logs.
      exclusive(join(directory, `${label}.status.json`), JSON.stringify({ code: result.code, signal: result.signal,
        failure: result.failure, closeConfirmed: result.closeConfirmed, killAttempted: result.killAttempted, killSent: result.killSent }) + '\n');
      if (!result.ok) fail();
      return result.stdout;
    };
    // xcode-select -p only queries selection. Never invoke /usr/bin/clang,
    // xcrun, xcodebuild or --install: their missing-tools shims can open dialogs.
    const selection = (await step('/usr/bin/xcode-select', ['-p'])).trim();
    if (!selection.startsWith('/') || selection.includes('\n') || selection.includes('\0')) fail();
    phase = 'sdk-discovery';
    const developer = realpathSync(selection);
    const xcodeClang = join(developer, 'Toolchains/XcodeDefault.xctoolchain/usr/bin/clang');
    const cltClang = join(developer, 'usr/bin/clang');
    let compiler, sdk;
    if (statExists(xcodeClang)) {
      compiler = safeExecutable(xcodeClang);
      sdk = realpathSync(join(developer, 'Platforms/MacOSX.platform/Developer/SDKs/MacOSX.sdk'));
    } else {
      compiler = safeExecutable(cltClang);
      sdk = realpathSync(join(developer, 'SDKs/MacOSX.sdk'));
    }
    if (!statSync(sdk).isDirectory() || compiler === '/usr/bin/clang') fail();
    const sdkInfo = JSON.parse(readBounded(join(sdk, 'SDKSettings.json'), 256 * 1024));
    const sdkVersion = numericVersion(sdkInfo.Version);
    if (Number(sdkVersion.split('.')[0]) < 14) fail();
    const osVersion = numericVersion((await step('/usr/bin/sw_vers', ['-productVersion'])).trim());
    if (Number(osVersion.split('.')[0]) < 14) fail();
    const osBuild = (await step('/usr/bin/sw_vers', ['-buildVersion'])).trim();
    if (!/^[0-9]{2}[A-Z][0-9]{1,6}[a-z]?$/.test(osBuild)) fail();
    // Hardware capability, not guessed from Node/Rosetta host architecture.
    // Missing/unknown sysctl is unsupported; no fallback or retry.
    const arm = (await step('/usr/sbin/sysctl', ['-n', 'hw.optional.arm64'])).trim();
    if (!['0', '1'].includes(arm)) fail();
    const architecture = arm === '1' ? 'arm64' : 'x86_64';
    if (host.arch !== (arm === '1' ? 'arm64' : 'x64')) fail();
    const compilerOutput = await step(compiler, ['--version']);
    const match = /^Apple clang version ([0-9]+\.[0-9]+\.[0-9]+) \(clang-([0-9.]+)\)$/m.exec(compilerOutput);
    if (!match || match[1].length > 32 || match[2].length > 48) fail();
    // Only fixed filenames in this owned fresh private directory.
    const source = join(directory, 'inert.c'), policy = join(directory, 'library.coderequirement'), executable = join(directory, 'inert');
    exclusive(source, inertSource); exclusive(policy, policyPlist);
    mkdirSync(join(directory, 'module-cache'), { mode: 0o700 });
    await step(compiler, ['-arch', architecture, '-isysroot', sdk, '-mmacosx-version-min=14.0',
      '-O0', '-fno-modules', '-fmodules-cache-path=' + join(directory, 'module-cache'), source, '-o', executable], 60000);
    readBounded(executable, 4 * 1024 * 1024, true);
    chmodSync(executable, 0o600); // Never execute. codesign needs read/write, not +x.
    // --force replaces only a possible linker ad-hoc signature on THIS disposable
    // newly compiled file. No deep/preserve/remove-signature/keychain/identity args.
    await step('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', '--options', 'runtime',
      '--identifier', 'invalid.brian.library-constraint-format-fixture', '--enforce-constraint-validity',
      '--library-constraint', policy, executable], 30000);
    phase = 'signed-artifact';
    const signed = readBounded(executable, 4 * 1024 * 1024, true);
    chmodSync(executable, 0o600);
    if (signed.length < 32 || signed.readUInt32LE(4) !== (arm === '1' ? 0x0100000c : 0x01000007)) fail();
    phase = 'static-extraction';
    const extracted = extractStaticLibraryConstraintFormat(signed);
    const shareable = { schema: 1, kind: 'static-format-fixture', productionAuthority: false,
      kernelEvidence: false, cmsAuthentication: false, executed: false, derPolicyValidation: 'unsupported',
      policyPlist, rawLibraryConstraintBase64: extracted.rawBlob.toString('base64'),
      provenance: { macOS: osVersion, macOSBuild: osBuild, architecture, sdk: sdkVersion,
        node: host.node, appleClang: match[1], appleClangBuild: match[2],
        codesign: 'macOS system tool; version identified by macOS build', signing: 'ad-hoc', deploymentTarget: '14.0' } };
    const json = JSON.stringify(shareable, null, 2) + '\n';
    if (Buffer.byteLength(json) > 32 * 1024) fail();
    phase = 'write-result';
    exclusive(join(directory, 'format-fixture.json'), json);
    return shareable;
  } catch (error) {
    // Only fixed parser classifications may enter this small failure report.
    // Raw filesystem/tool errors stay out; private numbered child logs remain.
    let reason = 'operation-failed';
    if (phase === 'static-extraction' && error instanceof Error &&
        /^macOS library constraint: [A-Za-z0-9 /_-]{1,120}$/.test(error.message)) {
      reason = error.message.slice('macOS library constraint: '.length);
    }
    if (directory) {
      try { exclusive(join(directory, 'collection-failure.json'), JSON.stringify({ phase, reason, productionAuthority: false }) + '\n'); } catch { /* no overwrite or raw-error fallback */ }
    }
    // Never print or return child exceptions, tool output, source paths or hashes.
    fail();
  } finally { process.umask(oldMask); }
}
function statExists(path) {
  try { return statSync(path).isFile(); } catch (e) { if (e.code === 'ENOENT') return false; throw e; }
}
function numericVersion(text) {
  if (typeof text !== 'string' || !/^[0-9]{1,3}(\.[0-9]{1,3}){1,2}$/.test(text)) fail();
  return text;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  collectFormatFixture(process.argv.slice(2)).then(() => {
    console.log('FORMAT ONLY: format-fixture.json created. No execution or production authority.');
  }).catch(() => {
    console.error('Format fixture refused or failed. Requires native macOS, Node 20+, installed Apple tools and explicit --allow-ad-hoc-format-fixture. Inspect private results locally if created.');
    process.exitCode = 1;
  });
}
