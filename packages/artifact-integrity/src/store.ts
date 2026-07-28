import { randomUUID } from "node:crypto";
import {
  access,
  link,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
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

const ARTIFACT_STORE_LOCK_SCHEMA = "narada.artifact.store_lock.v1" as const;
const ARTIFACT_STORE_LOCK_LEASE_MS = 10 * 60 * 1000;

function errorCode(error: unknown): string {
  return error !== null && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : "";
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
}

async function acquireArtifactStoreLock(storeRoot: string): Promise<() => Promise<void>> {
  const root = resolve(storeRoot);
  const lockPath = join(root, ".store.lock");
  await mkdir(root, { recursive: true });
  const token = randomUUID();
  const content = `${canonicalJson({
    schema: ARTIFACT_STORE_LOCK_SCHEMA,
    pid: process.pid,
    token,
    acquired_at: new Date().toISOString(),
    lease_expires_at: new Date(Date.now() + ARTIFACT_STORE_LOCK_LEASE_MS).toISOString(),
  })}\n`;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx");
      try {
        await handle.writeFile(content, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await syncDirectory(root);
      return async () => {
        try {
          const current = JSON.parse(await readFile(lockPath, "utf8")) as Record<string, unknown>;
          if (current.token === token && current.pid === process.pid) {
            await rm(lockPath, { force: true });
            await syncDirectory(root);
          }
        } catch (error) {
          if (errorCode(error) !== "ENOENT") throw error;
        }
      };
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      let ownerPid: number | null = null;
      try {
        const current = JSON.parse(await readFile(lockPath, "utf8")) as Record<string, unknown>;
        ownerPid = Number.isSafeInteger(current.pid) && Number(current.pid) > 0
          ? Number(current.pid)
          : null;
      } catch {
        // A corrupt lock is not safe to reclaim automatically.
      }
      if (ownerPid === null || processIsAlive(ownerPid)) {
        throw new ArtifactIntegrityError(
          "artifact_store_locked",
          "Another artifact store operation owns the immutable publication lock.",
          { lock_path: lockPath, owner_pid: ownerPid },
          { cause: error },
        );
      }
      await rm(lockPath, { force: true });
      await syncDirectory(root);
    }
  }
  throw new ArtifactIntegrityError(
    "artifact_store_locked",
    "The artifact store publication lock could not be acquired.",
    { lock_path: lockPath },
  );
}

async function withArtifactStoreLock<T>(
  storeRoot: string,
  operation: () => Promise<T>,
): Promise<T> {
  const release = await acquireArtifactStoreLock(storeRoot);
  try {
    return await operation();
  } finally {
    await release();
  }
}

async function syncDirectory(path: string): Promise<void> {
  try {
    const handle = await open(path, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    const code = error !== null && typeof error === "object" && "code" in error
      ? String((error as { code?: unknown }).code)
      : "";
    // Windows does not support fsync on directory handles; EPERM is that
    // platform capability refusal, while all other errors remain fatal.
    if (!["EINVAL", "EISDIR", "EBADF", "ENOTSUP", "EOPNOTSUPP", "EPERM"].includes(code)) {
      throw error;
    }
  }
}

async function writeImmutableJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const content = `${canonicalJson(value)}\n`;
  if (await exists(path)) {
    if (await readFile(path, "utf8") === content) return;
    throw new ArtifactIntegrityError(
      "artifact_record_collision",
      "Refusing to replace an immutable artifact record",
      { path },
    );
  }
  const temporary = `${path}.tmp-${randomUUID()}`;
  const handle = await open(temporary, "wx");
  try {
    await handle.writeFile(content, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    try {
      await link(temporary, path);
    } catch (error) {
      if (!(await exists(path)) || await readFile(path, "utf8") !== content) throw error;
    }
    await syncDirectory(dirname(path));
  } finally {
    await rm(temporary, { force: true });
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
  try {
    await rename(temporary, path);
    await syncDirectory(dirname(path));
  } finally {
    await rm(temporary, { force: true });
  }
}

async function syncTree(root: string): Promise<void> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      await syncTree(path);
    } else if (entry.isFile()) {
      const handle = await open(path, "r+");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
  }
  await syncDirectory(root);
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
  pre_publish_check?: () => Promise<void>;
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

function receiptSemantic(receipt: ArtifactBuildReceipt) {
  return {
    schema: receipt.schema,
    package_name: receipt.package_name,
    artifact_profile: receipt.artifact_profile,
    compatibility_key: receipt.compatibility_key,
    source_closure_digest: receipt.source_closure_digest,
    build_recipe_digest: receipt.build_recipe_digest,
    toolchain_digest: receipt.toolchain_digest,
    deployment_tree_digest: receipt.deployment_tree_digest,
    closure_digest: receipt.closure_digest,
  };
}

function assertReceiptIntegrity(input: {
  receipt: ArtifactBuildReceipt;
  package_name: string;
  artifact_profile: string;
  compatibility_key: Sha256Digest;
  receipt_digest: Sha256Digest;
  closure_digest: Sha256Digest;
  source_closure_digest: Sha256Digest;
}): void {
  const receipt = input.receipt;
  if (
    receipt.schema !== ARTIFACT_BUILD_RECEIPT_SCHEMA
    || receipt.package_name !== input.package_name
    || receipt.artifact_profile !== input.artifact_profile
    || receipt.compatibility_key !== input.compatibility_key
    || receipt.receipt_digest !== input.receipt_digest
    || receipt.closure_digest !== input.closure_digest
    || receipt.source_closure_digest !== input.source_closure_digest
    || semanticDigest(receiptSemantic(receipt)) !== receipt.receipt_digest
    || typeof receipt.built_at !== "string"
  ) {
    throw new ArtifactIntegrityError(
      "artifact_channel_corrupt",
      `Artifact receipt failed integrity validation for ${input.package_name}`,
      { receipt_digest: input.receipt_digest },
    );
  }
}

function channelSemantic(channel: ArtifactChannel) {
  return {
    schema: channel.schema,
    package_name: channel.package_name,
    compatibility: channel.compatibility,
    compatibility_key: channel.compatibility_key,
    closure_digest: channel.closure_digest,
    receipt_digest: channel.receipt_digest,
    source_closure_digest: channel.source_closure_digest,
  };
}

function assertChannelIntegrity(input: {
  channel: ArtifactChannel;
  selector: ArtifactSelector;
  compatibility_key: Sha256Digest;
  channel_path: string;
}): void {
  const channel = input.channel;
  if (
    channel.schema !== ARTIFACT_CHANNEL_SCHEMA
    || channel.package_name !== input.selector.package_name
    || canonicalJson(channel.compatibility) !== canonicalJson(input.selector.compatibility)
    || channel.compatibility_key !== input.compatibility_key
    || channel.channel_digest !== semanticDigest(channelSemantic(channel))
    || typeof channel.published_at !== "string"
  ) {
    throw new ArtifactIntegrityError(
      "artifact_channel_corrupt",
      `Artifact channel failed integrity validation for ${input.selector.package_name}`,
      { channel_path: input.channel_path },
    );
  }
}

async function sealDeploymentUnlocked(
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
  const key = compatibilityKey(input.package_name, input.compatibility);
  const closureSemantic = {
    schema: ARTIFACT_CLOSURE_SCHEMA,
    package_name: input.package_name,
    artifact_profile: input.artifact_profile,
    compatibility_key: key,
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
    compatibility_key: key,
    source_closure_digest: input.source_closure.source_closure_digest,
    build_recipe_digest: input.build_recipe.build_recipe_digest,
    toolchain_digest: input.toolchain.toolchain_digest,
    deployment_tree_digest: tree.deployment_tree_digest,
    closure_digest: closure.closure_digest,
  };
  const receiptDigest = semanticDigest(receiptSemantic);
  const now = (input.now ?? (() => new Date()))().toISOString();
  let receipt: ArtifactBuildReceipt = {
    ...receiptSemantic,
    receipt_digest: receiptDigest,
    built_at: now,
  };

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
      await syncTree(temporary);
      try {
        await rename(temporary, target);
        await syncDirectory(dirname(target));
      } catch (error) {
        if (!(await exists(target))) throw error;
        reusedClosure = true;
      }
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }

  await writeImmutableJson(paths.closureRecord(closure.closure_digest), closure);
  const verifiedClosure = await verifyClosure({
    store_root: input.store_root,
    package_name: input.package_name,
    closure_digest: closure.closure_digest,
  });
  if (
    verifiedClosure.closure.artifact_profile !== input.artifact_profile
    || canonicalJson(verifiedClosure.closure) !== canonicalJson(closure)
  ) {
    throw new ArtifactIntegrityError(
      "artifact_closure_corrupt",
      "An existing sealed closure differs from the canonical deployment",
      { package_name: input.package_name, closure_digest: closure.closure_digest },
    );
  }

  const receiptPath = paths.receiptRecord(receipt.receipt_digest);
  if (!(await exists(receiptPath))) {
    try {
      await writeImmutableJson(receiptPath, receipt);
    } catch (error) {
      if (!(await exists(receiptPath))) throw error;
    }
  }
  receipt = await readJson<ArtifactBuildReceipt>(receiptPath);
  assertReceiptIntegrity({
    receipt,
    package_name: input.package_name,
    artifact_profile: input.artifact_profile,
    compatibility_key: key,
    receipt_digest: receiptDigest,
    closure_digest: closure.closure_digest,
    source_closure_digest: input.source_closure.source_closure_digest,
  });

  const channelSemantic = {
    schema: ARTIFACT_CHANNEL_SCHEMA,
    package_name: input.package_name,
    compatibility: input.compatibility,
    compatibility_key: key,
    closure_digest: closure.closure_digest,
    receipt_digest: receipt.receipt_digest,
    source_closure_digest: input.source_closure.source_closure_digest,
  };
  let channel: ArtifactChannel = {
    ...channelSemantic,
    published_at: now,
    channel_digest: semanticDigest(channelSemantic),
  };

  let channelChanged = true;
  if (await exists(paths.channel)) {
    const previous = await readJson<ArtifactChannel>(paths.channel);
    assertChannelIntegrity({
      channel: previous,
      selector: {
        mode: "latest_compatible",
        store_root: resolve(input.store_root),
        package_name: input.package_name,
        compatibility: input.compatibility,
        source_policy: "require_fresh",
      },
      compatibility_key: key,
      channel_path: paths.channel,
    });
    channelChanged = previous.channel_digest !== channel.channel_digest;
    if (!channelChanged) channel = previous;
  }
  await input.pre_publish_check?.();
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

export async function sealDeployment(
  input: SealDeploymentInput,
): Promise<SealDeploymentResult> {
  return withArtifactStoreLock(input.store_root, () => sealDeploymentUnlocked(input));
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
  assertChannelIntegrity({
    channel,
    selector,
    compatibility_key: key,
    channel_path: paths.channel,
  });
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
    compatibility_key: closure.compatibility_key,
    deployment_tree_digest: closure.deployment_tree_digest,
    files: closure.files,
    entrypoints: closure.entrypoints,
    fixed_dependencies: closure.fixed_dependencies,
    platform_requirements: closure.platform_requirements,
  };
  if (
    closure.schema !== ARTIFACT_CLOSURE_SCHEMA ||
    closure.package_name !== input.package_name ||
    !/^sha256:[0-9a-f]{64}$/u.test(closure.compatibility_key) ||
    closure.closure_digest !== input.closure_digest ||
    semanticDigest(semantic) !== closure.closure_digest ||
    tree.deployment_tree_digest !== closure.deployment_tree_digest ||
    canonicalJson(tree.files) !== canonicalJson(closure.files)
  ) {
    throw new ArtifactIntegrityError(
      "artifact_closure_corrupt",
      `Sealed artifact closure failed verification for ${input.package_name}`,
      { closure_path: closurePath, closure_digest: input.closure_digest },
    );
  }
  return { closure, closure_path: closurePath };
}

/**
 * Verify an already-pinned artifact without consulting a mutable channel or
 * re-capturing workspace source.  Callers use this at a cutover boundary
 * where the prepared receipt and closure are the authority.
 */
export async function verifyArtifactPin(input: {
  store_root: string;
  package_name: string;
  compatibility: ArtifactCompatibility;
  closure_digest: Sha256Digest;
  receipt_digest: Sha256Digest;
}): Promise<{
  receipt: ArtifactBuildReceipt;
  closure: ArtifactClosure;
  closure_path: string;
}> {
  const key = compatibilityKey(input.package_name, input.compatibility);
  const paths = artifactStorePaths(input.store_root, input.package_name, key);
  let receipt: ArtifactBuildReceipt;
  try {
    receipt = await readJson<ArtifactBuildReceipt>(paths.receiptRecord(input.receipt_digest));
  } catch (error) {
    throw new ArtifactIntegrityError(
      "artifact_pin_corrupt",
      `Pinned artifact receipt is missing or unreadable for ${input.package_name}`,
      {
        package_name: input.package_name,
        receipt_digest: input.receipt_digest,
        receipt_path: paths.receiptRecord(input.receipt_digest),
      },
      { cause: error },
    );
  }

  assertReceiptIntegrity({
    receipt,
    package_name: input.package_name,
    artifact_profile: input.compatibility.artifact_profile,
    compatibility_key: key,
    receipt_digest: input.receipt_digest,
    closure_digest: input.closure_digest,
    source_closure_digest: receipt.source_closure_digest,
  });

  let verified: { closure: ArtifactClosure; closure_path: string };
  try {
    verified = await verifyClosure({
      store_root: input.store_root,
      package_name: input.package_name,
      closure_digest: input.closure_digest,
    });
  } catch (error) {
    if (error instanceof ArtifactIntegrityError) throw error;
    throw new ArtifactIntegrityError(
      "artifact_pin_corrupt",
      `Pinned artifact closure is missing or unreadable for ${input.package_name}`,
      {
        package_name: input.package_name,
        closure_digest: input.closure_digest,
      },
      { cause: error },
    );
  }

  if (
    verified.closure.artifact_profile !== input.compatibility.artifact_profile
    || verified.closure.compatibility_key !== key
    || verified.closure.deployment_tree_digest !== receipt.deployment_tree_digest
  ) {
    throw new ArtifactIntegrityError(
      "artifact_pin_corrupt",
      `Pinned artifact closure does not match its receipt for ${input.package_name}`,
      {
        package_name: input.package_name,
        receipt_digest: input.receipt_digest,
        closure_digest: input.closure_digest,
      },
    );
  }

  return { receipt, closure: verified.closure, closure_path: verified.closure_path };
}

const ARTIFACT_LEASE_SCHEMA = "narada.artifact.lease.v1" as const;
const DEFAULT_ARTIFACT_LEASE_TTL_MS = 10 * 60 * 1000;

type ArtifactLeaseRecord = {
  schema: typeof ARTIFACT_LEASE_SCHEMA;
  store_root: string;
  package_name: string;
  closure_digest: Sha256Digest;
  receipt_digest: Sha256Digest;
  owner_pid: number;
  token: string;
  acquired_at: string;
  expires_at: string;
};

export type ArtifactLeaseHandle = {
  lease_path: string;
  renew: () => Promise<void>;
  release: () => Promise<void>;
};

export async function acquireArtifactLease(input: {
  store_root: string;
  package_name: string;
  compatibility: ArtifactCompatibility;
  closure_digest: Sha256Digest;
  receipt_digest: Sha256Digest;
  ttl_ms?: number;
}): Promise<ArtifactLeaseHandle> {
  const ttlMs = input.ttl_ms ?? DEFAULT_ARTIFACT_LEASE_TTL_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw new ArtifactIntegrityError(
      "artifact_lease_invalid",
      "Artifact lease ttl_ms must be a positive integer.",
      { ttl_ms: ttlMs },
    );
  }
  const root = resolve(input.store_root);
  const token = randomUUID();
  const leasePath = join(root, "leases", `${process.pid}-${token}.json`);
  let released = false;
  let record: ArtifactLeaseRecord = {
    schema: ARTIFACT_LEASE_SCHEMA,
    store_root: root,
    package_name: input.package_name,
    closure_digest: input.closure_digest,
    receipt_digest: input.receipt_digest,
    owner_pid: process.pid,
    token,
    acquired_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + ttlMs).toISOString(),
  };

  await withArtifactStoreLock(root, async () => {
    await verifyArtifactPin(input);
    await atomicReplaceJson(leasePath, record);
  });

  const renew = async (): Promise<void> => {
    if (released) return;
    record = {
      ...record,
      expires_at: new Date(Date.now() + ttlMs).toISOString(),
    };
    await withArtifactStoreLock(root, () => atomicReplaceJson(leasePath, record));
  };
  const timer = setInterval(() => {
    void renew().catch(() => {
      // A failed heartbeat expires the lease; reclamation then fails closed for active owners.
    });
  }, Math.max(1_000, Math.floor(ttlMs / 3)));
  timer.unref();

  const release = async (): Promise<void> => {
    if (released) return;
    released = true;
    clearInterval(timer);
    await withArtifactStoreLock(root, async () => {
      try {
        const current = await readJson<ArtifactLeaseRecord>(leasePath);
        if (current.token === token && current.owner_pid === process.pid) {
          await rm(leasePath, { force: true });
          await syncDirectory(dirname(leasePath));
        }
      } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
      }
    });
  };

  return { lease_path: leasePath, renew, release };
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
  assertReceiptIntegrity({
    receipt,
    package_name: input.selector.package_name,
    artifact_profile: input.selector.compatibility.artifact_profile,
    compatibility_key: key,
    receipt_digest: channel.receipt_digest,
    closure_digest: channel.closure_digest,
    source_closure_digest: channel.source_closure_digest,
  });

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
  if (
    verified.closure.artifact_profile !== input.selector.compatibility.artifact_profile
    || verified.closure.compatibility_key !== key
    || verified.closure.deployment_tree_digest !== receipt.deployment_tree_digest
  ) {
    throw new ArtifactIntegrityError(
      "artifact_channel_corrupt",
      `Artifact closure does not match its receipt for ${input.selector.package_name}`,
      {
        receipt_digest: receipt.receipt_digest,
        closure_digest: verified.closure.closure_digest,
      },
    );
  }
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

async function filesBelow(root: string): Promise<string[]> {
  if (!(await exists(root))) return [];
  const output: string[] = [];
  async function visit(current: string): Promise<void> {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) output.push(path);
    }
  }
  await visit(root);
  return output;
}

async function retainLiveArtifactLeases(
  storeRoot: string,
  retainedClosures: Set<Sha256Digest>,
  retainedReceipts: Set<Sha256Digest>,
  closurePackages: Map<Sha256Digest, string>,
): Promise<string[]> {
  const removed: string[] = [];
  const leaseRoot = join(storeRoot, "leases");
  const now = Date.now();
  for (const path of await filesBelow(leaseRoot)) {
    let lease: ArtifactLeaseRecord;
    try {
      lease = await readJson<ArtifactLeaseRecord>(path);
    } catch (error) {
      throw new ArtifactIntegrityError(
        "artifact_lease_corrupt",
        "An artifact lease is unreadable; refusing reclamation.",
        { lease_path: path },
        { cause: error },
      );
    }
    if (
      lease.schema !== ARTIFACT_LEASE_SCHEMA
      || resolve(lease.store_root) !== storeRoot
      || typeof lease.package_name !== "string"
      || !lease.package_name
      || !/^sha256:[0-9a-f]{64}$/u.test(lease.closure_digest)
      || !/^sha256:[0-9a-f]{64}$/u.test(lease.receipt_digest)
      || !Number.isSafeInteger(lease.owner_pid)
      || lease.owner_pid <= 0
      || !Number.isFinite(Date.parse(lease.expires_at))
    ) {
      throw new ArtifactIntegrityError(
        "artifact_lease_corrupt",
        "An artifact lease has an invalid identity; refusing reclamation.",
        { lease_path: path },
      );
    }
    const expired = Date.parse(lease.expires_at) <= now;
    if (expired && !processIsAlive(lease.owner_pid)) {
      await rm(path, { force: true });
      removed.push(path);
      continue;
    }
    const priorPackage = closurePackages.get(lease.closure_digest);
    if (priorPackage !== undefined && priorPackage !== lease.package_name) {
      throw new ArtifactIntegrityError(
        "artifact_closure_corrupt",
        "One leased closure digest claims multiple package identities",
        {
          closure_digest: lease.closure_digest,
          package_names: [priorPackage, lease.package_name],
        },
      );
    }
    closurePackages.set(lease.closure_digest, lease.package_name);
    retainedClosures.add(lease.closure_digest);
    retainedReceipts.add(lease.receipt_digest);
  }
  return removed;
}

async function pruneArtifactStoreUnlocked(input: {
  store_root: string;
  active_selectors: ArtifactSelector[];
}): Promise<{
  retained_channel_paths: string[];
  retained_closure_digests: Sha256Digest[];
  retained_receipt_digests: Sha256Digest[];
  removed_paths: string[];
}> {
  const storeRoot = resolve(input.store_root);
  const retainedChannels = new Set<string>();
  const retainedClosures = new Set<Sha256Digest>();
  const retainedReceipts = new Set<Sha256Digest>();
  const closurePackages = new Map<Sha256Digest, string>();
  const closureReceipts = new Map<Sha256Digest, ArtifactBuildReceipt>();
  const removedLeasePaths = await retainLiveArtifactLeases(
    storeRoot,
    retainedClosures,
    retainedReceipts,
    closurePackages,
  );

  for (const selector of input.active_selectors) {
    if (resolve(selector.store_root) !== storeRoot) {
      throw new ArtifactIntegrityError(
        "artifact_binding_incompatible",
        "Artifact selector belongs to another store",
        { expected_store_root: storeRoot, selector_store_root: resolve(selector.store_root) },
      );
    }
    const { channel, channel_path: channelPath } = await readArtifactChannel(selector);
    const key = compatibilityKey(selector.package_name, selector.compatibility);
    const paths = artifactStorePaths(
      storeRoot,
      selector.package_name,
      key,
    );
    let receipt: ArtifactBuildReceipt;
    try {
      receipt = await readJson<ArtifactBuildReceipt>(paths.receiptRecord(channel.receipt_digest));
    } catch (error) {
      throw new ArtifactIntegrityError(
        "artifact_channel_corrupt",
        "Retained artifact receipt is missing during hard-cutover reclamation",
        { package_name: selector.package_name, receipt_digest: channel.receipt_digest },
        { cause: error },
      );
    }
    assertReceiptIntegrity({
      receipt,
      package_name: selector.package_name,
      artifact_profile: selector.compatibility.artifact_profile,
      compatibility_key: key,
      receipt_digest: channel.receipt_digest,
      closure_digest: channel.closure_digest,
      source_closure_digest: channel.source_closure_digest,
    });
    retainedChannels.add(resolve(channelPath));
    retainedClosures.add(channel.closure_digest);
    retainedReceipts.add(channel.receipt_digest);
    const priorPackage = closurePackages.get(channel.closure_digest);
    if (priorPackage !== undefined && priorPackage !== selector.package_name) {
      throw new ArtifactIntegrityError(
        "artifact_closure_corrupt",
        "One retained closure digest claims multiple package identities",
        {
          closure_digest: channel.closure_digest,
          package_names: [priorPackage, selector.package_name],
        },
      );
    }
    closurePackages.set(channel.closure_digest, selector.package_name);
    closureReceipts.set(channel.closure_digest, receipt);
  }

  const pendingClosures = [...retainedClosures];
  while (pendingClosures.length > 0) {
    const closureDigest = pendingClosures.pop()!;
    const paths = artifactStorePaths(
      storeRoot,
      "_closure_lookup",
      semanticDigest("prune"),
    );
    let recordedClosure: ArtifactClosure;
    try {
      recordedClosure = await readJson<ArtifactClosure>(paths.closureRecord(closureDigest));
    } catch (error) {
      throw new ArtifactIntegrityError(
        "artifact_closure_corrupt",
        "Retained artifact closure record is missing during hard-cutover reclamation",
        { closure_digest: closureDigest },
        { cause: error },
      );
    }
    const packageName = closurePackages.get(closureDigest) ?? recordedClosure.package_name;
    if (typeof packageName !== "string" || !packageName) {
      throw new ArtifactIntegrityError(
        "artifact_closure_corrupt",
        "Retained artifact closure has no package identity",
        { closure_digest: closureDigest },
      );
    }
    const { closure } = await verifyClosure({
      store_root: storeRoot,
      package_name: packageName,
      closure_digest: closureDigest,
    });
    const receipt = closureReceipts.get(closureDigest);
    if (
      receipt
      && (
        closure.artifact_profile !== receipt.artifact_profile
        || closure.deployment_tree_digest !== receipt.deployment_tree_digest
      )
    ) {
      throw new ArtifactIntegrityError(
        "artifact_channel_corrupt",
        "Retained closure does not match its active receipt",
        { closure_digest: closureDigest, receipt_digest: receipt.receipt_digest },
      );
    }
    for (const dependency of closure.fixed_dependencies) {
      let dependencyRecord: ArtifactClosure;
      try {
        dependencyRecord = await readJson<ArtifactClosure>(
          paths.closureRecord(dependency.closure_digest),
        );
      } catch (error) {
        throw new ArtifactIntegrityError(
          "artifact_closure_corrupt",
          "Retained fixed-dependency closure record is missing",
          {
            parent_closure_digest: closureDigest,
            closure_digest: dependency.closure_digest,
          },
          { cause: error },
        );
      }
      const priorPackage = closurePackages.get(dependency.closure_digest);
      if (priorPackage !== undefined && priorPackage !== dependencyRecord.package_name) {
        throw new ArtifactIntegrityError(
          "artifact_closure_corrupt",
          "One retained fixed-dependency digest claims multiple package identities",
          {
            closure_digest: dependency.closure_digest,
            package_names: [priorPackage, dependencyRecord.package_name],
          },
        );
      }
      closurePackages.set(dependency.closure_digest, dependencyRecord.package_name);
      if (!retainedClosures.has(dependency.closure_digest)) {
        retainedClosures.add(dependency.closure_digest);
        pendingClosures.push(dependency.closure_digest);
      }
    }
  }

  const removedPaths: string[] = [...removedLeasePaths];
  const changedDirectories = new Set<string>();
  for (const path of removedLeasePaths) changedDirectories.add(dirname(path));
  const closureRoot = join(storeRoot, "closures", "sha256");
  if (await exists(closureRoot)) {
    for (const entry of await readdir(closureRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const digest = `sha256:${entry.name}` as Sha256Digest;
      if (retainedClosures.has(digest)) continue;
      const path = join(closureRoot, entry.name);
      await rm(path, { recursive: true, force: true });
      removedPaths.push(path);
      changedDirectories.add(closureRoot);
    }
  }

  const closureRecordRoot = join(storeRoot, "records", "closures");
  for (const path of await filesBelow(closureRecordRoot)) {
    const name = basename(path);
    const digest = `sha256:${name.replace(/\.json$/u, "")}` as Sha256Digest;
    if (retainedClosures.has(digest)) continue;
    await rm(path, { force: true });
    removedPaths.push(path);
    changedDirectories.add(dirname(path));
  }

  const receiptRoot = join(storeRoot, "receipts", "sha256");
  for (const path of await filesBelow(receiptRoot)) {
    const name = basename(path);
    const digest = `sha256:${name.replace(/\.json$/u, "")}` as Sha256Digest;
    if (retainedReceipts.has(digest)) continue;
    await rm(path, { force: true });
    removedPaths.push(path);
    changedDirectories.add(dirname(path));
  }

  const channelRoot = join(storeRoot, "channels");
  for (const path of await filesBelow(channelRoot)) {
    if (retainedChannels.has(resolve(path))) continue;
    await rm(path, { force: true });
    removedPaths.push(path);
    changedDirectories.add(dirname(path));
  }

  // Never recursively delete the temporary root during GC. Build staging is
  // intentionally outside this lock and a live builder may still own it.
  for (const directory of [...changedDirectories].sort()) {
    await syncDirectory(directory);
  }

  return {
    retained_channel_paths: [...retainedChannels].sort(),
    retained_closure_digests: [...retainedClosures].sort(),
    retained_receipt_digests: [...retainedReceipts].sort(),
    removed_paths: removedPaths.sort(),
  };
}

export async function pruneArtifactStore(input: {
  store_root: string;
  active_selectors: ArtifactSelector[];
}): Promise<{
  retained_channel_paths: string[];
  retained_closure_digests: Sha256Digest[];
  retained_receipt_digests: Sha256Digest[];
  removed_paths: string[];
}> {
  return withArtifactStoreLock(
    input.store_root,
    () => pruneArtifactStoreUnlocked(input),
  );
}
