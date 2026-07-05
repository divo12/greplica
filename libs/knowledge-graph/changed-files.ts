import { execFileSync } from "node:child_process";

/**
 * The repo-relative paths that changed since `sinceSha`: the union of committed
 * changes (`git diff --name-only <sinceSha>..HEAD`) and uncommitted working-tree
 * changes (`git status --porcelain`). The second half is what lets the heal catch
 * edits that haven't been committed yet — the SHA-gate's blind spot.
 *
 * Best effort: any git failure (no repo, bad sha) yields `[]`, so the caller can
 * fall back to a full sweep rather than crash the background pass.
 */
export function changedFilesSince(repoRoot: string | undefined, sinceSha: string | undefined): string[] {
  if (repoRoot === undefined) return [];
  const files = new Set<string>();
  for (const file of committedChanges(repoRoot, sinceSha)) files.add(file);
  for (const file of uncommittedChanges(repoRoot)) files.add(file);
  return [...files];
}

function committedChanges(repoRoot: string, sinceSha: string | undefined): string[] {
  if (sinceSha === undefined) return [];
  const out = git(repoRoot, ["diff", "--name-only", `${sinceSha}..HEAD`]);
  return out === undefined ? [] : nonEmptyLines(out);
}

function uncommittedChanges(repoRoot: string): string[] {
  const out = git(repoRoot, ["status", "--porcelain"]);
  if (out === undefined) return [];
  return nonEmptyLines(out).map(porcelainPath);
}

/** Extract the path from a `git status --porcelain` line (rename shows `old -> new`). */
function porcelainPath(line: string): string {
  const path = line.slice(3);
  const arrow = path.indexOf(" -> ");
  return arrow === -1 ? path : path.slice(arrow + 4);
}

function git(repoRoot: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", args, { cwd: repoRoot, stdio: ["ignore", "pipe", "ignore"] }).toString();
  } catch {
    return undefined;
  }
}

function nonEmptyLines(out: string): string[] {
  return out.split("\n").map((line) => line.trimEnd()).filter((line) => line.length > 0);
}
