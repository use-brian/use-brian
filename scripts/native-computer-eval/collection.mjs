import { constants, openSync, closeSync, writeFileSync, fsyncSync, fstatSync, lstatSync, renameSync, unlinkSync, readSync } from 'node:fs';
import { basename, dirname, isAbsolute, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { manifest, validateHeader, validateRun, parseEvidence, limits } from './eval.mjs';
import { schedule } from './schedule.mjs';
import { createRecorder, validateConsent } from './recorder.mjs';
import { openProtectedDirectory } from './protected-directory.mjs';
const error = () => new Error('Incomplete attended collection');

export function readPrivateConfig(path) {
  if (!isAbsolute(path)) throw error();
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size < 1 || stat.size > limits.lineBytes) throw error();
    const b = Buffer.alloc(stat.size + 1); let used = 0;
    while (used < b.length) { const n = readSync(fd, b, used, b.length - used, null); if (!n) break; used += n; }
    if (used !== stat.size) throw error();
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(b.subarray(0, used));
  } finally { closeSync(fd); }
}

/** One synchronous writer; each bounded validated line is appended and fsynced.
 * The reserved public path stays INVALID until a fully validated, fsynced file
 * is atomically renamed over our own inode. The .partial journal never receives
 * a completion footer, even if all runs were recorded before a crash.
 */
export function createEvidenceWriter(output, header) {
  let directory, reserved, journal;
  const close = () => {
    for (const fd of [reserved, journal]) if (fd !== undefined) { try { closeSync(fd); } catch {} }
    reserved = journal = undefined;
    try { directory?.close(); } catch {}
  };
  try {
    header = Object.freeze({ ...validateHeader(header) });
    if (header.source !== 'synthetic' || header.version !== 2 || !isAbsolute(output) || output !== resolve(output)) throw error();
    directory = openProtectedDirectory(dirname(output));
    const name = basename(output), published = directory.entry(name);
    const flags = constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
    directory.revalidate();
    reserved = openSync(published, flags, 0o600);
    const identity = fstatSync(reserved), marker = '{"type":"incomplete","version":2}\n';
    writeFileSync(reserved, marker); fsyncSync(reserved);
    const partial = directory.entry(`${name}.${randomUUID()}.partial`);
    directory.revalidate();
    journal = openSync(partial, flags, 0o600);
    const journalIdentity = fstatSync(journal);
    let done = false, failed = false, total = 0, count = 0;
    const lines = [], expected = schedule(manifest, header.trials, header.seed);
    const hash = text => createHash('sha256').update(text).digest('hex');
    const sameFile = (s, id) => s.isFile() && s.dev === id.dev && s.ino === id.ino && s.uid === process.getuid() && s.nlink === 1 && (s.mode & 0o7777) === 0o600;
    const checkFile = (fd, path, id, text) => {
      directory.revalidate();
      if (!sameFile(fstatSync(fd), id) || !sameFile(lstatSync(path), id)) throw error();
      if (text !== undefined) {
        const size = Buffer.byteLength(text);
        if (fstatSync(fd).size !== size) throw error();
        const digest = createHash('sha256'), buffer = Buffer.alloc(65536);
        for (let offset = 0; offset < size;) {
          const n = readSync(fd, buffer, 0, Math.min(buffer.length, size - offset), offset);
          if (!n) throw error(); digest.update(buffer.subarray(0, n)); offset += n;
        }
        if (digest.digest('hex') !== hash(text) || fstatSync(fd).size !== size) throw error();
      }
      directory.revalidate();
      if (!sameFile(fstatSync(fd), id) || !sameFile(lstatSync(path), id)) throw error();
    };
    const line = obj => {
      const text = JSON.stringify(obj) + '\n';
      if (Buffer.byteLength(text) > limits.lineBytes || total + Buffer.byteLength(text) > limits.bytes - 1024) throw error();
      return text;
    };
    const appendText = text => {
      checkFile(reserved, published, identity, marker);
      checkFile(journal, partial, journalIdentity);
      writeFileSync(journal, text); fsyncSync(journal);
      directory.revalidate(); lines.push(text); total += Buffer.byteLength(text);
    };
    appendText(line(header)); directory.sync();
    return Object.freeze({
      append(run) {
        try {
          if (done || failed || count >= expected.length) throw error();
          validateRun(header, run);
          if (['fixture', 'lane', 'trial'].some(k => run[k] !== expected[count][k])) throw error();
          appendText(line(run)); count++;
        } catch { failed = true; throw error(); }
      },
      finalize(assertIntegrity = () => {}) {
        let readyFd, ready, readyIdentity;
        try {
          if (done || failed || count !== expected.length) throw error();
          assertIntegrity();
          const body = lines.join('');
          const footer = { type: 'complete', version: 2, runs: count, digest: hash(body) };
          const completed = body + line(footer);
          parseEvidence(completed);
          checkFile(journal, partial, journalIdentity, body);
          checkFile(reserved, published, identity, marker);
          ready = directory.entry(`${name}.${randomUUID()}.ready`);
          directory.revalidate();
          readyFd = openSync(ready, flags, 0o600); readyIdentity = fstatSync(readyFd);
          writeFileSync(readyFd, completed); fsyncSync(readyFd);
          // Keep the FD open. Check both the inode behind the name and its
          // actual bytes/link count/mode immediately before atomic publication.
          checkFile(reserved, published, identity, marker);
          checkFile(readyFd, ready, readyIdentity, completed);
          directory.revalidate(); assertIntegrity();
          renameSync(ready, published); ready = undefined;
          directory.sync();
          closeSync(readyFd); readyFd = undefined;
          checkFile(journal, partial, journalIdentity, body);
          unlinkSync(partial); directory.sync(); done = true; close();
        } catch {
          failed = true;
          // Do not unlink a substituted path or traverse a changed ancestor.
          if (ready && readyFd !== undefined) {
            try { checkFile(readyFd, ready, readyIdentity); unlinkSync(ready); } catch {}
          }
          if (readyFd !== undefined) { try { closeSync(readyFd); } catch {} }
          close(); throw error();
        }
      },
      abandon() { failed = true; close(); },
    });
  } catch { close(); throw error(); }
}

function abortable(work, signal, onLate = () => {}) {
  if (signal?.aborted) return Promise.reject(error());
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => signal?.removeEventListener('abort', abort);
    const abort = () => { if (!settled) { settled = true; cleanup(); reject(error()); } };
    signal?.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => { if (signal?.aborted) throw error(); return work(); }).then(value => {
      cleanup();
      if (settled || signal?.aborted) {
        try { Promise.resolve(onLate(value)).catch(() => {}); } catch {}
        if (!settled) { settled = true; reject(error()); }
      } else { settled = true; resolve(value); }
    }, () => { cleanup(); if (!settled) { settled = true; reject(error()); } });
  });
}

/** Trusted driver executes; this module supplies no grants, effect approvals,
 * secrets, IPC or model-selected executable paths. A thrown run aborts the
 * entire collection; an observed failed task is a normal success:false row.
 */
export async function collect({ output, header, driver, attended, signal, clock }) {
  header = Object.freeze({ ...validateHeader(header) });
  if (header.source !== 'synthetic' || !attended || header.version !== 2 || !driver || driver.source !== header.source || typeof driver.open !== 'function' || typeof driver.stop !== 'function' || (clock && header.source !== 'synthetic')) throw error();
  const writer = createEvidenceWriter(output, header);
  const controller = new AbortController(), recorders = [], closing = new WeakMap();
  let session, invalid = false, stopped = false;
  const stop = () => {
    if (stopped) return; stopped = true;
    try { Promise.resolve(driver.stop()).catch(() => {}); } catch {}
  };
  const invalidate = () => {
    invalid = true;
    stop(); // Independent gate first; never wait for hung model/helper/cleanup.
    controller.abort();
  };
  const closeSession = value => {
    if (!value || (typeof value !== 'object' && typeof value !== 'function')) return Promise.resolve();
    if (!closing.has(value)) {
      const pending = Promise.resolve().then(() => value.close()).catch(() => { throw error(); });
      closing.set(value, pending); pending.catch(() => {});
    }
    return closing.get(value);
  };
  const assertAll = () => {
    if (invalid || controller.signal.aborted) throw error();
    for (const r of recorders) r.assertFinalized();
  };
  signal?.addEventListener('abort', invalidate, { once: true });
  try {
    if (signal?.aborted) invalidate();
    for (const task of schedule(manifest, header.trials, header.seed)) {
      assertAll();
      // If cancellation wins this await, abortable retains ownership of a late
      // result and closes it exactly once rather than discarding its resources.
      session = await abortable(() => driver.open(Object.freeze({ ...task }), header, controller.signal), controller.signal, closeSession);
      if (!session || ['run', 'attest', 'close'].some(k => typeof session[k] !== 'function')) throw error();
      validateConsent(header, session.consent);
      const recorder = createRecorder({ header, case: task, consent: session.consent, oracle: session.oracle, signal: controller.signal, clock, onInvalidate: invalidate });
      recorders.push(recorder); // Retain every recorder through final publication.
      await abortable(() => session.run(recorder.hooks, controller.signal), controller.signal);
      const attestation = await abortable(() => session.attest(), controller.signal);
      const run = await abortable(() => recorder.finalize(attestation), controller.signal);
      await abortable(() => closeSession(session), controller.signal);
      assertAll(); writer.append(run); session = null;
    }
    assertAll();
    writer.finalize(assertAll); // Recheck ALL recorders at the actual commit gate.
    return { runs: recorders.length, releaseStatus: 'pending', routingProfileApproval: false };
  } catch {
    invalidate();
    for (const recorder of recorders) recorder.invalidate();
    // Initiate cleanup but do not await a blocked drain or surface its errors.
    closeSession(session).catch(() => {});
    try { writer.abandon(); } catch {}
    throw error();
  } finally { signal?.removeEventListener('abort', invalidate); }
}
