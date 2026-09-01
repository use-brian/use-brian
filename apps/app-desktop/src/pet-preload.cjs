// Sandboxed preload for the bundled Brian companion. The page receives no
// privileged API; activating its one button emits one fixed intent to main.
const { ipcRenderer } = require("electron");

const labels = {
  idle: "Message Brian",
  loading: "Loading…",
  thinking: "Thinking…",
  responding: "Responding…",
  "action-required": "I need your input",
};
let currentState = "idle";
let completionTimer;

window.addEventListener("DOMContentLoaded", () => {
  const status = document.getElementById("status");
  const button = document.getElementById("message-brian");
  let pointerStart;
  let dragged = false;
  let suppressClick = false;
  document.body.dataset.state = currentState;
  button?.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    pointerStart = { x: event.screenX, y: event.screenY, id: event.pointerId };
    dragged = false;
    button.setPointerCapture(event.pointerId);
    ipcRenderer.send("Use Brian:companion-drag", {
      phase: "start",
      screenX: event.screenX,
      screenY: event.screenY,
    });
  });
  button?.addEventListener("pointermove", (event) => {
    if (!pointerStart || event.pointerId !== pointerStart.id) return;
    if (Math.hypot(event.screenX - pointerStart.x, event.screenY - pointerStart.y) >= 4) {
      dragged = true;
    }
    if (!dragged) return;
    ipcRenderer.send("Use Brian:companion-drag", {
      phase: "move",
      screenX: event.screenX,
      screenY: event.screenY,
    });
  });
  const finishDrag = (event) => {
    if (!pointerStart || event.pointerId !== pointerStart.id) return;
    suppressClick = dragged;
    ipcRenderer.send("Use Brian:companion-drag", { phase: "end", moved: dragged });
    pointerStart = undefined;
    dragged = false;
    if (button.hasPointerCapture(event.pointerId)) button.releasePointerCapture(event.pointerId);
  };
  button?.addEventListener("pointerup", finishDrag);
  button?.addEventListener("pointercancel", finishDrag);
  button?.addEventListener("click", () => {
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    ipcRenderer.send("Use Brian:message-brian");
  });
  ipcRenderer.on("Use Brian:companion-state", (_event, next) => {
    if (!next || typeof next !== "object" || !(next.phase in labels)) return;
    clearTimeout(completionTimer);
    const prior = currentState;
    currentState = next.phase;
    if (next.phase === "idle" && (prior === "thinking" || prior === "responding")) {
      document.body.dataset.state = "complete";
      if (status) status.textContent = "Ready";
      completionTimer = setTimeout(() => {
        document.body.dataset.state = "idle";
        if (status) status.textContent = labels.idle;
      }, 900);
      return;
    }
    document.body.dataset.state = next.phase;
    if (status) status.textContent = next.label || labels[next.phase];
  });
});
