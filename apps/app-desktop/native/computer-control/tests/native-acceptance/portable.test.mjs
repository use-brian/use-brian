import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { cases, classify, preflightFailures } from './report.mjs';
import { command, decode, sourceFiles } from './run.mjs';
const file = name => readFile(new URL(name, import.meta.url), 'utf8');

test('pre-start refusals expose only closed reasons, never acceptance', async () => {
  const main = await file('main.swift');
  const blocked = { ...report('null'), started: false, records: [], localCounts: { 0: 0, 1: 0, 2: 0, 4: 0 } };
  assert.equal(classify(blocked).reason, 'preflight-unavailable'); // old reports remain readable
  for (const reason of preflightFailures) {
    assert(main.includes(`refusePreflight("${reason}")`));
    assert.deepEqual(classify({ ...blocked, preflightFailure: reason }), {
      verdict: 'blocked', reason, productionAcceptance: false,
    });
    assert.equal(classify({ ...report('null'), preflightFailure: reason }).reason, 'invalid-report');
    assert.equal(classify({ ...blocked, consented: false, preflightFailure: reason }).reason, 'invalid-report');
  }
  for (const reason of ['raw private error', {}, 1, false, undefined]) {
    assert.equal(classify({ ...blocked, preflightFailure: reason }).reason, 'invalid-report');
  }
  assert.equal(classify({ ...report('null'), preflightFailure: null }).verdict, 'observed-as-specified');
});

// Entirely synthetic protocol fixtures, never OS/proxy/delivery evidence.
function report(scenario = 'normal') {
  const r = { schema: 'native-mechanism-experiment.v1', case: scenario, productionAcceptance: false,
    consented: true, started: true, lost: false, os: 'Version 0.0 (Build TEST)', architecture: 'arm64', localCounts: {}, records: [] };
  const add = (source, code, ms) => r.records.push({ source, code, sequence: 0, ticks: String(1000000000n + BigInt(ms) * 1000000n) });
  add(0, 1, 0); add(0, 84, 1); add(0, 2, 2);
  add(3, 10, 10); add(1, 40, 11); add(3, 11, 12);
  if (scenario !== 'null') {
    add(3, 12, 20); add(3, 13, 21); add(3, 14, 22);
    const pre = ['paused-before-final-check', 'worker-death-before-check', 'parent-death-before-check', 'physical-before-check'].includes(scenario);
    if (!pre) add(3, 15, 23);
    if (scenario !== 'normal') {
      if (scenario.startsWith('after-down')) { add(3, 16, 24); add(1, 42, 25); add(2, 60, 26); }
      add(3, 20, 30); add(5, 90, 40);
      if (scenario.includes('worker-death')) { add(4, 7, 100); add(4, 81, 110); }
      if (scenario.includes('parent-death')) { add(4, 8, 100); add(4, 82, 110); }
      if (scenario.startsWith('physical-')) {
        add(1, 45, 200); add(2, 63, 201);
        if (scenario === 'physical-overlap') { add(1, 46, 300); add(2, 64, 301); }
      }
      if (scenario === 'after-down-owner-death') { add(4, 9, 100); add(4, 83, 110); }
      else {
        add(4, 6, 3030); add(3, 86, 3040); add(3, 93, 3041);
        if (pre) {
          if (scenario === 'physical-before-check') {
            add(3, 97, 3042); add(3, 100, 3043); add(0, 101, 3044);
            add(3, 18, 3046); add(1, 46, 3050); add(2, 64, 3051);
          } else add(3, 18, 3042);
        }
        else {
          if (!scenario.startsWith('after-down')) { add(3, 16, 3042); add(1, 42, 3043); add(2, 60, 3044); }
          add(3, 17, 3050); add(1, 43, 3051); add(2, 61, 3052); add(2, 62, 3053);
        }
      }
    } else {
      add(3, 16, 24); add(1, 42, 25); add(2, 60, 26); add(3, 17, 27);
      add(1, 43, 28); add(2, 61, 29); add(2, 62, 30);
    }
  }
  if (scenario !== 'after-down-owner-death') add(3, 19, 3600);
  add(0, 94, 8003); add(0, 4, 8010);
  normalize(r); return r;
}
function normalize(r) {
  r.records.sort((a, b) => Number(BigInt(a.ticks) - BigInt(b.ticks)));
  const seq = new Map();
  for (const row of r.records) { row.sequence = (seq.get(row.source) ?? 0) + 1; seq.set(row.source, row.sequence); }
  r.localCounts = Object.fromEntries([0, 1, 2, 4].map(s => [s, seq.get(s) ?? 0]));
}
function remove(r, source, code) { r.records = r.records.filter(x => x.source !== source || x.code !== code); normalize(r); return r; }
const verdict = r => classify(r).verdict;

test('closed finite case list matches Swift exactly; no arbitrary target/PID/point/yes interface', async () => {
  assert.equal(cases.length, 12); assert.equal(new Set(cases).size, 12);
  const swift = await file('Model.swift');
  for (const name of cases) assert(swift.includes(`"${name}"`) || swift.includes(`case ${name}`) || swift.includes(`, ${name},`));
  for (const name of cases) assert.deepEqual(command(['--run', name], 'darwin'), { mode: 'run', scenario: name });
  for (const args of [[], ['--yes'], ['--run', 'normal', '--yes'], ['--run', 'unknown'], ['--pid', '123'], ['--point', '1,2']]) assert.throws(() => command(args, 'darwin'));
  assert.throws(() => command(['--run', 'normal'], 'linux'));
});

test('valid null and normal remain observations, never production acceptance', () => {
  for (const name of ['null', 'normal']) {
    assert.equal(verdict(report(name)), 'observed-as-specified');
    assert.equal(classify(report(name)).productionAcceptance, false);
  }
});
for (const name of cases.filter(x => x !== 'null' && x !== 'normal')) {
  test(`finite fault case ${name} has explicit bounded verdict`, () => {
    const expected = name === 'after-down-owner-death' ? 'inconclusive' :
      name.includes('before-check') || name === 'paused-before-final-check' ? 'observed-as-specified' : 'counterexample';
    assert.equal(verdict(report(name)), expected);
    assert.equal(classify(report(name)).productionAcceptance, false);
  });
}
test('cancel and preflight refusal are blocked, not successful experiments', () => {
  const r = report(); r.records = []; normalize(r); r.started = false; r.consented = false;
  assert.equal(classify(r).reason, 'consent-declined');
  r.consented = true; assert.equal(classify(r).reason, 'preflight-unavailable');
});
test('consent cannot be forged by starting or emitting without it', () => {
  const r = report(); r.consented = false;
  assert.equal(classify(r).reason, 'consent-violation');
  r.consented = true; r.records.find(x => x.source === 0 && x.code === 1).ticks = '1050000000'; normalize(r);
  assert.equal(verdict(r), 'inconclusive');
});
test('missing phases, short windows, no terminal, no fixture up, or null loss are inconclusive', () => {
  for (const [s, c] of [[0, 4], [0, 94], [0, 84], [3, 11], [1, 40], [3, 14], [3, 19], [2, 61]]) assert.equal(verdict(remove(report(), s, c)), 'inconclusive');
  const short = report(); short.records.find(x => x.code === 94).ticks = '2000000000'; normalize(short);
  assert.equal(verdict(short), 'inconclusive');
});
test('record gaps, duplicates, unknown sources, types and extra content refuse', () => {
  for (const mutate of [r => r.records[1].sequence++, r => r.records.push(r.records[0]),
    r => r.records[0].source = 99, r => r.records[0].ticks = '-1', r => r.records[0].ticks = '9'.repeat(30),
    r => r.records[0].content = 'not permitted', r => r.productionAcceptance = true,
    r => r.case = 'arbitrary', r => r.records = new Array(2049).fill(r.records[0])]) {
    const r = report(); mutate(r); assert.equal(verdict(r), 'inconclusive');
  }
});
test('overflow, tap loss and uncertain resources prevent positive verdicts', () => {
  const lost = report(); lost.lost = true; assert.equal(verdict(lost), 'inconclusive');
  for (const [s, c] of [[1, 47], [0, 5], [0, 85]]) {
    const r = report(); r.records.push({ source: s, code: c, ticks: '6000000000' }); normalize(r);
    assert.equal(verdict(r), 'inconclusive');
  }
});
test('sleep/phase records do not substitute for observed stop, disable, death or physical exercise', () => {
  for (const [name, s, c] of [['last-check-to-post', 5, 90], ['last-check-to-post', 3, 93],
    ['worker-death-before-check', 4, 81], ['parent-death-after-check', 4, 82],
    ['physical-overlap', 1, 45], ['physical-overlap', 2, 64], ['physical-before-check', 2, 63]]) {
    assert.equal(verdict(remove(report(name), s, c)), 'inconclusive');
  }
});
test('after-check real death can expose late input without an OS timeout', () => {
  for (const name of ['worker-death-after-check', 'parent-death-after-check']) {
    assert.equal(classify(remove(report(name), 3, 93)).reason, 'input-observed-after-liveness-loss');
  }
});
test('observed duplicates and reversed input order are counterexamples, not cleanup proof', () => {
  const duplicate = report(); duplicate.records.push({ source: 1, code: 42, ticks: '1040000000' }); normalize(duplicate);
  assert.equal(classify(duplicate).reason, 'duplicate-sequence');
  const reversed = report(); reversed.records.find(x => x.source === 1 && x.code === 43).ticks = '1024000000'; normalize(reversed);
  assert.equal(classify(reversed).reason, 'up-before-observed-down');
});
test('malformed, mismatched and oversized transport cannot mint observations or export extra content', () => {
  for (const bytes of [Buffer.from('null'), Buffer.from('{}'), Buffer.from('invalid'), Buffer.alloc(262145)]) {
    assert.equal(decode(bytes, 'normal').verdict, 'inconclusive');
  }
  const r = report(); r.secret = 'not exported';
  const decoded = decode(Buffer.from(JSON.stringify(r)), 'normal');
  assert.equal(decoded.observation, undefined); assert.equal(decoded.productionAcceptance, false);
  assert.equal(decode(Buffer.from(JSON.stringify(report('null'))), 'normal').reason, 'case-mismatch');
});
test('GUI consent is per-case, timed, and cannot start children before confirmation/neutral foreground checks', async () => {
  const main = await file('main.swift');
  assert(main.includes('alert.runModal()')); assert(main.includes('check.state == .on'));
  assert(main.includes('timeInterval: 60'));
  const start = main.indexOf('func begin()');
  let previous = start;
  for (const guard of ['guard consented', 'guard experiment_cancelled() == 0', 'guard neutral()',
    'guard NSWorkspace.shared.frontmostApplication', 'guard CGPreflightListenEventAccess()',
    'guard CGPreflightPostEventAccess()', 'guard installObserver()', 'guard initialRect != nil',
    'guard experiment_gui_consent', 'experiment_start(']) {
    const index = main.indexOf(guard, start);
    assert(index > previous, guard); previous = index;
  }
  assert(main.includes('NSWorkspace.shared.frontmostApplication?.processIdentifier == getpid()'));
  assert(main.indexOf('record(0, .consent)') < main.indexOf('experiment_launch_owner()'));
  assert(main.includes('styleMask: [.borderless]')); assert(main.includes('width: 500, height: 350'));
});
test('exact emission sequence corresponds to candidate; shared allocation and pure ledger, no acceptance override', async () => {
  const [adapter, candidate, build] = await Promise.all([file('Adapter.swift'), file('../../ClickGuardianNative.swift'), file('build.sh')]);
  const insertion = 'down.tapPostEvent(proxy)', returned = 'return Unmanaged.passRetained(up)';
  for (const s of [adapter, candidate]) {
    assert.equal(s.split(insertion).length - 1, 1); assert.equal(s.split(returned).length - 1, 1);
    assert(s.indexOf(insertion) < s.indexOf(returned));
    assert(s.includes('retainedUp = up')); assert(s.includes('ledger.fence()'));
    assert(s.includes('event.type = .null')); assert(s.includes('let unchanged = Unmanaged.passUnretained(event)'));
  }
  assert(adapter.includes('ClickGuardianNative.preallocate')); assert(adapter.includes('ClickGuardianNativeLedger()'));
  assert(!adapter.includes('acceptsCurrentPlatform')); assert(!adapter.includes('ClickGuardianHost('));
  assert(candidate.includes('static let profiles: [ClickGuardianPlatformProfile] = []'))
  assert(candidate.includes('guard !profiles.isEmpty else { return false }'));
  assert(build.includes('"$root/ClickGuardianNative.swift"')); assert(!build.includes('sed '));
  assert(!adapter.includes('up.post(')); assert(!adapter.includes('down.post('));
});
test('real owner parent topology, checked suspension, group lifetime fence and bounded nonblocking records', async () => {
  const [c, main, adapter] = await Promise.all([file('Experiment.c'), file('main.swift'), file('Adapter.swift')]);
  assert(c.includes('experiment_parent_run')); assert(c.includes('if (!launch(3)'));
  assert(c.includes('experiment_accept(expected_role, &config)')); assert(adapter.includes('getppid() == config.parent'));
  assert(c.includes('WEXITED | WNOHANG | WNOWAIT')); assert(c.includes('POSIX_SPAWN_SETPGROUP'));
  assert(c.includes('kill(-children[1], sig)')); assert(c.includes('SIGKILL); // no resume before kill'));
  assert(c.includes('O_NONBLOCK')); assert(c.includes('sequences[source] >= 2048'));
  assert(main.includes('experiment_owner_stopped() == 1')); assert(main.includes('records.count < 2048'));
  assert(main.includes('now - startTime >= 8')); assert(main.includes('experiment_cleanup()'));
  assert(!c.includes('system(')); assert(!c.includes('popen('));
});
test('production build and packaging exclude this experiment; ordinary guardian tests stay non-emitting', async () => {
  const [build, packaging, guardian, dispatcher] = await Promise.all([
    file('../../build.sh'), file('../../../../electron-builder.yml'), file('../../guardian-tests.mjs'), file('../../Helper.swift')]);
  for (const text of [build, packaging, guardian, dispatcher]) {
    assert(!text.includes('native-acceptance')); assert(!text.includes('NativeMechanismExperiment')); assert(!text.includes('MechanismOwner'));
  }
  assert(packaging.includes('from: native/computer-control/build/brian-native-computer-helper'));
  assert(packaging.includes('from: native/computer-control/build/NativeComputerFixture.app'));
  assert(!build.includes('*.swift')); assert(!build.includes('find '));
  assert(guardian.includes('20 reviewed non-emitting tests'));
  assert(sourceFiles.includes('../../ClickGuardianNative.swift'));
});
test('build script is syntax-valid and compile-only; no signing, permission or production script invocation', async () => {
  const build = await file('build.sh');
  const lines = build.split('\n').filter(s => !s.trim().startsWith('#')).join('\n');
  assert(!/\bcodesign\b|sudo|curl|pnpm|npm|--run|open -a/.test(lines));
  assert.equal(spawnSync('bash', ['-n', fileURLToPath(new URL('build.sh', import.meta.url))]).status, 0);
});
test('portable C bridge record layout compiles without executing a binary', t => {
  const check = spawnSync('cc', ['-std=c11', '-Wall', '-Wextra', '-Werror', '-fsyntax-only', '-x', 'c', '-'], {
    input: '#include "Experiment.h"\n_Static_assert(sizeof(ExperimentRecord) == 24, "record width");\n_Static_assert(offsetof(ExperimentRecord,ticks) == 16, "tick offset");\n_Static_assert(sizeof(ExperimentConfig) == 40, "config width");\n',
    cwd: fileURLToPath(new URL('.', import.meta.url)), encoding: 'utf8', timeout: 10000,
  });
  if (check.error?.code === 'ENOENT') return t.skip('No local C compiler');
  assert.equal(check.status, 0, check.stderr);
});

// Truncation cannot be detected merely by contiguous prefix sequence numbers.
test('final local record counts reject a truncated last observer/fixture record', () => {
  for (const source of [1, 2, 4]) {
    const r = report();
    r.records.push({ source, code: source === 1 ? 44 : source === 2 ? 64 : 83, ticks: '7000000000' }); normalize(r);
    const index = r.records.findLastIndex(row => row.source === source);
    r.records.splice(index, 1); // retain the producer's final count
    assert.equal(classify(r).reason, 'incomplete-record-stream');
  }
});
test('orphan-group automatic resume is distinguished from requested resume', () => {
  const r = remove(report('parent-death-after-check'), 4, 6);
  r.records.push({ source: 3, code: 95, ticks: '4041500000' }); normalize(r);
  assert.equal(classify(r).reason, 'input-observed-after-liveness-loss');
});
test('a delayed disable notification alone does not prove disabled state at resume', () => {
  const r = remove(report('last-check-to-post'), 3, 93);
  r.records.push({ source: 3, code: 21, ticks: '4090000000' }); normalize(r);
  assert.equal(classify(r).reason, 'tap-disable-not-observed-at-resume');
});

test('native bootstrap policy compiles/runs synthetic identity and closed-topology regression seams', async t => {
  const directory = fileURLToPath(new URL('.', import.meta.url));
  await mkdir(new URL('.build/portable/', import.meta.url), { recursive: true });
  const binary = fileURLToPath(new URL('.build/portable/bootstrap-policy-tests', import.meta.url));
  const compile = spawnSync('cc', ['-std=c11', '-Wall', '-Wextra', '-Werror', 'BootstrapPolicyTests.c', '-o', binary],
    { cwd: directory, encoding: 'utf8', timeout: 10000 });
  if (compile.error?.code === 'ENOENT') return t.skip('No local C compiler');
  assert.equal(compile.status, 0, compile.stderr);
  const run = spawnSync(binary, [], { encoding: 'utf8', timeout: 10000 });
  assert.equal(run.status, 0, run.stderr); assert.match(run.stdout, /PASS 95 synthetic bootstrap/);
});
test('bootstrap credentials and original lifetime pins precede private grant and any native wake', async () => {
  const [bootstrap, c, main, adapter, build] = await Promise.all(['Bootstrap.c', 'Experiment.c', 'main.swift', 'Adapter.swift', 'build.sh'].map(file));
  assert(bootstrap.includes('proc_pidpath(pid, out->path'));
  assert(bootstrap.includes('PROC_PIDTBSDINFO')); assert(bootstrap.includes('PROC_PIDREGIONPATHINFO'));
  assert(bootstrap.includes('out->mapped_inode == file->st_ino')); assert(bootstrap.includes('O_RDONLY | O_CLOEXEC | O_NOFOLLOW'));
  assert(bootstrap.includes('experiment_same_executable')); assert(bootstrap.includes('LOCAL_PEERPID'));
  assert(bootstrap.includes('getpeereid(3, &uid, &gid)'));
  const accept = bootstrap.slice(bootstrap.indexOf('int experiment_accept('));
  assert(accept.indexOf('hold(parent_pid)') < accept.indexOf('transfer(3, &grant'));
  assert(accept.indexOf('getpeereid(') < accept.indexOf('transfer(3, &grant'));
  assert(accept.includes('hold(parent->id.ppid)'));
  assert(accept.includes('admitted.supervisor = supervisor->id.pid'));
  assert(accept.includes('window_owner(grant.config.window)'));
  assert(accept.includes('grant.recipient != getpid()'));
  assert(accept.includes('record.st_ino != grant.record_inode'));
  const hold = bootstrap.slice(bootstrap.indexOf('static struct Pin *hold('), bootstrap.indexOf('int experiment_bootstrap_live'));
  assert(hold.indexOf('brian_epoch_fence_create(pid)') < hold.indexOf('snapshot(pid,'));
  assert(bootstrap.includes('reply.nonce != grant.nonce')); assert(bootstrap.includes('!pins_current()'));
  assert(!bootstrap.includes('brian_epoch_fence_destroy(')); // originals survive through runtime
  assert(c.includes('experiment_claim_launch(role)')); assert(c.includes('experiment_issue('));
  assert(!c.includes('write(p[1], &c')); assert(!main.includes('--owned-child'));
  for (const role of ['parent', 'worker', 'owner']) assert(main.includes(`--owned-${role}`));
  assert(main.indexOf('check.state == .on') < main.indexOf('experiment_gui_consent('));
  assert(main.includes('experiment_supervisor_init()'));
  assert(adapter.includes('guard experiment_bootstrap_live() == 1'));
  assert(adapter.includes('experiment_bootstrap_live() == 1 && getppid()'));
  assert(build.includes('-c Bootstrap.c')); assert(build.includes('"$out/Bootstrap.o"'));
});
test('held-input case requires the actual resumed held-left/nonneutral sample, not deadline refusal', () => {
  for (const code of [97, 100]) assert.equal(verdict(remove(report('physical-before-check'), 3, code)), 'inconclusive');
  for (const [old, replacement] of [[97, 98], [100, 99]]) {
    const r = report('physical-before-check'); r.records.find(x => x.source === 3 && x.code === old).code = replacement;
    assert.equal(classify(r).reason, 'held-left-final-sample-not-established');
  }
});
test('early physical release in either observer or fixture, including both ups before resume, is inconclusive', () => {
  for (const sources of [[1], [2], [1, 2]]) {
    const r = report('physical-before-check');
    for (const source of sources) {
      r.records.find(x => x.source === source && x.code === (source === 1 ? 46 : 64)).ticks = '4020000000';
    }
    normalize(r);
    assert.equal(classify(r).reason, 'physical-released-before-final-sample');
  }
  const r = report('physical-before-check');
  r.records.find(x => x.source === 1 && x.code === 46).ticks = '4042500000'; normalize(r);
  assert.equal(classify(r).reason, 'physical-released-before-final-sample');
});
test('release cue must follow the sample, and the GUI does not cue release merely on resume', async () => {
  const r = report('physical-before-check');
  r.records.find(x => x.source === 0 && x.code === 101).ticks = '4020000000'; normalize(r);
  assert.equal(classify(r).reason, 'held-release-cue-not-established');
  assert.equal(verdict(remove(report('physical-before-check'), 0, 101)), 'inconclusive');
  const [main, adapter] = await Promise.all([file('main.swift'), file('Adapter.swift')]);
  assert(main.includes('Code.finalSampleNonNeutral.rawValue'));
  assert(main.includes('record(0, .heldReleaseCue)'));
  assert(main.includes('else if !heldSampleReceived'));
  assert(adapter.indexOf('record(3, heldLeft ?') < adapter.indexOf('guard scope(), (sampledNeutral'));
  for (const sample of ['NSEvent.pressedMouseButtons & 1', 'buttonState(.hidSystemState, button: .left)', 'buttonState(.combinedSessionState, button: .left)']) assert(adapter.includes(sample));
});
