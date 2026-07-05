import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url);

function git(cwd, ...args) {
  return execFileSync("git", ["-c", "user.email=t@t.io", "-c", "user.name=t", ...args], {
    cwd,
    stdio: ["ignore", "pipe", "ignore"],
  }).toString().trim();
}

// ---------------------------------------------------------------------------
// changedFilesSince: git diff (committed) ∪ git status --porcelain (uncommitted)
// ---------------------------------------------------------------------------
const { changedFilesSince } = await import(new URL("dist/libs/knowledge-graph/changed-files.js", root));

const gitRepo = mkdtempSync(join(tmpdir(), "greplica-cf-"));
git(gitRepo, "init", "-q");
writeFileSync(join(gitRepo, "a.ts"), "export const a = 1;\n");
writeFileSync(join(gitRepo, "b.ts"), "export const b = 1;\n");
git(gitRepo, "add", "-A");
git(gitRepo, "commit", "-qm", "seed");
const headSha = git(gitRepo, "rev-parse", "HEAD");

// Uncommitted edit to a.ts is caught; b.ts (untouched) is not.
writeFileSync(join(gitRepo, "a.ts"), "export const a = 2;\n");
let changed = changedFilesSince(gitRepo, headSha);
assert.ok(changed.includes("a.ts"), "uncommitted edit is caught");
assert.ok(!changed.includes("b.ts"), "untouched file is not reported");

// Commit the edit -> still reported as changed since the old headSha (committed diff).
git(gitRepo, "add", "-A");
git(gitRepo, "commit", "-qm", "edit a");
changed = changedFilesSince(gitRepo, headSha);
assert.ok(changed.includes("a.ts"), "committed change since sinceSha is caught");

// From the new HEAD with a clean tree -> nothing changed.
const headSha2 = git(gitRepo, "rev-parse", "HEAD");
assert.deepEqual(changedFilesSince(gitRepo, headSha2), [], "clean tree at HEAD -> no changes");

// Non-git / unreadable -> [] (caller falls back), never throws.
assert.deepEqual(changedFilesSince(mkdtempSync(join(tmpdir(), "greplica-nogit-")), headSha), [], "no git -> empty");
assert.deepEqual(changedFilesSince(undefined, undefined), [], "no repo root -> empty");

// ---------------------------------------------------------------------------
// freshness checkpoint + fingerprint deletion (repository)
// ---------------------------------------------------------------------------
const { openDatabase } = await import(new URL("dist/libs/storage/sqlite/db.js", root));
const { SqliteRepository } = await import(new URL("dist/libs/storage/sqlite/repository.js", root));

const cpRepo = new SqliteRepository(openDatabase(join(mkdtempSync(join(tmpdir(), "greplica-cp-")), "graph.db")));
assert.equal(cpRepo.getFreshnessCheckpoint("repo1"), undefined, "no checkpoint -> undefined");
cpRepo.setFreshnessCheckpoint("repo1", "sha-abc");
assert.equal(cpRepo.getFreshnessCheckpoint("repo1"), "sha-abc", "checkpoint round-trips");
cpRepo.setFreshnessCheckpoint("repo1", "sha-def");
assert.equal(cpRepo.getFreshnessCheckpoint("repo1"), "sha-def", "checkpoint updates in place");
assert.equal(cpRepo.getFreshnessCheckpoint("repo2"), undefined, "checkpoints are per-repo");

cpRepo.upsertAnchorFingerprints([
  { claim_id: "cx", file: "x.ts", symbol: "s", content_hash: "h", file_mtime_ms: 1, file_size: 2, resolver_status: "resolved" },
]);
assert.equal(cpRepo.fingerprintsForClaims(["cx"]).length, 1, "fingerprint written");
cpRepo.deleteAnchorFingerprints(["cx"]);
assert.equal(cpRepo.fingerprintsForClaims(["cx"]).length, 0, "fingerprints deleted for demoted claim");

// ---------------------------------------------------------------------------
// buildAnchorInvalidation generalizes to content drift (not just structural)
// ---------------------------------------------------------------------------
const { buildAnchorInvalidation } = await import(new URL("dist/libs/knowledge-graph/anchor-invalidation.js", root));

const demotedClaim = { id: "claim.c", kind: "fact", text: "t", truth: "code_verified", intent: "intended", code_anchors: [{ file: "a.ts", symbol: "f" }] };
const miniGraph = { components: [], flows: [], claims: [demotedClaim], sources: [], edges: [] };

// content drift: the anchor still resolves, but its span changed.
const contentPlan = buildAnchorInvalidation(
  [{ claim: demotedClaim, reason: "content", anchors: [{ file: "a.ts", symbol: "f", status: "resolved", start_line: 1, end_line: 1 }] }],
  miniGraph,
);
assert.equal(contentPlan.events[0].reason, "content_drift", "content demotion -> content_drift event");
assert.equal(contentPlan.events[0].resolver_status, "resolved", "content event records the resolving status");
assert.ok(contentPlan.proposal.creates.claims.some((c) => c.truth === "unknown"), "content demotion rebuilds a truth:unknown claim");

// structural drift: unchanged behavior (broken anchor + anchor_drift reason).
const structuralPlan = buildAnchorInvalidation(
  [{ claim: demotedClaim, reason: "structural", anchors: [{ file: "a.ts", symbol: "f", status: "missing_symbol" }] }],
  miniGraph,
);
assert.equal(structuralPlan.events[0].reason, "anchor_drift", "structural demotion -> anchor_drift event");
assert.equal(structuralPlan.events[0].resolver_status, "missing_symbol", "structural event records the drift status");

console.log("Freshness background checks passed.");
