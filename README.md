<div align="center">

# sidanclaw

### A local brain for your work, that dreams.

It sleeps, and it gets to know you.

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](./LICENSE)

</div>

---

sidanclaw is a local-first work brain. You talk to it, drop notes and decisions
into it, and it remembers. Then, while you are away, it **dreams**: a background
consolidation loop (Light / REM / Deep) reorganizes what it has learned and
synthesizes a **SOUL** - an evolving, written portrait of how *you* think, work,
and decide.

This is not a memory layer for an agent. It is a portrait of you.

- **Runs locally** on a single model key. No cloud account, no second secret.
- **The whole vertical:** chat + the dreaming brain + a canvas + a real frontend.
- **Yours:** your brain lives on your machine, in an inspectable local store.

## The wow: watch it dream

> *(Demo placeholder - the first-screenful artifact.)* Feed it a week of raw
> notes and messages. Let it sleep. Watch the SOUL paragraph change into
> something only your brain would know about you, and watch duplicate memories
> collapse into consolidated ones with provenance kept.

The dreaming is the differentiator, and it ships **on by default**.

## Quick start

```bash
git clone https://github.com/sidanclaw/sidanclaw.git
cd sidanclaw
# Set your model key (prompted on first run, persisted under ~/.sidanclaw/):
export GEMINI_API_KEY=...
pnpm install
pnpm dev        # starts the api + canvas sidecar + web app, opens your browser
```

That is it. The store defaults to an embedded PGLite database under
`~/.sidanclaw/`; a local Postgres container is a drop-in alternative.

## What's in the box

| Layer | What it does |
|---|---|
| **Engine** | The query loop, tool executor, compaction, provider abstraction. |
| **Brain** | Memory, hybrid retrieval (RRF + MMR), an entity / edge / task graph, a knowledge base, and the **consolidation / dreaming** loop with SOUL synthesis. |
| **Canvas** | A collaborative document surface (runs a local sync sidecar). |
| **Frontend** | The real desktop + web app, not a toy demo. |

## Growing your brain into a team

sidanclaw is single-player by design. When you are ready to add a teammate, the
app prompts an upgrade to the hosted cloud version, with a one-click, no-re-entry
migration of your existing brain. The paywall is a *capability* (a shared,
always-on team graph that cannot exist single-player), never a nag.

## License

sidanclaw is **AGPLv3** (see [`LICENSE`](./LICENSE)) - real, OSI/FSF-approved
open source with a network-copyleft clause. If you run a modified sidanclaw as a
hosted service, you must publish your changes. A separate **commercial license**
is available for organizations that cannot accept AGPL; it is powered by the
[CLA](./CLA.md) every contributor signs. See [`CONTRIBUTING.md`](./CONTRIBUTING.md).

## Contributing & security

Read [`CONTRIBUTING.md`](./CONTRIBUTING.md) first (it covers the CLA and how we
work). For vulnerabilities, see [`SECURITY.md`](./SECURITY.md) - please do not
open a public issue.
