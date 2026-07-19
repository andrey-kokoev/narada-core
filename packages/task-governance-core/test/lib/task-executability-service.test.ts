import { describe, expect, it, beforeEach } from 'vitest';
import Database from '../../src/sqlite-database.js';
import { SqliteTaskLifecycleStore, type TaskLifecycleRow } from '../../src/task-lifecycle-store.js';
import {
  TASK_EXECUTABILITY_FINDING_SCHEMA,
  TASK_EXECUTABILITY_RESOLVED_POLICY_SCHEMA,
  TASK_EXECUTABILITY_PRODUCT_DEFAULTS,
  TASK_EXECUTABILITY_EVALUATOR_PROVENANCE_SCHEMA,
  type TaskExecutabilityFinding,
} from '../../src/task-executability-contract.js';
import {
  admitTaskExecutabilityAssessment,
  assembleDeclaredEnvironment,
  buildTaskExecutabilityPosture,
  checkTaskExecutabilityDispatch,
  computeDispatchFingerprint,
  createExecutabilityOverride,
  enqueueTaskExecutabilityRequest,
  recordTaskExecutabilityFailure,
  resolveEffectiveTaskExecutabilityPolicy,
  taskSpecDigest,
  declaredEnvironmentDigest,
} from '../../src/task-executability-service.js';

const SPEC = {
  title: 'Do the thing',
  goal: 'goal',
  context: 'context',
  required_work: '1. step',
  non_goals: '- no',
  acceptance_criteria: ['a', 'b'],
  dependencies: [1, 2],
};

const ENV = {
  site_id: 'andrey-user',
  substrate: 'windows',
  variant: 'native',
  declared_tools: ['task_lifecycle_show'],
  declared_authority: ['read'],
};

function finding(kind: TaskExecutabilityFinding['kind'], severity: TaskExecutabilityFinding['severity']): TaskExecutabilityFinding {
  return { schema: TASK_EXECUTABILITY_FINDING_SCHEMA, kind, severity, code: `${kind}:x`, message: 'm' };
}

function evaluator(profile: string, profileVersion: string) {
  return {
    schema: TASK_EXECUTABILITY_EVALUATOR_PROVENANCE_SCHEMA,
    profile,
    profile_version: profileVersion,
    cognition: 'low' as const,
  };
}

describe('task-executability-service', () => {
  let db: Database;
  let store: SqliteTaskLifecycleStore;

  beforeEach(() => {
    db = new Database(':memory:');
    store = new SqliteTaskLifecycleStore({ db });
    store.initSchema();
    const lifecycle: TaskLifecycleRow = {
      task_id: 'task-exec-1',
      task_number: 901,
      status: 'opened',
      governed_by: null,
      closed_at: null,
      closed_by: null,
      reopened_at: null,
      reopened_by: null,
      continuation_packet_json: null,
      updated_at: '2026-07-19T12:00:00.000Z',
    };
    store.upsertLifecycle(lifecycle);
  });

  describe('assembleDeclaredEnvironment', () => {
    it('falls back to basename(siteRoot) when NARADA_SITE_ID is absent', () => {
      const env = assembleDeclaredEnvironment('/some/path/to/site');
      expect(env.site_id).toBe('site');
      expect(env.substrate).toBe(process.platform);
    });

    it('uses NARADA_SITE_ID and NARADA_SUBSTRATE_VARIANT when present', () => {
      const env = assembleDeclaredEnvironment('/some/path', {
        NARADA_SITE_ID: 'custom-site',
        NARADA_SUBSTRATE_VARIANT: 'wsl',
      });
      expect(env.site_id).toBe('custom-site');
      expect(env.variant).toBe('wsl');
      expect(env.declared_tools).toEqual([]);
      expect(env.declared_authority).toEqual([]);
    });
  });

  describe('resolveEffectiveTaskExecutabilityPolicy', () => {
    it('resolves product defaults when no policy files exist', () => {
      const policy = resolveEffectiveTaskExecutabilityPolicy('.');
      expect(policy.schema).toBe(TASK_EXECUTABILITY_RESOLVED_POLICY_SCHEMA);
      expect(policy.trigger).toBe(TASK_EXECUTABILITY_PRODUCT_DEFAULTS.trigger);
      expect(policy.enforcement).toBe(TASK_EXECUTABILITY_PRODUCT_DEFAULTS.enforcement);
      expect(policy.evaluator_profile).toBe(TASK_EXECUTABILITY_PRODUCT_DEFAULTS.evaluator_profile);
    });
  });

  describe('enqueueTaskExecutabilityRequest', () => {
    it('creates a pending request and returns it', () => {
      const request = enqueueTaskExecutabilityRequest({
        store,
        siteRoot: '.',
        taskId: 'task-exec-1',
        taskNumber: 901,
        spec: SPEC,
        environment: ENV,
      });
      expect(request.state).toBe('pending');
      expect(request.task_spec_digest).toBe(taskSpecDigest(SPEC));
      expect(request.environment_digest).toBe(declaredEnvironmentDigest(ENV));
      expect(store.getExecutabilityRequest(request.request_id)).toEqual(request);
    });

    it('is idempotent for identical spec and environment', () => {
      const first = enqueueTaskExecutabilityRequest({
        store,
        siteRoot: '.',
        taskId: 'task-exec-1',
        taskNumber: 901,
        spec: SPEC,
        environment: ENV,
      });
      const second = enqueueTaskExecutabilityRequest({
        store,
        siteRoot: '.',
        taskId: 'task-exec-1',
        taskNumber: 901,
        spec: SPEC,
        environment: ENV,
      });
      expect(second.request_id).toBe(first.request_id);
      expect(store.listExecutabilityRequestsForTask('task-exec-1')).toHaveLength(1);
    });

    it('supersedes older requests when the spec digest changes', () => {
      const first = enqueueTaskExecutabilityRequest({
        store,
        siteRoot: '.',
        taskId: 'task-exec-1',
        taskNumber: 901,
        spec: SPEC,
        environment: ENV,
      });
      const second = enqueueTaskExecutabilityRequest({
        store,
        siteRoot: '.',
        taskId: 'task-exec-1',
        taskNumber: 901,
        spec: { ...SPEC, title: 'Changed' },
        environment: ENV,
      });
      expect(second.request_id).not.toBe(first.request_id);
      const superseded = store.getExecutabilityRequest(first.request_id);
      expect(superseded!.superseded_by_request_id).toBe(second.request_id);
      const latest = store.listExecutabilityRequestsForTask('task-exec-1');
      expect(latest).toHaveLength(2);
      expect(latest[0]!.request_id).toBe(second.request_id);
    });
  });

  describe('buildTaskExecutabilityPosture', () => {
    it('reports stale when no assessment has been admitted', () => {
      const request = enqueueTaskExecutabilityRequest({
        store,
        siteRoot: '.',
        taskId: 'task-exec-1',
        taskNumber: 901,
        spec: SPEC,
        environment: ENV,
      });
      const posture = buildTaskExecutabilityPosture({
        store,
        taskId: 'task-exec-1',
        currentSpecDigest: request.task_spec_digest,
        currentEnvDigest: request.environment_digest,
      });
      expect(posture.request?.request_id).toBe(request.request_id);
      expect(posture.currency).toBe('stale');
      expect(posture.executable).toBe(false);
    });

    it('reports current and executable after an executable assessment is admitted', () => {
      const request = enqueueTaskExecutabilityRequest({
        store,
        siteRoot: '.',
        taskId: 'task-exec-1',
        taskNumber: 901,
        spec: SPEC,
        environment: ENV,
      });
      admitTaskExecutabilityAssessment({
        store,
        requestId: request.request_id,
        assessment: {
          request_id: request.request_id,
          task_id: 'task-exec-1',
          task_number: 901,
          task_spec_digest: request.task_spec_digest,
          environment_digest: request.environment_digest,
          verdict: 'executable',
          findings: [],
          evaluator: evaluator(request.evaluator_profile, request.evaluator_profile_version),
          created_at: '2026-07-19T12:05:00.000Z',
        },
      });
      const posture = buildTaskExecutabilityPosture({
        store,
        taskId: 'task-exec-1',
        currentSpecDigest: request.task_spec_digest,
        currentEnvDigest: request.environment_digest,
      });
      expect(posture.currency).toBe('current');
      expect(posture.verdict).toBe('executable');
      expect(posture.executable).toBe(true);
    });

    it('reports stale after the spec changes', () => {
      const request = enqueueTaskExecutabilityRequest({
        store,
        siteRoot: '.',
        taskId: 'task-exec-1',
        taskNumber: 901,
        spec: SPEC,
        environment: ENV,
      });
      admitTaskExecutabilityAssessment({
        store,
        requestId: request.request_id,
        assessment: {
          request_id: request.request_id,
          task_id: 'task-exec-1',
          task_number: 901,
          task_spec_digest: request.task_spec_digest,
          environment_digest: request.environment_digest,
          verdict: 'executable',
          findings: [],
          evaluator: evaluator(request.evaluator_profile, request.evaluator_profile_version),
          created_at: '2026-07-19T12:05:00.000Z',
        },
      });
      const posture = buildTaskExecutabilityPosture({
        store,
        taskId: 'task-exec-1',
        currentSpecDigest: 'changed-digest',
        currentEnvDigest: request.environment_digest,
      });
      expect(posture.currency).toBe('stale');
      expect(posture.executable).toBe(false);
    });
  });

  describe('checkTaskExecutabilityDispatch', () => {
    it('allows dispatch when the latest assessment is current and executable', () => {
      const request = enqueueTaskExecutabilityRequest({
        store,
        siteRoot: '.',
        taskId: 'task-exec-1',
        taskNumber: 901,
        spec: SPEC,
        environment: ENV,
      });
      admitTaskExecutabilityAssessment({
        store,
        requestId: request.request_id,
        assessment: {
          request_id: request.request_id,
          task_id: 'task-exec-1',
          task_number: 901,
          task_spec_digest: request.task_spec_digest,
          environment_digest: request.environment_digest,
          verdict: 'executable',
          findings: [],
          evaluator: evaluator(request.evaluator_profile, request.evaluator_profile_version),
          created_at: '2026-07-19T12:05:00.000Z',
        },
      });
      const fingerprint = computeDispatchFingerprint({
        taskId: 'task-exec-1',
        taskSpecDigest: request.task_spec_digest,
        environmentDigest: request.environment_digest,
      });
      const result = checkTaskExecutabilityDispatch({
        store,
        taskId: 'task-exec-1',
        dispatchFingerprint: fingerprint,
        currentSpecDigest: request.task_spec_digest,
        currentEnvDigest: request.environment_digest,
      });
      expect(result.executable).toBe(true);
      expect(result.basis).toBe('assessment');
    });

    it('allows dispatch by consuming a matching one-shot override', () => {
      const request = enqueueTaskExecutabilityRequest({
        store,
        siteRoot: '.',
        taskId: 'task-exec-1',
        taskNumber: 901,
        spec: SPEC,
        environment: ENV,
      });
      const fingerprint = computeDispatchFingerprint({
        taskId: 'task-exec-1',
        taskSpecDigest: request.task_spec_digest,
        environmentDigest: request.environment_digest,
      });
      createExecutabilityOverride({
        store,
        taskId: 'task-exec-1',
        taskSpecDigest: request.task_spec_digest,
        dispatchFingerprint: fingerprint,
        actor: 'operator',
        reason: 'emergency',
        authorityBasis: { kind: 'operator_direct', summary: 'Override' },
      });
      const result = checkTaskExecutabilityDispatch({
        store,
        taskId: 'task-exec-1',
        dispatchFingerprint: fingerprint,
        currentSpecDigest: request.task_spec_digest,
        currentEnvDigest: request.environment_digest,
      });
      expect(result.executable).toBe(true);
      expect(result.basis).toBe('override');
      expect(result.override_consumed).toBe(true);
    });

    it('rejects dispatch when no executable assessment or override exists', () => {
      const request = enqueueTaskExecutabilityRequest({
        store,
        siteRoot: '.',
        taskId: 'task-exec-1',
        taskNumber: 901,
        spec: SPEC,
        environment: ENV,
      });
      const fingerprint = computeDispatchFingerprint({
        taskId: 'task-exec-1',
        taskSpecDigest: request.task_spec_digest,
        environmentDigest: request.environment_digest,
      });
      const result = checkTaskExecutabilityDispatch({
        store,
        taskId: 'task-exec-1',
        dispatchFingerprint: fingerprint,
        currentSpecDigest: request.task_spec_digest,
        currentEnvDigest: request.environment_digest,
      });
      expect(result.executable).toBe(false);
      expect(result.basis).toBe('none');
    });
  });

  describe('recordTaskExecutabilityFailure', () => {
    it('records a retryable failure on a request', () => {
      const request = enqueueTaskExecutabilityRequest({
        store,
        siteRoot: '.',
        taskId: 'task-exec-1',
        taskNumber: 901,
        spec: SPEC,
        environment: ENV,
      });
      recordTaskExecutabilityFailure({
        store,
        requestId: request.request_id,
        failure: { kind: 'evaluator_timeout', message: 'timed out' },
      });
      const failed = store.getExecutabilityRequest(request.request_id);
      expect(failed!.state).toBe('failed_retryable');
    });

    it('rejects a verdict that does not mechanically derive from findings', () => {
      const request = enqueueTaskExecutabilityRequest({
        store,
        siteRoot: '.',
        taskId: 'task-exec-1',
        taskNumber: 901,
        spec: SPEC,
        environment: ENV,
      });
      expect(() =>
        admitTaskExecutabilityAssessment({
          store,
          requestId: request.request_id,
          assessment: {
            request_id: request.request_id,
            task_id: 'task-exec-1',
            task_number: 901,
            task_spec_digest: request.task_spec_digest,
            environment_digest: request.environment_digest,
            verdict: 'executable',
            findings: [finding('unresolved_reference', 'blocking')],
            evaluator: evaluator(request.evaluator_profile, request.evaluator_profile_version),
            created_at: '2026-07-19T12:05:00.000Z',
          },
        }),
      ).toThrow('verdict_mismatch');
    });
  });
});
