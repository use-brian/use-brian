// All drivers/oracles in this file are SYNTHETIC race reproductions, not live evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { manifest, parseEvidence } from './eval.mjs';
import { schedule, scheduleDigest } from './schedule.mjs';
import { syntheticRows } from './synthetic-test-data.mjs';
import { createSyntheticDriver } from './synthetic-driver.mjs';
import { createRecorder } from './recorder.mjs';
import { createEvidenceWriter, collect } from './collection.mjs';
import { createSyntheticSequentialDriver as createMainDriver } from './synthetic-sequential-driver.mjs';

const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const header = () => { const h = { ...syntheticRows()[0], version: 2, seed: 42 }; h.schedule = scheduleDigest(schedule(manifest, h.trials, h.seed)); return h; };
const temp = fn => async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'native-review-')));
  try { await fn(dir, join(dir, 'evidence.jsonl')); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
};
const rejectEvidence = path => assert.throws(() => parseEvidence(fs.readFileSync(path, 'utf8')));
const fill = writer => {
  const rows = syntheticRows().slice(1);
  for (const t of schedule(manifest, 1, header().seed)) writer.append(rows.find(r => r.fixture === t.fixture && r.lane === t.lane));
};

// Deterministic synchronous fault injection at the durable ready-file boundary.
// No test-only bypass is exposed by the production writer.
function atReadySync(dir, operation, run) {
  const original = fs.fsyncSync; let injected = false;
  fs.fsyncSync = fd => {
    original(fd);
    const ready = fs.readdirSync(dir).find(name => name.endsWith('.ready'));
    if (ready && !injected) { injected = true; operation(join(dir, ready)); }
  };
  syncBuiltinESMExports();
  try { run(); assert.equal(injected, true); }
  finally { fs.fsyncSync = original; syncBuiltinESMExports(); }
}

test('late first-run wrongWindow during second run invalidates collection even when driver catches it', temp(async (_dir, output) => {
  const driver = createSyntheticDriver(), original = driver.open;
  let opens = 0, firstHooks, stopped = 0, closes = 0;
  driver.stop = () => { stopped++; };
  driver.open = async (...args) => {
    const s = await original(...args), run = s.run; opens++;
    s.close = async () => { closes++; };
    const index = opens;
    s.run = async h => {
      if (index === 1) firstHooks = h;
      else {
        try { firstHooks.event('wrongWindow'); } catch {} // precise review repro
      }
      await run(h);
    };
    return s;
  };
  await assert.rejects(collect({ output, header: header(), driver, attended: true }), /^Error: Incomplete attended collection$/);
  await tick();
  assert.equal(opens, 2); assert.equal(stopped, 1); assert.equal(closes, 2);
  rejectEvidence(output);
}));

test('all old recorders are checked again at final publication, after ready-file fsync', temp(async (dir, output) => {
  const driver = createSyntheticDriver(), original = driver.open;
  let firstHooks, first = true, injected = false;
  driver.open = async (...args) => {
    const s = await original(...args), run = s.run;
    s.run = async h => { if (first) { firstHooks = h; first = false; } await run(h); };
    return s;
  };
  const originalSync = fs.fsyncSync;
  fs.fsyncSync = fd => {
    originalSync(fd);
    if (!injected && fs.readdirSync(dir).some(name => name.endsWith('.ready'))) {
      injected = true; try { firstHooks.event('wrongWindow'); } catch {}
    }
  };
  syncBuiltinESMExports();
  try { await assert.rejects(collect({ output, header: header(), driver, attended: true })); }
  finally { fs.fsyncSync = originalSync; syncBuiltinESMExports(); }
  assert.equal(injected, true); rejectEvidence(output);
}));

test('Stop opened during awaited task oracle prevents finalize; completed Stop and safety events survive', async () => {
  for (const completeStop of [false, true]) {
    const h = header(), task = schedule(manifest, 1, h.seed)[0];
    const s = await createSyntheticDriver().open(task, h), pending = deferred();
    const recorder = createRecorder({ header: h, case: task, consent: s.consent, oracle: { ...s.oracle, task: () => pending.promise } });
    await s.run(recorder.hooks);
    const result = recorder.finalize(await s.attest());
    const finish = recorder.hooks.beginStop(); recorder.hooks.event('wrongWindow');
    if (completeStop) finish();
    pending.resolve({ success: true });
    if (completeStop) {
      const row = await result; assert.equal(row.wrongWindow, 1); assert.ok(row.stopMs.length >= 1);
    } else {
      await assert.rejects(result, /^Error: Incomplete attended evidence$/);
      assert.throws(() => recorder.assertFinalized());
    }
  }
});

test('private leaf under a non-sticky writable ancestor is refused; sticky protected ancestor is allowed', temp(async (dir) => {
  const ancestor = join(dir, 'ancestor'), leaf = join(ancestor, 'private');
  fs.mkdirSync(ancestor, { mode: 0o700 }); fs.mkdirSync(leaf, { mode: 0o700 });
  for (const mode of [0o770, 0o777]) {
    fs.chmodSync(ancestor, mode);
    assert.throws(() => createEvidenceWriter(join(leaf, 'rejected'), header()), /^Error: Incomplete attended collection$/);
    assert.deepEqual(fs.readdirSync(leaf), []);
  }
  fs.chmodSync(ancestor, 0o1777);
  const w = createEvidenceWriter(join(leaf, 'protected'), header()); w.abandon();
  rejectEvidence(join(leaf, 'protected'));
}));

test('ancestor permissions becoming unsafe at ready sync block commit', temp(async (dir, output) => {
  const parent = join(dir, 'parent'), leaf = join(parent, 'private');
  fs.mkdirSync(parent, { mode: 0o700 }); fs.mkdirSync(leaf, { mode: 0o700 });
  const target = join(leaf, 'evidence.jsonl'), writer = createEvidenceWriter(target, header()); fill(writer);
  atReadySync(leaf, () => fs.chmodSync(parent, 0o770), () => assert.throws(() => writer.finalize()));
  rejectEvidence(target);
  fs.chmodSync(parent, 0o700);
}));

test('swapping whole ancestor path after ready sync does not redirect publication', temp(async (dir) => {
  const parent = join(dir, 'parent'), leaf = join(parent, 'private'), moved = join(dir, 'moved');
  fs.mkdirSync(parent, { mode: 0o700 }); fs.mkdirSync(leaf, { mode: 0o700 });
  const output = join(leaf, 'evidence.jsonl'), writer = createEvidenceWriter(output, header()); fill(writer);
  atReadySync(leaf, () => {
    fs.renameSync(parent, moved);
    fs.mkdirSync(parent, { mode: 0o700 }); fs.mkdirSync(leaf, { mode: 0o700 });
    fs.writeFileSync(output, 'do-not-replace', { mode: 0o600 });
  }, () => assert.throws(() => writer.finalize()));
  assert.equal(fs.readFileSync(output, 'utf8'), 'do-not-replace');
  rejectEvidence(join(moved, 'private', 'evidence.jsonl'));
}));

test('ready inode substitution, in-place content changes, extra links and broadened mode all reject', temp(async (dir) => {
  for (const kind of ['replace', 'content', 'link', 'mode']) {
    const sub = join(dir, kind); fs.mkdirSync(sub, { mode: 0o700 });
    const output = join(sub, 'evidence.jsonl'), writer = createEvidenceWriter(output, header()); fill(writer);
    atReadySync(sub, ready => {
      if (kind === 'replace') {
        const bytes = fs.readFileSync(ready); fs.renameSync(ready, ready + '.old');
        fs.writeFileSync(ready, bytes, { mode: 0o600 }); // same content, wrong inode
      } else if (kind === 'content') {
        const text = fs.readFileSync(ready, 'utf8').replace('"success":true', '"success":null');
        fs.writeFileSync(ready, text); // same length and inode, wrong hash
      } else if (kind === 'link') fs.linkSync(ready, ready + '.link');
      else fs.chmodSync(ready, 0o640);
    }, () => assert.throws(() => writer.finalize(), /^Error: Incomplete attended collection$/));
    rejectEvidence(output);
  }
}));

test('aborted pending driver.open resolves later: Stop immediate, late close called exactly once', temp(async (_dir, output) => {
  const pending = deferred(), entered = deferred(), controller = new AbortController();
  let closes = 0, stops = 0;
  const driver = { source: 'synthetic', stop() { stops++; }, open() { entered.resolve(); return pending.promise; } };
  const collecting = collect({ output, header: header(), driver, attended: true, signal: controller.signal });
  await entered.promise; controller.abort();
  assert.equal(stops, 1);
  await assert.rejects(collecting, /^Error: Incomplete attended collection$/);
  pending.resolve({ close() { closes++; return Promise.reject(new Error('PRIVATE-CLEANUP')); } });
  await tick(); await tick();
  assert.equal(closes, 1); assert.equal(stops, 1); rejectEvidence(output);
}));

test('failure stops immediately and closes current session once without awaiting hung cleanup', temp(async (_dir, output) => {
  const driver = createSyntheticDriver(), original = driver.open;
  let stopped = false, closes = 0;
  driver.stop = () => { stopped = true; };
  driver.open = async (...args) => {
    const s = await original(...args);
    s.run = async () => { throw new Error('PRIVATE-RUN'); };
    s.close = () => { assert.equal(stopped, true); closes++; return new Promise(() => {}); };
    return s;
  };
  await assert.rejects(collect({ output, header: header(), driver, attended: true }), /^Error: Incomplete attended collection$/);
  await tick(); assert.equal(closes, 1); rejectEvidence(output);
}));

test('quarantined synthetic adapter closes post-await aborted fixture session exactly once with generic error', async () => {
  const pending = deferred(), controller = new AbortController(); let closes = 0;
  const adapter = createMainDriver({ requireLocalFixtureSession: () => pending.promise, stopLocalExecutionGate() {} });
  const opening = adapter.open(schedule(manifest, 1, 42)[0], header(), controller.signal);
  controller.abort();
  pending.resolve({ closeAndDrain() { closes++; return Promise.reject(new Error('PRIVATE-DRAIN')); } });
  await assert.rejects(opening, /^Error: Incomplete attended collection$/);
  await tick(); assert.equal(closes, 1);
});

test('quarantined synthetic adapter unsubscribes on cancellation even when closeAndDrain hangs', async () => {
  const h = header(), task = schedule(manifest, 1, h.seed)[0], controller = new AbortController();
  const fake = await createSyntheticDriver().open(task, h);
  let closes = 0, unsubscribes = 0;
  const mainSession = {
    consent: fake.consent,
    subscribeLocalSafety() { return () => { unsubscribes++; }; },
    nextStep: () => new Promise(() => {}),
    closeAndDrain() { closes++; return new Promise(() => {}); },
  };
  const adapter = createMainDriver({ async requireLocalFixtureSession() { return mainSession; }, stopLocalExecutionGate() {} });
  const session = await adapter.open(task, h, controller.signal);
  void session.run({}, controller.signal); controller.abort();
  await tick(); assert.equal(closes, 1); assert.equal(unsubscribes, 1);
  void session.close(); await tick(); assert.equal(closes, 1);
});

test('protected-path fallback works without Linux procfs and still rejects ancestor replacement', temp(async (dir) => {
  const originalStat = fs.statSync;
  fs.statSync = (path, ...args) => {
    if (typeof path === 'string' && path.startsWith('/proc/self/fd/')) throw new Error('procfs unavailable');
    return originalStat(path, ...args);
  };
  syncBuiltinESMExports();
  try {
    const good = join(dir, 'good.jsonl'), writer = createEvidenceWriter(good, header());
    fill(writer); writer.finalize();
    assert.equal(parseEvidence(fs.readFileSync(good, 'utf8')).runs.length, 135);
    const old = join(dir, 'old'), moved = join(dir, 'moved'); fs.mkdirSync(old, { mode: 0o700 });
    const output = join(old, 'evidence.jsonl'), swapped = createEvidenceWriter(output, header()); fill(swapped);
    atReadySync(old, () => {
      fs.renameSync(old, moved); fs.mkdirSync(old, { mode: 0o700 });
      fs.writeFileSync(output, 'preserve', { mode: 0o600 });
    }, () => assert.throws(() => swapped.finalize()));
    assert.equal(fs.readFileSync(output, 'utf8'), 'preserve');
    rejectEvidence(join(moved, 'evidence.jsonl'));
  } finally { fs.statSync = originalStat; syncBuiltinESMExports(); }
}));
