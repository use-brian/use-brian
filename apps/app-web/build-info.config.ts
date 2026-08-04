import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

const GIT_COMMIT_PATTERN = /^[0-9a-f]{7,40}$/i;

function normalizedCommit(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && GIT_COMMIT_PATTERN.test(trimmed) ? trimmed.toLowerCase() : null;
}

/**
 * Resolve the OSS source revision once, while the client bundle is built.
 * Deploy pipelines may provide it explicitly when their source archive omits
 * `.git`; local and ordinary checkout builds read the use-brian repository's
 * HEAD directly.
 */
export function resolveOssGitCommitSha(): string {
  const configured =
    normalizedCommit(process.env.NEXT_PUBLIC_OSS_GIT_COMMIT_SHA) ??
    normalizedCommit(process.env.OSS_GIT_COMMIT_SHA);
  if (configured) return configured;

  try {
    const repositoryRoot = realpathSync(resolve(import.meta.dirname, "..", ".."));
    const discoveredGitRoot = realpathSync(
      execFileSync("git", ["rev-parse", "--show-toplevel"], {
        cwd: repositoryRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim(),
    );
    // A platform source archive may contain the OSS directory without its
    // nested .git metadata. In that case Git walks upward to the platform
    // repository; reject that SHA because it is not the OSS revision.
    if (discoveredGitRoot !== repositoryRoot) return "";

    return (
      normalizedCommit(
        execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: repositoryRoot,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
        }),
      ) ?? ""
    );
  } catch {
    // Source archives and some container build contexts intentionally omit
    // Git metadata. The settings footer will link to the repository root.
    return "";
  }
}
