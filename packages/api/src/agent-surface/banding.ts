/**
 * Agent-surface write banding — the Auto / Approve split for Tier-2
 * control-plane writes (docs/plans/agent-facing-capability-surface.md §6.1,
 * locked decision §12.3: conservative bands).
 *
 * Applies ONLY on the agent surfaces (brain MCP / assistant MCP /
 * public-api chat) — the web chat path keeps its existing behavior (humans
 * there have the confirmation-card + Approvals surfaces already).
 *
 *   - `auto`    — reversible, low blast radius: executes directly when the
 *                 bound assistant holds the `configure` capability.
 *   - `approve` — consequential: staged as a `kind='staged_write'`
 *                 pending_approvals row; a human approves in the web app
 *                 and only then does the tool execute.
 *
 * A tool absent from this map is NOT a control-plane write (Tier-1 reads
 * and the data-plane tools are unbanded). Loosen a band only after the
 * loop is observed working — never by default.
 *
 * Component tag: [COMP:agent-surface/banding].
 */

export type WriteBand = 'auto' | 'approve'

export const TIER2_WRITE_BANDS: Readonly<Record<string, WriteBand>> = {
  // ── Workflows — drafts are reversible; running one acts on the world.
  createWorkflow: 'auto',
  updateWorkflow: 'auto',
  runWorkflow: 'approve',

  // ── Scheduling — reversible rows the user sees in the assistant detail.
  createScheduledJob: 'auto',
  updateScheduledJob: 'auto',
  deleteScheduledJob: 'auto',

  // ── Ingest rules — reversible routing config.
  addIngestRule: 'auto',
  updateIngestRule: 'auto',
  deleteIngestRule: 'auto',

  // ── Brain corrections — reversible trust-loop operations.
  retractMemory: 'auto',
  deleteBrainRow: 'auto',
  reclassifySensitivity: 'auto',

  // ── Skills — proposing stages its own approval (the skills governance
  //    loop IS the gate); enabling on an assistant changes what that
  //    assistant can invoke (approve); disabling only reduces power (auto).
  proposeSkill: 'auto',
  enableSkill: 'approve',
  disableSkill: 'auto',

  // ── Connectors — policy toggles are reversible; credentials/enablement
  //    change what the workspace can reach (approve). OAuth connectors are
  //    never completable headless — scaffold + connect-link only.
  setConnectorPolicy: 'auto',
  addPatConnector: 'approve',
  configureConnectorInstance: 'approve',

  // ── Assistants — drafting is consequential by construction (§6.3):
  //    creation and updates land in the Approvals inbox.
  createAssistant: 'approve',
  updateAssistant: 'approve',
}

export function bandOf(toolName: string): WriteBand | null {
  return TIER2_WRITE_BANDS[toolName] ?? null
}

/** True when the tool is a Tier-2 control-plane write (configure-gated). */
export function isControlPlaneWrite(toolName: string): boolean {
  return toolName in TIER2_WRITE_BANDS
}
