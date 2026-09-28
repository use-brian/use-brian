import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BrowserApprovals } from '../browser-approvals.js';

const first = `persist:embedded-browser-${'a'.repeat(64)}`;
const second = `persist:embedded-browser-${'b'.repeat(64)}`;
let directory: string;
let filename: string;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'browser-approvals-test-')); filename = join(directory, 'approvals.json'); });
afterEach(() => rmSync(directory, { recursive: true, force: true }));
const store = () => new BrowserApprovals(() => filename);

describe('native standing approval persistence', () => {
  it('defaults to no consent when storage is missing', () => {
    expect(store().has(first)).toBe(false);
    expect(existsSync(filename)).toBe(false);
  });
  it('creates parent directories and persists only unique opaque partition keys across instances', () => {
    filename = join(directory, 'nested', 'approvals.json');
    store().grant(first); store().grant(second); store().grant(first);
    expect(store().has(first)).toBe(true); expect(store().has(second)).toBe(true);
    expect(JSON.parse(readFileSync(filename, 'utf8'))).toEqual([first, second]);
    expect(existsSync(`${filename}.tmp`)).toBe(false);
    if (process.platform !== 'win32') expect(statSync(filename).mode & 0o777).toBe(0o600);
  });
  it.each(['', '{broken', 'null', '{}', '42', '"string"'])('fails closed for corrupt or wrong-shaped storage: %j', contents => {
    writeFileSync(filename, contents);
    expect(store().has(first)).toBe(false);
    expect(() => store().grant(second)).not.toThrow();
    expect(store().has(second)).toBe(true); expect(store().has(first)).toBe(false);
  });
  it('ignores malformed keys while preserving valid grants', () => {
    const invalid = [null, 42, {}, 'profile', first.toUpperCase(), `${first}extra`, first.slice(0, -1)];
    writeFileSync(filename, JSON.stringify([first, ...invalid]));
    expect(store().has(first)).toBe(true);
    for (const key of invalid.filter((key): key is string => typeof key === 'string')) expect(store().has(key)).toBe(false);
    store().grant(second);
    expect(JSON.parse(readFileSync(filename, 'utf8'))).toEqual([first, second]);
  });
  it('fails closed without throwing when the storage path is unavailable', () => {
    writeFileSync(filename, 'not a directory'); filename = join(filename, 'approvals.json');
    expect(() => store().grant(first)).not.toThrow();
    expect(store().has(first)).toBe(false);
  });
  it('does not use leftover temporary files as consent', () => {
    writeFileSync(`${filename}.tmp`, JSON.stringify([first]));
    expect(store().has(first)).toBe(false);
    store().grant(second);
    expect(store().has(first)).toBe(false); expect(store().has(second)).toBe(true);
  });
});
