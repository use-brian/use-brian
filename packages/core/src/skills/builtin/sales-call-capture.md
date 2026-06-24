---
name: sales-call-capture
description: Turn a sales-call recording transcript into structured brain records. When a recording is detected as a sales call (discovery, demo, pricing, negotiation, renewal), extract the PEOPLE on the call as contacts, the prospect COMPANY, the DEAL/opportunity, and the concrete NEXT-STEP TASKS with owners and due dates - and write them into the company brain. Use right after a recording is transcribed and ingested when the sales-call signal fires, or when the operator says "log that sales call", "who was on the Acme call and what did we commit to", "pull the next steps from this call".
license: MIT
compatibility: Designed for sidanclaw
metadata:
  author: sidanclaw
  category: productivity
  when_to_use: Immediately after a long recording is transcribed (recording-to-brain) when the sales-call detector flags it, or as an ad-hoc operator request to parse a call into CRM records. Skip for internal standups, all-hands, or any recording with no external prospect.
  tags: official
---

# Sales-call capture

A sales-call recording carries exactly the entities the CRM half of the brain exists to hold - the people, the company, the opportunity, and what we promised to do next - but they are buried in a transcript no one re-reads. This skill lifts them out and files them, so the next time anyone asks "where are we with Acme?" the brain answers from the call instead of someone's memory.

This skill runs over a transcript that is already segmented and retrievable via `searchRecording` (see `docs/architecture/brain/recording-to-brain` flow). It does NOT load the whole transcript into context - it pulls the segments it needs by query.

## When to use

- A recording was just transcribed and the **sales-call detector** flagged it (`detectSalesCall`, see `packages/core/src/media/detect-sales-call.ts`). The recording's Episode id is the `recordingId`.
- The operator asks to log / summarize a sales call, or to extract its next steps.

**Skip** when the recording is an internal meeting (standup, all-hands, 1:1) with no external prospect, or when there is no company/contact to attach - do not fabricate a prospect.

## Recipe

Work from the transcript by **querying segments**, never by dumping the whole thing.

### 1. Identify the company and the people

```
searchRecording({ recordingId, query: "company name, who is on the call, introductions, roles and titles" })
```

- Resolve the **prospect company**. Create or update it: `saveCompany({ name, domain?, notes })` (check `searchBrain({ scope: "company" })` first to avoid a duplicate).
- For each **external participant**, create or update a contact: `saveContact({ name, company, role/title, email?, notes })`. Attribute who said what from the segment `speaker` labels where the transcript names them. Do **not** create contacts for your own team.

### 2. Capture the deal / opportunity

```
searchRecording({ recordingId, query: "budget, pricing, timeline, decision maker, contract, procurement, competitors, objections" })
```

- If a real opportunity is in play, `saveDeal({ company, title, stage, value?, notes })` with the stage you can justify from the call (discovery / demo / proposal / negotiation). Link it to the company and contacts.
- Record material **objections and risks** as deal notes or memories (`saveMemory`) tagged `sales` + `objection` so they surface on the next touch.

### 3. Extract the next-step tasks

```
searchRecording({ recordingId, query: "next steps, action items, follow up, we will send, by when, who owns, deadline, commitments" })
```

- For every concrete commitment, `saveTask({ title, dueDate?, assignee?, relatedCompany, relatedContact, notes })`. Prefer the **owner and due date stated on the call**; only infer a due date when the call clearly implies one ("by end of week"). Cite the moment (`start_ms`) in the task notes so it is auditable.
- Do not invent tasks. If the call ended with no commitment, say so rather than manufacturing follow-ups.

### 4. Confirm, briefly

Reply with a tight summary: the company, the people (name + role), the deal stage, and the next steps with owners/dates - and nothing else. The detail lives in the brain now; the chat reply is the receipt.

## Guardrails

- **Sensitivity follows the recording.** A confidential call produces confidential records - inherit the recording's sensitivity on every write.
- **Reuse, do not duplicate.** Always `searchBrain` for an existing company/contact/deal before creating one; update in place when it exists.
- **Provenance.** Every record traces back to the recording's Episode (`recordingId`) so a human can jump to the exact `start_ms` the claim came from.
