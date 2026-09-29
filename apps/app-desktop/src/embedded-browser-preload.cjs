// Runs only in the trusted local toolbar's isolated world. No contextBridge,
// ipcRenderer, events, WebContents, or generic command API is exposed to pages.
const { ipcRenderer } = require("electron");

window.addEventListener("DOMContentLoaded", () => {
  const element = id => document.getElementById(id);
  const send = (command, value) => ipcRenderer.send("embedded-browser:command", command, value);
  const address = element("address");
  let selected = null;
  for (const command of ["back", "forward", "reload", "new", "stop", "detach", "dock", "collapse", "expand"]) {
    element(command).addEventListener("click", () => send(command));
  }
  element("rail-stop").addEventListener("click", () => send("stop"));
  element("rail-detach").addEventListener("click", () => send("detach"));
  let presentation;
  let drag = null;
  const separator = element("separator");
  const endDrag = () => {
    if (drag && separator.hasPointerCapture(drag.id)) separator.releasePointerCapture(drag.id);
    drag = null;
  };
  separator.addEventListener("pointerdown", event => {
    if (event.button !== 0 || presentation?.mode !== "docked" || presentation.collapsed) return;
    drag = { id: event.pointerId, x: event.screenX, width: presentation.panelWidth };
    separator.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  separator.addEventListener("pointermove", event => {
    if (drag && event.pointerId === drag.id) send("resize", { width: drag.width + drag.x - event.screenX });
  });
  for (const name of ["pointerup", "pointercancel", "lostpointercapture"]) separator.addEventListener(name, endDrag);
  window.addEventListener("blur", endDrag);
  window.addEventListener("pagehide", endDrag);
  separator.addEventListener("keydown", event => {
    if (presentation?.mode !== "docked" || presentation.collapsed) return;
    const widths = { ArrowLeft: presentation.panelWidth + 16, ArrowRight: presentation.panelWidth - 16,
      Home: presentation.minWidth, End: presentation.maxWidth };
    if (Object.hasOwn(widths, event.key)) { event.preventDefault(); send("resize", { width: widths[event.key] }); }
  });
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
    presentation = state.presentation;
    if (presentation) {
      if (presentation.collapsed || presentation.mode !== "docked") endDrag();
      // Keep keyboard focus on a visible control when the panel changes shape.
      const active = document.activeElement;
      const focusExpand = presentation.collapsed && active && element("controls").contains(active);
      const focusCollapse = !presentation.collapsed && active && element("rail").contains(active);
      element("rail").hidden = !presentation.collapsed;
      element("controls").hidden = presentation.collapsed;
      element("empty").hidden = presentation.collapsed || state.tabs.length > 0;
      element("detach").hidden = presentation.mode !== "docked";
      element("dock").hidden = presentation.mode === "docked";
      element("collapse").hidden = presentation.mode !== "docked";
      separator.hidden = presentation.mode !== "docked" || presentation.collapsed;
      if (focusExpand) element("expand").focus();
      if (focusCollapse) element(presentation.mode === "docked" ? "collapse" : "dock").focus();
      separator.setAttribute("aria-valuemin", String(presentation.minWidth));
      separator.setAttribute("aria-valuemax", String(presentation.maxWidth));
      separator.setAttribute("aria-valuenow", String(presentation.panelWidth));
    }
    const tab = state.tabs.find(tab => tab.id === state.selected);
    if (selected !== state.selected || document.activeElement !== address) address.value = tab?.url || "";
    selected = state.selected;
    element("status").textContent = state.status || "Browser";
    element("status").title = state.status || "Browser";
    element("back").disabled = !tab?.back;
    element("forward").disabled = !tab?.forward;
    element("reload").disabled = !tab;
    element("tabs").replaceChildren(...state.tabs.map(tab => {
      const group = document.createElement("div");
      group.className = "tab";
      const select = document.createElement("button");
      select.textContent = tab.title;
      select.title = `${tab.title}: ${tab.url}`;
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
