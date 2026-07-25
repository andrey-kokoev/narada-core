import { randomUUID } from "node:crypto";
import {
  access,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  ARTIFACT_BUILD_RECEIPT_SCHEMA,
  ARTIFACT_CHANNEL_SCHEMA,
  ARTIFACT_CLOSURE_SCHEMA,
  type ArtifactBuildReceipt,
  type ArtifactChannel,
  type ArtifactClosure,
  type ArtifactCompatibility,
  type ArtifactFixedDependency,
  type ArtifactSelector,
  type ArtifactSourceClosure,
  type ArtifactToolchainEvidence,
  type ArtifactBuildRecipe,
  type Sha256Digest,
} from "./contracts.js";
import { canonicalJson, digestHex, semanticDigest } from "./canonical.js";
import { ArtifactIntegrityError } from "./errors.js";
import {
  captureSourceClosure,
  copyDeploymentTree,
  hashDeploymentTree,
  type SourceRoot,
} from "./tree.js";

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function writeImmutableJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, "wx");
  try {
    await handle.writeFile(`${canonicalJson(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function atomicReplaceJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${randomUUID()}`;
  const handle = await open(temporary, "wx");
  try {
    await handle.writeFile(`${canonicalJson(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, path);
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

export function compatibilityKey(
  packageName: string,
  compatibility: ArtifactCompatibility,
): Sha256Digest {
  return semanticDigest({
    package_name: packageName,
    artifact_profile: compatibility.artifact_profile,
    descriptor_digest: compatibility.descriptor_digest,
    interface_digest: compatibility.interface_digest,
  });
}

function packageDirectoryName(packageName: string): string {
  return packageName.replace(/^@/, "").replaceAll("/", "__").replaceAll("\\", "__");
}

export function artifactStorePaths(storeRoot: string, packageName: string, key: Sha256Digest) {
  const root = resolve(storeRoot);
  return {
    root,
    closureDirectory: (digest: Sha256Digest) =>
      join(root, "closures", "sha256", digestHex(digest)),
    closureRecord: (digest: Sha256Digest) =>
      join(root, "records", "closures", `${digestHex(digest)}.json`),
    receiptRecord: (digest: Sha256Digest) =>
      join(root, "receipts", "sha256", `${digestHex(digest)}.json`),
    channel: join(
      root,
      "channels",
      packageDirectoryName(packageName),
      `${digestHex(key)}.json`,
    ),
  };
}

export interface SealDeploymentInput {
  store_root: string;
  deployment_root: string;
  package_name: string;
  artifact_profile: string;
  source_closure: ArtifactSourceClosure;
  build_recipe: ArtifactBuildRecipe;
  toolchain: ArtifactToolchainEvidence;
  entrypoints: string[];
  compatibility: ArtifactCompatibility;
  fixed_dependencies?: ArtifactFixedDependency[];
  platform_requirements?: string[];
  now?: () => Date;
}

export interface SealDeploymentResult {
  closure: ArtifactClosure;
  receipt: ArtifactBuildReceipt;
  channel: ArtifactChannel;
  closure_path: string;
  channel_path: string;
  reused_closure: boolean;
  channel_changed: boolean;
}

export async function sealDeployment(
  input: SealDeploymentInput,
): Promise<SealDeploymentResult> {
  const tree = await hashDeploymentTree(input.deployment_root);
  const entrypoints = [...new Set(input.entrypoints)].sort();
  for (const entrypoint of entrypoints) {
    const normalized = entrypoint.replaceAll("\\", "/").replace(/^\.\//, "");
    if (!tree.files.some((file) => file.path === normalized && file.kind === "file")) {
      throw new ArtifactIntegrityError(
        "artifact_entrypoint_missing",
        `Required artifact entrypoint is missing: ${entrypoint}`,
        { package_name: input.package_name, entrypoint },
      );
    }
  }

  const fixedDependencies = [...(input.fixed_dependencies ?? [])].sort((left, right) =>
    left.role.localeCompare(right.role),
  );
  const platformRequirements = [...new Set(input.platform_requirements ?? [])].sort();
  const closureSemantic = {
    schema: ARTIFACT_CLOSURE_SCHEMA,
    package_name: input.package_name,
    artifact_profile: input.artifact_profile,
    deployment_tree_digest: tree.deployment_tree_digest,
    files: tree.files,
    entrypoints,
    fixed_dependencies: fixedDependencies,
    platform_requirements: platformRequirements,
  };
  const closure: ArtifactClosure = {
    ...closureSemantic,
    closure_digest: semanticDigest(closureSemantic),
  };

  const receiptSemantic = {
    schema: ARTIFACT_BUILD_RECEIPT_SCHEMA,
    package_name: input.package_name,
    artifact_profile: input.artifact_profile,
    source_closure_digest: input.source_closure.source_closure_digest,
    build_recipe_digest: input.build_recipe.build_recipe_digest,
    toolchain_digest: input.toolchain.toolchain_digest,
    deployment_tree_digest: tree.deployment_tree_digest,
    closure_digest: closure.closure_digest,
  };
  const receiptDigest = semanticDigest(receiptSemantic);
  const now = (input.now ?? (() => new Date()))().toISOString();
  const receipt: ArtifactBuildReceipt = {
    ...receiptSemantic,
    receipt_digest: receiptDigest,
    built_at: now,
  };

  const key = compatibilityKey(input.package_name, input.compatibility);
  const paths = artifactStorePaths(input.store_root, input.package_name, key);
  await mkdir(join(paths.root, ".tmp"), { recursive: true });
  const target = paths.closureDirectory(closure.closure_digest);
  await mkdir(dirname(target), { recursive: true });
  let reusedClosure = await exists(target);

  if (!reusedClosure) {
    const temporary = join(paths.root, ".tmp", `closure-${randomUUID()}`);
    try {
      await copyDeploymentTree(input.deployment_root, temporary);
      const copied = await hashDeploymentTree(temporary);
      if (copied.deployment_tree_digest !== closure.deployment_tree_digest) {
        throw new ArtifactIntegrityError(
          "artifact_closure_corrupt",
          "Deployment changed while it was being sealed",
          {
            expected: closure.deployment_tree_digest,
            actual: copied.deployment_tree_digest,
          },
        );
      }
      try {
        await rename(temporary, target);
      } catch (error) {
        if (!(await exists(target))) throw error;
        reusedClosure = true;
      }
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }

  if (!(await exists(paths.closureRecord(closure.closure_digest)))) {
    await writeImmutableJson(paths.closureRecord(closure.closure_digest), closure);
  }
  if (!(await exists(paths.receiptRecord(receipt.receipt_digest)))) {
    await writeImmutableJson(paths.receiptRecord(receipt.receipt_digest), receipt);
  }

  const channelSemantic = {
    schema: ARTIFACT_CHANNEL_SCHEMA,
    package_name: input.package_name,
    compatibility: input.compatibility,
    compatibility_key: key,
    closure_digest: closure.closure_digest,
    receipt_digest: receipt.receipt_digest,
    source_closure_digest: input.source_closure.source_closure_digest,
  };
  const channel: ArtifactChannel = {
    ...channelSemantic,
    published_at: now,
    channel_digest: semanticDigest(channelSemantic),
  };

  let channelChanged = true;
  if (await exists(paths.channel)) {
    const previous = await readJson<ArtifactChannel>(paths.channel);
    channelChanged = previous.channel_digest !== channel.channel_digest;
  }
  if (channelChanged) await atomicReplaceJson(paths.channel, channel);

  return {
    closure,
    receipt,
    channel,
    closure_path: target,
    channel_path: paths.channel,
    reused_closure: reusedClosure,
    channel_changed: channelChanged,
  };
}

export async function readArtifactChannel(selector: ArtifactSelector): Promise<{
  channel: ArtifactChannel;
  channel_path: string;
}> {
  const key = compatibilityKey(selector.package_name, selector.compatibility);
  const paths = artifactStorePaths(selector.store_root, selector.package_name, key);
  let channel: ArtifactChannel;
  try {
    channel = await readJson<ArtifactChannel>(paths.channel);
  } catch (error) {
    throw new ArtifactIntegrityError(
      "artifact_channel_corrupt",
      `Artifact channel is missing or unreadable for ${selector.package_name}`,
      { channel_path: paths.channel },
      { cause: error },
    );
  }
  const expectedDigest = semanticDigest({
    schema: channel.schema,
    package_name: channel.package_name,
    compatibility: channel.compatibility,
    compatibility_key: channel.compatibility_key,
    closure_digest: channel.closure_digest,
    receipt_digest: channel.receipt_digest,
    source_closure_digest: channel.source_closure_digest,
  });
  if (
    channel.schema !== ARTIFACT_CHANNEL_SCHEMA ||
    channel.package_name !== selector.package_name ||
    channel.compatibility_key !== key ||
    channel.channel_digest !== expectedDigest
  ) {
    throw new ArtifactIntegrityError(
      "artifact_channel_corrupt",
      `Artifact channel failed integrity validation for ${selector.package_name}`,
      { channel_path: paths.channel },
    );
  }
  return { channel, channel_path: paths.channel };
}

export async function verifyClosure(input: {
  store_root: string;
  package_name: string;
  closure_digest: Sha256Digest;
}): Promise<{ closure: ArtifactClosure; closure_path: string }> {
  const dummyKey = semanticDigest("path-only");
  const paths = artifactStorePaths(input.store_root, input.package_name, dummyKey);
  const closurePath = paths.closureDirectory(input.closure_digest);
  const recordPath = paths.closureRecord(input.closure_digest);
  const closure = await readJson<ArtifactClosure>(recordPath);
  const tree = await hashDeploymentTree(closurePath);
  const semantic = {
    schema: closure.schema,
    package_name: closure.package_name,
    artifact_profile: closure.artifact_profile,
    deployment_tree_digest: closure.deployment_tree_digest,
    files: closure.files,
    entrypoints: closure.entrypoints,
    fixed_dependencies: closure.fixed_dependencies,
    platform_requirements: closure.platform_requirements,
  };
  if (
    closure.schema !== ARTIFACT_CLOSURE_SCHEMA ||
    closure.package_name !== input.package_name ||
    closure.closure_digest !== input.closure_digest ||
    semanticDigest(semantic) !== closure.closure_digest ||
    tree.deployment_tree_digest !== closure.deployment_tree_digest
  ) {
    throw new ArtifactIntegrityError(
      "artifact_closure_corrupt",
      `Sealed artifact closure failed verification for ${input.package_name}`,
      { closure_path: closurePath, closure_digest: input.closure_digest },
    );
  }
  return { closure, closure_path: closurePath };
}

export async function resolveArtifactSelector(input: {
  selector: ArtifactSelector;
  source_roots: SourceRoot[];
}): Promise<{
  channel: ArtifactChannel;
  receipt: ArtifactBuildReceipt;
  closure: ArtifactClosure;
  closure_path: string;
}> {
  const { channel } = await readArtifactChannel(input.selector);
  const key = compatibilityKey(input.selector.package_name, input.selector.compatibility);
  const paths = artifactStorePaths(input.selector.store_root, input.selector.package_name, key);
  const receipt = await readJson<ArtifactBuildReceipt>(paths.receiptRecord(channel.receipt_digest));
  if (
    receipt.schema !== ARTIFACT_BUILD_RECEIPT_SCHEMA ||
    receipt.receipt_digest !== channel.receipt_digest ||
    receipt.closure_digest !== channel.closure_digest
  ) {
    throw new ArtifactIntegrityError(
      "artifact_channel_corrupt",
      `Artifact receipt does not match channel for ${input.selector.package_name}`,
      { receipt_digest: channel.receipt_digest },
    );
  }

  if (input.selector.source_policy === "require_fresh") {
    const current = await captureSourceClosure({
      package_name: input.selector.package_name,
      roots: input.source_roots,
    });
    if (current.source_closure_digest !== receipt.source_closure_digest) {
      throw new ArtifactIntegrityError(
        "artifact_source_stale",
        `Workspace source for ${input.selector.package_name} requires a canonical artifact build`,
        {
          package_name: input.selector.package_name,
          expected_source_closure_digest: receipt.source_closure_digest,
          actual_source_closure_digest: current.source_closure_digest,
          canonical_command: `pnpm --filter ${input.selector.package_name} build`,
        },
      );
    }
  }

  const verified = await verifyClosure({
    store_root: input.selector.store_root,
    package_name: input.selector.package_name,
    closure_digest: channel.closure_digest,
  });
  return {
    channel,
    receipt,
    closure: verified.closure,
    closure_path: verified.closure_path,
  };
}

export async function assertSourceUnchanged(
  before: ArtifactSourceClosure,
  after: ArtifactSourceClosure,
): Promise<void> {
  if (before.source_closure_digest !== after.source_closure_digest) {
    throw new ArtifactIntegrityError(
      "artifact_build_inputs_changed",
      `Source inputs changed while building ${before.package_name}`,
      {
        package_name: before.package_name,
        before: before.source_closure_digest,
        after: after.source_closure_digest,
      },
    );
  }
}

export async function statArtifactPath(path: string): Promise<Awaited<ReturnType<typeof stat>>> {
  return stat(path);
}
