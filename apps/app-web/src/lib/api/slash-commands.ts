/** Workspace slash-command catalog used by web chat autocomplete. */

import { authFetch } from "@/lib/auth-fetch";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export type SlashCommandTarget =
  | {
      kind: "skill";
      slug: string;
      name: string;
      description?: string | null;
    }
  | {
      kind: "workflow";
      workflowId: string;
      name: string;
      description?: string | null;
    };

export type SlashCommand = {
  /** Text inserted after `/`. Skills keep their familiar direct slug. */
  slug: string;
  name: string;
  description: string;
  kind: SlashCommandTarget["kind"];
  target: SlashCommandTarget;
};

type CatalogCommand = {
  name: string;
  description?: string;
  target: SlashCommandTarget;
};

/**
 * Read the same generated catalog used to resolve channel and web commands.
 * Workflow names stay generated (for example `workflow_daily_digest`), while
 * skills use the direct slug web-chat users already know.
 */
export async function listSlashCommands(
  workspaceId: string | null,
): Promise<SlashCommand[]> {
  if (!workspaceId) return [];
  const res = await authFetch(
    `${API_URL}/api/workspaces/${encodeURIComponent(workspaceId)}/slash-commands`,
  );
  if (!res.ok) throw new Error("Failed to load slash commands");

  const data = (await res.json()) as { commands?: unknown };
  if (!Array.isArray(data.commands)) return [];

  return data.commands.flatMap((value) => {
    const command = value as Partial<CatalogCommand>;
    const target = command.target;
    if (
      typeof command.name !== "string" ||
      !target ||
      (target.kind !== "skill" && target.kind !== "workflow") ||
      typeof target.name !== "string" ||
      (target.kind === "skill" && typeof target.slug !== "string") ||
      (target.kind === "workflow" && typeof target.workflowId !== "string")
    ) {
      return [];
    }
    return [{
      slug: target.kind === "skill" ? target.slug : command.name,
      name: target.name,
      description:
        typeof target.description === "string"
          ? target.description
          : typeof command.description === "string"
            ? command.description
            : "",
      kind: target.kind,
      target,
    }];
  });
}
