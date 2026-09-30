/** Page expression used before Brian-owned CDP actions. [COMP:sandbox/action-cursor] */
export type ActionCursorKind = 'pointer' | 'typing'

export const ACTION_CURSOR_MARKER = '__use_brian_action_cursor_v1__'

const ACTION_CURSOR_FUNCTION = String.raw`(kind) => {
  const key = Symbol.for("use-brian.action-cursor.v1");
  let state = window[key];
  if (!state || !state.host || !state.host.isConnected) {
    const host = document.createElement("div");
    host.setAttribute("aria-hidden", "true");
    host.inert = true;
    host.dataset.useBrianActionCursor = "__use_brian_action_cursor_v1__";
    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML = '<style>:host{all:initial;position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none;contain:layout style;opacity:0;transform:translate3d(-40px,-40px,0);transition:transform var(--travel-time,0ms) cubic-bezier(.4,0,.2,1),opacity 120ms ease}svg{position:absolute;left:-3px;top:-2px;width:28px;height:34px;overflow:visible;filter:drop-shadow(0 2px 3px rgba(0,0,0,.35))}.ring{position:absolute;left:-11px;top:-11px;width:22px;height:22px;border:3px solid rgba(65,137,255,.78);border-radius:999px;box-sizing:border-box;opacity:0}.ring.on{animation:use-brian-action-pulse 460ms ease-out}@keyframes use-brian-action-pulse{0%{opacity:.95;transform:scale(.35)}100%{opacity:0;transform:scale(1.75)}}@media(prefers-reduced-motion:reduce){:host{transition:opacity 120ms ease}.ring.on{animation:none;opacity:.8}}</style><div class="ring"></div><svg viewBox="0 0 28 34" aria-hidden="true"><path d="M3 2v25l6.8-6.2 5.1 10.4 5-2.4-5.1-10.1H24L3 2Z" fill="#4189ff" stroke="white" stroke-width="2" stroke-linejoin="round"/></svg>';
    (document.documentElement || document.body).appendChild(host);
    state = {
      host,
      ring: root.querySelector(".ring"),
      cleanup: null,
      hideTimer: null,
      target: null,
      position: null,
      async arrive(x, y) {
        this.target = null;
        this.show(x, y, false);
        // Flush style so getAnimations includes the newly started transition.
        void getComputedStyle(host).transform;
        const animations = host.getAnimations().filter(a => a.transitionProperty === "transform");
        if (!animations.length) return;
        await new Promise(resolve => {
          const timeout = setTimeout(resolve, 500);
          Promise.all(animations.map(a => a.finished.catch(() => {}))).then(() => {
            clearTimeout(timeout);
            resolve();
          });
        });
      },
      showTarget(target) {
        if (!target || !target.isConnected) return;
        this.target = target;
        const rect = target.getBoundingClientRect();
        this.show(rect.left + rect.width / 2, rect.top + rect.height / 2, true);
      },
      show(x, y, pulse) {
        const px = Math.max(0, Math.min(window.innerWidth - 1, Number(x) || 0));
        const py = Math.max(0, Math.min(window.innerHeight - 1, Number(y) || 0));
        const previous = this.position;
        if (!previous || previous.x !== px || previous.y !== py) {
          const distance = previous ? Math.hypot(px - previous.x, py - previous.y) : 0;
          // First appearance is at the target, not a flight from off-screen.
          // Longer journeys get more time; tiny adjustments stay responsive.
          const duration = distance ? Math.min(420, Math.max(90, 70 + 12 * Math.sqrt(distance))) : 0;
          host.style.setProperty("--travel-time", duration + "ms");
          host.style.transform = "translate3d(" + px + "px," + py + "px,0)";
          this.position = { x: px, y: py };
        }
        host.style.opacity = "1";
        if (pulse && this.ring) {
          this.ring.classList.remove("on");
          void this.ring.offsetWidth;
          this.ring.classList.add("on");
        }
        clearTimeout(this.hideTimer);
        this.hideTimer = setTimeout(() => {
          if (typeof this.cleanup === "function") this.cleanup();
          host.remove();
          delete window[key];
        }, 4000);
      },
    };
    Object.defineProperty(window, key, { value: state, configurable: true });
    // Failed/no-op actions must not leave presentation DOM behind either.
    state.hideTimer = setTimeout(() => {
      if (typeof state.cleanup === "function") state.cleanup();
      host.remove();
      delete window[key];
    }, 4000);
  }

  if (typeof state.cleanup === "function") state.cleanup();
  const removers = [];
  let timer = null;
  const on = (name, handler) => {
    document.addEventListener(name, handler, true);
    removers.push(() => document.removeEventListener(name, handler, true));
  };
  const cleanup = () => {
    for (const remove of removers) remove();
    clearTimeout(timer);
    if (state.cleanup === cleanup) state.cleanup = null;
  };
  state.cleanup = cleanup;

  if (kind === "pointer") {
    const move = (event) => { state.target = null; state.show(event.clientX, event.clientY, false); };
    const down = (event) => {
      state.show(event.clientX, event.clientY, true);
      cleanup();
    };
    on("pointermove", move);
    on("mousemove", move);
    on("pointerdown", down);
    on("mousedown", down);
  } else {
    const focus = (event) => {
      const target = event.target;
      if (!target || typeof target.getBoundingClientRect !== "function") return;
      state.showTarget(target);
      cleanup();
    };
    on("focusin", focus);
    on("input", focus);
  }

  timer = setTimeout(cleanup, 1500);
  return true;
}`

export function buildActionCursorArmExpression(kind: ActionCursorKind): string {
  return `(${ACTION_CURSOR_FUNCTION})(${JSON.stringify(kind)})`
}

/** Presentation-only travel: never synthesizes extra page input or hover events. */
export function buildActionCursorMoveExpression(x: number, y: number): string {
  return `window[Symbol.for("use-brian.action-cursor.v1")]?.arrive(${JSON.stringify(x)}, ${JSON.stringify(y)})`
}

/** Finish only our overlay's transition before CDP captures the composited page.
 * Bounded fallback also works when requestAnimationFrame is throttled in a hidden tab.
 */
export const ACTION_CURSOR_BEFORE_CAPTURE = `(() => {
  const state = window[Symbol.for("use-brian.action-cursor.v1")];
  if (!state || !state.host.isConnected) return;
  if (state.target) {
    if (!state.target.isConnected) { state.host.style.opacity = "0"; return; }
    const rect = state.target.getBoundingClientRect();
    state.host.style.transform = "translate3d(" + Math.max(0, Math.min(innerWidth - 1, rect.left + rect.width / 2)) + "px," + Math.max(0, Math.min(innerHeight - 1, rect.top + rect.height / 2)) + "px,0)";
  }
  for (const animation of state.host.getAnimations()) animation.finish();
  return new Promise(resolve => {
    const timer = setTimeout(resolve, 100);
    requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timer); resolve(); }));
  });
})()`
