import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ArtifactIntegrityError,
  assertSourceUnchanged,
  canonicalJson,
  captureSourceClosure,
  resolveArtifactSelector,
  sealDeployment,
  semanticDigest,
  sha256Bytes,
  verifyClosure,
  type ArtifactBuildRecipe,
  type ArtifactCompatibility,
  type ArtifactToolchainEvidence,
} from "../src/index.js";

const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "narada-artifact-test-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

const compatibility: ArtifactCompatibility = {
  artifact_profile: "mcp-surface",
  descriptor_digest: sha256Bytes("descriptor"),
  interface_digest: sha256Bytes("interface"),
};

const recipeSemantic = {
  schema: "narada.artifact.build_recipe.v1" as const,
  command: "pnpm",
  args: ["run", "build:raw"],
  environment_names: [] as string[],
};
const recipe: ArtifactBuildRecipe = {
  ...recipeSemantic,
  build_recipe_digest: semanticDigest(recipeSemantic),
};

const toolchainSemantic = {
  schema: "narada.artifact.toolchain.v1" as const,
  node_version: process.version,
  pnpm_version: "10.9.0",
  platform: process.platform,
  architecture: process.arch,
  lockfile_digest: sha256Bytes("lockfile"),
};
const toolchain: ArtifactToolchainEvidence = {
  ...toolchainSemantic,
  toolchain_digest: semanticDigest(toolchainSemantic),
};

async function fixture(): Promise<{
  root: string;
  source: string;
  deployment: string;
  store: string;
}> {
  const root = await temporaryRoot();
  const source = join(root, "source");
  const deployment = join(root, "deployment");
  const store = join(root, "store");
  await mkdir(source, { recursive: true });
  await mkdir(join(deployment, "dist"), { recursive: true });
  await writeFile(join(source, "index.ts"), "export const value = 'source-v1';\n");
  await writeFile(join(deployment, "dist", "index.mjs"), "export const value = 'sealed-v1';\n");
  return { root, source, deployment, store };
}

async function sealFixture(input: Awaited<ReturnType<typeof fixture>>, now: string) {
  const sourceClosure = await captureSourceClosure({
    package_name: "@narada2/example",
    roots: [{ root: input.source, logical_prefix: "packages/@narada2/example" }],
  });
  return sealDeployment({
    store_root: input.store,
    deployment_root: input.deployment,
    package_name: "@narada2/example",
    artifact_profile: "mcp-surface",
    source_closure: sourceClosure,
    build_recipe: recipe,
    toolchain,
    entrypoints: ["dist/index.mjs"],
    compatibility,
    now: () => new Date(now),
  });
}

describe("canonical artifact integrity", () => {
  it("canonicalizes object keys and excludes no-op wall clock changes from semantic identity", async () => {
    expect(canonicalJson({ z: 1, a: { d: 2, b: 1 } })).toBe(
      '{"a":{"b":1,"d":2},"z":1}',
    );
    const input = await fixture();
    const first = await sealFixture(input, "2026-07-25T00:00:00.000Z");
    const second = await sealFixture(input, "2026-07-26T00:00:00.000Z");
    expect(second.closure.closure_digest).toBe(first.closure.closure_digest);
    expect(second.receipt.receipt_digest).toBe(first.receipt.receipt_digest);
    expect(second.channel.channel_digest).toBe(first.channel.channel_digest);
    expect(second.channel_changed).toBe(false);
    expect(second.reused_closure).toBe(true);
  });

  it("pins lazy imports to sealed bytes after mutable staging changes", async () => {
    const input = await fixture();
    const sealed = await sealFixture(input, "2026-07-25T00:00:00.000Z");
    await writeFile(join(input.deployment, "dist", "index.mjs"), "export const value = 'mutable-v2';\n");
    const moduleUrl = new URL(
      `file:///${join(sealed.closure_path, "dist", "index.mjs").replaceAll("\\", "/")}`,
    );
    const loaded = (await import(`${moduleUrl.href}?closure=${Date.now()}`)) as { value: string };
    expect(loaded.value).toBe("sealed-v1");
  });

  it("refuses source drift for a new selector resolution", async () => {
    const input = await fixture();
    await sealFixture(input, "2026-07-25T00:00:00.000Z");
    await writeFile(join(input.source, "index.ts"), "export const value = 'source-v2';\n");
    await expect(
      resolveArtifactSelector({
        selector: {
          mode: "latest_compatible",
          store_root: input.store,
          package_name: "@narada2/example",
          compatibility,
          source_policy: "require_fresh",
        },
        source_roots: [
          { root: input.source, logical_prefix: "packages/@narada2/example" },
        ],
      }),
    ).rejects.toMatchObject({ code: "artifact_source_stale" });
  });

  it("detects closure tampering", async () => {
    const input = await fixture();
    const sealed = await sealFixture(input, "2026-07-25T00:00:00.000Z");
    await writeFile(join(sealed.closure_path, "dist", "index.mjs"), "export const value = 'tampered';\n");
    await expect(
      verifyClosure({
        store_root: input.store,
        package_name: "@narada2/example",
        closure_digest: sealed.closure.closure_digest,
      }),
    ).rejects.toMatchObject({ code: "artifact_closure_corrupt" });
  });

  it("includes transitive workspace roots in source identity", async () => {
    const root = await temporaryRoot();
    const packageRoot = join(root, "package");
    const dependencyRoot = join(root, "dependency");
    await mkdir(packageRoot, { recursive: true });
    await mkdir(dependencyRoot, { recursive: true });
    await writeFile(join(packageRoot, "index.ts"), "import 'dependency';\n");
    await writeFile(join(dependencyRoot, "index.ts"), "export const version = 1;\n");
    const before = await captureSourceClosure({
      package_name: "package",
      roots: [
        { root: packageRoot, logical_prefix: "packages/package" },
        { root: dependencyRoot, logical_prefix: "packages/dependency" },
      ],
    });
    await writeFile(join(dependencyRoot, "index.ts"), "export const version = 2;\n");
    const after = await captureSourceClosure({
      package_name: "package",
      roots: [
        { root: packageRoot, logical_prefix: "packages/package" },
        { root: dependencyRoot, logical_prefix: "packages/dependency" },
      ],
    });
    expect(after.source_closure_digest).not.toBe(before.source_closure_digest);
    await expect(assertSourceUnchanged(before, after)).rejects.toBeInstanceOf(
      ArtifactIntegrityError,
    );
  });

  it("stores immutable records as canonical JSON", async () => {
    const input = await fixture();
    const sealed = await sealFixture(input, "2026-07-25T00:00:00.000Z");
    const channelText = await readFile(sealed.channel_path, "utf8");
    expect(channelText).toBe(`${canonicalJson(sealed.channel)}\n`);
  });
});
