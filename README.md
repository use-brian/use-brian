<div align="center">

<img src="assets/mascot.png" alt="sidanclaw" width="132" />

# sidanclaw

### A local brain for your work, that dreams.

It sleeps, and it gets to know you.

[![CI](https://github.com/sidanclaw/sidanclaw/actions/workflows/ci.yml/badge.svg)](https://github.com/sidanclaw/sidanclaw/actions/workflows/ci.yml)
[![GitHub stars](https://img.shields.io/github/stars/sidanclaw/sidanclaw)](https://github.com/sidanclaw/sidanclaw/stargazers)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](./LICENSE)

</div>

---

Every other AI meets you for the first time, every time. You re-explain your
whole company every morning, like the guy in Memento.

sidanclaw is for solo founders, indie hackers, and small teams who want a work
brain that actually remembers. You talk to it, drop notes, decisions, and general
mess into it, and it remembers. Then, while you are away, it **dreams**: a
background consolidation loop (Light / REM / Deep) reorganizes what it has learned
and synthesizes a **SOUL**, an evolving, written portrait of how *you* think,
work, and decide.

This is not a memory layer for an agent. It is a portrait of you.

<div align="center">
<img src="assets/soul-diff.png" alt="The SOUL rewriting itself after a week of notes" width="780" />
</div>

- **Runs locally** on a single model key. No cloud account, no second secret, no
  "your data is important to us" email three years from now.
- **The whole vertical:** chat, the dreaming brain, a canvas, and a frontend.
- **Yours:** your brain lives on your machine, in a store you can open and read.
  It will end up knowing you better than your last three managers. That is the
  point, not the bug.

## Watch it dream

Feed it a week of raw notes. Let it sleep. On day one it knows your calendar. By
day seven it knows you reschedule anything that starts before 10am, and that you
trust a draft more than a meeting.

While you sleep, it consolidates: duplicate memories collapse into one, provenance
kept, and the SOUL paragraph rewrites itself into something only your own brain
would know about you.

Yes, it dreams about you. We sat with how that sounds. It still ships on by
default.

## Quick start

**Prerequisites:** Node 22+, pnpm 10+, and a free Gemini API key
([get one here](https://aistudio.google.com/apikey)).

```bash
git clone https://github.com/sidanclaw/sidanclaw.git
cd sidanclaw
# Set your model key (prompted on first run, persisted under ~/.sidanclaw/):
export GEMINI_API_KEY=...
pnpm install
pnpm dev        # starts the api + canvas sidecar + web app, opens your browser
```

That is it. There is no step three. The store defaults to an embedded PGLite
database under `~/.sidanclaw/`; a local Postgres container is a drop-in
alternative.

Want to see every available setting? Copying [`.env.example`](./.env.example) to
`.env` is optional, since the launcher prompts for the key, but it documents the
optional capability keys (web search, X search, model fallback) and self-hosting
overrides.

### Your data stays yours

Everything (the brain, the store, the canvas) stays local on your machine. The
only outbound network call sidanclaw makes is to the Gemini API, using your own
key. Nothing about your work leaves your computer otherwise.

## What's in the box

| Layer | What it does |
|---|---|
| **Engine** | The query loop, tool executor, compaction, provider abstraction. |
| **Brain** | Memory, hybrid retrieval (RRF + MMR), an entity / edge / task graph, a knowledge base, and the **consolidation / dreaming** loop with SOUL synthesis. |
| **Canvas** | A collaborative document surface (runs a local sync sidecar). |
| **App** | The desktop and web frontend. |

<!-- Feature GIFs (brain graph, canvas) belong here, captured from a LOCALLY seeded
     single-player brain. The launch footage on hand is hosted/CRM-seeded (a "Deals"
     nav, a "Deal Brief" doc) and is off-message for the open-core "portrait of you"
     story, so it is intentionally not shipped here yet. See the capture note below. -->

## Receipts

<!-- TODO: replace NN placeholders with measured values from a seeded local run. -->

| | |
|---|---|
| External services required | **0** |
| Model keys required | **1** |
| Memories after a week of notes | NNN raw, collapsed to NN |
| Recall across past sessions | NN% at k=NN |
| Local retrieval latency | NN ms |

The first two are facts. The rest get filled from a seeded run on your own
machine, because a number you cannot reproduce is just decoration.

## How this is different

"Isn't this just a vector database with extra steps?"

A vector database remembers what you said. sidanclaw decides what it meant, throws
out the duplicates, and writes down who you are. One is storage. The other sleeps
on it.

## Growing your brain into a team

sidanclaw is single-player by design, like most of your actual work. When you are
ready to add a teammate, the app prompts an upgrade to the hosted cloud version,
with a one-click, no-re-entry migration of your existing brain. The paywall is a
*capability* (a shared, always-on team graph that cannot exist single-player),
never a nag.

## Troubleshooting

A clean local run is a little chatty on first boot. Two log lines are expected and
safe to ignore:

- **`[registry] No community connectors (sidanclaw-tools not present)`** (and the
  matching skills line). The optional community registry lives in a separate
  `sidanclaw-tools` submodule that a default clone does not pull. Run
  `git submodule update --init sidanclaw-tools` if you want the community
  connectors and skills; otherwise the built-in official ones are all you need.
- **`bind message supplies 2 parameters, but prepared statement "" requires 1`**
  from a background consolidation tick. This is a known quirk of the embedded
  PGLite store's wire protocol on one specific query. It is non-fatal and retries
  automatically. To avoid it entirely, point `DATABASE_URL` at a real local
  Postgres (`postgres://...`); a container is a drop-in alternative to PGLite.

## License

sidanclaw is **AGPLv3** (see [`LICENSE`](./LICENSE)): real, OSI and FSF approved
open source with a network-copyleft clause. Run a modified sidanclaw as a hosted
service and you publish your changes. We will be reading. A separate **commercial
license** is available for organizations that cannot accept AGPL; it is powered by
the [CLA](./CLA.md) every contributor signs. See [`CONTRIBUTING.md`](./CONTRIBUTING.md).

## Contributing & security

Read [`CONTRIBUTING.md`](./CONTRIBUTING.md) first (it covers the CLA and how we
work). For vulnerabilities, see [`SECURITY.md`](./SECURITY.md), and please do not
open a public issue.

## Star the repo

If this resonates, [star the repo](https://github.com/sidanclaw/sidanclaw); it
genuinely helps more people find their own brain. Or just star it because your
current AI has the memory of a goldfish. Either way.
