import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = dirname(fileURLToPath(import.meta.url));

test('Linux executes production snapshot logic with syscall substitutions only in test translation units', { skip: process.platform !== 'linux' }, async t => {
  const temp = await mkdtemp(join(tmpdir(), 'kernel-signing-test-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const headers = {
    'libproc.h': `#include <stdint.h>\n#include <sys/types.h>\n#define PROC_PIDPATHINFO_MAXSIZE 4096\nint proc_pidinfo(int, int, uint64_t, void *, int);\nint proc_pidpath(int, void *, uint32_t);\nint getpeereid(int, uid_t *, gid_t *);\n`,
    'sys/proc_info.h': `#include <stdint.h>\n#include <sys/types.h>\n#define PROC_PIDTBSDINFO 3\nstruct proc_bsdinfo {\nuint32_t pbi_flags, pbi_status, pbi_xstatus, pbi_pid, pbi_ppid;\nuid_t pbi_uid; gid_t pbi_gid; uid_t pbi_ruid; gid_t pbi_rgid; uid_t pbi_svuid; gid_t pbi_svgid;\nuint32_t rfu_1; char pbi_comm[16]; char pbi_name[32];\nuint32_t pbi_nfiles, pbi_pgid, pbi_pjobc, e_tdev, e_tpgid; int32_t pbi_nice;\nuint64_t pbi_start_tvsec, pbi_start_tvusec; };\n`,
    'mach/message.h': 'typedef struct { unsigned int val[8]; } audit_token_t;\n',
  };
  for (const [name, contents] of Object.entries(headers)) {
    await mkdir(dirname(join(temp, name)), { recursive: true });
    await writeFile(join(temp, name), contents);
  }
  for (const missing of [false, true]) {
    const binary = join(temp, missing ? 'missing-entry' : 'snapshot');
    const args = ['-std=c11', '-D_DEFAULT_SOURCE', '-Wall', '-Wextra', '-Werror', '-O2', '-I', temp, '-I', root,
      ...(missing ? ['-DBRIAN_TEST_MISSING_CSOPS'] : []), join(root, 'KernelSigningSnapshotTests.c'), '-o', binary];
    const compile = spawnSync('cc', args, { encoding: 'utf8', timeout: 30_000 });
    assert.equal(compile.status, 0, `Host C compilation failed: ${compile.error ?? ''}\n${compile.stderr}`);
    const run = spawnSync(binary, [], { encoding: 'utf8', timeout: 5_000 });
    assert.equal(run.status, 0, `Shim execution failed: ${run.error ?? ''}\n${run.stdout}\n${run.stderr}`);
    assert.match(run.stdout, /PASS \d+ deterministic kernel snapshot cases/);
    console.log(run.stdout.trim());
  }
});

test('private ABI, read-only calls, generation guards and no authority bypass in production source', async () => {
  const source = await readFile(join(root, 'ProcessIdentity.c'), 'utf8');
  const header = await readFile(join(root, 'ProcessIdentity.h'), 'utf8');
  const added = source.slice(source.indexOf('// Private ABI pinned'));
  for (const marker of ['BRIAN_PROC_PIDUNIQIDENTIFIERINFO = 17', 'BRIAN_CS_OPS_STATUS = 0', 'BRIAN_CS_OPS_CDHASH = 5',
    'BRIAN_CS_OPS_PIDOFFSET = 6', '== 56', '== 32', '== 36', '== 40', '== 48',
    'p_orig_ppidversion', 'val[5]', 'val[7]', 'p_idversion', 'p_uniqueid',
    'BRIAN_KERNEL_INVALID_IDENTITY', 'BRIAN_KERNEL_INVALID_SLICE', 'BRIAN_KERNEL_MISSING_HASH',
    'csops_audittoken == NULL', 'count != size', 'getuid() != user', 'geteuid() != user',
    'info->pbi_svuid == user', 'caller_before', 'caller_after', '250000000ULL', 'BRIAN_KERNEL_UNTRUSTED_DATA',
    'memset(output, 0, sizeof(*output))', 'memcmp(&first, &last, sizeof(first))', 'a.status != b.status', 'a.offset != b.offset']) {
    assert(added.includes(marker), marker);
  }
  assert(!/getenv|dlsym|system\s*\(|execv|setuid|MARKINVALID|SET_STATUS|BRIAN_TEST|pbi_start_tv/.test(added));
  assert(added.includes('if (first.p_reserve2 || first.p_reserve3) return BRIAN_KERNEL_UNSUPPORTED_DATA;'));
  assert(!/if\s*\([^\n]*p_orig_ppidversion/.test(added));
  const shim = await readFile(join(root, 'KernelSigningSnapshotTests.c'), 'utf8');
  assert(shim.includes('memcpy(wire + 36, &original_parent, 4)'));
  assert(!shim.includes('struct brian_proc_uniqidentifierinfo'));
  assert(!/\bcsops\s*\(/.test(added.replace(/\/\/.*$/gm, '')));
  assert(header.includes('No result grants production authority'));
  const helper = await readFile(join(root, 'Helper.swift'), 'utf8');
  assert(!helper.includes('brian_kernel_signing_snapshot'));
  assert(helper.includes('let dispatcher = ObservationDispatcher { Broker(trust: trust) }'));
  assert(helper.includes('dispatcher.response(request, clock: sourceClock)'));
  const build = await readFile(join(root, 'build.sh'), 'utf8');
  assert(!build.includes('KernelSigningSnapshotTests') && !build.includes('KernelSigningProbe'));
});

test('probe accepts no PID/path options, inspects self, emits only fixed codes/booleans and avoids trust/UI/network APIs', async () => {
  const source = await readFile(join(root, 'KernelSigningProbe.c'), 'utf8');
  for (const marker of ['argc != 1', '(void)argv', 'brian_kernel_signing_snapshot(getpid(), getuid(), &before)',
    'brian_kernel_signing_snapshot(getpid(), getuid(), &after)', 'alarm(3)', '_exit(24)', 'production_authority',
    'kSecCodeAttributeUniversalFileOffset', 'kSecCodeInfoCdHashes', 'kSecCodeInfoUnique', 'selected > INT_MAX',
    'SecCodeCopySigningInformation(code, kSecCSDefaultFlags', '64 * 1024 * 1024', 'matched == 1']) assert(source.includes(marker), marker);
  assert(!/getenv|argv\[|SecStaticCodeCheckValidity\s*\(|SecTrustEvaluate|SecItemCopy|SecCodeCopyGuest|AppKit|AXUI|CGEvent|NSURLSession|socket\s*\(|system\s*\(|execv|posix_spawn|codesign/.test(source));
  const output = source.match(/printf\([^;]+;/gs) ?? [];
  assert.equal(output.length, 1);
  assert(!output[0].includes('path') && !output[0].includes('hash') && !output[0].includes('errno'));
});
