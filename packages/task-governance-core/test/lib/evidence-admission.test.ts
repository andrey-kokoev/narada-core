import { vi } from 'vitest';

vi.unmock('node:fs');
vi.unmock('node:fs/promises');

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { admitTaskEvidence } from '../../src/evidence-admission.js';
import { openTaskLifecycleStore } from '../../src/task-lifecycle-store.js';
import { evaluateTaskDependencySatisfaction } from '../../src/task-dependency-satisfaction.js';

describe('evidence admission', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'narada-evidence-admission-'));
    mkdirSync(join(tempDir, '.ai'), { recursive: true });
    mkdirSync(join(tempDir, '.ai', 'do-not-open', 'tasks'), { recursive: true });
    writeFileSync(
      join(tempDir, '.ai', 'do-not-open', 'tasks', '20260425-653-evidence.md'),
      [
        '---',
        'status: in_review',
        '---',
        '',
        '# Task 653',
        '',
        '## Acceptance Criteria',
        '',
        '- [x] Durable evidence exists.',
        '',
      ].join('\n'),
    );
    const store = openTaskLifecycleStore(tempDir);
    try {
      store.upsertLifecycle({
        task_id: '20260425-653-evidence',
        task_number: 653,
        status: 'in_review',
        governed_by: null,
        closed_at: null,
        closed_by: null,
        reopened_at: null,
        reopened_by: null,
        continuation_packet_json: null,
        updated_at: '2026-04-25T12:00:00.000Z',
      });
      store.upsertReportRecord({
        report_id: 'r1',
        task_id: '20260425-653-evidence',
        assignment_id: 'a1',
        agent_id: 'agent',
        reported_at: '2026-04-25T12:01:00.000Z',
        report_json: JSON.stringify({ changed_files: ['x.ts'], residuals: [] }),
      });
      store.insertVerificationRun({
        run_id: 'v1',
        request_id: 'req1',
        task_id: '20260425-653-evidence',
        target_command: 'pnpm test',
        scope: 'focused',
        timeout_seconds: 120,
        requester_identity: 'agent',
        requested_at: '2026-04-25T12:02:00.000Z',
        status: 'passed',
        exit_code: 0,
        duration_ms: 10,
        metrics_json: null,
        stdout_digest: null,
        stderr_digest: null,
        stdout_excerpt: null,
        stderr_excerpt: null,
        completed_at: '2026-04-25T12:02:10.000Z',
      });
    } finally {
      store.db.close();
    }
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    } catch (error) {
      if ((error as { code?: string }).code !== 'EBUSY') {
        throw error;
      }
    }
  });

  it('admits report plus TIZ verification without requiring review', async () => {
    const admission = await admitTaskEvidence({
      cwd: tempDir,
      taskNumber: 653,
      admittedBy: 'agent',
      methods: ['report', 'verification_run'],
    });

    expect(admission.result.verdict).toBe('admitted');
    expect(JSON.parse(admission.bundle.verification_run_ids_json)).toEqual(['v1']);
    expect(JSON.parse(admission.result.confirmation_json).observation_output_counted).toBe(false);
  });

  it('rejects unchecked criteria', async () => {
    writeFileSync(
      join(tempDir, '.ai', 'do-not-open', 'tasks', '20260425-653-evidence.md'),
      '---\nstatus: in_review\n---\n\n# Task 653\n\n## Acceptance Criteria\n\n- [ ] Durable evidence exists.\n',
    );

    const admission = await admitTaskEvidence({
      cwd: tempDir,
      taskNumber: 653,
      admittedBy: 'agent',
      methods: ['report'],
    });

    expect(admission.result.verdict).toBe('rejected');
    expect(admission.blockers.join(' ')).toContain('acceptance criteria');
  });

  it('admits review-gated evidence from satisfied dependency outcome without review rows', async () => {
    const store = openTaskLifecycleStore(tempDir);
    try {
      store.upsertLifecycle({
        task_id: '20260425-654-review-evidence',
        task_number: 654,
        status: 'closed',
        governed_by: 'review',
        closed_at: '2026-04-25T12:05:00.000Z',
        closed_by: 'reviewer',
        closure_mode: 'peer_reviewed',
        reopened_at: null,
        reopened_by: null,
        continuation_packet_json: null,
        updated_at: '2026-04-25T12:05:00.000Z',
      });
      store.upsertTaskDependency({
        dependency_id: 'dep-review-653-654',
        parent_task_id: '20260425-653-evidence',
        required_task_id: '20260425-654-review-evidence',
        kind: 'review',
        satisfying_outcomes_json: JSON.stringify(['accepted', 'accepted_with_notes']),
        status: 'open',
        created_by: 'agent',
        created_at: '2026-04-25T12:03:00.000Z',
      });
      store.upsertTaskOutcomeContract({
        contract_id: 'contract-review-654',
        task_id: '20260425-654-review-evidence',
        outcome_type: 'review',
        allowed_outcomes_json: JSON.stringify(['accepted', 'accepted_with_notes', 'rejected']),
        satisfying_outcomes_json: JSON.stringify(['accepted', 'accepted_with_notes']),
        blocking_outcomes_json: JSON.stringify(['rejected']),
        required_fields_json: JSON.stringify(['summary']),
        capability_requirement: 'review',
        created_by: 'agent',
        created_at: '2026-04-25T12:03:00.000Z',
      });
      store.insertTaskOutcome({
        outcome_id: 'outcome-review-654',
        task_id: '20260425-654-review-evidence',
        contract_id: 'contract-review-654',
        agent_id: 'reviewer',
        outcome: 'accepted',
        summary: 'Dependency review accepted.',
        findings_json: JSON.stringify([]),
        evidence_refs_json: JSON.stringify([]),
        admitted_at: '2026-04-25T12:04:00.000Z',
      });
      expect(store.listReviews('20260425-653-evidence')).toEqual([]);
    } finally {
      store.db.close();
    }

    const admission = await admitTaskEvidence({
      cwd: tempDir,
      taskNumber: 653,
      admittedBy: 'agent',
      methods: ['review'],
      requireReview: true,
    });

    const confirmation = JSON.parse(admission.result.confirmation_json);
    expect(admission.result.verdict).toBe('admitted');
    expect(confirmation.latest_review_id).toBe(null);
    expect(confirmation.dependency_satisfaction.all_satisfied).toBe(true);
    expect(confirmation.dependency_satisfaction.dependencies[0].required_outcome_id).toBe('outcome-review-654');
  });

  it('treats accepted disposition as satisfying a blocking dependency outcome', () => {
    const store = openTaskLifecycleStore(tempDir);
    try {
      store.upsertLifecycle({
        task_id: '20260425-655-review-evidence',
        task_number: 655,
        status: 'closed',
        governed_by: 'review',
        closed_at: '2026-04-25T12:05:00.000Z',
        closed_by: 'reviewer',
        closure_mode: 'peer_reviewed',
        reopened_at: null,
        reopened_by: null,
        continuation_packet_json: null,
        updated_at: '2026-04-25T12:05:00.000Z',
      });
      store.upsertTaskDependency({
        dependency_id: 'dep-review-653-655',
        parent_task_id: '20260425-653-evidence',
        required_task_id: '20260425-655-review-evidence',
        kind: 'review',
        satisfying_outcomes_json: JSON.stringify(['accepted', 'accepted_with_notes']),
        status: 'open',
        created_by: 'agent',
        created_at: '2026-04-25T12:03:00.000Z',
      });
      store.upsertTaskOutcomeContract({
        contract_id: 'contract-review-655',
        task_id: '20260425-655-review-evidence',
        outcome_type: 'review',
        allowed_outcomes_json: JSON.stringify(['accepted', 'accepted_with_notes', 'rejected']),
        satisfying_outcomes_json: JSON.stringify(['accepted', 'accepted_with_notes']),
        blocking_outcomes_json: JSON.stringify(['rejected']),
        required_fields_json: JSON.stringify(['summary']),
        capability_requirement: 'review',
        created_by: 'agent',
        created_at: '2026-04-25T12:03:00.000Z',
      });
      store.insertTaskOutcome({
        outcome_id: 'outcome-review-655',
        task_id: '20260425-655-review-evidence',
        contract_id: 'contract-review-655',
        agent_id: 'reviewer',
        outcome: 'rejected',
        summary: 'Dependency review rejected with deferred disposition.',
        findings_json: JSON.stringify([{ severity: 'blocking', description: 'Deferred by operator.' }]),
        evidence_refs_json: JSON.stringify([]),
        admitted_at: '2026-04-25T12:04:00.000Z',
      });

      const beforeDisposition = evaluateTaskDependencySatisfaction(store, '20260425-653-evidence');
      expect(beforeDisposition.all_satisfied).toBe(false);
      expect(beforeDisposition.dependencies[0].state).toBe('blocking_outcome');
      expect(beforeDisposition.dependencies[0].disposition_required).toBe(true);

      store.upsertTaskDependencyDisposition({
        disposition_id: 'disp-review-655',
        dependency_id: 'dep-review-653-655',
        required_outcome_id: 'outcome-review-655',
        kind: 'operator_deferred',
        status: 'deferred',
        target_task_id: null,
        routed_obligation_id: null,
        authority_basis_json: JSON.stringify({ kind: 'operator_direct_instruction', summary: 'Operator accepted deferral.' }),
        summary: 'Operator explicitly deferred remediation.',
        created_by: 'operator',
        created_at: '2026-04-25T12:06:00.000Z',
      });

      const afterDisposition = evaluateTaskDependencySatisfaction(store, '20260425-653-evidence');
      expect(afterDisposition.all_satisfied).toBe(true);
      expect(afterDisposition.dependencies[0].state).toBe('blocking_outcome');
      expect(afterDisposition.dependencies[0].satisfied).toBe(true);
      expect(afterDisposition.dependencies[0].disposition_required).toBe(false);
      expect(afterDisposition.dependencies[0].blocking_reason).toBe(null);
    } finally {
      store.db.close();
    }
  });
});
