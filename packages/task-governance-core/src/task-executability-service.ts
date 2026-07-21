/**
 * Task Executability service.
 *
 * Coordinates durable request/assessment/override state in Task Lifecycle with
 * the executability contract. This layer is pure logic: it never calls an
 * intelligence provider, never launches workers, and never invokes Delegated
 * Task or Worker Delegation. Assessments are admitted by callers (e.g. the
 * Task Lifecycle MCP complete tool) after Delegation runs the evaluator.
 */

import { basename } from 'node:path';
import type { TaskLifecycleStore, TaskExecutabilityRequestRow, TaskExecutabilityAssessmentRow } from './task-lifecycle-store.js';
import {
  TASK_EXECUTABILITY_ASSESSMENT_SCHEMA,
  TASK_EXECUTABILITY_DECLARED_ENVIRONMENT_SCHEMA,
  TASK_EXECUTABILITY_RESOLVED_POLICY_SCHEMA,
  canonicalizeForDigest,
  declaredEnvironmentDigest,
  deriveTaskExecutabilityVerdict,
  isAssessmentCurrent,
  resolveTaskExecutabilityPolicy,
  sha256Hex,
  taskExecutabilityAssessmentId,
  taskExecutabilityDispatchFingerprint,
  taskExecutabilityOverrideId,
  taskExecutabilityRequestId,
  taskSpecDigest,
  validateTaskExecutabilityAssessment,
  type ResolvedTaskExecutabilityPolicy,
  type TaskExecutabilityDeclaredEnvironment,
  type TaskExecutabilityFinding,
  type TaskExecutabilityRequestExecutionState,
  type TaskExecutabilityVerdict,
} from './task-executability-contract.js';

const DEFAULT_EVALUATOR_PROFILE_VERSION = '1.0.0';

export interface TaskExecutabilityPosture {
  policy: ResolvedTaskExecutabilityPolicy;
  request: TaskExecutabilityRequestRow | undefined;
  assessment: TaskExecutabilityAssessmentRow | undefined;
  currency: 'current' | 'stale' | 'superseded';
  verdict: TaskExecutabilityVerdict | undefined;
  findings: TaskExecutabilityFinding[] | undefined;
  executable: boolean;
  reason: string;
}

export interface TaskExecutabilityDispatchResult {
  executable: boolean;
  basis: 'assessment' | 'override' | 'none';
  assessment: TaskExecutabilityAssessmentRow | undefined;
  override_consumed?: boolean;
}

export interface TaskSpecDigestable {
  title: string;
  goal: string | null;
  context: string | null;
  required_work: string | null;
  non_goals: string | null;
  acceptance_criteria: string[];
  dependencies: number[];
}

export function assembleDeclaredEnvironment(
  siteRoot: string,
  env: Record<string, string | undefined> = process.env,
): TaskExecutabilityDeclaredEnvironment {
  return {
    schema: TASK_EXECUTABILITY_DECLARED_ENVIRONMENT_SCHEMA,
    site_id: env.NARADA_SITE_ID ?? basename(siteRoot),
    substrate: process.platform,
    variant: env.NARADA_SUBSTRATE_VARIANT,
    declared_tools: [],
    declared_authority: [],
  };
}

export function resolveEffectiveTaskExecutabilityPolicy(siteRoot: string): ResolvedTaskExecutabilityPolicy {
  return resolveTaskExecutabilityPolicy({
    targetSiteRoot: siteRoot,
    userSiteRoot: process.env.NARADA_USER_SITE_ROOT ?? null,
    hostSiteRoot: process.env.NARADA_HOST_SITE_ROOT ?? null,
  });
}

export function enqueueTaskExecutabilityRequest(args: {
  store: TaskLifecycleStore;
  siteRoot: string;
  taskId: string;
  taskNumber: number;
  spec: TaskSpecDigestable;
  environment?: TaskExecutabilityDeclaredEnvironment;
}): TaskExecutabilityRequestRow {
  const { store, siteRoot, taskId, taskNumber, spec } = args;
  const environment = args.environment ?? assembleDeclaredEnvironment(siteRoot);
  const policy = resolveEffectiveTaskExecutabilityPolicy(siteRoot);

  const taskSpecDigestValue = taskSpecDigest(spec);
  const environmentDigest = declaredEnvironmentDigest(environment);
  const evaluatorProfileVersion = DEFAULT_EVALUATOR_PROFILE_VERSION;
  const requestId = taskExecutabilityRequestId({
    task_id: taskId,
    task_spec_digest: taskSpecDigestValue,
    environment_digest: environmentDigest,
    evaluator_profile: policy.evaluator_profile,
    evaluator_profile_version: evaluatorProfileVersion,
  });

  const existing = store.getExecutabilityRequest(requestId);
  if (existing && existing.superseded_by_request_id === null) {
    return existing;
  }

  const now = new Date().toISOString();
  const request: TaskExecutabilityRequestRow = {
    request_id: requestId,
    task_id: taskId,
    task_number: taskNumber,
    state: 'pending',
    task_spec_digest: taskSpecDigestValue,
    environment_digest: environmentDigest,
    evaluator_profile: policy.evaluator_profile,
    evaluator_profile_version: evaluatorProfileVersion,
    assessment_id: null,
    lease_owner: null,
    lease_expires_at: null,
    attempt_count: 0,
    superseded_by_request_id: null,
    created_at: now,
    updated_at: now,
  };
  store.upsertExecutabilityRequest(request);

  // Supersede older in-flight requests for the same task whose identity differs.
  const older = store.listExecutabilityRequestsForTask(taskId, 100);
  for (const row of older) {
    if (row.request_id !== requestId && row.superseded_by_request_id === null) {
      store.upsertExecutabilityRequest({ ...row, superseded_by_request_id: requestId, updated_at: now });
    }
  }

  return store.getExecutabilityRequest(requestId) ?? request;
}

export function buildTaskExecutabilityPosture(args: {
  store: TaskLifecycleStore;
  taskId: string;
  currentSpecDigest: string;
  currentEnvDigest: string;
}): TaskExecutabilityPosture {
  const { store, taskId, currentSpecDigest, currentEnvDigest } = args;
  const policy = resolveEffectiveTaskExecutabilityPolicy('.');
  const requests = store.listExecutabilityRequestsForTask(taskId, 1);
  const request = requests[0];

  if (!request) {
    return {
      policy,
      request: undefined,
      assessment: undefined,
      currency: 'stale',
      verdict: undefined,
      findings: undefined,
      executable: false,
      reason: 'No executability request has been enqueued for this task.',
    };
  }

  const assessment = request.assessment_id
    ? store.getExecutabilityAssessment(request.assessment_id)
    : undefined;

  let currency: 'current' | 'stale' | 'superseded';
  if (request.superseded_by_request_id !== null) {
    currency = 'superseded';
  } else if (
    assessment &&
    isAssessmentCurrent({
      assessment,
      currentTaskSpecDigest: currentSpecDigest,
      currentEnvironmentDigest: currentEnvDigest,
    })
  ) {
    currency = 'current';
  } else {
    currency = 'stale';
  }

  const findings = assessment ? parseFindings(assessment.findings_json) : undefined;
  const verdict = currency === 'current' ? assessment?.verdict : undefined;
  const executable = currency === 'current' && verdict === 'executable';
  const reason = executable
    ? 'Current assessment verdict is executable.'
    : currency === 'superseded'
      ? 'Request was superseded by a newer request.'
      : currency === 'stale'
        ? 'Assessment is stale because the task spec or environment has changed.'
        : 'No current executable assessment is available.';

  return {
    policy,
    request,
    assessment,
    currency,
    verdict,
    findings,
    executable,
    reason,
  };
}

export function checkTaskExecutabilityDispatch(args: {
  store: TaskLifecycleStore;
  taskId: string;
  dispatchFingerprint: string;
  currentSpecDigest: string;
  currentEnvDigest: string;
}): TaskExecutabilityDispatchResult {
  const { store, taskId, dispatchFingerprint, currentSpecDigest, currentEnvDigest } = args;
  // The current request is the authority for which assessment may authorize
  // dispatch. Selecting by evaluator timestamp can resurrect a stale result
  // after a task-spec revision, especially when evaluator clocks tie or skew.
  const request = store.listExecutabilityRequestsForTask(taskId, 1)[0];
  const assessment = request?.superseded_by_request_id === null && request.assessment_id
    ? store.getExecutabilityAssessment(request.assessment_id)
    : undefined;

  if (
    assessment &&
    assessment.verdict === 'executable' &&
    isAssessmentCurrent({
      assessment,
      currentTaskSpecDigest: currentSpecDigest,
      currentEnvironmentDigest: currentEnvDigest,
    })
  ) {
    return { executable: true, basis: 'assessment', assessment };
  }

  const overrides = store.listExecutabilityOverridesForTask(taskId);
  const match = overrides.find(
    (override) =>
      override.consumed_at === null &&
      override.task_spec_digest === currentSpecDigest &&
      override.dispatch_fingerprint === dispatchFingerprint,
  );

  if (match) {
    const now = new Date().toISOString();
    store.consumeExecutabilityOverride(match.override_id, now);
    return { executable: true, basis: 'override', assessment, override_consumed: true };
  }

  return { executable: false, basis: 'none', assessment };
}

export function recordTaskExecutabilityFailure(args: {
  store: TaskLifecycleStore;
  requestId: string;
  failure: { kind: string; message: string; at?: string };
  state?: 'failed_retryable' | 'failed_terminal';
}): void {
  const { store, requestId, failure } = args;
  const state: TaskExecutabilityRequestExecutionState = args.state ?? 'failed_retryable';
  const failureJson = JSON.stringify({ ...failure, at: failure.at ?? new Date().toISOString() });
  store.failExecutabilityRequest(requestId, state, failureJson);
}

export function admitTaskExecutabilityAssessment(args: {
  store: TaskLifecycleStore;
  requestId: string;
  assessment: {
    assessment_id?: string;
    request_id: string;
    task_id: string;
    task_number: number;
    task_spec_digest: string;
    environment_digest: string;
    verdict: TaskExecutabilityVerdict;
    findings: TaskExecutabilityFinding[];
    evaluator: {
      schema?: string;
      profile: string;
      profile_version: string;
      cognition: 'low';
      provider?: string;
      model?: string;
      delegated_task_id?: string;
      worker_run_id?: string;
    };
    created_at: string;
  };
}): TaskExecutabilityAssessmentRow {
  const { store, requestId, assessment: input } = args;
  const assessmentId = input.assessment_id ??
    taskExecutabilityAssessmentId({ request_id: requestId, created_at: input.created_at });
  const errors = validateTaskExecutabilityAssessment({ ...input, assessment_id: assessmentId, schema: TASK_EXECUTABILITY_ASSESSMENT_SCHEMA });
  if (errors.length > 0) {
    throw new Error(`task_executability_assessment_invalid:${errors[0]}`);
  }

  const request = store.getExecutabilityRequest(requestId);
  if (!request) {
    throw new Error(`task_executability_request_not_found:${requestId}`);
  }
  if (request.task_spec_digest !== input.task_spec_digest || request.environment_digest !== input.environment_digest) {
    throw new Error('task_executability_assessment_digest_mismatch');
  }
  if (
    request.evaluator_profile !== input.evaluator.profile ||
    request.evaluator_profile_version !== input.evaluator.profile_version
  ) {
    throw new Error('task_executability_assessment_profile_mismatch');
  }

  const derivedVerdict = deriveTaskExecutabilityVerdict(input.findings);
  if (derivedVerdict !== input.verdict) {
    throw new Error(`task_executability_assessment_verdict_mismatch:derived=${derivedVerdict}:claimed=${input.verdict}`);
  }
  const row: TaskExecutabilityAssessmentRow = {
    assessment_id: assessmentId,
    request_id: requestId,
    task_id: input.task_id,
    task_number: input.task_number,
    task_spec_digest: input.task_spec_digest,
    environment_digest: input.environment_digest,
    verdict: input.verdict,
    findings_json: JSON.stringify(input.findings),
    evaluator_json: JSON.stringify(input.evaluator),
    created_at: input.created_at,
  };
  store.upsertExecutabilityAssessment(row);
  store.completeExecutabilityRequest(requestId, assessmentId);
  return row;
}

export function createExecutabilityOverride(args: {
  store: TaskLifecycleStore;
  taskId: string;
  taskSpecDigest: string;
  dispatchFingerprint: string;
  actor: string;
  reason: string;
  authorityBasis: { kind: string; summary: string };
}): { override_id: string } {
  const { store, taskId, taskSpecDigest, dispatchFingerprint, actor, reason, authorityBasis } = args;
  const now = new Date().toISOString();
  const overrideId = taskExecutabilityOverrideId({
    task_id: taskId,
    dispatch_fingerprint: dispatchFingerprint,
    actor,
    created_at: now,
  });
  store.upsertExecutabilityOverride({
    override_id: overrideId,
    task_id: taskId,
    task_spec_digest: taskSpecDigest,
    dispatch_fingerprint: dispatchFingerprint,
    actor,
    reason,
    authority_basis_json: JSON.stringify(authorityBasis),
    created_at: now,
    consumed_at: null,
  });
  return { override_id: overrideId };
}

export function computeDispatchFingerprint(args: {
  taskId: string;
  taskSpecDigest: string;
  environmentDigest: string;
  workflow?: string;
  siteId?: string;
}): string {
  return taskExecutabilityDispatchFingerprint({
    task_id: args.taskId,
    task_spec_digest: args.taskSpecDigest,
    environment_digest: args.environmentDigest,
    workflow: args.workflow ?? 'implement',
    site_id: args.siteId ?? assembleDeclaredEnvironment('.').site_id,
  });
}

function parseFindings(json: string): TaskExecutabilityFinding[] {
  try {
    return JSON.parse(json) as TaskExecutabilityFinding[];
  } catch {
    return [];
  }
}

// Re-export digest helpers that callers (MCP tools) need without importing the contract separately.
export {
  canonicalizeForDigest,
  declaredEnvironmentDigest,
  sha256Hex,
  taskSpecDigest,
  taskExecutabilityDispatchFingerprint,
  taskExecutabilityRequestId,
} from './task-executability-contract.js';
