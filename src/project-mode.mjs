export const PROJECT_MODE_SCHEMA_VERSION = 1;
export const PROJECT_MODE_KIND = "ProjectMode";
const modes = new Set(["greenfield", "brownfield"]);

function fail(code) { throw new Error(`project_mode:${code}`); }

export function validateProjectMode(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || value.schemaVersion !== PROJECT_MODE_SCHEMA_VERSION
    || value.kind !== PROJECT_MODE_KIND
    || !modes.has(value.mode)
    || Object.keys(value).some((key) => !["schemaVersion", "kind", "mode"].includes(key))) fail("invalid");
  return { schemaVersion: PROJECT_MODE_SCHEMA_VERSION, kind: PROJECT_MODE_KIND, mode: value.mode };
}

export function projectModeFor(mode) {
  return validateProjectMode({ schemaVersion: PROJECT_MODE_SCHEMA_VERSION, kind: PROJECT_MODE_KIND, mode });
}

export function sameProjectMode(left, right) {
  try { return validateProjectMode(left).mode === validateProjectMode(right).mode; }
  catch { return false; }
}

// Direct router fixtures from before Stage 05 retain their explicit
// repositoryMode only as a test/programmatic compatibility seam. loadConfig
// always produces the versioned contract and autonomous persisted runs never
// infer a mode from productRoots.
export function configuredProjectMode(project = {}, { allowLegacyRepositoryMode = false } = {}) {
  if (project.projectMode !== undefined) return validateProjectMode(project.projectMode);
  if (allowLegacyRepositoryMode && modes.has(project.repositoryMode)) return projectModeFor(project.repositoryMode);
  fail("configuration_missing");
}
