/**
 * User-facing text for a channel `sendError` hook.
 *
 * The pipeline's error event carries whatever the failure threw — provider
 * SDK wording, runtime stack prose, or one of our own server-authored
 * refusals. Only the server-authored messages are safe (and useful) to put
 * in front of a user; arbitrary provider/runtime wording is replaced with
 * the generic retry line.
 *
 * Two kinds of message pass through verbatim:
 *
 * - usage-limit notices — the message IS the recovery step, and
 * - the custom-model inline-image refusal minted by channel-pipeline.ts,
 *   matched EXACTLY so a vendor error that merely mentions the same words
 *   cannot ride along. Masking it as a generic outage hides the only useful
 *   recovery step (resend without the image, or switch the tier's model)
 *   and makes a healthy text-only endpoint look broken: the 2026-08-12
 *   Telegram SDR screenshot album, then again 2026-08-19 on Slack — the
 *   Telegram BYO route had been fixed in isolation and the other seven
 *   channel routes kept masking. This helper is the one copy of that
 *   decision; route-local whitelists are the drift that caused the repeat.
 *
 * Spec: docs/architecture/platform/byo-llm-key.md → "Strict fallback and
 * attachments".
 */
export const CUSTOM_MODEL_IMAGE_REJECTION =
  'Custom model endpoints currently support text and tools only. Remove the inline image or use the web app to choose a built-in model.'

export function channelUserErrorText(
  err: Error,
  fallback = 'Something went wrong. Please try again.',
): string {
  if (err.message.includes('usage limit')) return err.message
  if (err.message === CUSTOM_MODEL_IMAGE_REJECTION) return err.message
  return fallback
}
