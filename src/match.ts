import { execFileSync } from "node:child_process";

/**
 * A session matches a spoochie coming from outside if its checkout knows the envelope's
 * branch. Without a branch there is nothing to decide with, and nothing is handed out
 * blind: it stays queued until a session that does match starts, or until the 4 h expire.
 */
export function repoMatches(cwd: string, branch?: string): boolean {
  if (!branch) return false;
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", branch], { cwd, stdio: "ignore" });
    return true;
  } catch { return false; }
}
