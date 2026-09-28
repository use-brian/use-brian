// Runs only in the trusted local toolbar's isolated world. No contextBridge,
// ipcRenderer, events, WebContents, or generic command API is exposed to pages.
const { ipcRenderer } = require("electron");

window.addEventListener("DOMContentLoaded", () => {
  const element = id => document.getElementById(id);
  const send = (command, value) => ipcRenderer.send("embedded-browser:command", command, value);
  const address = element("address");
  let selected = null;
  for (const command of ["back", "forward", "reload", "new", "stop", "approve"]) {
    element(command).addEventListener("click", () => send(command));
  }
  element("navigation").addEventListener("submit", event => {
    event.preventDefault();
    send("navigate", address.value.trim());
    address.blur();
  });
  const focusAddress = () => { address.focus(); address.select(); };
  window.addEventListener("keydown", event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "l") {
      event.preventDefault();
      focusAddress();
    }
  });
  ipcRenderer.on("embedded-browser:focus-address", focusAddress);
  ipcRenderer.on("embedded-browser:state", (_event, state) => {
    const tab = state.tabs.find(tab => tab.id === state.selected);
    if (selected !== state.selected || document.activeElement !== address) address.value = tab?.url || "";
    selected = state.selected;
    element("status").textContent = state.status;
    element("status").title = state.status;
    element("back").disabled = !tab?.back;
    element("forward").disabled = !tab?.forward;
    element("reload").disabled = !tab;
    element("approve").disabled = !tab || tab.taskOwned;
    element("tabs").replaceChildren(...state.tabs.map(tab => {
      const group = document.createElement("div");
      group.className = "tab";
      const select = document.createElement("button");
      select.textContent = tab.title;
      select.title = `${tab.title} — ${tab.url}${tab.taskOwned ? " (Brian task)" : ""}`;
      select.setAttribute("role", "tab");
      select.setAttribute("aria-selected", String(tab.id === selected));
      select.addEventListener("click", () => send("select", tab.id));
      const close = document.createElement("button");
      close.textContent = "×";
      close.setAttribute("aria-label", `Close ${tab.title}`);
      close.addEventListener("click", () => send("close", tab.id));
      group.append(select, close);
      return group;
    }));
  });
  send("ready");
});
