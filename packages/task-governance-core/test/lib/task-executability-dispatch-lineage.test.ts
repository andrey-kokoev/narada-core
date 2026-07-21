import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import Database from '../../src/sqlite-database.js';
import { SqliteTaskLifecycleStore, type TaskLifecycleRow } from '../../src/task-lifecycle-store.js';
import {
  TASK_EXECUTABILITY_EVALUATOR_PROVENANCE_SCHEMA,
} from '../../src/task-executability-contract.js';
import {
  admitTaskExecutabilityAssessment,
  checkTaskExecutabilityDispatch,
  computeDispatchFingerprint,
  enqueueTaskExecutabilityRequest,
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

function evaluator(profile: string, profileVersion: string) {
  return {
    schema: TASK_EXECUTABILITY_EVALUATOR_PROVENANCE_SCHEMA,
    profile,
    profile_version: profileVersion,
    cognition: 'low' as const,
  };
}

describe('task executability dispatch request lineage', () => {
  let db: Database;
  let store: SqliteTaskLifecycleStore;

  beforeEach(() => {
    db = new Database(':memory:');
    store = new SqliteTaskLifecycleStore({ db });
    store.initSchema();
    const lifecycle: TaskLifecycleRow = {
      task_id: 'task-exec-lineage',
      task_number: 1901,
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

  afterEach(() => {
    db.close();
  });

  it('uses the current request assessment instead of timestamp-sorted stale assessment', () => {
    const initial = enqueueTaskExecutabilityRequest({
      store,
      siteRoot: '.',
      taskId: 'task-exec-lineage',
      taskNumber: 1901,
      spec: SPEC,
      environment: ENV,
    });
    admitTaskExecutabilityAssessment({
      store,
      requestId: initial.request_id,
      assessment: {
        request_id: initial.request_id,
        task_id: 'task-exec-lineage',
        task_number: 1901,
        task_spec_digest: initial.task_spec_digest,
        environment_digest: initial.environment_digest,
        verdict: 'executable',
        findings: [],
        evaluator: evaluator(initial.evaluator_profile, initial.evaluator_profile_version),
        created_at: '2026-07-19T12:10:00.000Z',
      },
    });

    const revised = enqueueTaskExecutabilityRequest({
      store,
      siteRoot: '.',
      taskId: 'task-exec-lineage',
      taskNumber: 1901,
      spec: { ...SPEC, title: 'Changed' },
      environment: ENV,
    });

    // Request chronology is explicit; evaluator timestamps are intentionally
    // skewed so a timestamp-only assessment lookup would choose the stale row.
    db.prepare('update task_executability_requests set created_at = ?, updated_at = ? where request_id = ?')
      .run('2026-07-19T12:00:00.000Z', '2026-07-19T12:00:00.000Z', initial.request_id);
    db.prepare('update task_executability_requests set created_at = ?, updated_at = ? where request_id = ?')
      .run('2026-07-19T12:01:00.000Z', '2026-07-19T12:01:00.000Z', revised.request_id);

    admitTaskExecutabilityAssessment({
      store,
      requestId: revised.request_id,
      assessment: {
        request_id: revised.request_id,
        task_id: 'task-exec-lineage',
        task_number: 1901,
        task_spec_digest: revised.task_spec_digest,
        environment_digest: revised.environment_digest,
        verdict: 'executable',
        findings: [],
        evaluator: evaluator(revised.evaluator_profile, revised.evaluator_profile_version),
        created_at: '2026-07-19T12:05:00.000Z',
      },
    });

    const fingerprint = computeDispatchFingerprint({
      taskId: 'task-exec-lineage',
      taskSpecDigest: revised.task_spec_digest,
      environmentDigest: revised.environment_digest,
    });
    const result = checkTaskExecutabilityDispatch({
      store,
      taskId: 'task-exec-lineage',
      dispatchFingerprint: fingerprint,
      currentSpecDigest: revised.task_spec_digest,
      currentEnvDigest: revised.environment_digest,
    });

    expect(result.executable).toBe(true);
    expect(result.basis).toBe('assessment');
    expect(result.assessment?.request_id).toBe(revised.request_id);
    expect(result.assessment?.task_spec_digest).toBe(revised.task_spec_digest);
  });
});
