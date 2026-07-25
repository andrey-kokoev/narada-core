import {
  TASK_EXECUTABILITY_ASSESSMENT_SCHEMA,
  validateTaskExecutabilityAssessment,
  type TaskExecutabilityAssessment,
  type TaskExecutabilityDeclaredEnvironment,
} from '@narada2/task-governance-core/task-executability-contract';

export const TASK_EXECUTABILITY_ORCHESTRATOR_SCHEMA = 'narada.task.executability.orchestrator.v1' as const;
export const TASK_EXECUTABILITY_OUTPUT_SCHEMA = TASK_EXECUTABILITY_ASSESSMENT_SCHEMA;

export type OrchestratorRunStatus = 'accepted' | 'running' | 'completed' | 'failed' | 'timed_out';
export type ReconcileOutcome =
  | 'idle'
  | 'dispatched'
  | 'pending'
  | 'completed'
  | 'failed_retryable'
  | 'failed_terminal'
  | 'stale_completion'
  | 'lease_expired';

export interface TaskExecutabilityRequest {
  request_id: string;
  task_id: string;
  task_number: number;
  task_spec_digest: string;
  environment_digest: string;
  evaluator_profile: string;
  evaluator_profile_version: string;
  attempt_count: number;
  lease_owner: string;
  lease_expires_at: string;
  /** Canonical task packet assembled by the Task Lifecycle adapter. */
  task_packet: unknown;
  /** Declared environment assembled by the Task Lifecycle adapter. */
  environment: TaskExecutabilityDeclaredEnvironment;
  latest_attempt?: {
    delegated_task_id?: string | null;
    worker_run_id?: string | null;
    state: 'dispatched' | 'completed' | 'failed_retryable' | 'failed_terminal';
  };
}

export interface TaskLifecyclePort {
  /** Atomically lease one pending or recoverable request for this coordinator. */
  leaseNextExecutabilityRequest(args: {
    consumer_id: string;
    lease_duration_minutes: number;
  }): Promise<TaskExecutabilityRequest | undefined>;
  /** Persist delegated-task/run provenance and the request execution state. */
  recordExecutabilityDispatch(args: {
    request_id: string;
    state: 'dispatched' | 'completed' | 'failed_retryable' | 'failed_terminal';
    delegated_task_id?: string | null;
    worker_run_id?: string | null;
    error?: { kind: string; message: string };
  }): Promise<void>;
  /** Admit only a current, lease-owned assessment. The adapter rejects stale completions. */
  completeExecutabilityAssessment(args: {
    request_id: string;
    lease_owner: string;
    lease_expires_at: string;
    assessment: TaskExecutabilityAssessment;
  }): Promise<{ status: 'completed' | 'stale' | 'rejected'; reason?: string }>;
  /** Record execution failure separately from the evaluator's task verdict. */
  failExecutabilityRequest(args: {
    request_id: string;
    lease_owner: string;
    state: 'failed_retryable' | 'failed_terminal';
    failure: { kind: string; message: string };
  }): Promise<void>;
}

export interface DelegatedTaskPort {
  run(args: DelegatedTaskInvocation): Promise<DelegatedTaskResult>;
  poll(args: DelegatedTaskPoll): Promise<DelegatedTaskResult>;
}

export interface DelegatedTaskInvocation {
  idempotency_key: string;
  task_id: string;
  task_number: number;
  task_packet: unknown;
  environment: TaskExecutabilityDeclaredEnvironment;
  evaluator_profile: string;
  evaluator_profile_version: string;
  output_contract: {
    schema: typeof TASK_EXECUTABILITY_OUTPUT_SCHEMA;
    structured_output_key: 'task_executability_assessment_v1';
    strict: true;
  };
  constraints: {
    authority: 'read';
    cognition: 'low';
    runtime: 'narada-agent-runtime-server';
    max_worker_runs: 1;
    max_run_ms: number;
    max_retries: 0;
    write_set: [];
  };
}

export interface DelegatedTaskPoll {
  idempotency_key: string;
  delegated_task_id?: string | null;
  worker_run_id?: string | null;
}

export interface DelegatedTaskResult {
  status: OrchestratorRunStatus;
  delegated_task_id?: string | null;
  worker_run_id?: string | null;
  /** Structured assessment returned by Delegated Task. Prose is never consumed. */
  output?: unknown;
  error?: { kind: string; message: string };
}

export interface TaskExecutabilityOrchestratorOptions {
  consumer_id: string;
  lease_duration_minutes?: number;
  max_attempts?: number;
  max_run_ms?: number;
  now?: () => Date;
}

export interface ReconcileResult {
  schema: typeof TASK_EXECUTABILITY_ORCHESTRATOR_SCHEMA;
  outcome: ReconcileOutcome;
  request_id?: string;
  idempotency_key?: string;
  delegated_task_id?: string | null;
  worker_run_id?: string | null;
  assessment?: TaskExecutabilityAssessment;
  reason?: string;
}

export interface ReconcileBatchResult {
  schema: typeof TASK_EXECUTABILITY_ORCHESTRATOR_SCHEMA;
  results: ReconcileResult[];
  stopped: 'limit' | 'idle';
}

/**
 * Coordinates Task Lifecycle and Delegated Task without owning either one.
 * Both adapters are injected, which keeps this package usable by NARS and
 * Site Loop while keeping storage, provider, and cadence concerns outside it.
 */
export class TaskExecutabilityOrchestrator {
  readonly #lifecycle: TaskLifecyclePort;
  readonly #delegatedTask: DelegatedTaskPort;
  readonly #consumerId: string;
  readonly #leaseDurationMinutes: number;
  readonly #maxAttempts: number;
  readonly #maxRunMs: number;
  readonly #now: () => Date;

  constructor(
    lifecycle: TaskLifecyclePort,
    delegatedTask: DelegatedTaskPort,
    options: TaskExecutabilityOrchestratorOptions,
  ) {
    if (!options.consumer_id.trim()) throw new Error('task_executability_consumer_id_required');
    if (!Number.isInteger(options.lease_duration_minutes ?? 10) || (options.lease_duration_minutes ?? 10) < 1) {
      throw new Error('task_executability_lease_duration_invalid');
    }
    if (!Number.isInteger(options.max_attempts ?? 3) || (options.max_attempts ?? 3) < 1) {
      throw new Error('task_executability_max_attempts_invalid');
    }
    if (!Number.isInteger(options.max_run_ms ?? 120000) || (options.max_run_ms ?? 120000) < 1) {
      throw new Error('task_executability_max_run_ms_invalid');
    }
    this.#lifecycle = lifecycle;
    this.#delegatedTask = delegatedTask;
    this.#consumerId = options.consumer_id;
    this.#leaseDurationMinutes = options.lease_duration_minutes ?? 10;
    this.#maxAttempts = options.max_attempts ?? 3;
    this.#maxRunMs = options.max_run_ms ?? 120000;
    this.#now = options.now ?? (() => new Date());
  }

  async reconcileOne(): Promise<ReconcileResult> {
    const request = await this.#lifecycle.leaseNextExecutabilityRequest({
      consumer_id: this.#consumerId,
      lease_duration_minutes: this.#leaseDurationMinutes,
    });
    if (!request) return { schema: TASK_EXECUTABILITY_ORCHESTRATOR_SCHEMA, outcome: 'idle' };

    const idempotencyKey = deterministicIdempotencyKey(request.request_id);
    if (this.#now().getTime() >= Date.parse(request.lease_expires_at)) {
      await this.#recordFailure(request, 'lease_expired', 'Task Lifecycle lease expired before reconciliation.', 'failed_retryable');
      return this.#result(request, idempotencyKey, 'lease_expired', 'lease_expired');
    }

    const existing = request.latest_attempt;
    const shouldPoll = Boolean(existing?.delegated_task_id || existing?.worker_run_id);
    if (!shouldPoll && request.attempt_count >= this.#maxAttempts) {
      await this.#recordFailure(request, 'max_attempts_exhausted', `Maximum attempts exceeded: ${this.#maxAttempts}.`, 'failed_terminal');
      return this.#result(request, idempotencyKey, 'failed_terminal', 'max_attempts_exhausted');
    }

    let delegatedResult: DelegatedTaskResult;
    try {
      delegatedResult = shouldPoll
        ? await this.#delegatedTask.poll({
          idempotency_key: idempotencyKey,
          delegated_task_id: existing?.delegated_task_id,
          worker_run_id: existing?.worker_run_id,
        })
        : await this.#delegatedTask.run(this.#invocation(request, idempotencyKey));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const state = request.attempt_count >= this.#maxAttempts ? 'failed_terminal' : 'failed_retryable';
      await this.#recordFailure(request, 'delegated_task_error', message, state);
      return this.#result(request, idempotencyKey, state, message);
    }

    const delegatedTaskId = delegatedResult.delegated_task_id ?? existing?.delegated_task_id ?? null;
    const workerRunId = delegatedResult.worker_run_id ?? existing?.worker_run_id ?? null;
    if (delegatedResult.status === 'accepted' || delegatedResult.status === 'running') {
      if (!delegatedTaskId && !workerRunId) {
        const state = request.attempt_count >= this.#maxAttempts ? 'failed_terminal' : 'failed_retryable';
        await this.#recordFailure(request, 'delegated_task_identity_missing', 'Running delegation returned no task or worker identity.', state);
        return this.#result(request, idempotencyKey, state, 'delegated_task_identity_missing');
      }
      await this.#lifecycle.recordExecutabilityDispatch({
        request_id: request.request_id,
        state: 'dispatched',
        delegated_task_id: delegatedTaskId,
        worker_run_id: workerRunId,
      });
      return this.#result(request, idempotencyKey, shouldPoll ? 'pending' : 'dispatched', undefined, delegatedTaskId, workerRunId);
    }

    if (delegatedResult.status === 'failed' || delegatedResult.status === 'timed_out') {
      const state = request.attempt_count >= this.#maxAttempts ? 'failed_terminal' : 'failed_retryable';
      const message = delegatedResult.error?.message ?? `Delegated task ${delegatedResult.status}.`;
      await this.#recordFailure(request, delegatedResult.status, message, state, delegatedTaskId, workerRunId);
      return this.#result(request, idempotencyKey, state, message, delegatedTaskId, workerRunId);
    }

    const assessment = normalizeAssessment(delegatedResult.output, request);
    if (!assessment.ok) {
      if (assessment.kind === 'stale_completion') {
        return this.#result(request, idempotencyKey, 'stale_completion', assessment.message, delegatedTaskId, workerRunId);
      }
      const state = request.attempt_count >= this.#maxAttempts ? 'failed_terminal' : 'failed_retryable';
      await this.#recordFailure(request, assessment.kind, assessment.message, state, delegatedTaskId, workerRunId);
      return this.#result(request, idempotencyKey, state, assessment.message, delegatedTaskId, workerRunId);
    }

    const completion = await this.#lifecycle.completeExecutabilityAssessment({
      request_id: request.request_id,
      lease_owner: request.lease_owner,
      lease_expires_at: request.lease_expires_at,
      assessment: assessment.value,
    });
    if (completion.status === 'stale') {
      return this.#result(request, idempotencyKey, 'stale_completion', completion.reason ?? 'stale_completion', delegatedTaskId, workerRunId);
    }
    if (completion.status === 'rejected') {
      return this.#result(request, idempotencyKey, 'stale_completion', completion.reason ?? 'assessment_rejected', delegatedTaskId, workerRunId);
    }
    await this.#lifecycle.recordExecutabilityDispatch({
      request_id: request.request_id,
      state: 'completed',
      delegated_task_id: delegatedTaskId,
      worker_run_id: workerRunId,
    });
    return this.#result(request, idempotencyKey, 'completed', undefined, delegatedTaskId, workerRunId, assessment.value);
  }

  async reconcileAll(limit = 1): Promise<ReconcileBatchResult> {
    if (!Number.isInteger(limit) || limit < 1) throw new Error('task_executability_reconcile_limit_invalid');
    const results: ReconcileResult[] = [];
    for (let index = 0; index < limit; index += 1) {
      const result = await this.reconcileOne();
      results.push(result);
      if (result.outcome === 'idle') return { schema: TASK_EXECUTABILITY_ORCHESTRATOR_SCHEMA, results, stopped: 'idle' };
    }
    return { schema: TASK_EXECUTABILITY_ORCHESTRATOR_SCHEMA, results, stopped: 'limit' };
  }

  #invocation(request: TaskExecutabilityRequest, idempotencyKey: string): DelegatedTaskInvocation {
    return {
      idempotency_key: idempotencyKey,
      task_id: request.task_id,
      task_number: request.task_number,
      task_packet: request.task_packet,
      environment: request.environment,
      evaluator_profile: request.evaluator_profile,
      evaluator_profile_version: request.evaluator_profile_version,
      output_contract: {
        schema: TASK_EXECUTABILITY_OUTPUT_SCHEMA,
        structured_output_key: 'task_executability_assessment_v1',
        strict: true,
      },
      constraints: {
        authority: 'read',
        cognition: 'low',
        runtime: 'narada-agent-runtime-server',
        max_worker_runs: 1,
        max_run_ms: this.#maxRunMs,
        max_retries: 0,
        write_set: [],
      },
    };
  }

  async #recordFailure(
    request: TaskExecutabilityRequest,
    kind: string,
    message: string,
    state: 'failed_retryable' | 'failed_terminal',
    delegatedTaskId: string | null = null,
    workerRunId: string | null = null,
  ): Promise<void> {
    await this.#lifecycle.recordExecutabilityDispatch({
      request_id: request.request_id,
      state,
      delegated_task_id: delegatedTaskId,
      worker_run_id: workerRunId,
      error: { kind, message },
    });
    await this.#lifecycle.failExecutabilityRequest({
      request_id: request.request_id,
      lease_owner: request.lease_owner,
      state,
      failure: { kind, message },
    });
  }

  #result(
    request: TaskExecutabilityRequest,
    idempotencyKey: string,
    outcome: ReconcileOutcome,
    reason?: string,
    delegatedTaskId: string | null = null,
    workerRunId: string | null = null,
    assessment?: TaskExecutabilityAssessment,
  ): ReconcileResult {
    return {
      schema: TASK_EXECUTABILITY_ORCHESTRATOR_SCHEMA,
      outcome,
      request_id: request.request_id,
      idempotency_key: idempotencyKey,
      delegated_task_id: delegatedTaskId,
      worker_run_id: workerRunId,
      ...(assessment ? { assessment } : {}),
      ...(reason ? { reason } : {}),
    };
  }
}

export function deterministicIdempotencyKey(requestId: string): string {
  if (!requestId.trim()) throw new Error('task_executability_request_id_required');
  return `task-executability-assessment:${requestId}`;
}

type NormalizedAssessment =
  | { ok: true; value: TaskExecutabilityAssessment }
  | { ok: false; kind: 'malformed_result' | 'stale_completion'; message: string };

function normalizeAssessment(output: unknown, request: TaskExecutabilityRequest): NormalizedAssessment {
  const errors = validateTaskExecutabilityAssessment(output);
  if (errors.length > 0) return { ok: false, kind: 'malformed_result', message: `Invalid structured assessment: ${errors.join(',')}` };
  const assessment = output as TaskExecutabilityAssessment;
  if (
    assessment.request_id !== request.request_id ||
    assessment.task_id !== request.task_id ||
    assessment.task_number !== request.task_number ||
    assessment.task_spec_digest !== request.task_spec_digest ||
    assessment.environment_digest !== request.environment_digest
  ) {
    return { ok: false, kind: 'stale_completion', message: 'Assessment does not match the leased request identity or digests.' };
  }
  return { ok: true, value: assessment };
}
