import { describe, it, expect } from 'vitest'
import { buildDocSkillBlock, buildAmbientDocSkillBlock } from '../soul.js'

// Doc authoring is a context-injected SKILL (`buildDocSkillBlock`),
// appended after the host assistant's own Layer-1 on the doc surface — not an
// assistant identity. These cases cover both the skill framing and the shared
// page-authoring protocol the block composes.
describe('[COMP:doc/soul] doc skill block', () => {
  it('frames doc as a CAPABILITY, not an identity', () => {
    // The block is appended after the host assistant's own Layer-1, so it must
    // NOT claim the assistant IS a doc assistant — it says the assistant is
    // currently WORKING ON a doc page. Guards against identity hijack of the
    // workspace primary.
    const out = buildDocSkillBlock({ mode: 'page', teamName: 'Acme' })
    expect(out).toContain('# Working on a Doc page')
    expect(out).not.toContain('# Doc assistant')
    expect(out).not.toMatch(/You are a Doc assistant/)
  })

  it('grounds the workspace name + purpose when provided, omits the line when not', () => {
    const out = buildDocSkillBlock({
      mode: 'page',
      teamName: 'Acme',
      teamPurpose: 'shipping the Q3 roadmap',
    })
    expect(out).toContain('Acme')
    expect(out).toContain('shipping the Q3 roadmap')
    // teamName is optional — the host already carries workspace context in its
    // memory block, so a missing name must not crash or print an empty placeholder.
    const noTeam = buildDocSkillBlock({ mode: 'page' })
    expect(noTeam).not.toContain('Workspace: ****')
    expect(noTeam).toContain('# Working on a Doc page')
  })

  it('selects the page-mode block by default and the research block on mode=research', () => {
    const page = buildDocSkillBlock({ mode: 'page', teamName: 'Acme' })
    expect(page).toContain('## Page mode')
    expect(page).not.toContain('## Research mode')
    const research = buildDocSkillBlock({ mode: 'research', teamName: 'Acme' })
    expect(research).toContain('## Research mode')
    expect(research).not.toContain('## Page mode')
    expect(research).toContain('TL;DR')
  })

  it('leads with renderPage / patchPage as the data-rendering path', () => {
    const out = buildDocSkillBlock({ mode: 'page', teamName: 'Acme' })
    expect(out).toContain('renderPage')
    expect(out).toContain('patchPage')
    expect(out).toMatch(/`data` block/)
  })

  it('catalogs the seven valid binding shapes', () => {
    const out = buildDocSkillBlock({ mode: 'page', teamName: 'Acme' })
    expect(out).toContain('"entity":"tasks","viewType":"table"')
    expect(out).toContain('"entity":"tasks","viewType":"board"')
    expect(out).toContain('"entity":"contacts","viewType":"table"')
    expect(out).toContain('"entity":"companies","viewType":"table"')
    expect(out).toContain('"entity":"deals","viewType":"table"')
    expect(out).toContain('"entity":"deals","viewType":"board"')
    expect(out).toContain('"entity":"workflow_runs","viewType":"table"')
    expect(out).toMatch(/Data-block .*binding.* shapes/)
  })

  it('forbids inventing viewTypes (regression: model emitted "kanban", "list")', () => {
    expect(buildDocSkillBlock({ mode: 'page', teamName: 'Acme' })).toMatch(/do not invent/i)
  })

  it('emphasises "render not narrate" and live data freshness', () => {
    const out = buildDocSkillBlock({ mode: 'page', teamName: 'Acme' })
    expect(out).toMatch(/render.*don't narrate/i)
    expect(out).toMatch(/live.*not snapshot/i)
  })

  it('never instructs the model to call renderView (retired on doc)', () => {
    expect(buildDocSkillBlock({ mode: 'page', teamName: 'Acme' })).not.toContain('renderView')
    expect(buildDocSkillBlock({ mode: 'research', teamName: 'Acme' })).not.toContain('renderView')
  })

  it('never names connector-specific tools (Tool-awareness rule)', () => {
    const out = buildDocSkillBlock({ mode: 'page', teamName: 'Acme' })
    expect(out).not.toMatch(/mcp_search|mcp_call|googleCalendar|gmailSend|notionCreate/i)
  })

  it('mandates a readable page, not a bare data dump', () => {
    const out = buildDocSkillBlock({ mode: 'page', teamName: 'Acme' })
    expect(out).toMatch(/readable page/i)
    expect(out).toMatch(/bare `data` block|single bare table|naked (table|dump)/i)
    expect(out).toMatch(/frame every data block/i)
  })

  it('instructs a plain-prose thread reply with no wrapper markup (confabulated-tag regression)', () => {
    const out = buildDocSkillBlock({ mode: 'page', teamName: 'Acme' })
    expect(out).toMatch(/plain prose/i)
    expect(out).toMatch(/markup envelope|wrap it in any tag/i)
  })

  it('treats prose authoring as first-class, not "prose second"', () => {
    const out = buildDocSkillBlock({ mode: 'page', teamName: 'Acme' })
    expect(out).toMatch(/authoring brief/i)
    expect(out).not.toMatch(/prose second/i)
    expect(out).not.toMatch(/not the body of the answer/i)
  })

  it('teaches the id-form subgraph reference for vertical stacking (regression: model linked subgraphs by spaced title → mermaid parse error)', () => {
    // The model authored `subgraph Traditional SaaS` then `Traditional SaaS ~~~
    // Services-as-Software` to force vertical stacking; mermaid can only
    // reference a subgraph by a single-token id, so the spaced title was a parse
    // error that blanked the diagram. The directive must steer to the id form
    // (`subgraph id [Title]`) + an `id1 ~~~ id2` invisible edge, and warn off
    // multi-word references.
    const out = buildDocSkillBlock({ mode: 'page', teamName: 'Acme' })
    expect(out).toContain('id1 ~~~ id2')
    expect(out).toMatch(/never by a multi-word title/i)
  })
})

// The AMBIENT variant rides the app-web workspace surfaces (Brain / Studio /
// Workflow / Approvals / Knowledge-base chat docks): same tools, inverted
// steering — chat-first, author a page only on an explicit ask. Compact by
// design: the HOW lives in the tool descriptions injected alongside it.
describe('[COMP:doc/soul] ambient doc skill block', () => {
  it('steers chat-first and gates page authoring on an explicit ask', () => {
    const out = buildAmbientDocSkillBlock({ teamName: 'Acme' })
    expect(out).toMatch(/answer in chat by default/i)
    expect(out).toMatch(/only on an explicit ask/i)
    // The doc-surface page-first framing must NOT leak in.
    expect(out).not.toContain('# Working on a Doc page')
    expect(out).not.toMatch(/never reply in chat/i)
  })

  it('names the page tools so the capability is discoverable', () => {
    const out = buildAmbientDocSkillBlock()
    expect(out).toContain('renderPage')
    expect(out).toContain('patchPage')
    expect(out).toContain('createSubPage')
  })

  it('stays compact — no authoring protocol, binding catalog, or comment protocol', () => {
    const out = buildAmbientDocSkillBlock({ teamName: 'Acme' })
    expect(out).not.toContain('## Page authoring')
    expect(out).not.toContain('"entity":"tasks","viewType":"table"')
    expect(out).not.toContain('## Comment threads')
    // Order-of-magnitude guard: ambient must stay a fraction of the full block.
    expect(out.length).toBeLessThan(
      buildDocSkillBlock({ mode: 'page', teamName: 'Acme' }).length / 3,
    )
  })

  it('reminds the model the user is not watching the page', () => {
    const out = buildAmbientDocSkillBlock()
    expect(out).toMatch(/not looking at the page/i)
    expect(out).toMatch(/sidebar/i)
  })

  it('teaches the /p/<pageId> chat link form for naming pages (hallucinated-link regression)', () => {
    const out = buildAmbientDocSkillBlock()
    // The model must link a real page as [Title](/p/<pageId>) from the tool
    // result, never paste a bare id or guess a URL.
    expect(out).toContain('/p/<pageId>')
    expect(out).toMatch(/pageId.*from the tool result|from the tool result/i)
    expect(out).toMatch(/never paste a bare id|guess a URL/i)
  })

  it('grounds the workspace name + purpose when provided, omits the line when not', () => {
    const out = buildAmbientDocSkillBlock({
      teamName: 'Acme',
      teamPurpose: 'shipping the Q3 roadmap',
    })
    expect(out).toContain('Acme')
    expect(out).toContain('shipping the Q3 roadmap')
    const noTeam = buildAmbientDocSkillBlock()
    expect(noTeam).not.toContain('Workspace: ****')
  })

  it('never instructs the model to call renderView (deleted wherever doc tools ride)', () => {
    expect(buildAmbientDocSkillBlock({ teamName: 'Acme' })).not.toContain('renderView')
  })

  it('names the mounted surface with a gloss when `surface` is set', () => {
    // The server half of the dock's "Asking about <surface>" context chip:
    // the model is told which view the user is looking at and steered to
    // read ambiguous questions against it.
    const out = buildAmbientDocSkillBlock({ teamName: 'Acme', surface: 'brain' })
    expect(out).toContain('**Brain**')
    expect(out).toMatch(/currently looking at/i)
    expect(out).toMatch(/read it against what that surface shows/i)
    // Other surfaces' glosses must not leak in.
    expect(out).not.toContain('**Studio**')
    // Every surface value produces its own named line.
    for (const surface of ['studio', 'workflow', 'approvals', 'knowledge-base'] as const) {
      expect(buildAmbientDocSkillBlock({ surface })).toMatch(/currently looking at/i)
    }
    expect(buildAmbientDocSkillBlock({ surface: 'knowledge-base' })).toContain('**Knowledge base**')
  })

  it('omits the surface line entirely when `surface` is absent (byte-identical to the pre-surface block)', () => {
    const out = buildAmbientDocSkillBlock({ teamName: 'Acme' })
    expect(out).not.toMatch(/currently looking at/i)
  })
})
