/** Exact acknowledgments and connectivity probes, never a short-request classifier.
 * [COMP:classification/trivial-chat] See docs/architecture/engine/chat-latency.md.
 */
export function isTrivialChatMessage(message: string): boolean {
  const text = message.trim()
  return text.length > 0 && text.length <= 40
    && /^(?:(?:hi|hello|hey)(?: there)?|thanks|thank you|test|ping|pong|i['’]m here|早晨|你好|多謝|谢谢|謝謝|こんにちは|ありがとう|而家得閒嗎)[\s!?.,。！？，]*$/iu.test(text)
}

/** A standalone greeting, without acknowledgments, questions or instructions. */
export function isBareChatGreeting(message: string): boolean {
  return /^(?:hi|hello|hey|你好|您好|こんにちは)[!.！。\s]*$/iu.test(message.trim())
}
