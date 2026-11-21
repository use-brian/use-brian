/** Home Dock response contract for the API and browser SDK. [COMP:shared/home-dock] */
export const NEED_CARD_KINDS = [
  'brain_review',
  'approvals',
  'autopilot',
  'task_triage',
  'task_cleanup',
  'deal_attention',
  'connector_attention',
  'workflow_attention',
] as const

export type NeedCardKind = (typeof NEED_CARD_KINDS)[number]

export type ApprovalGroupCounts = {
  externalActions: number
  contentReview: number
  systemImprovements: number
  questionsAndAccess: number
}

export type ResolvedNeed = {
  kind: NeedCardKind
  count: number
  caption: string | null
}

export type ResolvedDock = {
  source: 'assistant' | 'default'
  generatedAt: string | null
  note: string | null
  needsYou: ResolvedNeed[]
  approvalGroups: ApprovalGroupCounts
  pickUp: { id: string; name: string; updatedAt: string }[]
  comingUp: { id: string; name: string; nextRunAt: string }[]
  brain: {
    entryCount: number
    growth7d: number
    sparkline: number[]
    hasConnector: boolean
  }
}

/** Older API versions may omit grouped approvals or the daily growth counts. */
export type CompatibleResolvedDock = Omit<ResolvedDock, 'approvalGroups' | 'brain'> & {
  approvalGroups?: ApprovalGroupCounts
  brain: Omit<ResolvedDock['brain'], 'sparkline'> & Partial<Pick<ResolvedDock['brain'], 'sparkline'>>
}

export type HomeDockResponse<Dock extends CompatibleResolvedDock = ResolvedDock> = { dock: Dock }
