/**
 * Telegram link-code helpers — pure logic behind the Settings → Account →
 * Connected accounts connect flow.
 *
 * See docs/architecture/platform/auth.md → "Linked accounts".
 * Component tag: [COMP:app-web/telegram-link].
 */

/** Telegram deep-link payload charset (t.me start parameter). */
const DEEP_LINK_CODE_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** Telegram bot usernames: alphanumerics + underscore. */
const BOT_USERNAME_PATTERN = /^[A-Za-z0-9_]{3,64}$/;

/**
 * Build the `https://t.me/<bot>?start=<code>` deep link that delivers the
 * 6-char link code to the official bot as `/start <code>`. Returns null when
 * either part is missing or out of shape, in which case the UI falls back to
 * showing the code for manual paste.
 */
export function buildTelegramDeepLink(
  botUsername: string | null | undefined,
  code: string,
): string | null {
  if (!botUsername || !BOT_USERNAME_PATTERN.test(botUsername)) return null;
  if (!DEEP_LINK_CODE_PATTERN.test(code)) return null;
  return `https://t.me/${botUsername}?start=${code}`;
}

/**
 * Whole seconds until the code expires, clamped at 0. Accepts the ISO string
 * the API returns (or a Date) so callers don't need to pre-parse.
 */
export function linkCodeSecondsLeft(
  expiresAt: string | Date,
  now: Date = new Date(),
): number {
  const expiry = typeof expiresAt === "string" ? new Date(expiresAt) : expiresAt;
  const ms = expiry.getTime() - now.getTime();
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.floor(ms / 1000);
}

/** Format a countdown as `M:SS` for the "Code expires in" caption. */
export function formatCountdown(totalSeconds: number): string {
  const clamped = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(clamped / 60);
  const seconds = clamped % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}
