import { cp, lstat, mkdir, readdir, readFile, readlink, realpath } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { sha256Bytes, semanticDigest } from "./canonical.js";
import type {
  ArtifactSourceClosure,
  ArtifactSourceFile,
  ArtifactTreeFile,
  Sha256Digest,
} from "./contracts.js";
import { ArtifactIntegrityError } from "./errors.js";

const DEFAULT_SOURCE_EXCLUDES = [
  ".git",
  "node_modules",
  "dist",
  "coverage",
  ".turbo",
  ".cache",
  ".pnpm-store",
  ".tmp",
  ".tmp-tests",
  "target",
  ".ai/runtime",
  ".ai/tmp",
  ".ai/temp",
];

function portablePath(path: string): string {
  return path.split(sep).join("/");
}

function excluded(relativePath: string, excludes: readonly string[]): boolean {
  const portable = portablePath(relativePath);
  return excludes.some((candidate) => {
    const normalized = candidate.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
    return portable === normalized || portable.startsWith(`${normalized}/`) || portable.split("/").includes(normalized);
  });
}

async function walk(
  root: string,
  excludes: readonly string[],
  allowedLinkRoots?: ReadonlyArray<{
    root: string;
    excludes: readonly string[];
  }>,
): Promise<ArtifactTreeFile[]> {
  const absoluteRoot = resolve(root);
  const output: ArtifactTreeFile[] = [];

  async function visit(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const absolute = join(current, entry.name);
      const rel = portablePath(relative(absoluteRoot, absolute));
      if (excluded(rel, excludes)) continue;
      const stat = await lstat(absolute);
      if (stat.isDirectory()) {
        await visit(absolute);
        continue;
      }
      if (stat.isSymbolicLink()) {
        if (allowedLinkRoots !== undefined) {
          let resolvedTarget: string;
          try {
            resolvedTarget = await realpath(absolute);
          } catch (error) {
            throw new ArtifactIntegrityError(
              "artifact_source_link_invalid",
              "Source closure contains a broken link",
              { source_root: absoluteRoot, link_path: absolute },
              { cause: error },
            );
          }
          const admitted = allowedLinkRoots.some((candidate) => {
            if (!pathInside(candidate.root, resolvedTarget)) return false;
            const targetRelative = relative(resolve(candidate.root), resolvedTarget);
            return !excluded(targetRelative, candidate.excludes);
          });
          if (!admitted) {
            throw new ArtifactIntegrityError(
              "artifact_source_link_external",
              "Source closure contains a link outside its declared roots",
              {
                source_root: absoluteRoot,
                link_path: absolute,
                link_target: resolvedTarget,
              },
            );
          }
        }
        const target = portablePath(await readlink(absolute));
        output.push({
          path: rel,
          kind: "symlink",
          size: Buffer.byteLength(target),
          sha256: sha256Bytes(target),
          symlink_target: target,
        });
        continue;
      }
      if (stat.isFile()) {
        const bytes = await readFile(absolute);
        output.push({
          path: rel,
          kind: "file",
          size: bytes.byteLength,
          sha256: sha256Bytes(bytes),
        });
      }
    }
  }

  await visit(absoluteRoot);
  output.sort((left, right) => left.path.localeCompare(right.path));
  return output;
}

export async function hashDeploymentTree(root: string): Promise<{
  files: ArtifactTreeFile[];
  deployment_tree_digest: Sha256Digest;
}> {
  const files = await walk(root, []);
  return {
    files,
    deployment_tree_digest: semanticDigest(files),
  };
}

export interface SourceRoot {
  root: string;
  logical_prefix: string;
  excludes?: string[];
}

export async function captureSourceClosure(input: {
  package_name: string;
  roots: SourceRoot[];
}): Promise<ArtifactSourceClosure> {
  const files: ArtifactSourceFile[] = [];
  const orderedRoots = [...input.roots].sort((left, right) =>
    left.logical_prefix.localeCompare(right.logical_prefix),
  );
  const allowedLinkRoots = orderedRoots.map((sourceRoot) => ({
    root: resolve(sourceRoot.root),
    excludes: [
      ...DEFAULT_SOURCE_EXCLUDES,
      ...(sourceRoot.excludes ?? []),
    ],
  }));

  for (const sourceRoot of orderedRoots) {
    const rootFiles = await walk(
      sourceRoot.root,
      [
        ...DEFAULT_SOURCE_EXCLUDES,
        ...(sourceRoot.excludes ?? []),
      ],
      allowedLinkRoots,
    );
    for (const file of rootFiles) {
      files.push({
        logical_path: `${sourceRoot.logical_prefix.replace(/\/$/, "")}/${file.path}`,
        kind: file.kind,
        size: file.size,
        sha256: file.sha256,
        ...(file.symlink_target === undefined ? {} : { symlink_target: file.symlink_target }),
      });
    }
  }

  files.sort((left, right) => left.logical_path.localeCompare(right.logical_path));
  return {
    schema: "narada.artifact.source_closure.v1",
    package_name: input.package_name,
    files,
    source_closure_digest: semanticDigest(files),
  };
}

export async function copyDeploymentTree(from: string, to: string): Promise<void> {
  await mkdir(dirname(to), { recursive: true });
  await cp(from, to, {
    recursive: true,
    force: false,
    errorOnExist: true,
    preserveTimestamps: false,
    verbatimSymlinks: true,
  });
}

function pathInside(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

async function assertDeploymentLinksInternal(root: string): Promise<void> {
  const absoluteRoot = resolve(root);
  const visiting = new Set<string>();
  const visited = new Set<string>();

  function identity(path: string): string {
    const resolved = resolve(path);
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  }

  async function visit(current: string): Promise<void> {
    const realCurrent = await realpath(current);
    const key = identity(realCurrent);
    if (visiting.has(key)) {
      throw new ArtifactIntegrityError(
        "artifact_closure_corrupt",
        "Deployment contains a cyclic directory link",
        { deployment_root: absoluteRoot, link_target: realCurrent },
      );
    }
    if (visited.has(key)) return;
    visiting.add(key);
    const entries = await readdir(realCurrent, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = join(realCurrent, entry.name);
      const stat = await lstat(absolute);
      if (stat.isSymbolicLink()) {
        const target = await realpath(absolute);
        if (!pathInside(absoluteRoot, target)) {
          throw new ArtifactIntegrityError(
            "artifact_closure_corrupt",
            "Deployment contains a link outside its own tree",
            {
              deployment_root: absoluteRoot,
              link_path: absolute,
              link_target: target,
            },
          );
        }
        if ((await lstat(target)).isDirectory()) await visit(target);
        continue;
      }
      if (stat.isDirectory()) await visit(absolute);
    }
    visiting.delete(key);
    visited.add(key);
  }

  await visit(absoluteRoot);
}

export async function materializeDeploymentTree(from: string, to: string): Promise<void> {
  await assertDeploymentLinksInternal(from);
  await mkdir(dirname(to), { recursive: true });
  await cp(from, to, {
    recursive: true,
    force: false,
    errorOnExist: true,
    preserveTimestamps: false,
    dereference: true,
  });
}
