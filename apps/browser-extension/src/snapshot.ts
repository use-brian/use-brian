/**
 * Ref-based accessibility snapshot builder (P1.5): CDP
 * `Accessibility.getFullAXTree` nodes → the `@eN role "name"` interactive
 * list the agent acts on. Shape mirrors agent-browser so the cloud backend
 * matches (spec §3 browserSnapshot). Pure — unit-tested without Chrome.
 */

/** The slice of a CDP AXNode this builder reads. */
export type CdpAXNode = {
  nodeId: string
  ignored?: boolean
  role?: { value?: unknown }
  name?: { value?: unknown }
  value?: { value?: unknown }
  backendDOMNodeId?: number
  properties?: Array<{ name?: string; value?: { value?: unknown } }>
}

type SnapshotNode = {
  ref?: string
  role: string
  name: string
  value?: string
  disabled?: boolean
}

export type BuiltSnapshot = {
  nodes: SnapshotNode[]
  /** ref → backendDOMNodeId, for click/type targeting. Valid for this snapshot only. */
  refToBackendNodeId: Map<string, number>
  /** ref → accessible name, kept for audit/approval previews. */
  refToName: Map<string, string>
}

/**
 * Roles the agent can act on. CDP AX roles come from Chromium's internal
 * role names (lowercased here for matching).
 */
const INTERACTIVE_ROLES: ReadonlySet<string> = new Set([
  'button',
  'link',
  'textbox',
  'textfield',
  'textfieldwithcombobox',
  'searchbox',
  'combobox',
  'checkbox',
  'radio',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'tab',
  'switch',
  'slider',
  'spinbutton',
  'option',
  'listboxoption',
  'popupbutton',
])

const INFORMATION_ROLES: ReadonlySet<string> = new Set([
  'caption',
  'cell',
  'columnheader',
  'definition',
  'heading',
  'labeltext',
  'legend',
  'listitem',
  'paragraph',
  'row',
  'rowheader',
  'statictext',
  'table',
  'term',
])

function asString(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function propTrue(node: CdpAXNode, name: string): boolean {
  return (
    node.properties?.some((p) => p.name === name && p.value?.value === true) ?? false
  )
}

/**
 * Build the interactive-node list. Includes nodes whose role is interactive,
 * plus focusable nodes that carry a name (covers contenteditable message
 * boxes that report generic roles). Skips ignored/nameless-noise nodes.
 */
export function buildSnapshot(axNodes: CdpAXNode[], mode: 'interactive' | 'full' = 'interactive'): BuiltSnapshot {
  const nodes: SnapshotNode[] = []
  const refToBackendNodeId = new Map<string, number>()
  const refToName = new Map<string, string>()
  let counter = 0

  for (const ax of axNodes) {
    if (ax.ignored) continue
    const role = asString(ax.role?.value).toLowerCase()
    const name = asString(ax.name?.value).trim()
    const interactive = INTERACTIVE_ROLES.has(role) || (propTrue(ax, 'focusable') && name.length > 0)
    if (interactive && typeof ax.backendDOMNodeId !== 'number') continue
    if (!interactive && (mode !== 'full' || !INFORMATION_ROLES.has(role) || name.length === 0)) continue
    // StaticText is the stable semantic text node. InlineTextBox fragments are
    // layout artifacts and produce the duplicated, line-wrapped transcripts
    // seen on MTR fare tables.
    if (role === 'inlinetextbox') continue
    if (name.length === 0 && !INTERACTIVE_ROLES.has(role)) continue

    const ref = interactive ? `@e${++counter}` : undefined
    const value = asString(ax.value?.value)
    const node: SnapshotNode = {
      role: role || 'node',
      name,
      ...(ref ? { ref } : {}),
      ...(value ? { value } : {}),
      ...(propTrue(ax, 'disabled') ? { disabled: true } : {}),
    }
    nodes.push(node)
    if (ref && typeof ax.backendDOMNodeId === 'number') {
      refToBackendNodeId.set(ref, ax.backendDOMNodeId)
      refToName.set(ref, name)
    }
  }

  return { nodes, refToBackendNodeId, refToName }
}
