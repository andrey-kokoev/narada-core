import {
  access,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ArtifactIntegrityError,
  artifactStorePaths,
  assertSourceUnchanged,
  canonicalJson,
  captureSourceClosure,
  createBuildRecipe,
  materializeDeploymentTree,
  compatibilityKey,
  pruneArtifactStore,
  reapAbandonedBuildStaging,
  resolveArtifactSelector,
  sealDeployment,
  semanticDigest,
  sha256Bytes,
  verifyClosure,
  type ArtifactBuildRecipe,
  type ArtifactCompatibility,
  type ArtifactToolchainEvidence,
} from "../src/index.js";
import { pathToFileURL } from "node:url";

const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "narada-artifact-test-"));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => {
      // Windows transiently locks freshly written files (Defender, indexer);
      // retry, then tolerate leftover temp dirs rather than flake the suite.
      for (let attempt = 0; attempt < 6; attempt += 1) {
        try {
          await rm(root, { recursive: true, force: true });
          return;
        } catch (error) {
          if (attempt === 5) return;
          await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
        }
      }
    }),
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
  deployment: {
    command: "pnpm",
    args: ["deploy", "--prod", "{deployment_root}"],
    environment_names: [] as string[],
    working_directory: "D:\\workspace\\packages\\example",
    materialization: "dereference_internal_links_v1" as const,
  },
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

async function sealFixture(
  input: Awaited<ReturnType<typeof fixture>>,
  now: string,
  selectedCompatibility = compatibility,
) {
  const sourceClosure = await captureSourceClosure({
    package_name: "@narada-core/example",
    roots: [{ root: input.source, logical_prefix: "packages/@narada-core/example" }],
  });
  return sealDeployment({
    store_root: input.store,
    deployment_root: input.deployment,
    package_name: "@narada-core/example",
    artifact_profile: "mcp-surface",
    source_closure: sourceClosure,
    build_recipe: recipe,
    toolchain,
    entrypoints: ["dist/index.mjs"],
    compatibility: selectedCompatibility,
    now: () => new Date(now),
  });
}

describe("canonical artifact integrity", () => {
  it("pins the package-manager deployment operation into the build recipe", () => {
    const generated = createBuildRecipe({
      package_name: "@narada-core/example",
      package_root: "D:\\workspace\\packages\\example",
      workspace_root: "D:\\workspace",
      declaration: {
        profile: "mcp-surface-v3",
        entrypoints: ["dist/main.js"],
        build_script: "build",
      },
    });
    expect(generated.deployment).toEqual({
      command: "pnpm",
      args: [
        "--filter",
        "@narada-core/example",
        "deploy",
        "--prod",
        "{deployment_root}",
      ],
      environment_names: generated.environment_names,
      working_directory: ".",
      materialization: "dereference_internal_links_v1",
    });
    expect(generated.args).toEqual(["--filter", "@narada-core/example", "run", "build"]);
    expect(JSON.stringify(generated)).not.toContain("D:\\workspace");
  });

  it("materializes internal deployment links and refuses links to mutable external paths", async () => {
    const root = await temporaryRoot();
    const deployment = join(root, "deployment");
    const internal = join(deployment, "packages", "internal");
    const materialized = join(root, "materialized");
    const external = join(root, "external");
    await mkdir(internal, { recursive: true });
    await mkdir(external, { recursive: true });
    await writeFile(join(internal, "index.js"), "export const sealed = true;\n");
    await writeFile(join(external, "index.js"), "export const mutable = true;\n");
    await mkdir(join(deployment, "node_modules"), { recursive: true });
    await symlink(
      internal,
      join(deployment, "node_modules", "internal"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await materializeDeploymentTree(deployment, materialized);
    expect((await lstat(join(materialized, "node_modules", "internal"))).isSymbolicLink()).toBe(false);
    expect(await readFile(join(materialized, "node_modules", "internal", "index.js"), "utf8"))
      .toBe("export const sealed = true;\n");

    await symlink(
      external,
      join(deployment, "node_modules", "external"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(
      materializeDeploymentTree(deployment, join(root, "refused")),
    ).rejects.toMatchObject({ code: "artifact_closure_corrupt" });
  });

  it("preserves pnpm package links so dependency resolution keeps its topology", async () => {
    const root = await temporaryRoot();
    const deployment = join(root, "deployment");
    const materialized = join(root, "materialized");
    const packageRoot = join(
      deployment,
      "node_modules",
      ".pnpm",
      "package@1",
      "node_modules",
      "package",
    );
    const dependencyRoot = join(
      deployment,
      "node_modules",
      ".pnpm",
      "dependency@1",
      "node_modules",
      "dependency",
    );
    const nativePackageRoot = join(
      deployment,
      "node_modules",
      ".pnpm",
      "native-package@1",
      "node_modules",
      "native-package",
    );
    await mkdir(packageRoot, { recursive: true });
    await mkdir(dependencyRoot, { recursive: true });
    await mkdir(join(nativePackageRoot, "native"), { recursive: true });
    await writeFile(join(packageRoot, "package.json"), '{"type":"module"}\n');
    await writeFile(join(packageRoot, "index.js"), "export { value } from 'dependency';\n");
    await writeFile(join(dependencyRoot, "index.js"), "export const value = 'sealed';\n");
    await symlink(
      packageRoot,
      join(deployment, "node_modules", "package"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await symlink(
      dependencyRoot,
      join(packageRoot, "..", "dependency"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await symlink(
      nativePackageRoot,
      join(deployment, "node_modules", "native-package"),
      process.platform === "win32" ? "junction" : "dir",
    );

    await materializeDeploymentTree(deployment, materialized);

    expect((await lstat(join(materialized, "node_modules", "package"))).isSymbolicLink()).toBe(true);
    const loaded = await import(pathToFileURL(
      join(materialized, "node_modules", "package", "index.js"),
    ).href);
    expect(loaded.value).toBe("sealed");
    expect((await lstat(join(materialized, "node_modules", "native-package"))).isSymbolicLink()).toBe(false);
  });

  it("reaps only abandoned artifact-build staging directories", async () => {
    const root = await temporaryRoot();
    const stagingRoot = join(root, ".artifact-build");
    const active = join(stagingRoot, "build-active");
    const abandoned = join(stagingRoot, "build-abandoned");
    const legacy = join(stagingRoot, "build-legacy");
    const youngUnowned = join(stagingRoot, "build-young");
    await Promise.all([
      mkdir(active, { recursive: true }),
      mkdir(abandoned, { recursive: true }),
      mkdir(legacy, { recursive: true }),
      mkdir(youngUnowned, { recursive: true }),
    ]);
    const owner = (pid: number) => `${JSON.stringify({
      schema: "narada.artifact_build_staging_owner.v1",
      pid,
      created_at: "2026-07-25T00:00:00.000Z",
      workspace_root: root,
    })}\n`;
    await Promise.all([
      writeFile(join(active, ".owner.json"), owner(101)),
      writeFile(join(abandoned, ".owner.json"), owner(202)),
      utimes(legacy, new Date("2026-07-25T00:00:00.000Z"), new Date("2026-07-25T00:00:00.000Z")),
      utimes(youngUnowned, new Date("2026-07-25T01:59:30.000Z"), new Date("2026-07-25T01:59:30.000Z")),
    ]);

    const removed = await reapAbandonedBuildStaging({
      staging_root: stagingRoot,
      now: () => new Date("2026-07-25T02:00:00.000Z"),
      is_process_alive: (pid) => pid === 101,
      owned_grace_ms: 1_000,
      unowned_grace_ms: 60_000,
    });

    expect(removed).toEqual([abandoned, legacy].sort());
    await expect(access(active)).resolves.toBeUndefined();
    await expect(access(youngUnowned)).resolves.toBeUndefined();
    await expect(access(abandoned)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(legacy)).rejects.toMatchObject({ code: "ENOENT" });

    const concurrentlyReaped = join(stagingRoot, "build-concurrent");
    await mkdir(concurrentlyReaped, { recursive: true });
    await utimes(
      concurrentlyReaped,
      new Date("2026-07-25T00:00:00.000Z"),
      new Date("2026-07-25T00:00:00.000Z"),
    );
    await Promise.all([
      reapAbandonedBuildStaging({
        staging_root: stagingRoot,
        now: () => new Date("2026-07-25T02:00:00.000Z"),
        unowned_grace_ms: 60_000,
      }),
      reapAbandonedBuildStaging({
        staging_root: stagingRoot,
        now: () => new Date("2026-07-25T02:00:00.000Z"),
        unowned_grace_ms: 60_000,
      }),
    ]);
    await expect(access(concurrentlyReaped)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses an external link nested behind an internal deployment link", async () => {
    const root = await temporaryRoot();
    const deployment = join(root, "deployment");
    const internal = join(deployment, "packages", "internal");
    const external = join(root, "external");
    await mkdir(internal, { recursive: true });
    await mkdir(external, { recursive: true });
    await writeFile(join(external, "mutable.js"), "export const mutable = true;\n");
    await symlink(
      external,
      join(internal, "nested-external"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await mkdir(join(deployment, "node_modules"), { recursive: true });
    await symlink(
      internal,
      join(deployment, "node_modules", "internal"),
      process.platform === "win32" ? "junction" : "dir",
    );

    await expect(
      materializeDeploymentTree(deployment, join(root, "refused")),
    ).rejects.toMatchObject({ code: "artifact_closure_corrupt" });
  });

  it("refuses source links outside the declared source closure", async () => {
    const root = await temporaryRoot();
    const source = join(root, "source");
    const external = join(root, "external");
    await mkdir(source, { recursive: true });
    await mkdir(external, { recursive: true });
    await writeFile(join(external, "index.ts"), "export const mutable = true;\n");
    await symlink(
      external,
      join(source, "external"),
      process.platform === "win32" ? "junction" : "dir",
    );

    await expect(
      captureSourceClosure({
        package_name: "@narada-core/example",
        roots: [{ root: source, logical_prefix: "packages/@narada-core/example" }],
      }),
    ).rejects.toMatchObject({ code: "artifact_source_link_external" });
  });

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
    expect(second.receipt.built_at).toBe(first.receipt.built_at);
    expect(second.channel.published_at).toBe(first.channel.published_at);
  });

  it("runs the final source guard before publishing a new channel", async () => {
    const input = await fixture();
    const sourceClosure = await captureSourceClosure({
      package_name: "@narada-core/example",
      roots: [{ root: input.source, logical_prefix: "packages/@narada-core/example" }],
    });
    await expect(sealDeployment({
      store_root: input.store,
      deployment_root: input.deployment,
      package_name: "@narada-core/example",
      artifact_profile: "mcp-surface",
      source_closure: sourceClosure,
      build_recipe: recipe,
      toolchain,
      entrypoints: ["dist/index.mjs"],
      compatibility,
      pre_publish_check: async () => {
        throw new ArtifactIntegrityError(
          "artifact_build_inputs_changed",
          "source changed during seal",
        );
      },
    })).rejects.toMatchObject({ code: "artifact_build_inputs_changed" });
    const paths = artifactStorePaths(
      input.store,
      "@narada-core/example",
      compatibilityKey("@narada-core/example", compatibility),
    );
    await expect(access(paths.channel)).rejects.toMatchObject({ code: "ENOENT" });
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
          package_name: "@narada-core/example",
          compatibility,
          source_policy: "require_fresh",
        },
        source_roots: [
          { root: input.source, logical_prefix: "packages/@narada-core/example" },
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
        package_name: "@narada-core/example",
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

  it("rejects a closure record whose file inventory differs from its sealed tree", async () => {
    const input = await fixture();
    const sealed = await sealFixture(input, "2026-07-25T00:00:00.000Z");
    const semantic = {
      schema: sealed.closure.schema,
      package_name: sealed.closure.package_name,
      artifact_profile: sealed.closure.artifact_profile,
      deployment_tree_digest: sealed.closure.deployment_tree_digest,
      files: [],
      entrypoints: sealed.closure.entrypoints,
      fixed_dependencies: sealed.closure.fixed_dependencies,
      platform_requirements: sealed.closure.platform_requirements,
    };
    const forged = {
      ...semantic,
      closure_digest: semanticDigest(semantic),
    };
    const paths = artifactStorePaths(
      input.store,
      "@narada-core/example",
      compatibilityKey("@narada-core/example", compatibility),
    );
    await cp(
      sealed.closure_path,
      paths.closureDirectory(forged.closure_digest),
      { recursive: true },
    );
    await writeFile(
      paths.closureRecord(forged.closure_digest),
      `${canonicalJson(forged)}\n`,
    );
    await expect(verifyClosure({
      store_root: input.store,
      package_name: "@narada-core/example",
      closure_digest: forged.closure_digest,
    })).rejects.toMatchObject({ code: "artifact_closure_corrupt" });
  });

  it("rejects self-consistent channel and receipt records for another interface", async () => {
    const input = await fixture();
    const sealed = await sealFixture(input, "2026-07-25T00:00:00.000Z");
    const paths = artifactStorePaths(
      input.store,
      "@narada-core/example",
      compatibilityKey("@narada-core/example", compatibility),
    );
    const incompatible = {
      ...sealed.channel,
      compatibility: {
        ...sealed.channel.compatibility,
        artifact_profile: "another-profile",
      },
    };
    const channelSemantic = {
      schema: incompatible.schema,
      package_name: incompatible.package_name,
      compatibility: incompatible.compatibility,
      compatibility_key: incompatible.compatibility_key,
      closure_digest: incompatible.closure_digest,
      receipt_digest: incompatible.receipt_digest,
      source_closure_digest: incompatible.source_closure_digest,
    };
    await writeFile(
      sealed.channel_path,
      `${canonicalJson({
        ...incompatible,
        channel_digest: semanticDigest(channelSemantic),
      })}\n`,
    );
    await expect(resolveArtifactSelector({
      selector: {
        mode: "latest_compatible",
        store_root: input.store,
        package_name: "@narada-core/example",
        compatibility,
        source_policy: "require_fresh",
      },
      source_roots: [
        { root: input.source, logical_prefix: "packages/@narada-core/example" },
      ],
    })).rejects.toMatchObject({ code: "artifact_channel_corrupt" });

    await writeFile(sealed.channel_path, `${canonicalJson(sealed.channel)}\n`);
    await writeFile(
      paths.receiptRecord(sealed.receipt.receipt_digest),
      `${canonicalJson({
        ...sealed.receipt,
        package_name: "@narada-core/another-package",
      })}\n`,
    );
    await expect(resolveArtifactSelector({
      selector: {
        mode: "latest_compatible",
        store_root: input.store,
        package_name: "@narada-core/example",
        compatibility,
        source_policy: "require_fresh",
      },
      source_roots: [
        { root: input.source, logical_prefix: "packages/@narada-core/example" },
      ],
    })).rejects.toMatchObject({ code: "artifact_channel_corrupt" });
  });

  it("reclaims channels, receipts, and closures not selected by the active cutover", async () => {
    const input = await fixture();
    const oldArtifact = await sealFixture(input, "2026-07-25T00:00:00.000Z");
    await writeFile(
      join(input.deployment, "dist", "index.mjs"),
      "export const value = 'sealed-v2';\n",
    );
    const nextCompatibility: ArtifactCompatibility = {
      ...compatibility,
      interface_digest: sha256Bytes("interface-v2"),
    };
    const activeArtifact = await sealFixture(
      input,
      "2026-07-25T01:00:00.000Z",
      nextCompatibility,
    );

    const pruned = await pruneArtifactStore({
      store_root: input.store,
      active_selectors: [{
        mode: "latest_compatible",
        store_root: input.store,
        package_name: "@narada-core/example",
        compatibility: nextCompatibility,
        source_policy: "require_fresh",
      }],
    });

    await expect(access(oldArtifact.closure_path)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(oldArtifact.channel_path)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(access(activeArtifact.closure_path)).resolves.toBeUndefined();
    await expect(access(activeArtifact.channel_path)).resolves.toBeUndefined();
    const oldPaths = artifactStorePaths(
      input.store,
      "@narada-core/example",
      compatibilityKey("@narada-core/example", compatibility),
    );
    await expect(
      access(oldPaths.receiptRecord(oldArtifact.receipt.receipt_digest)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(pruned.retained_closure_digests).toContain(activeArtifact.closure.closure_digest);
  });

  it("refuses reclamation before deletion when an active receipt is corrupt", async () => {
    const input = await fixture();
    const active = await sealFixture(input, "2026-07-25T00:00:00.000Z");
    const paths = artifactStorePaths(
      input.store,
      "@narada-core/example",
      compatibilityKey("@narada-core/example", compatibility),
    );
    await writeFile(
      paths.receiptRecord(active.receipt.receipt_digest),
      `${JSON.stringify({ ...active.receipt, closure_digest: sha256Bytes("corrupt") })}\n`,
    );

    await expect(pruneArtifactStore({
      store_root: input.store,
      active_selectors: [{
        mode: "latest_compatible",
        store_root: input.store,
        package_name: "@narada-core/example",
        compatibility,
        source_policy: "require_fresh",
      }],
    })).rejects.toMatchObject({ code: "artifact_channel_corrupt" });
    await expect(access(active.closure_path)).resolves.toBeUndefined();
    await expect(access(active.channel_path)).resolves.toBeUndefined();
  });
});
