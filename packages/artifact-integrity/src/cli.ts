#!/usr/bin/env node
import { resolve } from "node:path";
import { canonicalBuild, findWorkspaceRoot } from "./build.js";
import { canonicalJson } from "./canonical.js";
import type { ArtifactCompatibility, Sha256Digest } from "./contracts.js";
import { ArtifactIntegrityError } from "./errors.js";
import { verifyClosure } from "./store.js";

interface ParsedArguments {
  command: string;
  options: Map<string, string>;
}

function parseArguments(argv: string[]): ParsedArguments {
  const [command = "help", ...rest] = argv;
  const options = new Map<string, string>();
  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--")) {
      throw new ArtifactIntegrityError(
        "artifact_declaration_invalid",
        `Unexpected argument: ${token}`,
      );
    }
    const value = rest[index + 1];
    if (!value || value.startsWith("--")) {
      throw new ArtifactIntegrityError(
        "artifact_declaration_invalid",
        `Missing value for ${token}`,
      );
    }
    options.set(token.slice(2), value);
    index += 1;
  }
  return { command, options };
}

function required(options: Map<string, string>, name: string): string {
  const value = options.get(name);
  if (!value) {
    throw new ArtifactIntegrityError(
      "artifact_declaration_invalid",
      `Missing required option --${name}`,
    );
  }
  return value;
}

function digest(options: Map<string, string>, name: string): Sha256Digest {
  const value = required(options, name);
  if (!/^sha256:[a-f0-9]{64}$/u.test(value)) {
    throw new ArtifactIntegrityError(
      "artifact_declaration_invalid",
      `Option --${name} must be a sha256: digest`,
      { value },
    );
  }
  return value as Sha256Digest;
}

function help(): string {
  return [
    "narada-artifact build --package-root <path> --store-root <path> --descriptor-digest <sha256:...> --interface-digest <sha256:...> [--workspace-root <path>]",
    "narada-artifact verify-closure --store-root <path> --package-name <name> --closure-digest <sha256:...>",
  ].join("\n");
}

async function main(): Promise<void> {
  const parsed = parseArguments(process.argv.slice(2));
  if (parsed.command === "help" || parsed.command === "--help" || parsed.command === "-h") {
    process.stdout.write(`${help()}\n`);
    return;
  }

  if (parsed.command === "build") {
    const packageRoot = resolve(required(parsed.options, "package-root"));
    const workspaceRoot = resolve(
      parsed.options.get("workspace-root") ?? (await findWorkspaceRoot(packageRoot)),
    );
    const packageManifest = JSON.parse(
      await (await import("node:fs/promises")).readFile(
        resolve(packageRoot, "package.json"),
        "utf8",
      ),
    ) as { narada?: { artifact?: { profile?: string } } };
    const profile = packageManifest.narada?.artifact?.profile;
    if (!profile) {
      throw new ArtifactIntegrityError(
        "artifact_declaration_invalid",
        "Package artifact profile is missing",
        { package_root: packageRoot },
      );
    }
    const compatibility: ArtifactCompatibility = {
      artifact_profile: profile,
      descriptor_digest: digest(parsed.options, "descriptor-digest"),
      interface_digest: digest(parsed.options, "interface-digest"),
    };
    const result = await canonicalBuild({
      package_root: packageRoot,
      workspace_root: workspaceRoot,
      store_root: resolve(required(parsed.options, "store-root")),
      compatibility,
    });
    process.stdout.write(
      `${canonicalJson({
        schema: "narada.artifact.build_result.v1",
        package_name: result.closure.package_name,
        closure_digest: result.closure.closure_digest,
        receipt_digest: result.receipt.receipt_digest,
        channel_digest: result.channel.channel_digest,
        closure_path: result.closure_path,
        channel_path: result.channel_path,
        reused_closure: result.reused_closure,
        channel_changed: result.channel_changed,
      })}\n`,
    );
    return;
  }

  if (parsed.command === "verify-closure") {
    const result = await verifyClosure({
      store_root: resolve(required(parsed.options, "store-root")),
      package_name: required(parsed.options, "package-name"),
      closure_digest: digest(parsed.options, "closure-digest"),
    });
    process.stdout.write(
      `${canonicalJson({
        schema: "narada.artifact.verify_result.v1",
        status: "ok",
        package_name: result.closure.package_name,
        closure_digest: result.closure.closure_digest,
        closure_path: result.closure_path,
      })}\n`,
    );
    return;
  }

  throw new ArtifactIntegrityError(
    "artifact_declaration_invalid",
    `Unknown command: ${parsed.command}`,
    { help: help() },
  );
}

main().catch((error: unknown) => {
  const payload =
    error instanceof ArtifactIntegrityError
      ? error.toJSON()
      : {
          schema: "narada.artifact_integrity.error.v1",
          code: "artifact_internal_error",
          message: error instanceof Error ? error.message : String(error),
        };
  process.stderr.write(`${canonicalJson(payload)}\n`);
  process.exitCode = 1;
});
