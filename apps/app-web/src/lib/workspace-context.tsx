"use client";

import { createContext, useContext, type ReactNode } from "react";

export type WorkspaceContextValue = {
  workspaceId: string;
  name: string;
  role: "owner" | "admin" | "member";
  /**
   * The requesting member's own data clearance (migration 153). The doc
   * page-header clearance pill bounds its picker to this — a member can't set
   * a page above their own clearance (the PATCH route enforces the same).
   */
  clearance: "public" | "internal" | "confidential";
  /**
   * Identity of the requesting user — used by collaborative surfaces
   * to dedupe own-events from bus broadcasts and skip presence flicker
   * for self.
   */
  me: { id: string };
};

const WorkspaceContext = createContext<WorkspaceContextValue | null>(null);

export function WorkspaceContextProvider(props: {
  value: WorkspaceContextValue;
  children: ReactNode;
}) {
  return (
    <WorkspaceContext.Provider value={props.value}>
      {props.children}
    </WorkspaceContext.Provider>
  );
}

export function useWorkspaceContext(): WorkspaceContextValue {
  const value = useContext(WorkspaceContext);
  if (!value) {
    throw new Error(
      "useWorkspaceContext must be used inside a WorkspaceContextProvider",
    );
  }
  return value;
}
