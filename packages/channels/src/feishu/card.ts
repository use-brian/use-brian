import type { OutgoingAction } from '../types.js'

const BUTTON_TYPE: Record<string, 'primary' | 'danger' | 'default'> = {
  allow: 'primary',
  always: 'primary',
  always_allow: 'primary',
  deny: 'danger',
  never: 'danger',
  always_deny: 'danger',
}

/** Build a Feishu interactive card for channel-agnostic actions. */
export function buildFeishuCard(text: string, actions: OutgoingAction[]): object {
  const buttons = actions.map((action) => {
    if (action.kind === 'web_app') {
      return {
        tag: 'button',
        text: { tag: 'plain_text', content: action.label },
        type: 'default',
        url: action.url,
      }
    }
    return {
      tag: 'button',
      text: { tag: 'plain_text', content: action.label },
      type: BUTTON_TYPE[action.id] ?? 'default',
      value: { data: action.data },
    }
  })

  return {
    config: { wide_screen_mode: true },
    elements: [
      ...(text.trim() ? [{ tag: 'markdown', content: text }] : []),
      ...(buttons.length > 0 ? [{ tag: 'action', actions: buttons }] : []),
    ],
  }
}
