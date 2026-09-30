import { EventEmitter } from 'node:events';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DownloadItem } from 'electron';
import { BrowserFiles, DOWNLOAD_CHUNK, DOWNLOAD_LIMIT, UPLOAD_LIMIT } from '../browser-files.js';

class Item extends EventEmitter {
  path = ''; received = 0; total = 0;
  getTotalBytes() { return this.total; }
  getReceivedBytes() { return this.received; }
  getFilename() { return '../../timetable.pdf'; }
  getMimeType() { return 'application/pdf'; }
  setSavePath(path: string) { this.path = path; }
  cancel = vi.fn(() => this.emit('done', {}, 'cancelled'));
}
const managers: BrowserFiles[] = [];
function setup() {
  const status = vi.fn();
  const files = new BrowserFiles(status); managers.push(files);
  const item = new Item();
  return { files, item, status, capture: () => files.capture(item as unknown as DownloadItem) };
}
afterEach(() => { for (const files of managers.splice(0)) files.dispose(); vi.useRealTimers(); });

describe('private browser file session', () => {
  it('captures actual downloaded bytes and exposes bounded chunks, never a local path', async () => {
    const { files, item, capture } = setup(); capture();
    const bytes = Buffer.alloc(DOWNLOAD_CHUNK + 3, 65);
    await writeFile(item.path, bytes);
    item.received = bytes.length; item.emit('done', {}, 'completed');
    const entry = files.list().downloads[0]!;
    expect(entry).toMatchObject({ name: '.._.._timetable.pdf', state: 'completed', size: bytes.length });
    expect(entry).not.toHaveProperty('path');
    expect(item.path).not.toContain('timetable');
    const first = await files.read(entry.id, 0);
    expect(Buffer.from(first.data, 'base64')).toHaveLength(DOWNLOAD_CHUNK);
    expect(await files.read(entry.id, DOWNLOAD_CHUNK)).toEqual({ offset: DOWNLOAD_CHUNK, total: bytes.length, data: 'QUFB' });
    await expect(files.read(entry.id, -1)).rejects.toThrow('offset');
    await expect(files.read(entry.id, bytes.length + 1)).rejects.toThrow('offset');
    await expect(files.read('/etc/passwd', 0)).rejects.toThrow('unknown');
    const other = setup().files;
    await expect(other.read(entry.id, 0)).rejects.toThrow('unknown');
    files.dispose();
    await expect(files.read(entry.id, 0)).rejects.toThrow('closed');
    await vi.waitFor(async () => { await expect(stat(item.path)).rejects.toThrow(); });
  });
  it('does not expose progressing downloads and cancels unknown-length files over the limit', async () => {
    const { files, item, capture } = setup(); capture();
    const id = files.list().downloads[0]!.id;
    await expect(files.read(id, 0)).rejects.toThrow('not completed');
    item.received = DOWNLOAD_LIMIT + 1; item.emit('updated', {}, 'progressing');
    expect(item.cancel).toHaveBeenCalledOnce();
    expect(files.list().downloads[0]).toMatchObject({ state: 'cancelled', size: 0, error: expect.stringContaining('32 MiB') });
  });
  it('rejects known oversized downloads before choosing a destination', () => {
    const { item, capture, files } = setup(); item.total = DOWNLOAD_LIMIT + 1; capture();
    expect(item.cancel).toHaveBeenCalledOnce(); expect(item.path).toBe('');
    expect(files.list().downloads).toEqual([]);
  });
  it('reserves storage for concurrent downloads and releases files on Stop', () => {
    const { files } = setup();
    const items = Array.from({ length: 5 }, () => new Item());
    for (const item of items) files.capture(item as unknown as DownloadItem);
    expect(files.list().downloads).toHaveLength(4);
    expect(items[4]!.cancel).toHaveBeenCalledOnce();
    files.dispose();
    for (const item of items) expect(item.cancel).toHaveBeenCalledOnce();
  });
  it('bounds stalled downloads', () => {
    vi.useFakeTimers(); const { capture, item, files } = setup(); capture();
    vi.advanceTimersByTime(120_000);
    expect(item.cancel).toHaveBeenCalledOnce();
    expect(files.list().downloads[0]!.error).toMatch(/timed out/);
  });
  it('stages only bounded canonical bytes under a private path', async () => {
    const { files } = setup();
    const path = await files.stageUpload('report.pdf', Buffer.from('approved file').toString('base64'));
    expect(await readFile(path, 'utf8')).toBe('approved file');
    expect(path.endsWith('/report.pdf')).toBe(true);
    for (const name of ['../secret', '/etc/passwd', '.', '..', 'a\\b']) await expect(files.stageUpload(name, '')).rejects.toThrow('filename');
    for (const value of ['%%%=', 'a===', 'YR==', 'abc']) await expect(files.stageUpload('report.pdf', value)).rejects.toThrow();
    await expect(files.stageUpload('large.pdf', Buffer.alloc(UPLOAD_LIMIT + 1).toString('base64'))).rejects.toThrow();
    // Maximum supported payload must not overflow a regexp stack.
    const large = await files.stageUpload('large.pdf', Buffer.alloc(UPLOAD_LIMIT).toString('base64'));
    expect((await stat(large)).size).toBe(UPLOAD_LIMIT);
    files.dispose();
    await vi.waitFor(async () => { await expect(stat(path)).rejects.toThrow(); });
  });
});
