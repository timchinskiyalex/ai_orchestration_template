import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { relative, resolve, sep, join } from "node:path";
import { documentIdForPath, documentSetDigest } from "./product-blueprint.mjs";
import { compileImportedSourceClaimManifest, normalizeSourceText } from "./source-evidence.mjs";

const digest = (value) => createHash("sha256").update(value).digest("hex");

function isInside(root, candidate) {
  const relation = relative(root, candidate);
  return relation && !relation.startsWith(`..${sep}`) && relation !== "..";
}

function markdownFiles(root) {
  const result = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
      const fullPath = join(directory, entry.name);
      const details = lstatSync(fullPath);
      if (details.isSymbolicLink()) throw new Error(`Symlink is not allowed in documentation intake: ${fullPath}`);
      if (entry.isDirectory()) visit(fullPath);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) result.push(fullPath);
    }
  };
  visit(root);
  return result;
}

export function ingestDocumentation({ source, repository, destinationRelative }) {
  const sourceRoot = resolve(source);
  const repositoryRoot = resolve(repository);
  const destination = resolve(repositoryRoot, destinationRelative);
  if (!existsSync(sourceRoot)) throw new Error(`Documentation source does not exist: ${sourceRoot}`);
  if (!existsSync(repositoryRoot)) throw new Error(`Project repository does not exist: ${repositoryRoot}`);
  if (!isInside(repositoryRoot, destination)) throw new Error("documentationDir must stay inside the project repository");
  const files = markdownFiles(sourceRoot);
  if (!files.length) throw new Error("No Markdown files found in documentation source");
  // The declaration is a single, explicit root companion.  When absent the
  // controller owns extraction; do not discover arbitrary JSON alongside docs.
  const declaration = join(sourceRoot, "source-claims.json");
  const suppliedDeclaration = existsSync(declaration);
  if (suppliedDeclaration && lstatSync(declaration).isSymbolicLink()) throw new Error("source_claim_contract: supplied_source_claims_declaration_symlink");
  for (const sourceFile of files) {
    const destinationFile = resolve(destination, relative(sourceRoot, sourceFile));
    if (!isInside(destination, destinationFile)) throw new Error(`Unsafe documentation path: ${sourceFile}`);
    mkdirSync(join(destinationFile, ".."), { recursive: true });
    copyFileSync(sourceFile, destinationFile);
  }
  const inventory = {
    generatedAt: new Date().toISOString(),
    source: "imported-local-documentation",
    files: files.map((file) => {
      const path = relative(sourceRoot, file).split("\\").join("/");
      return { documentId: documentIdForPath(path), path, sha256: digest(normalizeSourceText(readFileSync(file, "utf8"))) };
    })
  };
  inventory.documentSetDigest = documentSetDigest(inventory.files);
  const inventoryPath = join(destination, "inventory.json");
  writeFileSync(inventoryPath, `${JSON.stringify(inventory, null, 2)}\n`, "utf8");
  if (!suppliedDeclaration) return { files: files.length, destination, inventoryPath, sourceClaimInput: "raw" };
  copyFileSync(declaration, join(destination, "source-claims.json"));
  const manifest = compileImportedSourceClaimManifest({ repository, documentationDir: destinationRelative });
  return { files: files.length, destination, inventoryPath, sourceClaimInput: "supplied", sourceClaimManifest: { manifestId: manifest.manifestId, digest: manifest.digest } };
}
