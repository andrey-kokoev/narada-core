/**
 * Task Executability Assessment contracts and resolved policy.
 *
 * Ownership: Task Lifecycle owns assessment truth and policy. Delegated Task
 * owns outcome-level orchestration, Worker Delegation owns provider/runtime
 * execution, and NARS / Site Loop only dispatch and reconcile. This module is
 * the shared contract layer: versioned schemas, field-by-field policy
 * resolution with provenance, deterministic digests, and mechanical verdict
 * derivation. It never invokes an intelligence provider and never selects a
 * provider or model — policy names an evaluator profile (default shoshin-v1)
 * and Delegation resolves provider/model through its own registry.
 */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const TASK_EXECUTABILITY_ASSESSMENT_SCHEMA = 'narada.task_executability_assessment.v1' as const;
export const TASK_EXECUTABILITY_REQUEST_STATE_SCHEMA = 'narada.task_executability_request_state.v1' as const;
export const TASK_EXECUTABILITY_POLICY_SCHEMA = 'narada.task_executability_policy.v1' as const;
export const TASK_EXECUTABILITY_RESOLVED_POLICY_SCHEMA = 'narada.task_executability_resolved_policy.v1' as const;
export const TASK_EXECUTABILITY_DIGEST_SCHEMA = 'narada.task_executability_digest.v1' as const;
export const TASK_EXECUTABILITY_FINDING_SCHEMA = 'narada.task_executability_finding.v1' as const;
export const TASK_EXECUTABILITY_EVALUATOR_PROVENANCE_SCHEMA = 'narada.task_executability_evaluator_provenance.v1' as const;
export const TASK_EXECUTABILITY_OVERRIDE_SCHEMA = 'narada.task_executability_override.v1' as const;
export const TASK_EXECUTABILITY_DECLARED_ENVIRONMENT_SCHEMA = 'narada.task_executability_declared_environment.v1' as const;

/** Policy overlay filename, resolved under `<siteRoot>/.ai/`. */
export const TASK_EXECUTABILITY_POLICY_FILENAME = 'task-executability-policy.json' as const;

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

export type TaskExecutabilityTrigger = 'manual' | 'on_create';
export type TaskExecutabilityEnforcement = 'off' | 'warn' | 'strict';

export const TASK_EXECUTABILITY_TRIGGERS: readonly TaskExecutabilityTrigger[] = ['manual', 'on_create'];
export const TASK_EXECUTABILITY_ENFORCEMENTS: readonly TaskExecutabilityEnforcement[] = ['off', 'warn', 'strict'];

/**
 * Policy overlay document stored at one locus (`<siteRoot>/.ai/task-executability-policy.json`).
 * Every field is optional; unset fields fall through to the next locus.
 * Policy may name an evaluator profile only — provider/model selection is
 * Delegation's registry concern and is rejected here.
 */
export interface TaskExecutabilityPolicy {
  schema: typeof TASK_EXECUTABILITY_POLICY_SCHEMA;
  trigger?: TaskExecutabilityTrigger;
  enforcement?: TaskExecutabilityEnforcement;
  evaluator_profile?: string;
  updated_at?: string;
  updated_by?: string;
}

export type TaskExecutabilityPolicyField = 'trigger' | 'enforcement' | 'evaluator_profile';
export const TASK_EXECUTABILITY_POLICY_FIELDS: readonly TaskExecutabilityPolicyField[] = [
  'trigger',
  'enforcement',
  'evaluator_profile',
];

export type TaskExecutabilityPolicySource = 'target_site' | 'user_site' | 'host_site' | 'product_default';

export interface TaskExecutabilityPolicyProvenanceEntry {
  field: TaskExecutabilityPolicyField;
  value: string;
  source: TaskExecutabilityPolicySource;
  /** Locus policy file path, or the `product-defaults` marker. */
  source_ref: string;
}

export interface ResolvedTaskExecutabilityPolicy {
  schema: typeof TASK_EXECUTABILITY_RESOLVED_POLICY_SCHEMA;
  trigger: TaskExecutabilityTrigger;
  enforcement: TaskExecutabilityEnforcement;
  evaluator_profile: string;
  provenance: TaskExecutabilityPolicyProvenanceEntry[];
}

export const TASK_EXECUTABILITY_PRODUCT_DEFAULTS: Readonly<{
  trigger: TaskExecutabilityTrigger;
  enforcement: TaskExecutabilityEnforcement;
  evaluator_profile: string;
}> = Object.freeze({
  trigger: 'manual',
  enforcement: 'off',
  evaluator_profile: 'shoshin-v1',
});

export const TASK_EXECUTABILITY_PRODUCT_DEFAULTS_REF = 'product-defaults' as const;

export function taskExecutabilityPolicyPath(siteRoot: string): string {
  return join(siteRoot, '.ai', TASK_EXECUTABILITY_POLICY_FILENAME);
}

/** Validate a policy overlay document. Returns a list of error codes; empty means valid. */
export function validateTaskExecutabilityPolicy(doc: unknown): string[] {
  const errors: string[] = [];
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return ['policy_not_an_object'];
  const record = doc as Record<string, unknown>;
  if (record.schema !== TASK_EXECUTABILITY_POLICY_SCHEMA) errors.push('policy_schema_mismatch');
  if (record.trigger !== undefined && !TASK_EXECUTABILITY_TRIGGERS.includes(record.trigger as TaskExecutabilityTrigger)) {
    errors.push('policy_trigger_invalid');
  }
  if (record.enforcement !== undefined && !TASK_EXECUTABILITY_ENFORCEMENTS.includes(record.enforcement as TaskExecutabilityEnforcement)) {
    errors.push('policy_enforcement_invalid');
  }
  if (record.evaluator_profile !== undefined) {
    if (typeof record.evaluator_profile !== 'string' || record.evaluator_profile.trim().length === 0) {
      errors.push('policy_evaluator_profile_invalid');
    }
  }
  // Provider/model selection is Delegation registry authority, never Task Lifecycle policy.
  for (const forbidden of ['provider', 'model', 'provider_id', 'model_id', 'reasoning_effort', 'cognition']) {
    if (record[forbidden] !== undefined) errors.push(`policy_field_forbidden:${forbidden}`);
  }
  return errors;
}

type PolicyLocus = { source: TaskExecutabilityPolicySource; siteRoot: string };

/**
 * Resolve effective executability policy field-by-field:
 * target Site overlay → User Site overlay → Host Site overlay → product defaults.
 * Every field carries its own provenance. Loci with no policy file simply do
 * not participate. A malformed policy file is an explicit error, never a
 * silent fallback.
 */
export function resolveTaskExecutabilityPolicy(args: {
  targetSiteRoot: string;
  userSiteRoot?: string | null;
  hostSiteRoot?: string | null;
  readFile?: (path: string) => string | null;
}): ResolvedTaskExecutabilityPolicy {
  const readFile = args.readFile ?? defaultReadFile;
  const loci: PolicyLocus[] = [{ source: 'target_site', siteRoot: args.targetSiteRoot }];
  if (args.userSiteRoot) loci.push({ source: 'user_site', siteRoot: args.userSiteRoot });
  if (args.hostSiteRoot) loci.push({ source: 'host_site', siteRoot: args.hostSiteRoot });

  const overlays: Array<{ source: TaskExecutabilityPolicySource; path: string; policy: TaskExecutabilityPolicy }> = [];
  for (const locus of loci) {
    const path = taskExecutabilityPolicyPath(locus.siteRoot);
    const text = readFile(path);
    if (text === null) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(`task_executability_policy_invalid:${locus.source}:not_json:${path}`);
    }
    const errors = validateTaskExecutabilityPolicy(parsed);
    if (errors.length > 0) {
      throw new Error(`task_executability_policy_invalid:${locus.source}:${errors[0]}:${path}`);
    }
    overlays.push({ source: locus.source, path, policy: parsed as TaskExecutabilityPolicy });
  }

  const resolved: ResolvedTaskExecutabilityPolicy = {
    schema: TASK_EXECUTABILITY_RESOLVED_POLICY_SCHEMA,
    trigger: TASK_EXECUTABILITY_PRODUCT_DEFAULTS.trigger,
    enforcement: TASK_EXECUTABILITY_PRODUCT_DEFAULTS.enforcement,
    evaluator_profile: TASK_EXECUTABILITY_PRODUCT_DEFAULTS.evaluator_profile,
    provenance: [],
  };
  for (const field of TASK_EXECUTABILITY_POLICY_FIELDS) {
    const overlay = overlays.find((candidate) => candidate.policy[field] !== undefined);
    if (overlay) {
      const value = overlay.policy[field] as string;
      resolved[field] = value as never;
      resolved.provenance.push({ field, value, source: overlay.source, source_ref: overlay.path });
    } else {
      resolved[field] = TASK_EXECUTABILITY_PRODUCT_DEFAULTS[field] as never;
      resolved.provenance.push({
        field,
        value: TASK_EXECUTABILITY_PRODUCT_DEFAULTS[field],
        source: 'product_default',
        source_ref: TASK_EXECUTABILITY_PRODUCT_DEFAULTS_REF,
      });
    }
  }
  return resolved;
}

function defaultReadFile(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Digests
// ---------------------------------------------------------------------------

export type TaskExecutabilityDigestKind = 'task_spec' | 'declared_environment';

export interface TaskExecutabilityDigest {
  schema: typeof TASK_EXECUTABILITY_DIGEST_SCHEMA;
  kind: TaskExecutabilityDigestKind;
  algorithm: 'sha256';
  value: string;
  /** Schema id of the canonical input document the digest was computed over. */
  canonical_input: string;
}

/**
 * Canonical JSON for digests: object keys sorted recursively, undefined
 * dropped, no insignificant whitespace. Two semantically identical documents
 * always serialize to identical bytes.
 */
export function canonicalizeForDigest(value: unknown): string {
  return JSON.stringify(sortForDigest(value));
}

function sortForDigest(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortForDigest);
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) {
      if (record[key] === undefined) continue;
      out[key] = sortForDigest(record[key]);
    }
    return out;
  }
  return value;
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Material task-spec digest input. Only fields that change what the task
 * asks an executor to do participate; tags, chapter, projection state
 * (execution notes, verification, criterion checkmarks), and timestamps are
 * deliberately excluded because they do not change executability.
 */
export interface TaskSpecDigestInput {
  title: string;
  goal: string | null;
  context: string | null;
  required_work: string | null;
  non_goals: string | null;
  acceptance_criteria: string[];
  dependencies: number[];
}

export function taskSpecDigest(spec: TaskSpecDigestInput): string {
  return sha256Hex(
    canonicalizeForDigest({
      kind: 'task_spec',
      title: spec.title,
      goal: spec.goal,
      context: spec.context,
      required_work: spec.required_work,
      non_goals: spec.non_goals,
      acceptance_criteria: spec.acceptance_criteria,
      dependencies: spec.dependencies,
    }),
  );
}

/**
 * Declared environment: the bounded Site environment the evaluator is allowed
 * to see and the dispatch envelope is compared against. Assembly happens in
 * the lifecycle/orchestration layers; this contract fixes the shape.
 */
export interface TaskExecutabilityDeclaredEnvironment {
  schema: typeof TASK_EXECUTABILITY_DECLARED_ENVIRONMENT_SCHEMA;
  site_id: string;
  substrate?: string;
  variant?: string;
  /** Tool names the dispatch is declared to have available. */
  declared_tools?: string[];
  /** Authority capabilities (e.g. read/write/command) declared available. */
  declared_authority?: string[];
  notes?: string;
}

export function declaredEnvironmentDigest(environment: Omit<TaskExecutabilityDeclaredEnvironment, 'schema'>): string {
  return sha256Hex(
    canonicalizeForDigest({
      kind: 'declared_environment',
      site_id: environment.site_id,
      substrate: environment.substrate,
      variant: environment.variant,
      declared_tools: environment.declared_tools ? [...environment.declared_tools].sort() : undefined,
      declared_authority: environment.declared_authority ? [...environment.declared_authority].sort() : undefined,
    }),
  );
}

export function makeTaskExecutabilityDigest(kind: TaskExecutabilityDigestKind, value: string): TaskExecutabilityDigest {
  return {
    schema: TASK_EXECUTABILITY_DIGEST_SCHEMA,
    kind,
    algorithm: 'sha256',
    value,
    canonical_input: kind === 'task_spec' ? 'narada.task_spec_digest_input.v1' : TASK_EXECUTABILITY_DECLARED_ENVIRONMENT_SCHEMA,
  };
}

// ---------------------------------------------------------------------------
// Request state, currency, verdict — three distinct axes
// ---------------------------------------------------------------------------

/**
 * Request execution state (orchestration progress). This axis never expresses
 * an opinion about the task itself.
 */
export type TaskExecutabilityRequestExecutionState =
  | 'pending'
  | 'leased'
  | 'dispatched'
  | 'completed'
  | 'failed_retryable'
  | 'failed_terminal';

export const TASK_EXECUTABILITY_REQUEST_EXECUTION_STATES: readonly TaskExecutabilityRequestExecutionState[] = [
  'pending',
  'leased',
  'dispatched',
  'completed',
  'failed_retryable',
  'failed_terminal',
];

/**
 * Assessment currency: whether an admitted assessment still describes the
 * current task spec and declared environment. A task or environment revision
 * makes prior results stale; a newer admitted assessment supersedes older ones.
 */
export type TaskExecutabilityAssessmentCurrency = 'current' | 'stale' | 'superseded';

export type TaskExecutabilityVerdict = 'executable' | 'needs_revision' | 'not_executable';
export const TASK_EXECUTABILITY_VERDICTS: readonly TaskExecutabilityVerdict[] = [
  'executable',
  'needs_revision',
  'not_executable',
];

export interface TaskExecutabilityRequestState {
  schema: typeof TASK_EXECUTABILITY_REQUEST_STATE_SCHEMA;
  request_id: string;
  task_id: string;
  task_number: number;
  state: TaskExecutabilityRequestExecutionState;
  task_spec_digest: string;
  environment_digest: string;
  evaluator_profile: string;
  evaluator_profile_version: string;
  /** Present once an assessment was admitted for this request. */
  assessment_id?: string;
  /** Execution failure detail; never a verdict about the task. */
  failure?: { kind: string; message: string; at: string };
}

export function isAssessmentCurrent(args: {
  assessment: { task_spec_digest: string; environment_digest: string };
  currentTaskSpecDigest: string;
  currentEnvironmentDigest: string;
}): boolean {
  return (
    args.assessment.task_spec_digest === args.currentTaskSpecDigest &&
    args.assessment.environment_digest === args.currentEnvironmentDigest
  );
}

// ---------------------------------------------------------------------------
// Findings and evaluator provenance
// ---------------------------------------------------------------------------

export type TaskExecutabilityFindingKind =
  | 'unresolved_reference'
  | 'undecided_choice'
  | 'unavailable_authority'
  | 'unavailable_tool'
  | 'unmapped_acceptance_criterion'
  | 'missing_information'
  | 'ambiguity'
  | 'evaluator_note';

export const TASK_EXECUTABILITY_FINDING_KINDS: readonly TaskExecutabilityFindingKind[] = [
  'unresolved_reference',
  'undecided_choice',
  'unavailable_authority',
  'unavailable_tool',
  'unmapped_acceptance_criterion',
  'missing_information',
  'ambiguity',
  'evaluator_note',
];

export type TaskExecutabilityFindingSeverity = 'info' | 'warning' | 'blocking';

export interface TaskExecutabilityFinding {
  schema: typeof TASK_EXECUTABILITY_FINDING_SCHEMA;
  kind: TaskExecutabilityFindingKind;
  severity: TaskExecutabilityFindingSeverity;
  /** Stable machine-readable code, e.g. `unresolved_ref:findings-doc`. */
  code: string;
  message: string;
  /** Optional pointer into the task packet or environment (path, criterion index, reference id). */
  ref?: string;
}

export function validateTaskExecutabilityFinding(doc: unknown): string[] {
  const errors: string[] = [];
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return ['finding_not_an_object'];
  const record = doc as Record<string, unknown>;
  if (record.schema !== TASK_EXECUTABILITY_FINDING_SCHEMA) errors.push('finding_schema_mismatch');
  if (!TASK_EXECUTABILITY_FINDING_KINDS.includes(record.kind as TaskExecutabilityFindingKind)) errors.push('finding_kind_invalid');
  if (!['info', 'warning', 'blocking'].includes(record.severity as string)) errors.push('finding_severity_invalid');
  if (typeof record.code !== 'string' || record.code.trim().length === 0) errors.push('finding_code_required');
  if (typeof record.message !== 'string' || record.message.trim().length === 0) errors.push('finding_message_required');
  return errors;
}

export interface TaskExecutabilityEvaluatorProvenance {
  schema: typeof TASK_EXECUTABILITY_EVALUATOR_PROVENANCE_SCHEMA;
  profile: string;
  profile_version: string;
  cognition: 'low';
  /** Resolved provider/model as reported by Delegation; informational only. */
  provider?: string;
  model?: string;
  delegated_task_id?: string;
  worker_run_id?: string;
}

export function validateTaskExecutabilityEvaluatorProvenance(doc: unknown): string[] {
  const errors: string[] = [];
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return ['evaluator_not_an_object'];
  const record = doc as Record<string, unknown>;
  if (record.schema !== TASK_EXECUTABILITY_EVALUATOR_PROVENANCE_SCHEMA) errors.push('evaluator_schema_mismatch');
  if (typeof record.profile !== 'string' || record.profile.trim().length === 0) errors.push('evaluator_profile_required');
  if (typeof record.profile_version !== 'string' || record.profile_version.trim().length === 0) errors.push('evaluator_profile_version_required');
  if (record.cognition !== 'low') errors.push('evaluator_cognition_must_be_low');
  return errors;
}

// ---------------------------------------------------------------------------
// Assessment
// ---------------------------------------------------------------------------

export interface TaskExecutabilityAssessment {
  schema: typeof TASK_EXECUTABILITY_ASSESSMENT_SCHEMA;
  assessment_id: string;
  request_id: string;
  task_id: string;
  task_number: number;
  task_spec_digest: string;
  environment_digest: string;
  verdict: TaskExecutabilityVerdict;
  findings: TaskExecutabilityFinding[];
  evaluator: TaskExecutabilityEvaluatorProvenance;
  created_at: string;
}

export function validateTaskExecutabilityAssessment(doc: unknown): string[] {
  const errors: string[] = [];
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return ['assessment_not_an_object'];
  const record = doc as Record<string, unknown>;
  if (record.schema !== TASK_EXECUTABILITY_ASSESSMENT_SCHEMA) errors.push('assessment_schema_mismatch');
  for (const field of ['assessment_id', 'request_id', 'task_id', 'task_spec_digest', 'environment_digest', 'created_at']) {
    if (typeof record[field] !== 'string' || (record[field] as string).trim().length === 0) errors.push(`assessment_${field}_required`);
  }
  if (typeof record.task_number !== 'number' || !Number.isFinite(record.task_number)) errors.push('assessment_task_number_required');
  if (!TASK_EXECUTABILITY_VERDICTS.includes(record.verdict as TaskExecutabilityVerdict)) errors.push('assessment_verdict_invalid');
  if (!Array.isArray(record.findings)) {
    errors.push('assessment_findings_required');
  } else {
    for (const finding of record.findings) {
      const findingErrors = validateTaskExecutabilityFinding(finding);
      if (findingErrors.length > 0) {
        errors.push(`assessment_finding_invalid:${findingErrors[0]}`);
        break;
      }
    }
  }
  errors.push(...validateTaskExecutabilityEvaluatorProvenance(record.evaluator));
  return errors;
}

/**
 * Mechanical verdict derivation from structured findings. Verdicts come only
 * from structured evidence — never from evaluator prose. Blocking spec-level
 * problems (unresolved references, undecided choices, unmapped acceptance
 * criteria, missing information, ambiguity) yield needs_revision; blocking
 * environment-level problems (unavailable authority or tools) yield
 * not_executable and dominate, because revising the task cannot fix the
 * environment. Evaluator execution failure is not a verdict input at all.
 */
export function deriveTaskExecutabilityVerdict(findings: TaskExecutabilityFinding[]): TaskExecutabilityVerdict {
  const blocking = findings.filter((finding) => finding.severity === 'blocking');
  if (blocking.some((finding) => finding.kind === 'unavailable_authority' || finding.kind === 'unavailable_tool')) {
    return 'not_executable';
  }
  if (blocking.length > 0) return 'needs_revision';
  return 'executable';
}

// ---------------------------------------------------------------------------
// One-shot override
// ---------------------------------------------------------------------------

/**
 * One-shot operator-authorized override admitting exactly one dispatch whose
 * fingerprint matches, durably audited. Overrides never rewrite the
 * assessment; consumed overrides cannot be reused.
 */
export interface TaskExecutabilityOverride {
  schema: typeof TASK_EXECUTABILITY_OVERRIDE_SCHEMA;
  override_id: string;
  task_id: string;
  task_spec_digest: string;
  dispatch_fingerprint: string;
  actor: string;
  reason: string;
  authority_basis: { kind: string; summary: string };
  created_at: string;
  consumed_at: string | null;
}

export function validateTaskExecutabilityOverride(doc: unknown): string[] {
  const errors: string[] = [];
  if (doc === null || typeof doc !== 'object' || Array.isArray(doc)) return ['override_not_an_object'];
  const record = doc as Record<string, unknown>;
  if (record.schema !== TASK_EXECUTABILITY_OVERRIDE_SCHEMA) errors.push('override_schema_mismatch');
  for (const field of ['override_id', 'task_id', 'task_spec_digest', 'dispatch_fingerprint', 'actor', 'reason', 'created_at']) {
    if (typeof record[field] !== 'string' || (record[field] as string).trim().length === 0) errors.push(`override_${field}_required`);
  }
  const basis = record.authority_basis as Record<string, unknown> | undefined;
  if (basis === null || typeof basis !== 'object' || typeof basis.kind !== 'string' || typeof basis.summary !== 'string') {
    errors.push('override_authority_basis_required');
  }
  if (record.consumed_at !== null && typeof record.consumed_at !== 'string') errors.push('override_consumed_at_invalid');
  return errors;
}

// ---------------------------------------------------------------------------
// Deterministic ids and dispatch fingerprints
// ---------------------------------------------------------------------------

/** Idempotent request id: one logical request per task + digests + profile. */
export function taskExecutabilityRequestId(args: {
  task_id: string;
  task_spec_digest: string;
  environment_digest: string;
  evaluator_profile: string;
  evaluator_profile_version: string;
}): string {
  return `texr_${sha256Hex(canonicalizeForDigest({ kind: 'request', ...args })).slice(0, 32)}`;
}

export function taskExecutabilityAssessmentId(args: { request_id: string; created_at: string }): string {
  return `texa_${sha256Hex(canonicalizeForDigest({ kind: 'assessment', ...args })).slice(0, 32)}`;
}

/**
 * Fingerprint of one concrete dispatch envelope. One-shot overrides are
 * scoped to this fingerprint so a changed dispatch cannot reuse an override
 * admitted for a different envelope.
 */
export function taskExecutabilityDispatchFingerprint(args: {
  task_id: string;
  task_spec_digest: string;
  environment_digest: string;
  workflow: string;
  site_id: string;
}): string {
  return `texd_${sha256Hex(canonicalizeForDigest({ kind: 'dispatch', ...args })).slice(0, 32)}`;
}

export function taskExecutabilityOverrideId(args: {
  task_id: string;
  dispatch_fingerprint: string;
  actor: string;
  created_at: string;
}): string {
  return `texo_${sha256Hex(canonicalizeForDigest({ kind: 'override', ...args })).slice(0, 32)}`;
}
