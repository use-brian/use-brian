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
/**
 * A channel turn never carries an explicit `custom:<id>` selection, so it
 * reaches a custom endpoint through the workspace's TIER ROUTE - and a tier
 * route captures every built-in model in the picker too. "Use the web app to
 * choose a built-in model", the wording this constant carried until
 * 2026-08-19, therefore sent the user somewhere that refuses the same image
 * for the same reason. Name the setting that actually lifts the restriction.
 *
 * Since the same day this sentence is also RARE: a tier-routed turn whose
 * endpoint cannot read images is served by a built-in model instead (see
 * `CUSTOM_MODEL_IMAGE_FALLBACK_NOTICE`). It survives for the one case with
 * nowhere to fall back to - a deployment whose only configured model is the
 * endpoint itself - so it must not promise a built-in that does not exist.
 */
export const CUSTOM_MODEL_IMAGE_REJECTION =
  'This workspace routes its models to an endpoint that cannot read images, and no built-in model is configured to answer instead. Send the message without the image, or point this tier at a model that reads images in Settings > Models.'

/**
 * Said when the fallback DID happen: the endpoint could not read the image,
 * so a built-in model answered this one turn.
 *
 * It exists because byo-llm-key.md forbids a SILENT fallback, not a fallback:
 * moving a turn to a provider the workspace admin did not choose is only
 * acceptable while the person reading the answer can see that it happened.
 * Delete this sentence and the fallback becomes the thing the spec forbids.
 */
export const CUSTOM_MODEL_IMAGE_FALLBACK_NOTICE =
  'This workspace routes its models to an endpoint that cannot read images, so a built-in Brian model answered this message.'

export function channelUserErrorText(
  err: Error,
  fallback = 'Something went wrong. Please try again.',
): string {
  if (err.message.includes('usage limit')) return err.message
  if (err.message === CUSTOM_MODEL_IMAGE_REJECTION) return err.message
  return fallback
}
