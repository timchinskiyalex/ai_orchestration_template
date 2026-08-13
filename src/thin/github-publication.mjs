import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { GitHubCiAdapter, GitHubMergeAdapter, GitHubPullRequestAdapter, RemoteAdapterError, RemoteGitAdapter } from "../remote-adapters.mjs";

const exec = promisify(execFile);
const PROTECTED_BRANCHES = new Set(["main", "master"]);
const SHA = /^[0-9a-f]{40}$/i;
const SAFE_REF = /^(?!.*(?:^|\/)\.{1,2}(?:\/|$))[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;

/**
 * Controller-owned publication of an already accepted thin candidate.
 * It deliberately has no knowledge of workers, worktrees, or the legacy
 * runtime: the only authority it accepts is a persisted acceptance report.
 */
export async function publishThinCandidate({
  repository,
  runtimeDir,
  acceptance,
  remoteName,
  allowedRemotes = ["origin"],
  branch,
  base,
  requiredCiContexts = [],
  autoMerge = false,
  adapters = {},
  gitRunner = defaultGitRunner,
  onEvent = () => {},
} = {}) {
  const candidate = validateAdmission({ repository, runtimeDir, acceptance, remoteName, allowedRemotes, branch, base, requiredCiContexts, autoMerge });
  const statePath = publicationStatePath(runtimeDir, candidate);
  const stored = readState(statePath, candidate);
  const emit = (type, details = {}) => onEvent({ at: new Date().toISOString(), type, candidate: safeCandidate(candidate), ...details });
  const persist = (next) => writeState(statePath, { schemaVersion: 1, candidate, ...next });

  // Verify local object identity before any remote side effect. A SHA supplied
  // by a report is not enough if the repository no longer contains that exact
  // commit (for example after an accidental cleanup).
  try {
    const [local, branchHead] = await Promise.all([
      gitRunner(repository, ["rev-parse", "--verify", `${candidate.sha}^{commit}`]),
      gitRunner(repository, ["rev-parse", "--verify", `refs/heads/${candidate.branch}^{commit}`]),
    ]);
    if (local.toLowerCase() !== candidate.sha.toLowerCase() || branchHead.toLowerCase() !== candidate.sha.toLowerCase()) {
      throw new Error("accepted candidate branch does not resolve to the exact accepted SHA");
    }
  } catch (error) {
    return blocked("blocked_candidate", "candidate_not_available", { statePath, candidate, detail: safeError(error) });
  }

  const remoteGit = adapters.remoteGit ?? new RemoteGitAdapter({ repository, remoteName, allowedRemotes, branchPrefix: candidate.branchPrefix });
  const pullRequests = adapters.pullRequests ?? new GitHubPullRequestAdapter({ repository });
  const ci = adapters.ci ?? new GitHubCiAdapter({ repository, requiredContexts: requiredCiContexts });
  const merge = adapters.merge ?? new GitHubMergeAdapter({ repository });

  let push = stored?.push ?? null;
  try {
    if (push?.verifiedSha?.toLowerCase() === candidate.sha.toLowerCase()) {
      emit("publication_push_reused", { statePath });
    } else {
      emit("publication_push_started", { statePath });
      push = await remoteGit.pushCandidate({ branch: candidate.branch, sha: candidate.sha, confirmRemotePush: true, idempotencyKey: candidate.pushKey });
      if ((push?.verifiedSha ?? push?.sha)?.toLowerCase() !== candidate.sha.toLowerCase()) throw new RemoteAdapterError("remote_sha_mismatch", "Remote push did not verify the exact accepted candidate SHA.");
      persist({ push, pullRequest: null, ci: null, merge: null });
      emit("publication_push_completed", { statePath });
    }
  } catch (error) { return blockedFromError(error, "push", { statePath, candidate, push }); }

  let pullRequest = stored?.pullRequest ?? null;
  try {
    if (pullRequest?.number && pullRequest?.headSha?.toLowerCase() === candidate.sha.toLowerCase()) {
      emit("publication_pr_reused", { statePath, pullRequest: safePr(pullRequest) });
    } else {
      emit("publication_pr_started", { statePath });
      pullRequest = await pullRequests.ensurePullRequest({
        branch: candidate.branch, base: candidate.base, sha: candidate.sha, idempotencyKey: candidate.prKey,
        title: `Autonomous delivery: ${candidate.branch}`,
        body: `Controller-owned candidate ${candidate.sha}. Acceptance report: ${candidate.acceptanceDigest}.`,
      });
      if (!Number.isInteger(pullRequest?.number) || pullRequest?.headSha?.toLowerCase() !== candidate.sha.toLowerCase()) throw new RemoteAdapterError("pr_create_failed", "Pull request does not point to the exact accepted candidate SHA.");
      persist({ push, pullRequest, ci: null, merge: null });
      emit("publication_pr_completed", { statePath, pullRequest: safePr(pullRequest) });
    }
  } catch (error) { return blockedFromError(error, "pull_request", { statePath, candidate, push, pullRequest }); }

  let ciResult;
  try {
    emit("publication_ci_started", { statePath, pullRequest: safePr(pullRequest) });
    ciResult = await ci.waitForChecks({ pullRequest, candidate });
    persist({ push, pullRequest, ci: ciResult, merge: stored?.merge ?? null });
    if (ciResult?.status !== "passed") {
      const code = ciResult?.status === "timed_out" ? "ci_timeout" : "ci_failed";
      return blocked("blocked_ci", code, { statePath, candidate, push, pullRequest: safePr(pullRequest), ci: safeCi(ciResult) });
    }
    emit("publication_ci_completed", { statePath, pullRequest: safePr(pullRequest) });
  } catch (error) { return blockedFromError(error, "ci", { statePath, candidate, push, pullRequest: safePr(pullRequest) }); }

  if (autoMerge !== true) {
    persist({ push, pullRequest, ci: ciResult, merge: null });
    return Object.freeze({ ok: true, state: "completed_pr_ready", candidate, push, pullRequest: safePr(pullRequest), ci: safeCi(ciResult), statePath, autoMerge: false });
  }

  let merged = stored?.merge ?? null;
  try {
    if (merged?.status === "merged" && merged?.targetVerified === true) {
      emit("publication_merge_reused", { statePath, pullRequest: safePr(pullRequest) });
    } else {
      emit("publication_merge_started", { statePath, pullRequest: safePr(pullRequest) });
      merged = await merge.merge({ pullRequest, candidate, base: candidate.base, idempotencyKey: candidate.mergeKey });
      if (merged?.status !== "merged" || merged?.targetVerified !== true) throw new RemoteAdapterError("merge_verify_failed", "Merge adapter did not prove the target branch contains the candidate.");
      persist({ push, pullRequest, ci: ciResult, merge: merged });
      emit("publication_merge_completed", { statePath, pullRequest: safePr(pullRequest) });
    }
  } catch (error) { return blockedFromError(error, "merge", { statePath, candidate, push, pullRequest: safePr(pullRequest), ci: safeCi(ciResult) }); }
  return Object.freeze({ ok: true, state: "completed_merged", candidate, push, pullRequest: safePr(pullRequest), ci: safeCi(ciResult), merge: safeMerge(merged), statePath, autoMerge: true });
}

/** Read a strict controller report from disk; user-provided free-form JSON is rejected. */
export function readThinAcceptanceReport(path) {
  let parsed;
  try { parsed = JSON.parse(readFileSync(resolve(path), "utf8")); }
  catch (error) { throw new Error(`acceptance report cannot be read: ${safeError(error)}`); }
  if (!isPlainObject(parsed) || parsed.schemaVersion !== 2 || parsed.state !== "completed_spec_verified" || !SHA.test(parsed.candidateSha ?? "")) {
    throw new Error("acceptance report is not a completed_spec_verified ThinAcceptanceReport");
  }
  return parsed;
}

function validateAdmission({ repository, runtimeDir, acceptance, remoteName, allowedRemotes, branch, base, requiredCiContexts, autoMerge }) {
  if (typeof repository !== "string" || !repository) throw new TypeError("repository is required");
  if (typeof runtimeDir !== "string" || !runtimeDir) throw new TypeError("runtimeDir is required");
  if (!isPlainObject(acceptance) || acceptance.schemaVersion !== 2 || acceptance.state !== "completed_spec_verified" || !SHA.test(acceptance.candidateSha ?? "")) throw new Error("publication requires a completed_spec_verified acceptance report with an exact candidate SHA");
  if (!safeName(remoteName) || !Array.isArray(allowedRemotes) || !allowedRemotes.includes(remoteName)) throw new Error("remoteName must be explicitly allowlisted");
  if (!safeBranch(branch) || PROTECTED_BRANCHES.has(branch.toLowerCase())) throw new Error("candidate branch must be an explicit non-protected branch");
  if (!safeBranch(base) || branch === base) throw new Error("base branch must be explicit and distinct from the candidate branch");
  if (!Array.isArray(requiredCiContexts) || requiredCiContexts.some((name) => typeof name !== "string" || !name.trim() || name.length > 200)) throw new Error("requiredCiContexts must be a bounded string array");
  if (autoMerge !== true && autoMerge !== false) throw new Error("autoMerge must be boolean");
  const branchPrefix = `${branch.split("/").slice(0, -1).join("/")}/`;
  if (!branchPrefix || branchPrefix === "/") throw new Error("candidate branch must include a controller-owned namespace prefix");
  const acceptanceDigest = createHash("sha256").update(JSON.stringify({ schemaVersion: acceptance.schemaVersion, state: acceptance.state, candidateSha: acceptance.candidateSha })).digest("hex");
  return Object.freeze({ sha: acceptance.candidateSha.toLowerCase(), branch, base, branchPrefix, remoteName, acceptanceDigest, pushKey: `thin-push:${remoteName}:${branch}:${acceptance.candidateSha.toLowerCase()}`, prKey: `thin-pr:${branch}:${base}:${acceptance.candidateSha.toLowerCase()}`, mergeKey: `thin-merge:${branch}:${base}:${acceptance.candidateSha.toLowerCase()}` });
}

function publicationStatePath(runtimeDir, candidate) {
  const id = createHash("sha256").update(`${candidate.remoteName}\0${candidate.branch}\0${candidate.base}\0${candidate.sha}`).digest("hex").slice(0, 24);
  return join(resolve(runtimeDir), "thin-publication", `${id}.json`);
}
function readState(path, candidate) {
  if (!existsSync(path)) return null;
  try {
    const state = JSON.parse(readFileSync(path, "utf8"));
    if (state?.schemaVersion !== 1 || state?.candidate?.sha !== candidate.sha || state.candidate.branch !== candidate.branch || state.candidate.base !== candidate.base || state.candidate.remoteName !== candidate.remoteName) return null;
    return state;
  } catch { return null; }
}
function writeState(path, payload) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(payload)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, path);
}
async function defaultGitRunner(repository, args) { const result = await exec("git", ["-C", repository, ...args], { encoding: "utf8", windowsHide: true }); return String(result.stdout ?? "").trim(); }
function safeBranch(value) { return typeof value === "string" && SAFE_REF.test(value) && !value.includes("//") && !value.endsWith("/"); }
function safeName(value) { return typeof value === "string" && /^[A-Za-z0-9._-]+$/.test(value); }
function blockedFromError(error, stage, details) {
  const remoteCode = error instanceof RemoteAdapterError ? error.code : null;
  const missingGh = /(?:spawn\s+gh\s+enoent|\bgh(?:\.exe)?\b.*(?:not recognized|not found|no such file))/i.test(String(error?.message ?? error));
  const code = remoteCode ?? (missingGh ? "gh_unavailable" : `${stage}_failed`);
  const state = code === "credentials" ? "blocked_credentials" : code === "branch_protection" ? "blocked_branch_protection" : stage === "ci" ? "blocked_ci" : "blocked_remote";
  return blocked(state, code, { ...details, detail: safeError(error) });
}
function blocked(state, code, details) { return Object.freeze({ ok: false, state, code, ...details }); }
function safeCandidate(candidate) { return { sha: candidate.sha, branch: candidate.branch, base: candidate.base, remoteName: candidate.remoteName }; }
function safePr(pr) { return pr ? { number: pr.number, url: typeof pr.url === "string" ? pr.url : null, headSha: pr.headSha } : null; }
function safeCi(ci) { return ci ? { status: ci.status, reason: typeof ci.reason === "string" ? ci.reason.slice(0, 500) : null, required: Array.isArray(ci.required) ? ci.required.map((item) => ({ name: item.name, state: item.state })) : [] } : null; }
function safeMerge(merge) { return merge ? { status: merge.status, number: merge.number, mergeSha: merge.mergeSha, mainSha: merge.mainSha, targetVerified: merge.targetVerified === true } : null; }
function safeError(value) { return String(value?.message ?? value ?? "unknown").replace(/[\r\n]+/g, " ").slice(0, 500); }
function isPlainObject(value) { return value != null && typeof value === "object" && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype; }
