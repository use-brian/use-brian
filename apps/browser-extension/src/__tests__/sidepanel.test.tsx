import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { BrowserAssistantPanel } from '../sidepanel.js'

describe('[COMP:ext/assistant-chat] app-style panel', () => {
  it('uses shared chat chrome and composer with a clear disconnected recovery path', () => {
    const html = renderToStaticMarkup(<BrowserAssistantPanel />)
    expect(html).toContain('data-brian-chat-composer')
    expect(html).toContain('data-brian-chat-action="send"')
    expect(html).toContain('What would you like to work on?')
    expect(html).toContain('Retry connection')
    expect(html).toContain('This browser connects automatically')
    expect(html).not.toContain('Connect this account')
    expect(html).not.toContain('pair this extension in Browsers')
    expect(html).toContain('aria-label="Conversation"')
    expect(html).not.toMatch(/<select|<iframe/)
  })
})
