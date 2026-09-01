import { describe, it, expect } from 'vitest'
import {
  buildDocSkillBlock,
  buildDocSupervisorSkillBlock,
  buildDocEditAgentPrompt,
  buildAmbientDocSkillBlock,
} from '../soul.js'

// Doc authoring is a context-injected SKILL (`buildDocSkillBlock`),
// appended after the host assistant's own Layer-1 on the doc surface — not an
// assistant identity. These cases cover both the skill framing and the shared
// page-authoring protocol the block composes.
describe('[COMP:doc/soul] doc skill block', () => {
  it('keeps the conversational supervisor compact and moves raw authoring mechanics to the editor', () => {
    const supervisor = buildDocSupervisorSkillBlock({ mode: 'page', teamName: 'Acme' })
    const editor = buildDocEditAgentPrompt({ mode: 'page', teamName: 'Acme' })

    expect(supervisor).toContain('delegateDocEdit')
    expect(supervisor).toContain('`intent: "edit"`')
    expect(supervisor).toContain('An edit never creates a replacement page')
    // One delegation per turn, plus one retry after a no-change failure.
    expect(supervisor).toMatch(/call `delegateDocEdit` once with/i)
    expect(supervisor).toMatch(/one retry is allowed after a no-change failure/i)
    expect(supervisor).not.toContain('renderPage')
    expect(supervisor).not.toContain('patchPage')
    expect(supervisor).not.toContain('## Data-block')
    expect(supervisor.length).toBeLessThan(editor.length / 5)

    expect(editor).toContain('# Context-clean Doc editor')
    expect(editor).toContain('renderPage')
    expect(editor).toContain('patchPage')
    expect(editor).toMatch(/no access to the parent conversation/i)
    expect(buildDocSkillBlock({ mode: 'page' })).toBe(
      buildDocEditAgentPrompt({ mode: 'page' }),
    )
  })

  it('tells the research supervisor to carry evidence into the brief', () => {
    const out = buildDocSupervisorSkillBlock({ mode: 'research' })
    expect(out).toMatch(/research first/i)
    expect(out).toMatch(/source URLs/i)
    expect(out).toMatch(/cannot see your research transcript/i)
  })

  it('frames the full protocol as an internal editor, not a user-facing identity', () => {
    const out = buildDocSkillBlock({ mode: 'page', teamName: 'Acme' })
    expect(out).toContain('# Context-clean Doc editor')
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
    expect(noTeam).toContain('# Context-clean Doc editor')
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

  it('child prompt names only tools in the child allowlist - no search / brain / web (2026-08-19 "could not access the meeting-note evidence")', () => {
    // The isolated editor receives ONLY the Doc tools captured by
    // `injectDocTools` (`childTools`). Naming an evidence tool here sends it
    // hunting for one that does not exist and failing the edit.
    const CHILD_TOOLS = new Set([
      'renderPage', 'patchPage', 'getBlock', 'queryDataBlock', 'getCurrentPage',
      'getSection', 'getBlockRange', 'createSubPage', 'exportPage', 'importToPage',
      'listEntityTypes', 'createEntityType', 'addProperty', 'removeProperty',
      'renameProperty', 'createEntity', 'updateEntity', 'deleteEntity',
      'queryEntities', 'postComment', 'resolveComment', 'getCommentThread',
    ])
    for (const mode of ['page', 'research'] as const) {
      const out = buildDocEditAgentPrompt({ mode })
      expect(out).not.toMatch(/`(search|recentEpisodes|getEntity|searchBrain|searchRecording|findPage|webSearch|mcp_search|mcp_call)`/)
      expect(out).not.toMatch(/web search is allowed/i)
      // Every backticked call-shaped identifier (`name(` or a lone `camelCase`
      // tool word) that is a known tool must be in the child allowlist.
      const called = [...out.matchAll(/`([a-z][A-Za-z]+)\(/g)].map((m) => m[1])
      for (const name of called) expect(CHILD_TOOLS.has(name), `child prompt calls ${name}`).toBe(true)
    }
  })

  it('child prompt states the evidence boundary and the missing_evidence contract', () => {
    for (const mode of ['page', 'research'] as const) {
      const out = buildDocEditAgentPrompt({ mode })
      expect(out).toMatch(/NO search, brain, memory, recording, email, connector, or web tools/)
      expect(out).toMatch(/missing_evidence:/)
      // The child never asks the end user a clarifying question.
      expect(out).not.toMatch(/ask ONE clarifying question/)
    }
  })

  it('supervisor block says the editor has no evidence tools and the brief must carry the evidence', () => {
    for (const mode of ['page', 'research'] as const) {
      const out = buildDocSupervisorSkillBlock({ mode })
      expect(out).toMatch(/editor has NO evidence tools/)
      expect(out).toMatch(/paste the relevant text itself/)
      expect(out).toMatch(/missing_evidence/)
    }
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
// Workflow / Approvals / Knowledge-base / full Chat): same tools, inverted
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

  it('names only the delegation gateway so the capability is discoverable', () => {
    const out = buildAmbientDocSkillBlock()
    expect(out).toContain('delegateDocEdit')
    expect(out).toContain('Choose `create` only when the user explicitly requested a new page')
    expect(out).toMatch(/open or pin it/i)
    expect(out).toMatch(/several pinned Pages.*ask which Page/i)
    expect(out).not.toContain('renderPage')
    expect(out).not.toContain('patchPage')
    expect(out).not.toContain('createSubPage')
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
    for (const surface of ['studio', 'workflow', 'approvals', 'knowledge-base', 'chat'] as const) {
      expect(buildAmbientDocSkillBlock({ surface })).toMatch(/currently looking at/i)
    }
    expect(buildAmbientDocSkillBlock({ surface: 'knowledge-base' })).toContain('**Knowledge base**')
    expect(buildAmbientDocSkillBlock({ surface: 'chat' })).toContain('**Chat**')
  })

  it('omits the surface line entirely when `surface` is absent (byte-identical to the pre-surface block)', () => {
    const out = buildAmbientDocSkillBlock({ teamName: 'Acme' })
    expect(out).not.toMatch(/currently looking at/i)
  })
})
