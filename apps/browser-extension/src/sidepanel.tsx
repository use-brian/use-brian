import { useEffect, useRef, useState, type ComponentProps } from 'react'
import { createRoot } from 'react-dom/client'
import { AssistantAvatar, ChatComposer, ChatMarkdown, applyChatAppearance, Popover, PopoverContent, WorkspacePickerTrigger, IdentityAccountSection, IdentityWorkspaceSection, IdentityMenuAction, organizeWorkspacePicker, usesScalableWorkspacePicker, type IdentityAccount, type IdentityWorkspace, type IdentityPickerLabels } from '@use-brian/chat-ui'
import remarkGfm from 'remark-gfm'
import { ArrowUp, Check, ChevronDown, Copy, Globe, Plus, Settings2, Square, X } from 'lucide-react'
import type { PageEvidence } from './assistant-chat.js'

type Account = IdentityAccount
const defaultPickerLabels: IdentityPickerLabels = { searchPlaceholder: 'Search workspaces...', empty: 'No workspaces found', addAnotherAccount: 'Add another account', switchAccountAria: 'Switch to {email}', switcherAriaLabel: 'Switch workspace: {name}' }
type AccountSetup = { waiting: true; profiles?: Array<{ id: string; name: string }>; workspaceName?: string; pairing?: boolean; automatic?: boolean; failed?: boolean }
type Assistant = { id: string; name: string; iconSeed?: number | null }
type Message = { id: string; role: 'user' | 'assistant'; text: string; assistant?: Assistant; page?: PageEvidence }
const errors: Record<string, string> = {
  page_changed: 'The page changed or its shared excerpt expired. Share the current page again, then send.',
  different_task_tab: 'Brian is already working in another tab. Stop that task before sharing this tab.',
  no_eligible_tab: 'Open a regular website tab to share its context. Private and browser settings tabs are excluded.',
  consent_denied: 'Page sharing was declined. Press Share current page to request permission again.',
  busy: 'Finish the current chat or press Stop before switching accounts.',
  account_switching: 'Finish switching accounts before sending or sharing a page.',
  account_changed: 'The active account changed. The previous chat was stopped.',
  account_unavailable: 'Account setup could not finish. Retry, or open Brian to check your sign-in.',
  browser_identity_changed: 'This browser connection was removed or its access changed. Retry can set up a missing private connection. Existing access rules still apply.',
  browser_connection_busy: 'This browser identity is connected elsewhere. End that connection, then retry.',
  browser_connect_failed: 'This browser could not connect. Check your connection and retry.',
  pairing_in_progress: 'The browser profile is connecting. Wait for it to finish.',
  stopped: 'Stopped before sending or sharing. No new request was started.',
  protected_fill_denied: 'Finish protected fill cleanup in extension Settings before sharing this page.',
  sign_in_failed: 'The sign-in tab could not open. Try again, or open Brian in this browser profile.',
}
const fallbackError = 'The connection or page read failed. Open Brian, check the chat, then retry. No action was repeated.'

function CodeBlock({ children }: ComponentProps<'pre'>) {
  const pre = useRef<HTMLPreElement>(null)
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  return <div data-chat-code-block className="group/codeblock relative min-w-0">
    <button className="code-copy" type="button" aria-label={copied ? 'Copied' : 'Copy code'} onClick={() => {
      void navigator.clipboard.writeText(pre.current?.textContent?.replace(/\n$/, '') ?? '').then(() => {
        setCopied(true); clearTimeout(timer.current); timer.current = setTimeout(() => setCopied(false), 1600)
      }).catch(() => undefined)
    }}>{copied ? <Check size={14} /> : <Copy size={14} />}</button>
    <pre ref={pre}>{children}</pre>
  </div>
}
const markdownComponents = {
  pre: CodeBlock,
  a: ({ children, href }: ComponentProps<'a'>) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
}

export function BrowserAssistantPanel() {
  const [accountDirectory, setAccountDirectory] = useState<{ current: Account; accounts: Account[]; canManageAccounts?: boolean } | null>(null)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [workspaceQuery, setWorkspaceQuery] = useState('')
  const [workspaceDirectory, setWorkspaceDirectory] = useState<{ active: IdentityWorkspace; workspaces: IdentityWorkspace[] } | null>(null)
  const [pickerLabels, setPickerLabels] = useState(defaultPickerLabels)
  const displayedWorkspace = useRef<string | undefined>(undefined)
  const [accountSetup, setAccountSetup] = useState<AccountSetup | null>(null)
  const boundIdentity = useRef<string | undefined>(undefined)
  const displayedAccount = useRef<string | undefined>(undefined)
  const [connected, setConnected] = useState(false)
  const [signInPending, setSignInPending] = useState(false)
  const [signInExpired, setSignInExpired] = useState(false)
  const [control, setControl] = useState<{ phase: 'idle' | 'waiting' | 'active' | 'stopped'; host?: string }>({ phase: 'idle' })
  const [workspace, setWorkspace] = useState('')
  const [assistants, setAssistants] = useState<Assistant[]>([])
  const [assistant, setAssistant] = useState<Assistant | null>(null)
  const selected = useRef<Assistant | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [draft, setDraft] = useState('')
  const [page, setPage] = useState<PageEvidence | undefined>()
  const [activity, setActivity] = useState('')
  const [error, setError] = useState('')
  const [review, setReview] = useState(false)
  const [running, setRunning] = useState(false)
  const [reading, setReading] = useState(false)
  const port = useRef<chrome.runtime.Port | null>(null)
  const request = useRef<string | null>(null)
  const session = useRef<string | undefined>(undefined)
  const transcript = useRef<HTMLDivElement>(null)

  const send = (message: unknown) => {
    try { (port.current ?? connect()).postMessage(message) }
    catch { setConnected(false); setError('Connection lost. Keep Brian open and retry. No message was resent.') }
  }
  const clear = () => { session.current = undefined; setMessages([]); setPage(undefined); setReview(false); setError('') }
  const resetIdentity = () => {
    clear(); setDraft(''); setPickerOpen(false); setConnected(false); setWorkspace(''); setAssistants([]); selected.current = null; setAssistant(null)
    setRunning(false); setReading(false); setActivity(''); request.current = null
  }
  const connect = (): chrome.runtime.Port => {
    const previous = port.current
    port.current = null
    previous?.disconnect()
    const next = chrome.runtime.connect({ name: 'brian-assistant-panel' })
    port.current = next
    next.onDisconnect.addListener(() => {
      if (port.current !== next) return
      port.current = null
      setConnected(false); setRunning(false); setReading(false); request.current = null
      setError('Connection lost. Check the full chat before retrying an action.')
    })
    next.onMessage.addListener(message => {
      if (port.current !== next) return
      if (message.type === 'identity-reset') { resetIdentity(); boundIdentity.current = undefined; return }
      if (message.type === 'account-setup') { setAccountSetup(message.setup); if (!message.setup) send({ type: 'status' }); return }
      if (message.type === 'account-error') { setError(errors[message.code] ?? errors.account_unavailable); send({ type: 'status' }); return }
      if (message.type === 'status') {
        const accountId = message.accountDirectory?.current?.id
        if (accountId && displayedAccount.current && accountId !== displayedAccount.current) resetIdentity()
        if (accountId) displayedAccount.current = accountId
        const identity = message.identity ? `${message.identity.userId}:${message.identity.workspaceId}` : undefined
        if (identity && boundIdentity.current && identity !== boundIdentity.current) resetIdentity()
        if (identity) boundIdentity.current = identity
        const workspaceId = message.workspaceDirectory?.active?.id
        if (workspaceId && displayedWorkspace.current && workspaceId !== displayedWorkspace.current) resetIdentity()
        if (workspaceId) displayedWorkspace.current = workspaceId
        setWorkspaceDirectory(message.workspaceDirectory ?? null)
        setPickerLabels(message.identityPickerLabels ?? defaultPickerLabels)
        setAccountDirectory(message.accountDirectory ?? null)
        setAccountSetup(message.accountSetup ?? null)
        setConnected(message.connected === true)
        if (message.connected) setError(current => current === errors.sign_in_failed ? '' : current)
        setSignInPending(message.signInPending === true)
        setSignInExpired(message.signInExpired === true)
        if (['idle', 'waiting', 'active', 'stopped'].includes(message.control?.phase)) setControl({ phase: message.control.phase, ...(typeof message.control.host === 'string' ? { host: message.control.host } : {}) })
        setWorkspace(typeof message.workspaceName === 'string' ? message.workspaceName : '')
        if (message.appearance) applyChatAppearance(document.documentElement, message.appearance)
        if (Array.isArray(message.assistants)) {
          const roster: Assistant[] = message.assistants.filter((a: Assistant) => typeof a?.id === 'string' && typeof a?.name === 'string')
          setAssistants(roster)
          const current = roster.find(a => a.id === selected.current?.id) ?? roster[0] ?? null
          if (selected.current?.id !== current?.id) clear()
          selected.current = current; setAssistant(current)
        }
        return
      }
      if (message.type === 'page') { setPage(message.page); setReading(false); setActivity(''); return }
      if (message.id && message.id !== request.current) return
      if (message.type === 'event') {
        const data = message.data ?? {}
        if (message.event === 'session') session.current = data.sessionId
        if (message.event === 'text_delta' && typeof data.text === 'string') {
          setMessages(rows => rows.map(row => row.id === message.id ? { ...row, text: row.text + data.text } : row))
          setActivity('')
        }
        if (message.event === 'tool_start') {
          setMessages(rows => rows.map(row => row.id === message.id ? { ...row, text: '' } : row))
          setActivity(({ browserNavigate: 'Opening the page...', browserSnapshot: 'Reading the page...', browserClick: 'Acting on the page...', browserType: 'Typing in the page...', browserFillForm: 'Filling in the form...', browserSwitchTab: 'Switching tabs...' } as Record<string, string>)[data.name] ?? 'Working...'); if (data.name === 'askQuestion') setReview(true)
        }
        if (message.event === 'tool_confirmation_required') { setReview(true); setActivity('Waiting for your approval') }
        if (message.event === 'error') setError(typeof data.error === 'string' ? data.error : 'The turn could not finish. Open the full chat for details.')
        return
      }
      if (message.type === 'complete' || message.type === 'failure') {
        request.current = null; setRunning(false); setReading(false); setActivity('')
        if (message.type === 'failure') setError(errors[message.code] ?? fallbackError)
      }
    })
    return next
  }
  useEffect(() => {
    connect()
    const poll = setInterval(() => send({ type: 'status' }), 2000)
    return () => { clearInterval(poll); const previous = port.current; port.current = null; previous?.disconnect() }
  }, [])
  useEffect(() => {
    const node = transcript.current
    if (node) node.scrollTop = messages.length || activity ? node.scrollHeight : 0
  }, [messages, activity])

  useEffect(() => { if (!pickerOpen) setWorkspaceQuery('') }, [pickerOpen])

  const submit = () => {
    const text = draft.trim()
    if (!text || !connected || running || !assistant || accountSetup) return
    const id = crypto.randomUUID(); request.current = id
    setMessages(rows => [...rows, { id: `${id}-user`, role: 'user', text, page }, { id, role: 'assistant', text: '', assistant }])
    setError(''); setReview(false); setRunning(true); setActivity('Thinking...')
    send({ type: 'send', id, text, assistantId: assistant.id, sessionId: session.current, page })
    setDraft(''); setPage(undefined)
  }
  const choose = (next: Assistant) => {
    if (running) return
    selected.current = next; setAssistant(next); clear()
    document.getElementById('assistant-picker')?.removeAttribute('open')
  }
  const openBrian = () => { setError(''); send({ type: 'sign-in' }) }
  const openSettings = (advanced = false) => { void chrome.windows.create({ url: chrome.runtime.getURL(`popup.html${advanced ? '#advanced-connection' : ''}`), type: 'popup', width: 380, height: 720 }) }
  const stop = () => send({ type: 'stop' })
  const manageAccount = (message: unknown) => {
    setError(''); send(message)
    setPickerOpen(false)
  }

  const searchableWorkspaces = usesScalableWorkspacePicker(workspaceDirectory?.workspaces.length ?? 0)
  const groupedWorkspaces = organizeWorkspacePicker(workspaceDirectory?.workspaces ?? [], workspaceQuery)
  const workspaceRows = searchableWorkspaces ? [...groupedWorkspaces.pinned, ...groupedWorkspaces.recent, ...groupedWorkspaces.all] : workspaceDirectory?.workspaces ?? []
  const needsSignIn = !connected && !accountDirectory && !accountSetup
  const signInCard = <section className={`connection-card ${messages.length ? 'connection-card-inline' : 'welcome'}`} aria-labelledby="connection-heading">
    <h2 id="connection-heading">{signInPending ? 'Finish signing in' : 'Sign in to Brian'}</h2>
    <p>{signInPending ? 'Sign in and choose a workspace in the Brian tab. This panel will connect automatically.' : 'Use your Brian account to chat and connect this browser automatically.'}</p>
    {signInExpired ? <p role="status">Sign-in has not connected yet. Open Brian to check your account, then try again.</p> : null}
    <div className="connection-actions">
      <button className="connection-primary" type="button" onClick={openBrian}>{signInPending ? 'Open sign-in tab' : 'Sign in to Brian'}</button>
      {signInPending ? <button className="text-button" type="button" onClick={() => send({ type: 'cancel-sign-in' })}>Cancel</button> : null}
    </div>
    <p className="connection-help">Sign-in opens in this browser profile. Keep the Brian tab open while you chat here.</p>
    <details className="connection-advanced">
      <summary>Advanced connection</summary>
      <p>Use a relay URL and pairing token to set up browser control manually. Chat still needs a signed-in Brian tab.</p>
      <button className="text-button" type="button" onClick={() => openSettings(true)}>Open manual pairing</button>
    </details>
  </section>

  return <div data-chat-surface className="extension-chat @container/chat-reading bg-background text-foreground">
    <header className="panel-header">
      {accountDirectory ? <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
        <WorkspacePickerTrigger workspace={workspaceDirectory?.active ?? { id: 'workspace', name: workspace || accountDirectory.current.name || 'Brian' }} open={pickerOpen}
          label={pickerLabels.switcherAriaLabel.replaceAll('{name}', workspaceDirectory?.active.name ?? workspace)} className="min-w-0 flex-1 justify-start"
          disabled={running || reading || accountSetup?.pairing} />
        <PopoverContent role="menu" side="bottom" align="start" sideOffset={8} className="w-[min(20rem,calc(100vw-1rem))] gap-3 p-3">
          <div className="px-1"><div className="font-semibold text-sm truncate">{workspaceDirectory?.active.name ?? workspace}</div></div>
          <IdentityAccountSection accounts={accountDirectory.canManageAccounts === false ? [accountDirectory.current] : accountDirectory.accounts} activeId={accountDirectory.current.id} onSwitch={id => manageAccount({ type: 'account-switch', accountId: id })}
            switchLabel={account => pickerLabels.switchAccountAria.replaceAll('{email}', account.email)} />
          {workspaceDirectory ? <IdentityWorkspaceSection workspaces={workspaceRows} activeId={workspaceDirectory.active.id} onSelect={id => { if (id !== workspaceDirectory.active.id) manageAccount({ type: 'workspace-switch', workspaceId: id }); else setPickerOpen(false) }}
            searchable={searchableWorkspaces} query={workspaceQuery} onQueryChange={setWorkspaceQuery} searchLabel={pickerLabels.searchPlaceholder} emptyLabel={pickerLabels.empty} /> : null}
          <div className="border-t border-border" />
          {accountDirectory.canManageAccounts !== false ? <IdentityMenuAction onClick={() => manageAccount({ type: 'account-add' })}>{pickerLabels.addAnotherAccount}</IdentityMenuAction> : null}
          <p className="px-2 text-[11px] text-muted-foreground">Switching changes the account in your other Brian tabs too.</p>
        </PopoverContent>
      </Popover> : <span className="chat-heading">Chat</span>}
      <span className="header-status" title={connected ? workspace : 'Open Brian to connect'} aria-label={connected ? `Connected: ${workspace}` : 'Not connected'} data-connected={connected} />
      <div className="header-actions">
        <button type="button" className="icon-button" title="Stop browser task" aria-label="Stop browser task" onClick={stop}><Square size={14} /></button>
        <button type="button" className="icon-button" disabled={running} title="New chat" aria-label="New chat" onClick={clear}><Plus size={16} /></button>
        <button type="button" className="icon-button" title="Extension settings" aria-label="Extension settings" onClick={() => openSettings()}><Settings2 size={16} /></button>
      </div>
    </header>

    {control.phase !== 'idle' ? <div className="browser-control-card" role="status" data-control-phase={control.phase}>
      <Globe size={15} aria-hidden />
      <span>{control.phase === 'waiting' ? 'Waiting for tab permission' : control.phase === 'active' ? `Browser control: ${control.host || 'this tab'}` : 'Browser control stopped'}</span>
      {control.phase !== 'stopped' ? <button type="button" className="text-button" onClick={stop}>Stop</button> : null}
    </div> : null}

    <div ref={transcript} className="transcript" role="log" aria-label="Conversation">
      {!messages.length && needsSignIn ? signInCard : !messages.length && !accountSetup ? <div data-chat-greeting className="welcome"><h2>What would you like to work on?</h2></div> : null}
      {messages.map(message => message.role === 'user' ? <div key={message.id} className="user-row"><div data-brian-chat-user>
        {message.text}{message.page ? <a className="shared-page-receipt" href={message.page.url} target="_blank" rel="noreferrer"><Globe size={12} />{message.page.title || message.page.url}</a> : null}
      </div></div> : message.text ? <div key={message.id} className="assistant-row">
        <AssistantAvatar id={message.assistant?.id ?? 'assistant'} name={message.assistant?.name ?? 'Assistant'} iconSeed={message.assistant?.iconSeed ?? undefined} size="sm" />
        <div className="answer-column"><div data-brian-chat-answer className="chat-markdown text-foreground"><ChatMarkdown text={message.text} components={markdownComponents} remarkPlugins={[remarkGfm]} /></div></div>
      </div> : null)}
      {activity ? <div role="status" className="chat-activity">{activity}</div> : null}
      {review ? <div className="review-note"><p>This step needs your review in the full chat.</p><button type="button" className="text-button" onClick={() => send({ type: 'open-chat', sessionId: session.current })}>Review in Brian</button></div> : null}
    </div>

    <footer className="composer-area">
      {messages.length && needsSignIn ? signInCard : null}
      {accountSetup ? <div className="account-setup" role="status">
        {accountSetup.automatic ? <p>{accountSetup.failed ? 'This browser could not connect. Check your sign-in and retry.' : 'Connecting this browser to your workspace...'}</p> : accountSetup.profiles ? <>
          <p>{accountSetup.pairing ? 'Connecting browser profile...' : `Choose your local browser profile${accountSetup.workspaceName ? ` in ${accountSetup.workspaceName}` : ''}.`}</p>
          <div className="account-profile-list">{accountSetup.profiles.map(profile => <button className="text-button" key={profile.id} disabled={accountSetup.pairing} onClick={() => manageAccount({ type: 'account-pair', profileId: profile.id })}><Globe size={14} />Connect {profile.name}</button>)}</div>
          {!accountSetup.profiles.length ? <button className="text-button" onClick={() => manageAccount({ type: 'account-browsers' })}>Create a local profile in Browsers</button> : null}
        </> : <p>Finish signing in to Brian. This browser will connect automatically.</p>}
        {!accountSetup.pairing ? <div><button className="text-button" onClick={openBrian}>Open Brian</button><button className="text-button" onClick={() => manageAccount({ type: 'account-retry' })}>Retry connection</button><button className="text-button" onClick={() => manageAccount({ type: 'account-cancel' })}>Cancel account setup</button></div> : null}
      </div> : null}
      {!connected && !accountSetup && accountDirectory ? <div className="connection-note" role="status"><p>Signed in as {accountDirectory.current.email || accountDirectory.current.name}. Retry to connect this browser, and keep your Brian tab open.</p><div>
        <button className="text-button" onClick={openBrian}>Open Brian</button>

        <button className="text-button" onClick={() => { if (accountDirectory) manageAccount({ type: 'account-connect' }); else connect() }}>Retry connection</button>
      </div></div> : null}
      {error ? <p className="error-note" role="alert">{error}</p> : null}
      {!accountSetup ? <>
      <div className="context-band"><span className="brain-context" title={workspace || 'Brain context'}>Brain{workspace ? ` · ${workspace}` : ''}</span>
        <button type="button" className="context-button" disabled={!connected || running || reading || !!accountSetup} onClick={() => { setReading(true); setError(''); send({ type: 'read-page' }) }}><Globe size={14} />{reading ? 'Reading page...' : 'Share page'}</button>
      </div>
      {page ? <details className="page-context"><summary><Globe size={13} /><span>{page.title || page.url}</span><ChevronDown size={13} /></summary>
        <a href={page.url} target="_blank" rel="noreferrer">{page.url}</a><pre>{page.text}</pre><button type="button" className="text-button" onClick={() => setPage(undefined)}><X size={12} />Remove page</button>
      </details> : null}
      <div data-brian-chat-composer>
        <ChatComposer appearance="app" value={draft} onChange={setDraft} onSend={submit}
          sendDisabled={!connected || !assistant || running || !!accountSetup} placeholder="Ask a question or give Brian a task" textareaId="message"
          rowClassName="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-0.5 gap-y-1 px-2 pb-2"
          textareaClassName="col-span-3 col-start-1 row-start-1 w-full min-w-0 max-h-[min(240px,30dvh)] resize-none overflow-y-auto bg-transparent px-1.5 pt-3 pb-2 text-[16px] leading-6 outline-none placeholder:whitespace-nowrap placeholder:text-muted-foreground focus-visible:shadow-none"
          slotPreInput={<div className="composer-toolbar col-span-2 col-start-1 row-start-2">
            <details id="assistant-picker" className="assistant-picker" inert={running}>
              <summary title={assistant?.name || 'Choose assistant'} aria-label={assistant ? `Switch assistant: ${assistant.name}` : 'Choose assistant'}>
                {assistant ? <AssistantAvatar id={assistant.id} name={assistant.name} iconSeed={assistant.iconSeed ?? undefined} size="xs" /> : <span className="avatar-placeholder" />}
                <span>{assistant?.name || 'Choose assistant'}</span><ChevronDown size={13} />
              </summary>
              <div className="assistant-options">{assistants.map(item => <button key={item.id} type="button" onClick={() => choose(item)}><AssistantAvatar id={item.id} name={item.name} iconSeed={item.iconSeed ?? undefined} size="xs" /><span>{item.name}</span>{assistant?.id === item.id ? <Check size={13} /> : null}</button>)}</div>
            </details>
          </div>}
          sendButtonClassName={`col-start-3 row-start-2${running ? ' hidden' : ''}`}
          sendLabel={<ArrowUp size={18} aria-label="Send message" />}
          slotPostInput={running ? <button className="col-start-3 row-start-2" data-brian-chat-action="stop" type="button" aria-label="Stop" title="Stop" onClick={stop}><Square size={14} fill="currentColor" /></button> : null}
        />
      </div>
      <p className="composer-hint">Page sharing and browser actions use your permissions.</p>
      </> : null}
    </footer>
  </div>
}

const root = typeof document === 'undefined' ? null : document.getElementById('root')
if (root) createRoot(root).render(<BrowserAssistantPanel />)
