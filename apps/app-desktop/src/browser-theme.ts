/** A bounded appearance-only message from the trusted app frame. Never copy CSS rules or URLs. */
export const browserThemeColors = ["background", "foreground", "sidebar", "sidebar-foreground", "muted-foreground", "border", "primary", "accent", "accent-foreground", "destructive", "ring", "sidebar-accent", "sidebar-accent-foreground"] as const;
export type BrowserTheme = {
  colors: Record<typeof browserThemeColors[number], string>;
  colorScheme: "light" | "dark";
  radius: string;
  fontFamily: string;
};

export function parseBrowserTheme(input: unknown): BrowserTheme | null {
  if (!input || typeof input !== "object") return null;
  const value = input as Partial<BrowserTheme>;
  if (!value.colors || typeof value.colors !== "object" ||
      (value.colorScheme !== "light" && value.colorScheme !== "dark") ||
      typeof value.radius !== "string" || !/^\d+(?:\.\d+)?px$/.test(value.radius) || parseFloat(value.radius) > 64 ||
      typeof value.fontFamily !== "string" || value.fontFamily.length > 512 || !/^[\w\s,'"-]+$/.test(value.fontFamily)) return null;
  const colors = {} as BrowserTheme["colors"];
  for (const key of browserThemeColors) {
    const color = value.colors[key];
    if (typeof color !== "string" || color.length > 160 ||
        !/^(?:#[\da-f]{3,8}|(?:rgb|rgba|hsl|hsla|oklch|oklab|lab|lch|color)\([\da-z.,%+\-/\s]+\))$/i.test(color)) return null;
    colors[key] = color;
  }
  return { colors, colorScheme: value.colorScheme, radius: value.radius, fontFamily: value.fontFamily };
}
