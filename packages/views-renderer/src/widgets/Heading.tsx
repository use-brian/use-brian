import type { JSX } from 'react'

/**
 * A2UI Heading — h1 / h2 / h3 / h4. Sizing matched to the workspace
 * design system (sidan.io style — see apps/web/CLAUDE.md). Level 4 matches
 * Notion's Heading 4 (`####`).
 */
export function Heading(props: {
  level: 1 | 2 | 3 | 4
  text: string
}): JSX.Element {
  const sizeClass = props.level === 1
    ? 'text-2xl font-semibold'
    : props.level === 2
      ? 'text-xl font-semibold'
      : props.level === 3
        ? 'text-lg font-medium'
        : 'text-base font-medium'
  switch (props.level) {
    case 1:
      return <h1 className={sizeClass}>{props.text}</h1>
    case 2:
      return <h2 className={sizeClass}>{props.text}</h2>
    case 3:
      return <h3 className={sizeClass}>{props.text}</h3>
    case 4:
      return <h4 className={sizeClass}>{props.text}</h4>
  }
}
