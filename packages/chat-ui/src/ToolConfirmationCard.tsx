import type { ReactNode } from 'react'
import type { PendingConfirmation } from './types.js'

export type ToolConfirmationCardProps = {
  confirmation: PendingConfirmation
  onApprove: (toolCallId: string) => void
  onDeny: (toolCallId: string) => void
  /**
   * Optional override for the visible title. Defaults to
   * `confirmation.displayName ?? confirmation.toolName`.
   */
  title?: string
  /**
   * Optional override for the body content. Defaults to a list of
   * `displayLines` if present, otherwise a JSON dump of `input`.
   */
  body?: ReactNode
  className?: string
}

/**
 * Renders a single pending tool confirmation with approve / deny actions.
 * Stateless — the host's `useChatSession` is the source of truth for status;
 * this component just calls back when the user clicks. Buttons disable
 * themselves while the confirmation is mid-resolution.
 */
export function ToolConfirmationCard(props: ToolConfirmationCardProps) {
  const { confirmation } = props
  const title = props.title ?? confirmation.displayName ?? confirmation.toolName
  const isResolved =
    confirmation.status === 'approved' ||
    confirmation.status === 'denied' ||
    confirmation.status === 'failed'
  const isInFlight = confirmation.status === 'approving'

  return (
    <div
      data-tool-confirmation
      data-status={confirmation.status}
      data-tool-call-id={confirmation.toolCallId}
      className={props.className}
    >
      <div className="confirmation-title">{title}</div>
      {confirmation.description ? (
        <p className="confirmation-description">{confirmation.description}</p>
      ) : null}
      <div className="confirmation-body">
        {props.body ?? <ConfirmationBody confirmation={confirmation} />}
      </div>
      {confirmation.result ? (
        <pre className="confirmation-result">{confirmation.result}</pre>
      ) : null}
      {!isResolved ? (
        <div className="confirmation-actions">
          <button
            type="button"
            onClick={() => props.onApprove(confirmation.toolCallId)}
            disabled={isInFlight}
            data-action="approve"
          >
            {isInFlight ? 'Approving…' : 'Approve'}
          </button>
          <button
            type="button"
            onClick={() => props.onDeny(confirmation.toolCallId)}
            disabled={isInFlight}
            data-action="deny"
          >
            Deny
          </button>
        </div>
      ) : null}
    </div>
  )
}

function ConfirmationBody({ confirmation }: { confirmation: PendingConfirmation }) {
  if (confirmation.displayLines && confirmation.displayLines.length > 0) {
    return (
      <ul className="confirmation-display-lines">
        {confirmation.displayLines.map((line, i) => (
          <li key={i}>{line}</li>
        ))}
      </ul>
    )
  }
  return (
    <pre className="confirmation-input-dump">
      {JSON.stringify(confirmation.input, null, 2)}
    </pre>
  )
}
