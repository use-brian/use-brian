/**
 * `chat/` fallback - covers entry into `/chat` and every sub-route swap under
 * it. Fresh Chat has no transcript to load. Keep entry quiet while its bundle
 * arrives; the persistent workspace chrome already owns navigation feedback.
 *
 * Spec: docs/architecture/features/perceived-performance.md
 */

export default function ChatLoading() {
  return null;
}
