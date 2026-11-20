import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BrowserPreferences } from '../browser-preferences.js';

let directory: string;
let filename: string;
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'browser-preference-')); filename = join(directory, 'preferences.json'); });
afterEach(() => rmSync(directory, { recursive: true, force: true }));
const store = () => new BrowserPreferences(() => filename);

describe('[COMP:app-desktop/embedded-browser] persistent device preference', () => {
  it('defaults on and retains an explicit off and on across fresh instances', () => {
    expect(store().enabled()).toBe(true);
    store().setEnabled(false);
    expect(store().enabled()).toBe(false);
    expect(JSON.parse(readFileSync(filename, 'utf8'))).toEqual({ browserEnabled: false });
    store().setEnabled(true);
    expect(store().enabled()).toBe(true);
  });
  it.each(['', '{broken', 'null', '{}', '{"browserEnabled":"false"}'])('does not enable access for invalid storage %j', value => {
    writeFileSync(filename, value); expect(store().enabled()).toBe(false);
  });
  it('reports failed saves without changing the last saved setting', () => {
    const preferences = store(); preferences.setEnabled(false);
    filename = join(filename, 'child.json');
    expect(() => preferences.setEnabled(true)).toThrow();
    expect(preferences.enabled()).toBe(false);
    expect(store().enabled()).toBe(false);
  });
  it.each([null, 'false', 0, {}, undefined])('rejects invalid IPC values %j', value => {
    expect(() => store().setEnabled(value)).toThrow();
  });
});
