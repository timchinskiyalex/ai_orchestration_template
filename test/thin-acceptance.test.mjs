import test from "node:test";
import assert from "node:assert/strict";
import { buildThinAcceptancePrompt, extractThinAcceptanceCriteria, runThinAcceptance, validateThinAcceptanceCandidate } from "../src/thin/acceptance.mjs";

const markdown = "# Product\n\n## Accounts\n- Users must register and log in.\n## Guides\n- A visitor must see city guides.\n";
const sha = "a".repeat(40);

test("controller derives bounded deterministic criteria and rejects unmapped semantic audit output", () => {
  const criteria = extractThinAcceptanceCriteria(markdown);
  assert.ok(criteria.length >= 2);
  assert.match(buildThinAcceptancePrompt({ criteria, candidateSha: sha }), /Exact schema/);
  assert.throws(() => validateThinAcceptanceCandidate({ results: [{ criterionId: criteria[0].criterionId, status: "pass", reason: "only one" }] }, criteria), /exactly one result/);
  assert.throws(() => validateThinAcceptanceCandidate({ results: criteria.map((item) => ({ criterionId: item.criterionId, status: "pass", reason: "ok", candidateSha: sha })) }, criteria), /unsupported fields/);
});

test("controller accepts product requirements but excludes manifesto and process instructions before audit", () => {
  const criteria = extractThinAcceptanceCriteria([
    { documentId: "TECH_SPEC.md", markdown: "# Product\n\n- Users must register and log in.\n- The website must display paid city guides.\n- The API must return a user's favorites.\n" },
    { documentId: "agency_manifesto.md", markdown: "# Agency\n\n- Agents must create a worktree for each task.\n- The reviewer must run npm test.\n- Documentation must be stored in a folder.\n" },
  ]);
  assert.deepEqual(criteria.map((criterion) => criterion.statement), [
    "Users must register and log in.",
    "The website must display paid city guides.",
    "The API must return a user's favorites.",
  ]);
  assert.ok(criteria.every((criterion) => criterion.sourceRef.documentId === "TECH_SPEC.md"));
  assert.ok(criteria.every((criterion) => /^[a-f0-9]{64}$/.test(criterion.sourceRef.sourceDigest)));
  assert.throws(() => extractThinAcceptanceCriteria([{ documentId: "agency_manifesto.md", markdown: "# Agency\n- Agents must create a worktree.\n" }]), /No product acceptance requirements/);
});

test("passing audit and controller verification accept the exact candidate without repair", async () => {
  let repairs = 0;
  const result = await runThinAcceptance({
    markdown, candidateSha: sha,
    audit: async ({ criteria }) => ({ results: criteria.map(({ criterionId }) => ({ criterionId, status: "pass", reason: "fixture evidence" })) }),
    verify: async () => ({ ok: true }),
    repair: async () => { repairs += 1; },
  });
  assert.equal(result.ok, true); assert.equal(result.state, "completed_spec_verified"); assert.equal(result.candidateSha, sha); assert.equal(repairs, 0);
});

test("one bounded repair is followed by mandatory re-audit and verification", async () => {
  let audits = 0; let repairs = 0; let verifications = 0;
  const repairedSha = "b".repeat(40);
  const result = await runThinAcceptance({
    markdown, candidateSha: sha,
    audit: async ({ criteria }) => ({ results: criteria.map(({ criterionId }, index) => ({ criterionId, status: audits++ < criteria.length ? (index === 0 ? "gap" : "pass") : "pass", reason: "fixture" })) }),
    verify: async () => ({ ok: ++verifications > 0 }),
    repair: async ({ attempts, failureOutput }) => { repairs += 1; assert.equal(attempts, 0); assert.match(failureOutput, /criterion-/); return { ok: true, candidateSha: repairedSha, attempts: 1 }; },
  });
  assert.equal(result.ok, true); assert.equal(result.repaired, true); assert.equal(result.candidateSha, repairedSha); assert.equal(repairs, 1); assert.equal(verifications, 2);
});

test("unverified criteria after the single repair fail closed with a bounded report", async () => {
  const result = await runThinAcceptance({
    markdown, candidateSha: sha,
    audit: async ({ criteria }) => ({ results: criteria.map(({ criterionId }) => ({ criterionId, status: "unverified", reason: "no proof" })) }),
    verify: async () => ({ ok: true }),
    repair: async () => ({ ok: true, candidateSha: "c".repeat(40), attempts: 1 }),
  });
  assert.equal(result.ok, false); assert.equal(result.code, "acceptance_unverified_after_repair"); assert.equal(result.report.results.length, extractThinAcceptanceCriteria(markdown).length);
});
