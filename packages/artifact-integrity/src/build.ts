import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { semanticDigest, sha256Bytes } from "./canonical.js";
import type {
  ArtifactBuildRecipe,
  ArtifactCompatibility,
  ArtifactFixedDependency,
  ArtifactToolchainEvidence,
  NaradaArtifactDeclaration,
  PackageArtifactConfiguration,
} from "./contracts.js";
import { ArtifactIntegrityError } from "./errors.js";
import { assertSourceUnchanged, sealDeployment, type SealDeploymentResult } from "./store.js";
import { captureSourceClosure, type SourceRoot } from "./tree.js";

interface PackageJson {
  name?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
  narada?: {
    artifact?: NaradaArtifactDeclaration;
  };
}

async function readPackageJson(packageRoot: string): Promise<PackageJson> {
  return JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as PackageJson;
}

function validateDeclaration(
  packageName: string,
  packageJson: PackageJson,
): NaradaArtifactDeclaration {
  const declaration = packageJson.narada?.artifact;
  if (
    !declaration ||
    typeof declaration.profile !== "string" ||
    declaration.profile.length === 0 ||
    !Array.isArray(declaration.entrypoints) ||
    declaration.entrypoints.length === 0 ||
    typeof declaration.build_script !== "string" ||
    !packageJson.scripts?.[declaration.build_script]
  ) {
    throw new ArtifactIntegrityError(
      "artifact_declaration_invalid",
      `Package ${packageName} has no valid narada.artifact declaration`,
      { package_name: packageName },
    );
  }
  return declaration;
}

async function workspacePatterns(workspaceRoot: string): Promise<string[]> {
  const text = await readFile(join(workspaceRoot, "pnpm-workspace.yaml"), "utf8");
  const patterns: string[] = [];
  for (const line of text.split(/\r?\n/u)) {
    const match = /^\s*-\s*["']?([^"'#]+)["']?\s*$/u.exec(line);
    if (match) patterns.push(match[1].trim());
  }
  return patterns;
}

async function expandWorkspacePattern(
  workspaceRoot: string,
  pattern: string,
): Promise<string[]> {
  const portable = pattern.replaceAll("\\", "/").replace(/\/$/u, "");
  if (!portable.includes("*")) return [resolve(workspaceRoot, portable)];
  if (!portable.endsWith("/*") || portable.slice(0, -2).includes("*")) {
    throw new ArtifactIntegrityError(
      "artifact_declaration_invalid",
      `Unsupported pnpm workspace pattern: ${pattern}`,
      { workspace_root: workspaceRoot, pattern },
    );
  }
  const parent = resolve(workspaceRoot, portable.slice(0, -2));
  const entries = await readdir(parent, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(parent, entry.name))
    .sort();
}

export async function discoverWorkspacePackages(
  workspaceRoot: string,
): Promise<Map<string, string>> {
  const packages = new Map<string, string>();
  for (const pattern of await workspacePatterns(workspaceRoot)) {
    for (const candidate of await expandWorkspacePattern(workspaceRoot, pattern)) {
      try {
        const manifest = await readPackageJson(candidate);
        if (manifest.name) packages.set(manifest.name, candidate);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
  }
  return packages;
}

async function collectSourceRoots(
  configuration: PackageArtifactConfiguration,
): Promise<SourceRoot[]> {
  const workspacePackages = await discoverWorkspacePackages(configuration.workspace_root);
  const roots: SourceRoot[] = [];
  const visited = new Set<string>();

  async function visit(packageName: string, packageRoot: string): Promise<void> {
    if (visited.has(packageName)) return;
    visited.add(packageName);
    const manifest = await readPackageJson(packageRoot);
    roots.push({
      root: packageRoot,
      logical_prefix: `packages/${packageName}`,
      excludes:
        packageName === configuration.package_name
          ? configuration.declaration.source_excludes
          : undefined,
    });
    const dependencies = {
      ...manifest.dependencies,
      ...manifest.optionalDependencies,
      ...manifest.peerDependencies,
    };
    for (const dependencyName of Object.keys(dependencies).sort()) {
      const dependencyRoot = workspacePackages.get(dependencyName);
      if (dependencyRoot) await visit(dependencyName, dependencyRoot);
    }
  }

  await visit(configuration.package_name, configuration.package_root);
  return roots.sort((left, right) => left.logical_prefix.localeCompare(right.logical_prefix));
}

export async function loadPackageArtifactConfiguration(input: {
  package_root: string;
  workspace_root: string;
}): Promise<PackageArtifactConfiguration> {
  const packageRoot = resolve(input.package_root);
  const workspaceRoot = resolve(input.workspace_root);
  const manifest = await readPackageJson(packageRoot);
  if (!manifest.name) {
    throw new ArtifactIntegrityError(
      "artifact_declaration_invalid",
      `Package at ${packageRoot} has no name`,
      { package_root: packageRoot },
    );
  }
  return {
    package_name: manifest.name,
    package_root: packageRoot,
    workspace_root: workspaceRoot,
    declaration: validateDeclaration(manifest.name, manifest),
  };
}

function run(command: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolvePromise(stdout.trim());
        return;
      }
      reject(
        new ArtifactIntegrityError(
          "artifact_command_failed",
          `Artifact command failed (${command} ${args.join(" ")})`,
          { command, args, cwd, exit_code: code, stdout, stderr },
        ),
      );
    });
  });
}

export function createBuildRecipe(
  configuration: PackageArtifactConfiguration,
): ArtifactBuildRecipe {
  const command = "pnpm";
  const args = ["--dir", configuration.package_root, "run", configuration.declaration.build_script];
  const semantic = {
    schema: "narada.artifact.build_recipe.v1" as const,
    command,
    args,
    environment_names: [] as string[],
  };
  return { ...semantic, build_recipe_digest: semanticDigest(semantic) };
}

export async function captureToolchainEvidence(
  workspaceRoot: string,
): Promise<ArtifactToolchainEvidence> {
  const pnpmVersion = await run("pnpm", ["--version"], workspaceRoot);
  let lockfile: Uint8Array;
  try {
    lockfile = await readFile(join(workspaceRoot, "pnpm-lock.yaml"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    lockfile = new Uint8Array();
  }
  const semantic = {
    schema: "narada.artifact.toolchain.v1" as const,
    node_version: process.version,
    pnpm_version: pnpmVersion,
    platform: process.platform,
    architecture: process.arch,
    lockfile_digest: sha256Bytes(lockfile),
  };
  return { ...semantic, toolchain_digest: semanticDigest(semantic) };
}

export interface CanonicalBuildInput {
  package_root: string;
  workspace_root: string;
  store_root: string;
  compatibility: ArtifactCompatibility;
  fixed_dependencies?: ArtifactFixedDependency[];
  now?: () => Date;
}

export async function canonicalBuild(
  input: CanonicalBuildInput,
): Promise<SealDeploymentResult> {
  const configuration = await loadPackageArtifactConfiguration(input);
  if (configuration.declaration.profile !== input.compatibility.artifact_profile) {
    throw new ArtifactIntegrityError(
      "artifact_binding_incompatible",
      `Artifact profile does not match package declaration for ${configuration.package_name}`,
      {
        declared: configuration.declaration.profile,
        requested: input.compatibility.artifact_profile,
      },
    );
  }
  const sourceRoots = await collectSourceRoots(configuration);
  const before = await captureSourceClosure({
    package_name: configuration.package_name,
    roots: sourceRoots,
  });
  const recipe = createBuildRecipe(configuration);
  const toolchain = await captureToolchainEvidence(configuration.workspace_root);

  await run(recipe.command, recipe.args, configuration.workspace_root);

  const after = await captureSourceClosure({
    package_name: configuration.package_name,
    roots: sourceRoots,
  });
  await assertSourceUnchanged(before, after);

  const stagingParent = await mkdtemp(join(tmpdir(), "narada-artifact-build-"));
  const deploymentRoot = join(stagingParent, "deployment");
  try {
    await run(
      "pnpm",
      ["--filter", configuration.package_name, "deploy", "--prod", deploymentRoot],
      configuration.workspace_root,
    );
    return await sealDeployment({
      store_root: input.store_root,
      deployment_root: deploymentRoot,
      package_name: configuration.package_name,
      artifact_profile: configuration.declaration.profile,
      source_closure: before,
      build_recipe: recipe,
      toolchain,
      entrypoints: configuration.declaration.entrypoints,
      compatibility: input.compatibility,
      fixed_dependencies: input.fixed_dependencies,
      platform_requirements: configuration.declaration.platform_requirements,
      now: input.now,
    });
  } finally {
    await rm(stagingParent, { recursive: true, force: true });
  }
}

export async function findWorkspaceRoot(fromPath: string): Promise<string> {
  let current = resolve(fromPath);
  for (;;) {
    try {
      await access(join(current, "pnpm-workspace.yaml"));
      return current;
    } catch {
      // Continue toward the filesystem root.
    }
    const parent = dirname(current);
    if (parent === current) return resolve(fromPath);
    current = parent;
  }
}

export const packageRootLabel = (packageRoot: string): string => basename(resolve(packageRoot));
