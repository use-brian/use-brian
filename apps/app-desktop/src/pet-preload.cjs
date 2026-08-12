// Sandboxed preload for the bundled Brian companion. The page receives no
// privileged API; activating its one button emits one fixed intent to main.
const { ipcRenderer } = require("electron");

window.addEventListener("DOMContentLoaded", () => {
  document.getElementById("message-brian")?.addEventListener("click", () => {
    ipcRenderer.send("Use Brian:message-brian");
  });
});
