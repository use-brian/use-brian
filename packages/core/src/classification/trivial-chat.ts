/** Exact acknowledgments and connectivity probes, never a short-request classifier.
 * [COMP:classification/trivial-chat] See docs/chat-reply-delivery.md.
 */
export function isTrivialChatMessage(message: string): boolean {
  const text = message.trim()
  return text.length > 0 && text.length <= 40
    && /^(?:(?:hi|hello|hey)(?: there)?|thanks|thank you|ok(?:ay)?|sure|got it|yes|no|test|ping|pong|i['’]m here|早晨|你好|多謝|谢谢|謝謝|こんにちは|ありがとう|而家得閒嗎)[\s!?.,。！？，]*$/iu.test(text)
}
