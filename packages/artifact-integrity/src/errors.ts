export type ArtifactIntegrityErrorCode =
  | "artifact_source_stale"
  | "artifact_closure_corrupt"
  | "artifact_channel_corrupt"
  | "artifact_build_inputs_changed"
  | "artifact_entrypoint_missing"
  | "artifact_binding_incompatible"
  | "artifact_declaration_invalid"
  | "artifact_command_failed";

export class ArtifactIntegrityError extends Error {
  readonly code: ArtifactIntegrityErrorCode;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    code: ArtifactIntegrityErrorCode,
    message: string,
    details: Record<string, unknown> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ArtifactIntegrityError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }

  toJSON(): Record<string, unknown> {
    return {
      schema: "narada.artifact_integrity.error.v1",
      code: this.code,
      message: this.message,
      details: this.details,
    };
  }
}
