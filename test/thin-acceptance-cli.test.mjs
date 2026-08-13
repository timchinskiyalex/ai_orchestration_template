import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseThinAcceptArgs, runThinAccept, thinAcceptUsage } from "../scripts/thin-accept.mjs";

test("thin acceptance CLI parses only explicit candidate and repair inputs", () => {
  const parsed = parseThinAcceptArgs(["--repo", "repo", "--docs", "docs", "--candidate", "abcdef1", "--verify", "node --test", "--repair-surface", "apps/api, apps/web", "--confirm-spend-quota"]);
  assert.deepEqual(parsed, { repo: "repo", docs: "docs", candidate: "abcdef1", verify: "node --test", repairSurface: ["apps/api", "apps/web"], confirm: true, help: false });
  assert.match(thinAcceptUsage(), /thin-accept/);
});

test("accepted repair remains on an explicit candidate branch without mutating the source branch", async (t) => {
  const fixture = createRepositoryFixture(t);
  const output = [];
  let auditCalls = 0;
  let verificationCalls = 0;
  const code = await runThinAccept({
    argv: acceptanceArgv(fixture), stdout: (line) => output.push(line), stderr: (line) => output.push(line),
    dependencies: {
      createRuntimeDir: () => fixture.runtime,
      runSemanticAuditTurn: async ({ label, prompt }) => {
        if (label === "acceptance-repair") return JSON.stringify({ title: "Repair acceptance gap", prompt: "Create the required repair file in src.", allowedPaths: ["src"] });
        auditCalls += 1;
        return acceptanceResponse(prompt, auditCalls === 1 ? "gap" : "pass");
      },
      runThinAppServerWorker: async ({ cwd }) => { writeFileSync(join(cwd, "src", "repaired.txt"), "repaired\n"); },
      runVerification: async () => { verificationCalls += 1; return { ok: true }; },
    },
  });

  assert.equal(code, 0);
  assert.equal(auditCalls, 2, "repair is accepted only after the second audit");
  assert.equal(verificationCalls, 2, "repair is accepted only after the second verification");
  const completed = output.find((line) => line.startsWith("[completed] accepted candidate "));
  assert.ok(completed);
  const match = completed.match(/^\[completed\] accepted candidate ([0-9a-f]{40}) branch=(thin\/acceptance-candidate-[A-Za-z0-9._-]+)$/);
  assert.ok(match, completed);
  const [, candidateSha, candidateBranch] = match;
  assert.equal(git(fixture.repository, ["rev-parse", "HEAD"]), fixture.sourceHead);
  assert.equal(git(fixture.repository, ["branch", "--show-current"]), "main");
  assert.equal(git(fixture.repository, ["status", "--porcelain=v1"]), "");
  assert.equal(git(fixture.repository, ["rev-parse", "--verify", `${candidateBranch}^{commit}`]), candidateSha);
  execFileSync("git", ["-C", fixture.repository, "merge-base", "--is-ancestor", fixture.sourceHead, candidateSha]);
  const reportPath = output.find((line) => line.startsWith("[acceptance] report ")).slice("[acceptance] report ".length);
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  assert.equal(report.candidateSha, candidateSha);
  assert.equal(report.candidateBranch, candidateBranch);
});

test("failed acceptance repair preserves its candidate worktree and branch without mutating the source branch", async (t) => {
  const fixture = createRepositoryFixture(t);
  const output = [];
  const code = await runThinAccept({
    argv: acceptanceArgv(fixture), stdout: (line) => output.push(line), stderr: (line) => output.push(line),
    dependencies: {
      createRuntimeDir: () => fixture.runtime,
      runSemanticAuditTurn: async ({ label, prompt }) => label === "acceptance-repair"
        ? JSON.stringify({ title: "Repair acceptance gap", prompt: "Create the required repair file in src.", allowedPaths: ["src"] })
        : acceptanceResponse(prompt, "gap"),
      runThinAppServerWorker: async () => { throw new Error("controlled worker failure"); },
      runVerification: async () => ({ ok: true }),
    },
  });

  assert.equal(code, 1);
  const failure = output.find((line) => line.startsWith("[failure] stage=acceptance code=repair_worker_failed recovery="));
  assert.ok(failure);
  const worktree = failure.slice(failure.indexOf("recovery=") + "recovery=".length);
  assert.equal(existsSync(worktree), true, "failed repair worktree is preserved for recovery");
  const branches = git(fixture.repository, ["branch", "--format=%(refname:short)"]).split(/\r?\n/).filter((branch) => branch.startsWith("thin/acceptance-candidate-"));
  assert.equal(branches.length, 1, "failed repair branch remains reachable for recovery");
  assert.equal(git(fixture.repository, ["rev-parse", "HEAD"]), fixture.sourceHead);
  assert.equal(git(fixture.repository, ["branch", "--show-current"]), "main");
  assert.equal(git(fixture.repository, ["status", "--porcelain=v1"]), "");
  await cleanupPreservedWorktree(fixture.repository, worktree, branches[0]);
});

function createRepositoryFixture(t) {
  const root = mkdtempSync(join(tmpdir(), "thin-acceptance-cli-"));
  const repository = join(root, "product");
  const docs = join(root, "docs");
  const runtime = join(root, "runtime");
  mkdirSync(join(repository, "src"), { recursive: true });
  mkdirSync(docs, { recursive: true });
  mkdirSync(runtime, { recursive: true });
  execFileSync("git", ["init", "-b", "main", repository]);
  git(repository, ["config", "user.name", "Fixture"]);
  git(repository, ["config", "user.email", "fixture@example.test"]);
  writeFileSync(join(repository, "src", "seed.txt"), "seed\n");
  writeFileSync(join(docs, "requirements.md"), "# Product\n\n- Must create repaired output.\n");
  git(repository, ["add", "--", "src/seed.txt"]);
  git(repository, ["commit", "-m", "fixture"]);
  const sourceHead = git(repository, ["rev-parse", "HEAD"]);
  t.after(async () => {
    const worktrees = git(repository, ["worktree", "list", "--porcelain"]).split(/\r?\n/)
      .filter((line) => line.startsWith("worktree ")).map((line) => line.slice("worktree ".length))
      .filter((path) => path.startsWith(runtime));
    for (const worktree of worktrees) await cleanupPreservedWorktree(repository, worktree);
    rmSync(root, { recursive: true, force: true });
  });
  return { root, repository, docs, runtime, sourceHead };
}

function acceptanceArgv({ repository, docs, sourceHead }) {
  return ["--repo", repository, "--docs", docs, "--candidate", sourceHead, "--verify", "ignored", "--repair-surface", "src", "--confirm-spend-quota"];
}

function acceptanceResponse(prompt, status) {
  const criterionId = [...prompt.matchAll(/"criterionId":"(criterion-[a-f0-9]+)"/g)].at(-1)?.[1];
  assert.ok(criterionId, "controller criterion ID must be present in semantic prompt");
  return JSON.stringify({ results: [{ criterionId, status, reason: status === "pass" ? "verified after controller repair" : "missing repair output" }] });
}

async function cleanupPreservedWorktree(repository, worktree, branch = null) {
  if (worktree && existsSync(worktree)) execFileSync("git", ["-C", repository, "worktree", "remove", "--force", worktree]);
  if (branch) execFileSync("git", ["-C", repository, "branch", "-D", branch]);
}

function git(cwd, args) {
  return String(execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" })).trim();
}
