// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ToolNotificationFields } from '../step-editor';
import { en } from '@/lib/i18n/dictionaries/en';
import type { ToolCallStep } from '@/lib/api/workflow';
vi.mock('../delivery-feedback', () => ({ DeliveryAudienceGuidance: () => null }));
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root, container: HTMLDivElement;
afterEach(() => { act(() => root?.unmount()); container?.remove(); });
function mount(disabled = false) {
  const changed = vi.fn();
  function Harness() {
    const [step, setStep] = useState<ToolCallStep>({ id: 'read', type: 'tool_call', toolName: 'getCrmSubmission', arguments: {},
      deliver: { channelType: 'slack', channelId: 'C_APPROVED' }, deliveryText: 'Saved {{prev.reference}}' });
    return <ToolNotificationFields step={step} onChange={(value) => { changed(value); setStep(value as ToolCallStep); }}
      destinations={[]} channelOptions={[]} slackChannels={[{ id: 'C_APPROVED', name: 'sdr', is_private: false } as never]} disabled={disabled} t={en} />;
  }
  container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  act(() => root.render(<Harness />)); return changed;
}
describe('[COMP:app-web/workflow] deterministic notification controls', () => {
  it('edits authored text while preserving the selected destination and tool', () => {
    const changed = mount(), textarea = container.querySelector('textarea')!;
    expect(textarea.value).toBe('Saved {{prev.reference}}');
    expect(textarea.getAttribute('aria-label')).toBe(en.workflowPage.builder.toolNotificationTextLabel);
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'Enquiry from {{prev.name}}');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(changed).toHaveBeenCalledWith(expect.objectContaining({ toolName: 'getCrmSubmission', deliveryText: 'Enquiry from {{prev.name}}', deliver: { channelType: 'slack', channelId: 'C_APPROVED' } }));
  });
  it('respects read-only editing', () => {
    mount(true); expect(container.querySelector('textarea')?.disabled).toBe(true);
  });
  it('removes destination and text together when notifications are disabled', () => {
    const changed = mount();
    act(() => (container.querySelector('[role="switch"]') as HTMLButtonElement).click());
    expect(changed).toHaveBeenCalledWith(expect.objectContaining({ deliver: undefined, deliveryText: undefined }));
    expect(container.querySelector('textarea')).toBeNull();
  });
});
