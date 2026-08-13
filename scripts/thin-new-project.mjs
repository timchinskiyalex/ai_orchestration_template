import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { basename, dirname, extname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const exec = promisify(execFile);
const MAX_MARKDOWN_FILES = 100;
const MAX_MARKDOWN_BYTES = 2_000_000;
const BASELINE_IDENTITY = { name: "Thin Orchestrator", email: "thin-orchestrator@local" };

export function thinNewProjectUsage() {
  return "Usage: node scripts/thin-new-project.mjs --target <new-absolute-directory> --docs <absolute-markdown-file-or-directory> --verify <command> --confirm-spend-quota [--acceptance --repair-surface <path,path>] [--remote <url> --branch <branch>]";
}

export function parseThinNewProjectArgs(argv) {
  const options = { target: null, docs: null, verify: null, repairSurface: null, remote: null, branch: null, confirm: false, acceptance: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--confirm-spend-quota") options.confirm = true;
    else if (flag === "--acceptance") options.acceptance = true;
    else if (["--target", "--docs", "--verify", "--repair-surface", "--remote", "--branch"].includes(flag)) {
      const value = argv[++index];
      if (typeof value !== "string" || value.trim() === "" || value.startsWith("--")) throw new Error(`${flag} requires a value`);
      options[flag.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value.trim();
    } else if (flag === "--help" || flag === "-h") options.help = true;
    else throw new Error(`unknown option: ${flag}`);
  }
  return options;
}

/**
 * Create a brand-new target repository then hand it to the thin delivery
 * seam. No target is removed on failure: its path is always a recovery path.
 */
export async function createThinNewProject({
  target,
  docs,
  verify,
  repairSurface = null,
  remote = null,
  branch = null,
  confirm = false,
  acceptance = false,
  deliveryRunner = defaultDeliveryRunner,
  acceptanceRunner = defaultAcceptanceRunner,
  gitRunner = defaultGitRunner,
  stdout = console.log,
} = {}) {
  const targetPath = validateNewTarget(target);
  const docsPath = validateExistingAbsolutePath(docs, "docs");
  const verificationCommand = requireText(verify, "verify");
  const normalizedRepairSurface = repairSurface == null ? null : parseRepairSurface(repairSurface);
  validateRemoteOptions({ remote, branch });
  if (confirm !== true) throw new Error("--confirm-spend-quota is required before thin delivery");
  if (acceptance === true && !normalizedRepairSurface?.length) throw new Error("--acceptance requires an explicit --repair-surface");
  if (typeof deliveryRunner !== "function" || typeof acceptanceRunner !== "function" || typeof gitRunner !== "function") throw new TypeError("deliveryRunner, acceptanceRunner, and gitRunner must be functions");
  if (lstatSync(docsPath).isDirectory() && isInside(targetPath, docsPath)) {
    throw new Error("target must not be inside the documentation source path");
  }

  let baselineSha = null;
  try {
    mkdirSync(targetPath);
    const copied = copyMarkdownSnapshot({ source: docsPath, destination: join(targetPath, "docs", "source") });
    if (!copied.length) throw new Error("docs must contain at least one Markdown file");
    // A remotely published project must start on the explicit, non-protected
    // branch selected by the caller.  It is never renamed to, or pushed to,
    // main after delivery/acceptance has begun.
    await gitRunner({ cwd: targetPath, args: remote ? ["init", `--initial-branch=${branch}`] : ["init"] });
    await gitRunner({ cwd: targetPath, args: ["add", "--", "docs/source"] });
    await gitRunner({ cwd: targetPath, args: [
      "-c", `user.name=${BASELINE_IDENTITY.name}`,
      "-c", `user.email=${BASELINE_IDENTITY.email}`,
      "commit", "-m", "chore: add source documentation baseline",
    ] });
    baselineSha = await gitRunner({ cwd: targetPath, args: ["rev-parse", "HEAD"] });
    stdout(`[baseline] created ${baselineSha}`);

    const delivery = await deliveryRunner({
      repository: targetPath,
      docs: join(targetPath, "docs", "source"),
      verify: verificationCommand,
      repairSurface: normalizedRepairSurface,
      confirm: true,
      stdout,
    });
    if (!delivery?.ok || !isGitSha(delivery.candidateSha)) {
      return failed("delivery_failed", targetPath, baselineSha, stdout);
    }

    let acceptedCandidateSha = delivery.candidateSha;
    let acceptanceCandidateBranch = null;
    if (acceptance === true) {
      const accepted = await acceptanceRunner({
        repository: targetPath,
        docs: join(targetPath, "docs", "source"),
        candidateSha: delivery.candidateSha,
        verify: verificationCommand,
        repairSurface: normalizedRepairSurface,
        confirm: true,
        stdout,
      });
      if (!accepted?.ok || !isGitSha(accepted.candidateSha)) return failed("acceptance_failed", targetPath, baselineSha, stdout);
      acceptedCandidateSha = accepted.candidateSha;
      acceptanceCandidateBranch = accepted.candidateBranch == null ? null : validateAcceptanceCandidateBranch(accepted.candidateBranch);
      stdout(`[acceptance] accepted ${acceptedCandidateSha}${acceptanceCandidateBranch ? ` branch=${acceptanceCandidateBranch}` : ""}`);
    }

    if (remote) {
      await gitRunner({ cwd: targetPath, args: ["remote", "add", "origin", remote] });
      const pushBranch = acceptanceCandidateBranch ?? branch;
      // In the repaired case `pushBranch` is the controller-created branch
      // whose local ref was verified by thin-accept.  Do not infer HEAD and
      // do not alter the initial branch.
      await gitRunner({ cwd: targetPath, args: ["push", "--set-upstream", "origin", `${pushBranch}:${pushBranch}`] });
      stdout(`[remote] pushed ${pushBranch}`);
    }
    stdout(`[completed] candidate ${acceptedCandidateSha}`);
    return { ok: true, target: targetPath, baselineSha, candidateSha: acceptedCandidateSha, copiedMarkdown: copied, branch: acceptanceCandidateBranch ?? branch ?? null };
  } catch (error) {
    return failed("new_project_failed", targetPath, baselineSha, stdout, error);
  }
}

export async function runThinNewProject({ argv = process.argv.slice(2), stdout = console.log, stderr = console.error, ...seams } = {}) {
  let options;
  try { options = parseThinNewProjectArgs(argv); }
  catch (error) { stderr(`[failure] code=invalid_arguments recovery=- message=${safe(error.message)}`); return 2; }
  if (options.help) { stdout(thinNewProjectUsage()); return 0; }
  try {
    const result = await createThinNewProject({ ...options, stdout, ...seams });
    if (!result.ok) stderr(`[failure] code=${result.code} recovery=${result.recoveryPath} message=${safe(result.message)}`);
    return result.ok ? 0 : 1;
  } catch (error) {
    stderr(`[failure] code=invalid_arguments recovery=- message=${safe(error.message)}`);
    return 2;
  }
}

export function copyMarkdownSnapshot({ source, destination }) {
  const sourcePath = validateExistingAbsolutePath(source, "docs");
  const destinationPath = requireAbsolutePath(destination, "destination");
  if (existsSync(destinationPath)) throw new Error("documentation destination already exists");
  const sourceStats = lstatSync(sourcePath);
  if (sourceStats.isSymbolicLink()) throw new Error("documentation source must not be a symbolic link");
  const root = sourceStats.isDirectory() ? sourcePath : dirname(sourcePath);
  const files = collectMarkdownFiles(sourcePath);
  if (files.length > MAX_MARKDOWN_FILES) throw new Error(`docs contains more than ${MAX_MARKDOWN_FILES} Markdown files`);
  let totalBytes = 0;
  const copied = [];
  for (const file of files) {
    const bytes = statSync(file).size;
    totalBytes += bytes;
    if (totalBytes > MAX_MARKDOWN_BYTES) throw new Error(`docs exceeds ${MAX_MARKDOWN_BYTES} bytes`);
    const relativePath = sourceStats.isDirectory() ? relative(root, file) : basename(file);
    const target = resolve(destinationPath, relativePath);
    if (!isInside(target, destinationPath)) throw new Error("documentation path escapes destination");
    if (existsSync(target)) throw new Error(`refusing to overwrite documentation file '${relativePath}'`);
    mkdirSync(dirname(target), { recursive: true });
    // `file` was lstat-checked by collectMarkdownFiles; copy preserves the
    // exact Markdown bytes without evaluating or following source links.
    cpSync(file, target, { dereference: false, errorOnExist: true, force: false });
    copied.push(relativePath.split(sep).join("/"));
  }
  return copied.sort();
}

function collectMarkdownFiles(source) {
  const stats = lstatSync(source);
  if (stats.isSymbolicLink()) throw new Error("documentation source must not contain symbolic links");
  if (stats.isFile()) return extname(source).toLowerCase() === ".md" ? [source] : [];
  if (!stats.isDirectory()) throw new Error("docs must be a Markdown file or directory");
  const files = [];
  for (const entry of readdirSync(source, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const child = join(source, entry.name);
    if (entry.isSymbolicLink()) throw new Error("documentation source must not contain symbolic links");
    files.push(...collectMarkdownFiles(child));
  }
  return files;
}

function validateNewTarget(value) {
  const target = requireAbsolutePath(value, "target");
  if (target === parse(target).root) throw new Error("target must not be a filesystem root");
  if (existsSync(target)) throw new Error("target already exists; refusing to modify an existing directory");
  return target;
}

function validateExistingAbsolutePath(value, label) {
  const path = requireAbsolutePath(value, label);
  if (!existsSync(path)) throw new Error(`${label} does not exist`);
  return path;
}

function requireAbsolutePath(value, label) {
  const raw = requireText(value, label);
  if (/[\u0000-\u001f]/.test(raw) || !isAbsolute(raw)) throw new Error(`${label} must be a safe absolute path`);
  return resolve(raw);
}

function parseRepairSurface(value) {
  const parts = Array.isArray(value) ? value : String(value).split(",");
  if (!parts.length) throw new Error("repairSurface must contain at least one path");
  return [...new Set(parts.map((part) => normalizeRelativePath(part.trim())))];
}

function normalizeRelativePath(value) {
  if (!value || value.includes("\\") || value.startsWith("/") || /^[A-Za-z]:/.test(value) || value.startsWith("//")) {
    throw new Error("repairSurface paths must be normalized relative POSIX paths");
  }
  if (value.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error("repairSurface paths must not contain traversal");
  }
  return value;
}

function validateRemoteOptions({ remote, branch }) {
  if ((remote == null) !== (branch == null)) throw new Error("--remote and --branch must be supplied together");
  if (remote == null) return;
  if (/[\s\u0000-\u001f]/.test(remote)) throw new Error("remote must not contain whitespace or control characters");
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(branch) || branch.includes("..") || branch.includes("//") || branch.endsWith("/")) {
    throw new Error("branch must be an explicit safe Git branch name");
  }
  if (["main", "master"].includes(branch.toLowerCase())) throw new Error("remote branch must not be main or master");
}

function validateAcceptanceCandidateBranch(value) {
  if (typeof value !== "string" || !/^thin\/acceptance-candidate-[A-Za-z0-9._-]+(?:-[A-Za-z0-9._-]+)*$/.test(value)) {
    throw new Error("acceptance candidate branch is not a verified controller-owned branch");
  }
  return value;
}

function isInside(child, parent) {
  const candidate = resolve(child); const root = resolve(parent);
  const delta = relative(root, candidate);
  return delta === "" || (!delta.startsWith(`..${sep}`) && delta !== ".." && !isAbsolute(delta));
}

function failed(code, target, baselineSha, stdout, error = null) {
  const result = { ok: false, code, target, baselineSha, recoveryPath: target, message: safe(error?.message ?? "thin delivery did not produce a verified candidate") };
  stdout(`[recovery] target preserved ${target}`);
  return result;
}

function isGitSha(value) { return typeof value === "string" && /^[0-9a-f]{7,64}$/i.test(value); }
function requireText(value, label) { if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} is required`); return value.trim(); }
function safe(value) { return String(value ?? "").replace(/[\r\n]+/g, " ").slice(0, 300); }

async function defaultGitRunner({ cwd, args }) {
  const result = await exec("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return String(result.stdout).trim();
}

async function defaultDeliveryRunner({ repository, docs, verify, repairSurface, confirm, stdout }) {
  const { runThinDeliver } = await import("./thin-deliver.mjs");
  const output = [];
  const argv = ["--repo", repository, "--docs", docs, "--verify", verify];
  if (repairSurface?.length) argv.push("--repair-surface", repairSurface.join(","));
  if (confirm) argv.push("--confirm-spend-quota");
  const code = await runThinDeliver({
    argv,
    stdout: (line) => { output.push(String(line)); stdout(line); },
    stderr: (line) => stdout(line),
  });
  const candidate = [...output].reverse().map((line) => /^\[completed\] candidate ([0-9a-f]{7,64})$/i.exec(line)?.[1]).find(Boolean) ?? null;
  return { ok: code === 0 && isGitSha(candidate), candidateSha: candidate };
}

async function defaultAcceptanceRunner({ repository, docs, candidateSha, verify, repairSurface, confirm, stdout }) {
  const { runThinAccept } = await import("./thin-accept.mjs");
  const output = [];
  const argv = ["--repo", repository, "--docs", docs, "--candidate", candidateSha, "--verify", verify, "--repair-surface", repairSurface.join(",")];
  if (confirm) argv.push("--confirm-spend-quota");
  const code = await runThinAccept({
    argv,
    stdout: (line) => { output.push(String(line)); stdout(line); },
    stderr: (line) => { output.push(String(line)); stdout(line); },
  });
  const completed = [...output].reverse().map((line) => /^\[completed\] accepted candidate ([0-9a-f]{7,64})(?: branch=(thin\/acceptance-candidate-[A-Za-z0-9._-]+(?:-[A-Za-z0-9._-]+)*))?$/i.exec(line)).find(Boolean);
  return { ok: code === 0 && Boolean(completed), candidateSha: completed?.[1] ?? null, candidateBranch: completed?.[2] ?? null };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = await runThinNewProject({});
}
