export const ARTIFACT_BUILD_RECEIPT_SCHEMA = "narada.artifact.build_receipt.v2" as const;
export const ARTIFACT_CLOSURE_SCHEMA = "narada.artifact.closure.v2" as const;
export const ARTIFACT_CHANNEL_SCHEMA = "narada.artifact.channel.v2" as const;

export type Sha256Digest = `sha256:${string}`;

export interface ArtifactSourceFile {
  logical_path: string;
  kind: "file" | "symlink";
  size: number;
  sha256: Sha256Digest;
  symlink_target?: string;
}

export interface ArtifactSourceClosure {
  schema: "narada.artifact.source_closure.v1";
  package_name: string;
  files: ArtifactSourceFile[];
  source_closure_digest: Sha256Digest;
}

export interface ArtifactBuildRecipe {
  schema: "narada.artifact.build_recipe.v1";
  command: string;
  args: string[];
  environment_names: string[];
  deployment: {
    command: string;
    args: string[];
    environment_names: string[];
    working_directory: string;
    materialization: "dereference_internal_links_v1";
  };
  build_recipe_digest: Sha256Digest;
}

export interface ArtifactToolchainEvidence {
  schema: "narada.artifact.toolchain.v1";
  node_version: string;
  pnpm_version: string;
  platform: string;
  architecture: string;
  lockfile_digest: Sha256Digest;
  toolchain_digest: Sha256Digest;
}

export interface ArtifactTreeFile {
  path: string;
  kind: "file" | "symlink";
  size: number;
  sha256: Sha256Digest;
  symlink_target?: string;
}

export interface ArtifactFixedDependency {
  role: string;
  closure_digest: Sha256Digest;
  required_entrypoint?: string;
}

export interface ArtifactClosure {
  schema: typeof ARTIFACT_CLOSURE_SCHEMA;
  package_name: string;
  artifact_profile: string;
  compatibility_key: Sha256Digest;
  deployment_tree_digest: Sha256Digest;
  files: ArtifactTreeFile[];
  entrypoints: string[];
  fixed_dependencies: ArtifactFixedDependency[];
  platform_requirements: string[];
  closure_digest: Sha256Digest;
}

export interface ArtifactBuildReceipt {
  schema: typeof ARTIFACT_BUILD_RECEIPT_SCHEMA;
  package_name: string;
  artifact_profile: string;
  compatibility_key: Sha256Digest;
  source_closure_digest: Sha256Digest;
  build_recipe_digest: Sha256Digest;
  toolchain_digest: Sha256Digest;
  deployment_tree_digest: Sha256Digest;
  closure_digest: Sha256Digest;
  receipt_digest: Sha256Digest;
  built_at: string;
}

export interface ArtifactCompatibility {
  descriptor_digest: Sha256Digest;
  interface_digest: Sha256Digest;
  artifact_profile: string;
}

export interface ArtifactChannel {
  schema: typeof ARTIFACT_CHANNEL_SCHEMA;
  package_name: string;
  compatibility: ArtifactCompatibility;
  compatibility_key: Sha256Digest;
  closure_digest: Sha256Digest;
  receipt_digest: Sha256Digest;
  source_closure_digest: Sha256Digest;
  published_at: string;
  channel_digest: Sha256Digest;
}

export interface ArtifactSelector {
  mode: "latest_compatible";
  store_root: string;
  package_name: string;
  compatibility: ArtifactCompatibility;
  source_policy: "require_fresh";
}

export interface NaradaArtifactDeclaration {
  profile: string;
  entrypoints: string[];
  build_script: string;
  build_environment_names?: string[];
  build_dependencies?: string[];
  source_excludes?: string[];
  fixed_dependencies?: Array<{
    role: string;
    package: string;
    required_entrypoint?: string;
  }>;
  platform_requirements?: string[];
}

export interface PackageArtifactConfiguration {
  package_name: string;
  package_root: string;
  workspace_root: string;
  declaration: NaradaArtifactDeclaration;
}
