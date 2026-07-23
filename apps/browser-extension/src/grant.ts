/**
 * Browser-control permission window: the one place Chrome's own permission
 * prompt can be raised.
 *
 * `chrome.permissions.request()` only runs from an extension context, inside a
 * real user gesture — so neither our web app nor the background service worker
 * can ask on the user's behalf. The sidebar's "Allow browser control" opens
 * THIS window, and the click below is the gesture Chrome requires.
 *
 * Closing on grant is deliberate: the prompt is the whole content of the
 * window, and leaving a dead "Allow" button on screen after a grant reads as
 * "it didn't work".
 */
import { hasBrowserControl, requestBrowserControl } from './browser-control-permission.js'

function note(text: string, isError = false): void {
  const el = document.getElementById('note')
  if (!el) return
  el.textContent = text
  el.classList.toggle('error', isError)
}

document.getElementById('grant')?.addEventListener('click', () => {
  // No `await` before the request: anything asynchronous here would spend the
  // user gesture Chrome requires, and the prompt would throw instead of open.
  void requestBrowserControl().then(async (granted) => {
    if (granted) {
      window.close()
      return
    }
    // Distinguish "you said no" from "Chrome would not ask" — only the first is
    // something the user can change their mind about right here.
    const already = await hasBrowserControl()
    if (already) {
      window.close()
      return
    }
    note(
      'Not allowed. Use Brian cannot drive your browser until you allow it. You can press Allow again.',
      true,
    )
  })
})

document.getElementById('cancel')?.addEventListener('click', () => window.close())
