import assert from 'node:assert/strict';
import test from 'node:test';
import {
  TASK_EXECUTABILITY_ASSESSMENT_SCHEMA,
  TASK_EXECUTABILITY_DECLARED_ENVIRONMENT_SCHEMA,
  TASK_EXECUTABILITY_EVALUATOR_PROVENANCE_SCHEMA,
} from '@narada2/task-governance-core/task-executability-contract';
import {
  TaskExecutabilityOrchestrator,
  deterministicIdempotencyKey,
} from '../dist/index.js';

const requestBase = {
  request_id: 'texr_request_1',
  task_id: 'task_1',
  task_number: 1,
  task_spec_digest: 'spec_1',
  environment_digest: 'env_1',
  evaluator_profile: 'shoshin-v1',
  evaluator_profile_version: '1.0.0',
  attempt_count: 0,
  lease_owner: 'coordinator',
  lease_expires_at: '2099-01-01T00:00:00.000Z',
  task_packet: { task_id: 'task_1', objective: 'read only' },
  environment: {
    schema: TASK_EXECUTABILITY_DECLARED_ENVIRONMENT_SCHEMA,
    site_id: 'test-site',
    declared_authority: ['read'],
    declared_tools: [],
  },
};

function assessment(request = requestBase, overrides = {}) {
  return {
    schema: TASK_EXECUTABILITY_ASSESSMENT_SCHEMA,
    assessment_id: 'texa_assessment_1',
    request_id: request.request_id,
    task_id: request.task_id,
    task_number: request.task_number,
    task_spec_digest: request.task_spec_digest,
    environment_digest: request.environment_digest,
    verdict: 'executable',
    findings: [],
    evaluator: {
      schema: TASK_EXECUTABILITY_EVALUATOR_PROVENANCE_SCHEMA,
      profile: request.evaluator_profile,
      profile_version: request.evaluator_profile_version,
      cognition: 'low',
      provider: 'test-low-provider',
      model: 'test-low-model',
      ...overrides.evaluator,
    },
    created_at: '2026-07-19T00:00:00.000Z',
    ...overrides,
  };
}

class FakeLifecycle {
  constructor(request = requestBase) {
    this.request = structuredClone(request);
    this.dispatches = [];
    this.failures = [];
    this.completions = [];
    this.leases = 0;
  }

  async leaseNextExecutabilityRequest({ consumer_id }) {
    if (this.request.state === 'completed' || this.request.state === 'failed_terminal') return undefined;
    if (this.request.leased) {
      if (this.request.lease_owner !== consumer_id || this.request.state !== 'dispatched') return undefined;
      return structuredClone(this.request);
    }
    this.request.leased = true;
    this.request.lease_owner = consumer_id;
    this.request.state = 'leased';
    this.request.attempt_count += 1;
    this.request.lease_expires_at = '2099-01-01T00:00:00.000Z';
    this.leases += 1;
    return structuredClone(this.request);
  }

  async recordExecutabilityDispatch(args) {
    this.dispatches.push(args);
    this.request.state = args.state;
    this.request.latest_attempt = {
      delegated_task_id: args.delegated_task_id ?? null,
      worker_run_id: args.worker_run_id ?? null,
      state: args.state,
    };
  }

  async completeExecutabilityAssessment(args) {
    if (!this.request.leased || args.lease_owner !== this.request.lease_owner) return { status: 'stale', reason: 'lease_not_owned' };
    this.completions.push(args);
    this.request.leased = false;
    this.request.state = 'completed';
    return { status: 'completed' };
  }

  async failExecutabilityRequest(args) {
    this.failures.push(args);
    this.request.leased = false;
    this.request.state = args.state === 'failed_retryable' ? 'failed_retryable' : args.state;
    if (args.state === 'failed_retryable') this.request.lease_expires_at = '2020-01-01T00:00:00.000Z';
  }
}

class FakeDelegatedTask {
  constructor(results) {
    this.results = [...results];
    this.runCalls = [];
    this.pollCalls = [];
  }

  async run(args) {
    this.runCalls.push(args);
    return this.results.shift();
  }

  async poll(args) {
    this.pollCalls.push(args);
    return this.results.shift();
  }
}

test('uses one deterministic delegated request across concurrent coordinators', async () => {
  const lifecycle = new FakeLifecycle();
  const delegated = new FakeDelegatedTask([{ status: 'running', delegated_task_id: 'delegated_1' }]);
  const a = new TaskExecutabilityOrchestrator(lifecycle, delegated, { consumer_id: 'a' });
  const b = new TaskExecutabilityOrchestrator(lifecycle, delegated, { consumer_id: 'b' });
  const [first, second] = await Promise.all([a.reconcileOne(), b.reconcileOne()]);
  assert.equal(delegated.runCalls.length, 1);
  assert.equal(delegated.runCalls[0].idempotency_key, deterministicIdempotencyKey(requestBase.request_id));
  assert.deepEqual([first.outcome, second.outcome].sort(), ['dispatched', 'idle']);
  assert.equal(delegated.runCalls[0].constraints.authority, 'read');
  assert.equal(delegated.runCalls[0].constraints.cognition, 'low');
  assert.equal(delegated.runCalls[0].constraints.runtime, 'narada-agent-runtime-server');
  assert.equal(delegated.runCalls[0].constraints.write_set.length, 0);
});

test('polls a dispatched run and admits only matching structured output', async () => {
  const lifecycle = new FakeLifecycle();
  const delegated = new FakeDelegatedTask([
    { status: 'running', delegated_task_id: 'delegated_1', worker_run_id: 'worker_1' },
    { status: 'completed', delegated_task_id: 'delegated_1', worker_run_id: 'worker_1', output: assessment() },
  ]);
  const coordinator = new TaskExecutabilityOrchestrator(lifecycle, delegated, { consumer_id: 'a' });
  assert.equal((await coordinator.reconcileOne()).outcome, 'dispatched');
  assert.equal((await coordinator.reconcileOne()).outcome, 'completed');
  assert.equal(delegated.pollCalls[0].worker_run_id, 'worker_1');
  assert.equal(lifecycle.completions.length, 1);
});

test('keeps provider failures retryable, then bounds them terminally', async () => {
  const lifecycle = new FakeLifecycle();
  const delegated = new FakeDelegatedTask([
    { status: 'timed_out', error: { kind: 'timeout', message: 'worker timed out' } },
    { status: 'failed', error: { kind: 'provider', message: 'provider unavailable' } },
  ]);
  const coordinator = new TaskExecutabilityOrchestrator(lifecycle, delegated, { consumer_id: 'a', max_attempts: 2 });
  assert.equal((await coordinator.reconcileOne()).outcome, 'failed_retryable');
  assert.equal((await coordinator.reconcileOne()).outcome, 'failed_terminal');
  assert.equal(lifecycle.failures[0].state, 'failed_retryable');
  assert.equal(lifecycle.failures[1].state, 'failed_terminal');
});

test('rejects malformed and stale completions without admitting them', async () => {
  const malformedLifecycle = new FakeLifecycle();
  const malformed = new FakeDelegatedTask([{ status: 'completed', output: 'model prose' }]);
  const malformedCoordinator = new TaskExecutabilityOrchestrator(malformedLifecycle, malformed, { consumer_id: 'a' });
  assert.equal((await malformedCoordinator.reconcileOne()).outcome, 'failed_retryable');
  assert.equal(malformedLifecycle.completions.length, 0);

  const staleLifecycle = new FakeLifecycle();
  const stale = new FakeDelegatedTask([{ status: 'completed', output: assessment(requestBase, { task_spec_digest: 'old_spec' }) }]);
  const staleCoordinator = new TaskExecutabilityOrchestrator(staleLifecycle, stale, { consumer_id: 'a' });
  assert.equal((await staleCoordinator.reconcileOne()).outcome, 'stale_completion');
  assert.equal(staleLifecycle.completions.length, 0);
});

test('does not dispatch an expired lease', async () => {
  const lifecycle = new FakeLifecycle({ ...requestBase, lease_expires_at: '2020-01-01T00:00:00.000Z' });
  lifecycle.request.leased = true;
  lifecycle.request.state = 'dispatched';
  lifecycle.request.lease_owner = 'a';
  const delegated = new FakeDelegatedTask([]);
  const coordinator = new TaskExecutabilityOrchestrator(lifecycle, delegated, { consumer_id: 'a' });
  assert.equal((await coordinator.reconcileOne()).outcome, 'lease_expired');
  assert.equal(delegated.runCalls.length, 0);
  assert.equal(lifecycle.failures[0].failure.kind, 'lease_expired');
});
