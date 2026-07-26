import { spawn } from "node:child_process";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
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
import {
  captureSourceClosure,
  materializeDeploymentTree,
  type SourceRoot,
} from "./tree.js";

interface PackageJson {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
  narada?: {
    artifact?: NaradaArtifactDeclaration;
  };
}

export async function discoverPackageSourceRoots(input: {
  package_root: string;
  workspace_root: string;
}): Promise<{
  configuration: PackageArtifactConfiguration;
  source_roots: SourceRoot[];
}> {
  const configuration = await loadPackageArtifactConfiguration(input);
  return {
    configuration,
    source_roots: await collectSourceRoots(configuration),
  };
}

async function readPackageJson(packageRoot: string): Promise<PackageJson> {
  return JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as PackageJson;
}

function buildEnvironmentNames(declaration?: NaradaArtifactDeclaration): string[] {
  const baseline = process.platform === "win32"
    ? ["SystemRoot", "WINDIR", "ComSpec", "PATH", "PATHEXT", "TEMP", "TMP", "USERPROFILE", "APPDATA", "LOCALAPPDATA"]
    : ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL"];
  const declared = declaration?.build_environment_names ?? [];
  if (
    !Array.isArray(declared)
    || declared.some((name) => typeof name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name))
  ) {
    throw new ArtifactIntegrityError(
      "artifact_declaration_invalid",
      "build_environment_names must contain only valid environment variable names",
    );
  }
  return [...new Set([...baseline, ...declared])].sort();
}

function buildEnvironment(environmentNames: readonly string[]): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const name of environmentNames) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}

function declaredBuildDependencies(
  packageName: string,
  manifest: PackageJson,
): string[] {
  const dependencies = manifest.narada?.artifact?.build_dependencies ?? [];
  if (
    !Array.isArray(dependencies) ||
    dependencies.some((dependency) => typeof dependency !== "string" || dependency.length === 0)
  ) {
    throw new ArtifactIntegrityError(
      "artifact_declaration_invalid",
      `Package ${packageName} has invalid narada.artifact.build_dependencies`,
      { package_name: packageName },
    );
  }
  const declaredDependencies = {
    ...manifest.dependencies,
    ...manifest.devDependencies,
    ...manifest.optionalDependencies,
    ...manifest.peerDependencies,
  };
  for (const dependency of dependencies) {
    if (!(dependency in declaredDependencies)) {
      throw new ArtifactIntegrityError(
        "artifact_declaration_invalid",
        `Package ${packageName} names undeclared build dependency ${dependency}`,
        { package_name: packageName, build_dependency: dependency },
      );
    }
  }
  return [...new Set(dependencies)].sort();
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

export async function collectSourceRoots(
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
    const runtimeDependencies = {
      ...manifest.dependencies,
      ...manifest.optionalDependencies,
      ...manifest.peerDependencies,
    };
    const dependencyNames = new Set([
      ...Object.keys(runtimeDependencies),
      ...declaredBuildDependencies(packageName, manifest),
    ]);
    for (const dependencyName of [...dependencyNames].sort()) {
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

function run(
  command: string,
  args: string[],
  cwd: string,
  environmentNames: readonly string[],
): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      shell: false,
      windowsHide: true,
      env: buildEnvironment(environmentNames),
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
  const args = [
    "--filter",
    configuration.package_name,
    "run",
    configuration.declaration.build_script,
  ];
  const environmentNames = buildEnvironmentNames(configuration.declaration);
  const semantic = {
    schema: "narada.artifact.build_recipe.v1" as const,
    command,
    args,
    environment_names: environmentNames,
    deployment: {
      command: "pnpm",
      args: [
        "--filter",
        configuration.package_name,
        "deploy",
        "--prod",
        "{deployment_root}",
      ],
      environment_names: environmentNames,
      working_directory: ".",
      materialization: "dereference_internal_links_v1" as const,
    },
  };
  return { ...semantic, build_recipe_digest: semanticDigest(semantic) };
}

export async function captureToolchainEvidence(
  workspaceRoot: string,
  environmentNames = buildEnvironmentNames(),
): Promise<ArtifactToolchainEvidence> {
  const pnpmVersion = await run("pnpm", ["--version"], workspaceRoot, environmentNames);
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

const BUILD_STAGING_OWNER_SCHEMA = "narada.artifact_build_staging_owner.v1";
const OWNED_STAGING_GRACE_MS = 60 * 60_000;
const UNOWNED_STAGING_GRACE_MS = 60 * 60_000;

type BuildStagingOwner = {
  schema: typeof BUILD_STAGING_OWNER_SCHEMA;
  pid: number;
  created_at: string;
  workspace_root: string;
};

function processIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function isMissingPathError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

function parseBuildStagingOwner(value: unknown): BuildStagingOwner | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    record.schema !== BUILD_STAGING_OWNER_SCHEMA
    || !Number.isSafeInteger(record.pid)
    || Number(record.pid) <= 0
    || typeof record.created_at !== "string"
    || !Number.isFinite(Date.parse(record.created_at))
    || typeof record.workspace_root !== "string"
  ) {
    return null;
  }
  return record as BuildStagingOwner;
}

export async function reapAbandonedBuildStaging(input: {
  staging_root: string;
  now?: () => Date;
  is_process_alive?: (pid: number) => boolean;
  owned_grace_ms?: number;
  unowned_grace_ms?: number;
}): Promise<string[]> {
  const stagingRoot = resolve(input.staging_root);
  const nowMs = (input.now ?? (() => new Date()))().getTime();
  const isProcessAlive = input.is_process_alive ?? processIsAlive;
  const ownedGraceMs = input.owned_grace_ms ?? OWNED_STAGING_GRACE_MS;
  const unownedGraceMs = input.unowned_grace_ms ?? UNOWNED_STAGING_GRACE_MS;
  const removed: string[] = [];
  await mkdir(stagingRoot, { recursive: true });
  const entries = await readdir(stagingRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (!/^build-[A-Za-z0-9_-]+$/u.test(entry.name) || !entry.isDirectory()) continue;
    const candidate = resolve(stagingRoot, entry.name);
    if (dirname(candidate) !== stagingRoot) continue;
    try {
      const candidateStat = await lstat(candidate);
      if (!candidateStat.isDirectory() || candidateStat.isSymbolicLink()) continue;

      let owner: BuildStagingOwner | null = null;
      try {
        const ownerContent = await readFile(join(candidate, ".owner.json"), "utf8");
        try {
          owner = parseBuildStagingOwner(JSON.parse(ownerContent));
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
          // An interrupted marker write is treated as an unowned staging directory.
        }
      } catch (error) {
        if (!isMissingPathError(error)) throw error;
        // Legacy staging directories have no owner marker.
      }
      const ageMs = owner
        ? nowMs - Date.parse(owner.created_at)
        : nowMs - (await stat(candidate)).mtimeMs;
      const graceMs = owner ? ownedGraceMs : unownedGraceMs;
      if (ageMs < graceMs || (owner && isProcessAlive(owner.pid))) continue;
      await rm(candidate, { recursive: true, force: true });
      removed.push(candidate);
    } catch (error) {
      if (isMissingPathError(error)) continue;
      throw error;
    }
  }
  return removed.sort();
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
  const toolchain = await captureToolchainEvidence(
    configuration.workspace_root,
    recipe.environment_names,
  );

  await run(
    recipe.command,
    recipe.args,
    configuration.workspace_root,
    recipe.environment_names,
  );

  const afterBuild = await captureSourceClosure({
    package_name: configuration.package_name,
    roots: sourceRoots,
  });
  await assertSourceUnchanged(before, afterBuild);

  const stagingRoot = join(configuration.workspace_root, ".ai", "runtime", ".artifact-build");
  await mkdir(stagingRoot, { recursive: true });
  await reapAbandonedBuildStaging({ staging_root: stagingRoot });
  const stagingParent = await mkdtemp(join(stagingRoot, "build-"));
  const stagingOwner: BuildStagingOwner = {
    schema: BUILD_STAGING_OWNER_SCHEMA,
    pid: process.pid,
    created_at: new Date().toISOString(),
    workspace_root: resolve(configuration.workspace_root),
  };
  await writeFile(
    join(stagingParent, ".owner.json"),
    `${JSON.stringify(stagingOwner, null, 2)}\n`,
    "utf8",
  );
  const deployedRoot = join(stagingParent, "deployed");
  const deploymentRoot = join(stagingParent, "deployment");
  try {
    await run(
      recipe.deployment.command,
      recipe.deployment.args.map((argument) =>
        argument === "{deployment_root}"
          ? deployedRoot
          : argument),
      resolve(configuration.workspace_root, recipe.deployment.working_directory),
      recipe.deployment.environment_names,
    );
    await materializeDeploymentTree(deployedRoot, deploymentRoot);
    const afterDeployment = await captureSourceClosure({
      package_name: configuration.package_name,
      roots: sourceRoots,
    });
    await assertSourceUnchanged(before, afterDeployment);
    return await sealDeployment({
      store_root: input.store_root,
      deployment_root: deploymentRoot,
      package_name: configuration.package_name,
      artifact_profile: configuration.declaration.profile,
      source_closure: afterDeployment,
      build_recipe: recipe,
      toolchain,
      entrypoints: configuration.declaration.entrypoints,
      compatibility: input.compatibility,
      fixed_dependencies: input.fixed_dependencies,
      platform_requirements: configuration.declaration.platform_requirements,
      pre_publish_check: async () => {
        const beforePublish = await captureSourceClosure({
          package_name: configuration.package_name,
          roots: sourceRoots,
        });
        await assertSourceUnchanged(before, beforePublish);
      },
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
