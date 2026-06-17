import type { Locale } from "../config";
import { en, type Dictionary } from "./en";
import { ja } from "./ja";
import { zh } from "./zh";

const REGISTRY: Record<Locale, Dictionary> = { en, zh, ja };

export function getDictionary(locale: Locale): Dictionary {
  return REGISTRY[locale];
}

export type { Dictionary };
