import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { publishThinCandidate, readThinAcceptanceReport } from "../src/thin/github-publication.mjs";
import { parseThinPublishArgs, runThinPublish } from "../scripts/thin-publish.mjs";
import { RemoteAdapterError } from "../src/remote-adapters.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "thin-publication-"));
  const repository = join(root, "repo"); const runtimeDir = join(root, "runtime");
  mkdirSync(repository); git(repository, ["init"]); writeFileSync(join(repository, "README.md"), "candidate\n");
  git(repository, ["add", "README.md"]); git(repository, ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "candidate"]);
  const sha = git(repository, ["rev-parse", "HEAD"]); git(repository, ["branch", "thin/candidate/product", sha]);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, repository, runtimeDir, sha, acceptance: { schemaVersion: 2, state: "completed_spec_verified", candidateSha: sha } };
}
function git(cwd, args) { return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim(); }
function greenAdapters(calls) {
  return {
    remoteGit: { async pushCandidate(request) { calls.push += 1; assert.equal(request.confirmRemotePush, true); return { status: "pushed", verifiedSha: request.sha }; } },
    pullRequests: { async ensurePullRequest(request) { calls.pr += 1; return { status: "open", number: 18, url: "https://example.test/pr/18", headSha: request.sha }; } },
    ci: { async waitForChecks() { calls.ci += 1; return { status: "passed", required: [{ name: "verify", state: "passed" }] }; } },
    merge: { async merge(request) { calls.merge += 1; return { status: "merged", number: request.pullRequest.number, mainSha: "f".repeat(40), mergeSha: "e".repeat(40), targetVerified: true }; } },
  };
}

test("publication requires accepted local candidate branch, persists idempotently, and merges only with explicit flag", async (t) => {
  const { repository, runtimeDir, acceptance } = fixture(t); const calls = { push: 0, pr: 0, ci: 0, merge: 0 };
  const first = await publishThinCandidate({ repository, runtimeDir, acceptance, remoteName: "origin", branch: "thin/candidate/product", base: "main", requiredCiContexts: ["verify"], adapters: greenAdapters(calls) });
  assert.equal(first.ok, true); assert.equal(first.state, "completed_pr_ready"); assert.deepEqual(calls, { push: 1, pr: 1, ci: 1, merge: 0 });
  const second = await publishThinCandidate({ repository, runtimeDir, acceptance, remoteName: "origin", branch: "thin/candidate/product", base: "main", requiredCiContexts: ["verify"], autoMerge: true, adapters: greenAdapters(calls) });
  assert.equal(second.ok, true); assert.equal(second.state, "completed_merged"); assert.deepEqual(calls, { push: 1, pr: 1, ci: 2, merge: 1 });
  const resumed = await publishThinCandidate({ repository, runtimeDir, acceptance, remoteName: "origin", branch: "thin/candidate/product", base: "main", requiredCiContexts: ["verify"], autoMerge: true, adapters: greenAdapters(calls) });
  assert.equal(resumed.ok, true); assert.equal(resumed.state, "completed_merged"); assert.deepEqual(calls, { push: 1, pr: 1, ci: 3, merge: 1 });
});

test("publication fails closed before adapters for report, protected branch, and local branch identity defects", async (t) => {
  const { repository, runtimeDir, acceptance, sha } = fixture(t); const calls = { push: 0, pr: 0, ci: 0, merge: 0 };
  await assert.rejects(publishThinCandidate({ repository, runtimeDir, acceptance: { ...acceptance, state: "blocked" }, remoteName: "origin", branch: "thin/candidate/product", base: "main", adapters: greenAdapters(calls) }), /completed_spec_verified/);
  await assert.rejects(publishThinCandidate({ repository, runtimeDir, acceptance, remoteName: "origin", branch: "main", base: "master", adapters: greenAdapters(calls) }), /non-protected/);
  git(repository, ["branch", "-f", "thin/candidate/product", sha]); writeFileSync(join(repository, "other.txt"), "different\n"); git(repository, ["add", "other.txt"]); git(repository, ["-c", "user.name=Test", "-c", "user.email=test@example.test", "commit", "-m", "different"]);
  git(repository, ["branch", "-f", "thin/candidate/product", "HEAD"]);
  const blocked = await publishThinCandidate({ repository, runtimeDir, acceptance, remoteName: "origin", branch: "thin/candidate/product", base: "main", adapters: greenAdapters(calls) });
  assert.equal(blocked.ok, false); assert.equal(blocked.state, "blocked_candidate"); assert.equal(blocked.code, "candidate_not_available"); assert.deepEqual(calls, { push: 0, pr: 0, ci: 0, merge: 0 });
});

test("credential, CI and branch-protection failures remain structured and never merge", async (t) => {
  const { repository, runtimeDir, acceptance } = fixture(t); const calls = { push: 0, pr: 0, ci: 0, merge: 0 };
  const credentials = { ...greenAdapters(calls), remoteGit: { async pushCandidate() { throw new RemoteAdapterError("credentials", "not logged in"); } } };
  const first = await publishThinCandidate({ repository, runtimeDir, acceptance, remoteName: "origin", branch: "thin/candidate/product", base: "main", adapters: credentials });
  assert.equal(first.state, "blocked_credentials"); assert.equal(calls.merge, 0);
  const ciFailed = { ...greenAdapters(calls), ci: { async waitForChecks() { return { status: "failed", reason: "verify failed", required: [{ name: "verify", state: "failed" }] }; } } };
  const second = await publishThinCandidate({ repository, runtimeDir, acceptance, remoteName: "origin", branch: "thin/candidate/product", base: "main", adapters: ciFailed, autoMerge: true });
  assert.equal(second.state, "blocked_ci"); assert.equal(second.code, "ci_failed"); assert.equal(calls.merge, 0);
  const protection = { ...greenAdapters(calls), merge: { async merge() { throw new RemoteAdapterError("branch_protection", "required review"); } } };
  const third = await publishThinCandidate({ repository, runtimeDir, acceptance, remoteName: "origin", branch: "thin/candidate/product", base: "main", adapters: protection, autoMerge: true });
  assert.equal(third.state, "blocked_branch_protection"); assert.equal(calls.merge, 0);
  const missingFixture = fixture(t); const unavailable = { ...greenAdapters(calls), pullRequests: { async ensurePullRequest() { throw new Error("spawn gh ENOENT"); } } };
  const fourth = await publishThinCandidate({ repository: missingFixture.repository, runtimeDir: missingFixture.runtimeDir, acceptance: missingFixture.acceptance, remoteName: "origin", branch: "thin/candidate/product", base: "main", adapters: unavailable });
  assert.equal(fourth.state, "blocked_remote"); assert.equal(fourth.code, "gh_unavailable");
});

test("publish CLI requires explicit confirmation and a strict acceptance report", async (t) => {
  const { root, acceptance } = fixture(t); const report = join(root, "acceptance.json"); writeFileSync(report, JSON.stringify(acceptance));
  assert.equal(parseThinPublishArgs(["--repo", "C:/repo", "--runtime", "C:/runtime", "--acceptance-report", report, "--remote-name", "origin", "--branch", "thin/candidate/a", "--base", "main", "--required-check", "verify", "--confirm-remote-publication"]).requiredChecks[0], "verify");
  const errors = []; const code = await runThinPublish({ argv: ["--acceptance-report", report], stdout: () => {}, stderr: (line) => errors.push(line) });
  assert.equal(code, 2); assert.match(errors[0], /remote_confirmation_required/);
  const parsed = readThinAcceptanceReport(report); assert.equal(parsed.candidateSha, acceptance.candidateSha);
});
