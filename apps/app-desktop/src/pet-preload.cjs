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
  document.body.dataset.state = currentState;
  document.getElementById("message-brian")?.addEventListener("click", () => {
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
