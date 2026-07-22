/**
 * WhatsApp link-code helpers — pure logic behind the Settings → Account →
 * Connected accounts WhatsApp row.
 *
 * The Telegram sibling deep-links by bot @username (`t.me/<bot>?start=<code>`).
 * WhatsApp has no username, only a number, so the equivalent is
 * `wa.me/<digits>?text=<code>` — which prefills the outgoing message, making
 * the handshake two taps instead of a copy-paste.
 *
 * Countdown/expiry helpers are shared with Telegram (`telegram-link.ts`);
 * only the deep link differs.
 *
 * See docs/architecture/channels/whatsapp.md → "Account Linking Flow".
 * Component tag: [COMP:app-web/whatsapp-link].
 */

/** The code charset minted by LinkCodeStore (ambiguous glyphs excluded). */
const LINK_CODE_PATTERN = /^[A-Z0-9]{6}$/;

/**
 * Build the `https://wa.me/<digits>?text=<code>` deep link that opens a chat
 * with the official bot and prefills the 6-char code.
 *
 * The number arrives as display text (`+852 6123 4567`), and wa.me accepts
 * digits only, so punctuation and spacing are stripped. Returns null when the
 * number has no digits or the code is out of shape — the UI then just shows
 * the code for manual sending, which still works.
 */
export function buildWhatsappDeepLink(
  officialNumber: string | null | undefined,
  code: string,
): string | null {
  if (!officialNumber) return null;
  const digits = officialNumber.replace(/\D/g, "");
  if (!digits) return null;
  if (!LINK_CODE_PATTERN.test(code)) return null;
  return `https://wa.me/${digits}?text=${encodeURIComponent(code)}`;
}
