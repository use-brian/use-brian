"use client";

import { createContext, useContext, type ReactNode } from "react";
import type { Dictionary } from "./dictionaries";

const Context = createContext<Dictionary | null>(null);

export function I18nProvider({ dictionary, children }: { dictionary: Dictionary; children: ReactNode }) {
  return <Context.Provider value={dictionary}>{children}</Context.Provider>;
}

export function useT(): Dictionary {
  const value = useContext(Context);
  if (!value) throw new Error("I18nProvider is missing");
  return value;
}
