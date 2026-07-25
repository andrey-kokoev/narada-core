import { cp, lstat, mkdir, readdir, readFile, readlink } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { sha256Bytes, semanticDigest } from "./canonical.js";
import type {
  ArtifactSourceClosure,
  ArtifactSourceFile,
  ArtifactTreeFile,
  Sha256Digest,
} from "./contracts.js";

const DEFAULT_SOURCE_EXCLUDES = [
  ".git",
  "node_modules",
  "dist",
  "coverage",
  ".turbo",
  ".cache",
  ".pnpm-store",
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

  for (const sourceRoot of orderedRoots) {
    const rootFiles = await walk(sourceRoot.root, [
      ...DEFAULT_SOURCE_EXCLUDES,
      ...(sourceRoot.excludes ?? []),
    ]);
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
