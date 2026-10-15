/** Typed approval-review failure; routes map `status`, tools render `code` + message. */
export class ApprovalReviewError extends Error {
  constructor(public readonly code: string, public readonly status: number, message: string) {
    super(message)
    this.name = 'ApprovalReviewError'
  }
}
