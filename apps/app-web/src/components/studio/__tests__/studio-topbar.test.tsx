// @vitest-environment jsdom
/**
 * [COMP:app-web/studio-topbar] Route-owned action slot.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  STUDIO_TOPBAR_ACTIONS_ID,
  StudioTopbarActions,
} from "../studio-topbar";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let pageRoot: HTMLDivElement;
let root: Root;

beforeEach(() => {
  const target = document.createElement("div");
  target.id = STUDIO_TOPBAR_ACTIONS_ID;
  document.body.appendChild(target);

  pageRoot = document.createElement("div");
  document.body.appendChild(pageRoot);
  root = createRoot(pageRoot);
});

afterEach(async () => {
  await act(async () => root.unmount());
  document.body.replaceChildren();
});

describe("[COMP:app-web/studio-topbar] StudioTopbarActions", () => {
  it("portals a route-owned action into the persistent top bar and removes it on unmount", async () => {
    await act(async () => {
      root.render(
        <StudioTopbarActions>
          <button type="button">Add connector</button>
        </StudioTopbarActions>,
      );
    });

    const target = document.getElementById(STUDIO_TOPBAR_ACTIONS_ID);
    expect(target?.textContent).toBe("Add connector");
    expect(pageRoot.textContent).toBe("");

    await act(async () => root.render(null));
    expect(target?.textContent).toBe("");
  });
});
