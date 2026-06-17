/**
 * Desktop SPA entry (Approach B). Mounts the React app loaded from file:// in
 * the Electron bundled shell. The doc shell + react-router mount here as the
 * port progresses (plan Phase 2); today it's the boot/auth screen in `App`.
 */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./app.css";
import { App } from "./app";

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
