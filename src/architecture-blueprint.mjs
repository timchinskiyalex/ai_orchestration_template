import { createHash } from "node:crypto";
import { validateProjectMode } from "./project-mode.mjs";
import { getStackAdapter, STACK_ADAPTER_REGISTRY_VERSION } from "./stack-adapter.mjs";

export const ARCHITECTURE_BLUEPRINT_SCHEMA_VERSION = 1;
export const ARCHITECTURE_BLUEPRINT_KIND = "ArchitectureBlueprint";

const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fail = (code) => { throw new Error(`architecture_blueprint:${code}`); };
const safePath = (value) => typeof value === "string" && value === value.trim() && value.length > 0
  && !/^(?:[A-Za-z]:|[\\/])/.test(value) && !value.split(/[\\/]/).some((part) => !part || part === "." || part === "..");

function component(value, index, mode, seenIds, seenPaths) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(`component_${index}_invalid`);
  const keys = Object.keys(value).sort();
  if (JSON.stringify(keys) !== JSON.stringify(["adapter", "id", "path"])) fail(`component_${index}_fields_invalid`);
  if (typeof value.id !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(value.id) || seenIds.has(value.id)) fail(`component_${index}_id_invalid`);
  if (!safePath(value.path)) fail(`component_${index}_path_invalid`);
  const path = value.path.replace(/\\/g, "/").replace(/\/+$/, "");
  if (seenPaths.has(path)) fail(`component_${index}_path_duplicate`);
  if (!value.adapter || typeof value.adapter !== "object" || Array.isArray(value.adapter) || JSON.stringify(Object.keys(value.adapter).sort()) !== JSON.stringify(["id", "version"])) fail(`component_${index}_adapter_invalid`);
  let adapter;
  try { adapter = getStackAdapter(value.adapter.id, value.adapter.version); }
  catch (error) { throw new Error(String(error.message)); }
  if (!adapter.allowedProjectModes.includes(mode)) fail(`adapter_mode_not_allowed:${value.adapter.id}`);
  seenIds.add(value.id); seenPaths.add(path);
  return { id: value.id, path, adapter: { id: adapter.id, version: adapter.version } };
}

export function validateArchitectureBlueprint(value, { projectMode } = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid");
  // Controller-created admitted objects carry a derived digest/registry version
  // in memory and in overlays. Those fields are never caller authority.
  if (Object.keys(value).some((key) => !["schemaVersion", "kind", "projectMode", "components", "registryVersion", "digest"].includes(key))) fail("fields_invalid");
  const source = Object.fromEntries(["schemaVersion", "kind", "projectMode", "components"].filter((key) => key in value).map((key) => [key, value[key]]));
  const keys = Object.keys(source).sort();
  if (JSON.stringify(keys) !== JSON.stringify(["components", "kind", "projectMode", "schemaVersion"])) fail("fields_invalid");
  if (source.schemaVersion !== ARCHITECTURE_BLUEPRINT_SCHEMA_VERSION || source.kind !== ARCHITECTURE_BLUEPRINT_KIND) fail("version_invalid");
  const mode = validateProjectMode(projectMode ?? source.projectMode);
  if (JSON.stringify(source.projectMode) !== JSON.stringify(mode)) fail("project_mode_mismatch");
  if (!Array.isArray(source.components)) fail("components_invalid");
  const ids = new Set(), paths = new Set();
  const components = source.components.map((item, index) => component(item, index, mode.mode, ids, paths));
  const canonical = { schemaVersion: ARCHITECTURE_BLUEPRINT_SCHEMA_VERSION, kind: ARCHITECTURE_BLUEPRINT_KIND, projectMode: mode, components };
  const calculatedDigest = digest(canonical);
  if (value.registryVersion !== undefined && value.registryVersion !== STACK_ADAPTER_REGISTRY_VERSION) fail("registry_version_invalid");
  if (value.digest !== undefined && value.digest !== calculatedDigest) fail("digest_invalid");
  return Object.freeze({ ...canonical, registryVersion: STACK_ADAPTER_REGISTRY_VERSION, digest: calculatedDigest });
}

// Existing configurations are controller input only.  This conversion is a
// compatibility seam, not worker-provided architecture data.
export function architectureBlueprintFromProductRoots(productRoots = [], projectMode) {
  const mode = validateProjectMode(projectMode);
  return validateArchitectureBlueprint({
    schemaVersion: ARCHITECTURE_BLUEPRINT_SCHEMA_VERSION,
    kind: ARCHITECTURE_BLUEPRINT_KIND,
    projectMode: mode,
    components: productRoots.map(({ id, path, adapter }) => ({ id, path, adapter: typeof adapter === "string" ? { id: adapter, version: 1 } : adapter }))
  }, { projectMode: mode });
}

export function selectedAdapters(blueprint, projectMode) {
  const admitted = validateArchitectureBlueprint(blueprint, { projectMode });
  return Object.freeze(admitted.components.map((component) => Object.freeze({ ...component, adapter: getStackAdapter(component.adapter.id, component.adapter.version) })));
}
