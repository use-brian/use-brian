// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const recover = vi.fn(), process = vi.fn();
vi.mock('@/lib/api/recordings', () => ({ recoverRecording: (...args: unknown[]) => recover(...args) }));
vi.mock('@/lib/recordings/confirm-and-process', () => ({ confirmAndProcessRecording: (...args: unknown[]) => process(...args) }));
vi.mock('@/lib/i18n/client', () => ({ useT: () => ({ recordings: {
 processTranscribe: 'Transcribe', processRetry: 'Retry transcription', processPreparing: 'Preparing',
 processQueued: 'Queued', processActionFailed: 'Could not start', recoveryBody: 'Reuse saved audio',
} }) }));
import { RecordingProcessAction } from '../recording-process-action';

describe('[COMP:app-web/recording-chrome] transcription and recovery action', () => {
 let root: Root, el: HTMLDivElement;
 beforeEach(() => { recover.mockReset(); process.mockReset().mockResolvedValue({ outcome: 'queued' }); el = document.createElement('div'); document.body.append(el); root = createRoot(el); });
 afterEach(() => { act(() => root.unmount()); el.remove(); });
 async function render(recovery = false) {
  await act(async () => root.render(<RecordingProcessAction workspaceId="ws" recordingId="old" mime="audio/webm"
   recovery={recovery ? { recordingId: 'old', replacementId: null, title: 'Memo', mime: 'audio/webm' } : null} />));
 }
 it('starts normal processing through the shared confirmation flow', async () => {
  await render(); expect(el.textContent).toContain('Transcribe');
  await act(async () => el.querySelector('button')!.click());
  expect(recover).not.toHaveBeenCalled();
  expect(process).toHaveBeenCalledWith(expect.objectContaining({ recordingId: 'old', workspaceId: 'ws' }));
  expect(el.querySelector('[role="status"]')?.textContent).toBe('Queued');
 });
 it('prepares once, confirms the replacement and prevents duplicate clicks while pending', async () => {
  let finish!: (value: unknown) => void;
  recover.mockReturnValue(new Promise(resolve => { finish = resolve; }));
  await render(true);
  await act(async () => { el.querySelector('button')!.click(); el.querySelector('button')!.click(); });
  expect(recover).toHaveBeenCalledTimes(1); expect(process).not.toHaveBeenCalled();
  expect(el.querySelector('button')!.disabled).toBe(true);
  await act(async () => finish({ replacementId: 'fresh' }));
  expect(process).toHaveBeenCalledWith(expect.objectContaining({ recordingId: 'fresh' }));
 });
 it('does not claim queue success when confirmation is cancelled', async () => {
  process.mockResolvedValue({ outcome: 'cancelled' }); recover.mockResolvedValue({ replacementId: 'fresh' });
  await render(true); await act(async () => el.querySelector('button')!.click());
  expect(el.querySelector('[role="status"]')).toBeNull();
 });
 it('reports recovery refusal and never starts processing', async () => {
  recover.mockRejectedValue(new Error('source changed'));
  await render(true); await act(async () => el.querySelector('button')!.click());
  expect(process).not.toHaveBeenCalled(); expect(el.querySelector('[role="alert"]')?.textContent).toBe('Could not start');
  expect(el.querySelector('button')!.disabled).toBe(false);
 });
});
