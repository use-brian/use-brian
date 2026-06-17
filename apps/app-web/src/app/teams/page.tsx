import Link from "next/link";
import { redirect } from "next/navigation";
import { serverApiFetch } from "@/lib/server-fetch";
import { getServerDictionary } from "@/lib/i18n/server";

type Team = { id: string; name: string; role?: string };

/**
 * Workspace picker — landed when the operator belongs to multiple
 * workspaces. A single-workspace operator skips it; the `/` route at
 * `src/app/page.tsx` redirects them straight to `/w/:workspaceId`. A
 * failed fetch (`!data`) bounces to `/login`; a genuinely empty list
 * renders the picker with no rows — effectively unreachable since every
 * user has a Personal workspace auto-created at signup.
 */
export default async function TeamsPage() {
  const [data, { dict }] = await Promise.all([
    serverApiFetch<{ teams?: Team[] }>("/api/workspaces"),
    getServerDictionary(),
  ]);
  if (!data) redirect("/login");
  const teams = data.teams ?? [];
  if (teams.length === 1) redirect(`/w/${teams[0].id}`);

  const t = dict.teams;

  return (
    <div
      className="flex min-h-screen flex-col items-center justify-center bg-background px-4 relative overflow-hidden"
      style={{
        backgroundImage:
          "radial-gradient(ellipse 60% 50% at 50% 0%, rgba(52,211,255,0.07) 0%, transparent 70%), radial-gradient(ellipse 50% 40% at 100% 100%, rgba(52,211,255,0.04) 0%, transparent 60%)",
      }}
    >
      <div className="w-full max-w-md space-y-6 animate-fade-in">
        <header className="space-y-2 text-center animate-rise-in">
          <h1
            className="text-2xl font-bold tracking-tight"
            style={{ fontFamily: "var(--font-rocknroll)" }}
          >
            {t.title}
          </h1>
          <p className="text-sm text-muted-foreground">{t.description}</p>
        </header>
        <ul className="space-y-2 animate-stagger">
          {teams.map((team) => (
            <li key={team.id}>
              <Link
                href={`/w/${team.id}`}
                className="group flex items-center justify-between rounded-xl border border-border bg-card px-4 py-3.5 transition-all duration-200 hover:border-primary/40 hover:bg-accent active:bg-accent/80 hover-lift"
              >
                <div className="space-y-0.5">
                  <div className="text-sm font-medium">{team.name}</div>
                  {team.role ? (
                    <div className="text-xs text-muted-foreground capitalize">
                      {team.role}
                    </div>
                  ) : null}
                </div>
                <span
                  aria-hidden
                  className="text-muted-foreground transition-all duration-200 group-hover:text-primary group-hover:translate-x-0.5"
                >
                  →
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
