---
name: browser-skill-author
description: Author a sidanclaw browser skill (logic-block) and sync it into a company brain via the brain MCP writeBrowserSkill tool. Use when asked to "build a browser skill", "automate a browsing flow for sidanclaw", or to harden a self-healed draft skill. Requires a read_write sidanclaw brain key (sk_brain_*) connected as an MCP server.
---

# Browser-skill author

You are authoring a **logic-block**: a deterministic, reviewed browsing script a
sidanclaw assistant runs against a **browser profile** via `runBrowserSkill`.
The kb-author analog for browsing: you write the artifact, the brain governs it.

## The shape

A skill is Python with exactly this entry point, driving ONLY the governed
runner verbs — never subprocess, never raw agent-browser, never http libraries:

```python
def run(runner, params):
    runner.open("https://www.example.com/inbox")
    runner.snapshot()                                  # refresh @e refs + labels
    ref = runner.find(params["recipient"])             # ref by visible label
    runner.click(ref)
    runner.snapshot()
    runner.fill(runner.find("Message"), params["message"])
    runner.submit(runner.find("Send"), "Send the reply")   # TERMINAL - gate-checked
    return "replied"
```

Verbs: `open(url)` · `snapshot()` · `find(label)` · `click(ref)` ·
`fill(ref, text)` · `eval(js)` · `scroll(dy)` · `wait(s)` · `current_url()` ·
`log(msg)` · **`submit(ref, description)`** — the ONLY terminal verb. Every
`submit` pauses at the brain's send-gate (grant / async approval / verb
ceiling); it never fires on its own. Anything else in scope (subprocess,
requests, exec, unknown `runner.*` names) fails the effect contract and the
skill is rejected.

## The workflow

1. **Study the flow.** Walk the real site (your own browser or the user's
   description of a watched run). Note each step: URL, the visible label you
   act on, what you type, and which click actually SENDS.
2. **Write the block.** One `run(runner, params)`; parameterize anything the
   caller should choose (recipient, message text) via `params` + a JSON
   schema. Re-`snapshot()` after every navigation or click that changes the
   page — refs go stale.
3. **Build the recording.** One storyboard entry per step of the run you
   studied: `{step, action, url?, detail?}`. This is a REQUIRED review
   artifact — a human sees it when deciding to grant the skill.
4. **Declare the sends.** List every terminal send the code performs (empty
   list for a read-only skill). The server re-extracts the contract from the
   code and REJECTS any mismatch — declare exactly what it sends.
5. **Sync to brain.** Call the brain MCP tool `writeBrowserSkill` with
   `{name, site, description, code, paramsSchema, recording, declaredSends}`.
   Same name = update (version bumps). A `read` key cannot call it; ask the
   user for a `read_write` brain key if the tool is missing.
6. **Hand off.** Tell the user: the skill is immediately usable; its sends
   queue in Approvals until they grant it on a profile (the grant is the
   review — they'll see your contract + recording there). Suggest a rehearsal
   first: `runBrowserSkill` with `rehearsal: true` replays everything with
   sends stubbed.

## Hardening a self-healed draft

Drafts distilled from a watched exploration (`origin: self_heal`) replay by
visible label. To harden one: read it via the brain MCP, tighten the
`runner.find` labels (or switch to stable refs the site keeps), parameterize
hardcoded text, keep every `submit` terminal, and write it back with the same
name. Never remove a `submit` to dodge the gate — a send that stops being
declared is a rejected contract, and a drifted skill just re-gates.
