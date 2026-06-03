import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { closeTaskService } from '../../src/task-close-service.js';
import { openTaskLifecycleStore } from '../../src/task-lifecycle-store.js';
import { ExitCode } from '../../src/exit-codes.js';

describe('task close service', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'narada-task-close-service-'));
    mkdirSync(join(tempDir, '.ai', 'do-not-open', 'tasks'), { recursive: true });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function writeTask(num: number) {
    writeFileSync(
      join(tempDir, '.ai', 'do-not-open', 'tasks', `20260425-${num}-service-close.md`),
      `---\nstatus: in_review\n---\n\n# Task ${num}: Service Close\n\n## Acceptance Criteria\n\n- [x] Criterion A\n\n## Execution Notes\nDone.\n\n## Verification\nPassed.\n`,
    );
  }

  function admitClose(num: number) {
    const taskId = `20260425-${num}-service-close`;
    const store = openTaskLifecycleStore(tempDir);
    try {
      store.upsertLifecycle({
        task_id: taskId,
        task_number: num,
        status: 'in_review',
        governed_by: null,
        closed_at: null,
        closed_by: null,
        closure_mode: null,
        reopened_at: null,
        reopened_by: null,
        continuation_packet_json: null,
        updated_at: '2026-04-25T00:00:00Z',
      });
      store.upsertEvidenceBundle({
        bundle_id: `evb-${num}`,
        task_id: taskId,
        task_number: num,
        report_ids_json: '[]',
        verification_run_ids_json: '[]',
        acceptance_criteria_json: JSON.stringify({ all_checked: true, unchecked_count: 0 }),
        review_ids_json: '[]',
        changed_files_json: '[]',
        residuals_json: '[]',
        assembled_at: '2026-04-25T00:00:00Z',
        assembled_by: 'tester',
      });
      store.upsertEvidenceAdmissionResult({
        admission_id: `ear-${num}`,
        bundle_id: `evb-${num}`,
        task_id: taskId,
        task_number: num,
        verdict: 'admitted',
        methods_json: JSON.stringify(['admission']),
        blockers_json: '[]',
        lifecycle_eligible_status: 'closed',
        admitted_at: '2026-04-25T00:00:01Z',
        admitted_by: 'tester',
        confirmation_json: '{}',
      });
    } finally {
      store.db.close();
    }
  }

  it('closes through package-owned lifecycle service', async () => {
    writeTask(7081);
    admitClose(7081);

    const result = await closeTaskService({
      taskNumber: '7081',
      by: 'a2',
      cwd: tempDir,
      mode: 'operator_direct',
    });

    expect(result.exitCode).toBe(ExitCode.SUCCESS);
    expect(result.result.status).toBe('success');
    expect(result.result.new_status).toBe('closed');
    expect(result.result.closed_by).toBe('a2');
    expect(result.result.closure_mode).toBe('operator_direct');

    const content = readFileSync(join(tempDir, '.ai', 'do-not-open', 'tasks', '20260425-7081-service-close.md'), 'utf8');
    expect(content).toContain('status: closed');
    expect(content).toContain('governed_by: task_close:a2');
  });

  it('blocks lifecycle close without evidence admission', async () => {
    writeTask(7082);

    const result = await closeTaskService({
      taskNumber: '7082',
      by: 'a2',
      cwd: tempDir,
      mode: 'operator_direct',
    });

    expect(result.exitCode).toBe(ExitCode.GENERAL_ERROR);
    expect(result.result.status).toBe('error');
    expect(result.result.gate_failures).toEqual([
      'Task lacks an Evidence Admission result; run `narada task evidence admit <task-number> --by <id>` first',
    ]);
  });

  it('uses the current inserted Evidence Admission when admission timestamps tie', async () => {
    writeTask(7083);
    const taskId = '20260425-7083-service-close';
    const store = openTaskLifecycleStore(tempDir);
    try {
      store.upsertLifecycle({
        task_id: taskId,
        task_number: 7083,
        status: 'in_review',
        governed_by: null,
        closed_at: null,
        closed_by: null,
        closure_mode: null,
        reopened_at: null,
        reopened_by: null,
        continuation_packet_json: null,
        updated_at: '2026-04-25T00:00:00Z',
      });
      for (const [suffix, verdict, eligible] of [
        ['rejected', 'rejected', null],
        ['admitted', 'admitted', 'closed'],
      ] as const) {
        store.upsertEvidenceBundle({
          bundle_id: `evb-7083-${suffix}`,
          task_id: taskId,
          task_number: 7083,
          report_ids_json: '[]',
          verification_run_ids_json: '[]',
          acceptance_criteria_json: JSON.stringify({ all_checked: true, unchecked_count: 0 }),
          review_ids_json: '[]',
          changed_files_json: '[]',
          residuals_json: '[]',
          assembled_at: '2026-04-25T00:00:01Z',
          assembled_by: 'tester',
        });
        store.upsertEvidenceAdmissionResult({
          admission_id: `ear-7083-${suffix}`,
          bundle_id: `evb-7083-${suffix}`,
          task_id: taskId,
          task_number: 7083,
          verdict,
          methods_json: JSON.stringify(['admission']),
          blockers_json: verdict === 'rejected' ? JSON.stringify(['stale failure']) : '[]',
          lifecycle_eligible_status: eligible,
          admitted_at: '2026-04-25T00:00:02Z',
          admitted_by: 'tester',
          confirmation_json: '{}',
        });
      }
    } finally {
      store.db.close();
    }

    const result = await closeTaskService({
      taskNumber: '7083',
      by: 'a2',
      cwd: tempDir,
      mode: 'operator_direct',
    });

    expect(result.exitCode).toBe(ExitCode.SUCCESS);
    expect(result.result).toMatchObject({
      status: 'success',
      admission_id: 'ear-7083-admitted',
      new_status: 'closed',
    });
  });
});
